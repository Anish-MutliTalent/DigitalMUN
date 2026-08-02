/**
 * @mun/server — submission REST routes
 *
 * POST   /committee/:cid/submissions           — delegate submits a link (JSON)
 * POST   /committee/:cid/submissions/upload    — delegate uploads a file (JSON + base64)
 * GET    /committee/:cid/submissions           — chair/delegate lists
 * GET    /committee/:cid/submissions/:id/file  — chair downloads the file
 * POST   /committee/:cid/submissions/:id/reviewed — chair toggles reviewed
 * DELETE /committee/:cid/submissions/:id       — delegate (own) or chair deletes
 */

import type { FastifyInstance } from 'fastify';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ProtocolError,
  SubmissionLinkRequestSchema,
  SubmissionTypeSchema,
  safeParse,
  formatZodIssues,
} from '@mun/protocol';
import { authPreHandler, requireCommitteeChair } from '../auth/context.js';
import * as subService from './service.js';
import { pool } from '../db/pool.js';
import { randomUuid } from '@mun/crypto';

const ALLOWED_EXT = new Set(['.pdf', '.doc', '.docx']);

export async function registerSubmissionRoutes(app: FastifyInstance): Promise<void> {
  // Delegate submits a Google Doc (or other) link.
  app.post(
    '/committee/:committeeId/submissions',
    { preHandler: [authPreHandler] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const user = request.user!;
      if (user.role !== 'delegate' || user.committeeId !== committeeId) {
        throw new ProtocolError('AUTH_FORBIDDEN', 'Only a delegate of this committee may submit.');
      }
      const parsed = safeParse(SubmissionLinkRequestSchema, request.body);
      if (!parsed.success) {
        throw new ProtocolError('VALIDATION_ERROR', 'Invalid submission', {
          details: formatZodIssues(parsed.error),
        });
      }
      const sub = await subService.createLinkSubmission({
        committeeId,
        delegateId: user.delegateId!,
        type: parsed.data.type,
        title: parsed.data.title,
        url: parsed.data.url,
      });
      return reply.send({ submission: sub });
    },
  );

  // Delegate uploads a PDF/DOC file as base64 in a JSON body (no multipart —
  // reliable + no parser hangs). bodyLimit raised for this route to allow large
  // documents (base64 is ~33% larger than the raw file).
  app.post(
    '/committee/:committeeId/submissions/upload',
    { preHandler: [authPreHandler], bodyLimit: 40 * 1024 * 1024 },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const user = request.user!;
      if (user.role !== 'delegate' || user.committeeId !== committeeId) {
        throw new ProtocolError('AUTH_FORBIDDEN', 'Only a delegate of this committee may submit.');
      }

      const body = request.body as {
        type?: string;
        title?: string;
        fileName?: string;
        dataBase64?: string;
      };
      const typeParsed = SubmissionTypeSchema.safeParse(body.type);
      if (!typeParsed.success) {
        throw new ProtocolError('VALIDATION_ERROR', 'type must be resolution or directive');
      }
      if (!body.title?.trim()) throw new ProtocolError('VALIDATION_ERROR', 'title required');
      if (!body.fileName) throw new ProtocolError('VALIDATION_ERROR', 'fileName required');
      if (!body.dataBase64) throw new ProtocolError('VALIDATION_ERROR', 'file data required');

      const ext = extOf(body.fileName);
      if (!ALLOWED_EXT.has(ext)) {
        throw new ProtocolError('VALIDATION_ERROR', 'Only PDF, DOC, or DOCX files are accepted.');
      }

      let buf: Buffer;
      try {
        buf = Buffer.from(body.dataBase64, 'base64');
      } catch {
        throw new ProtocolError('VALIDATION_ERROR', 'Invalid file data.');
      }
      if (buf.length === 0) throw new ProtocolError('VALIDATION_ERROR', 'Empty file.');
      if (buf.length > 25 * 1024 * 1024) {
        throw new ProtocolError('VALIDATION_ERROR', 'File exceeds 25 MB.');
      }

      const dir = subService.uploadDir();
      mkdirSync(dir, { recursive: true });
      const storedName = `${randomUuid()}${ext}`;
      const storagePath = join(dir, storedName);
      const { writeFile: writeBinaryFile } = await import('node:fs/promises');
      await writeBinaryFile(storagePath, buf);

      const mime =
        ext === '.pdf' ? 'application/pdf' :
        ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' :
        'application/msword';

      const sub = await subService.createFileSubmission({
        committeeId,
        delegateId: user.delegateId!,
        type: typeParsed.data,
        title: body.title.trim(),
        fileName: body.fileName,
        storagePath,
        mime,
      });
      return reply.send({ submission: sub });
    },
  );

  // List submissions (chair or delegate of the committee).
  app.get(
    '/committee/:committeeId/submissions',
    { preHandler: [authPreHandler] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const user = request.user!;
      if (user.role === 'delegate' && user.committeeId !== committeeId) {
        throw new ProtocolError('AUTH_FORBIDDEN', 'Not a member of this committee.');
      }
      if (user.role === 'chair') {
        // requireCommitteeChair semantics inline
        const { rows } = await pool.query('SELECT chair_user_id FROM committees WHERE id = $1', [committeeId]);
        if (rows.length === 0) throw new ProtocolError('COMMITTEE_NOT_FOUND', 'Committee not found');
        if (rows[0].chair_user_id !== user.userId) {
          throw new ProtocolError('AUTH_FORBIDDEN', 'Not the chair of this committee.');
        }
      }
      const submissions = await subService.listSubmissions(committeeId);
      return reply.send({ submissions });
    },
  );

  // Chair downloads a file submission.
  app.get(
    '/committee/:committeeId/submissions/:submissionId/file',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { submissionId } = request.params as { submissionId: string };
      const info = await subService.getSubmissionFile(submissionId);
      if (!info) throw new ProtocolError('NOT_FOUND', 'File not found');
      reply.header('Content-Type', info.mime);
      reply.header('Content-Disposition', `attachment; filename="${info.fileName.replace(/"/g, '')}"`);
      const { createReadStream } = await import('node:fs');
      return reply.send(createReadStream(info.storagePath));
    },
  );

  // Chair toggles reviewed.
  app.post(
    '/committee/:committeeId/submissions/:submissionId/reviewed',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { submissionId } = request.params as { submissionId: string };
      const sub = await subService.markReviewed(submissionId, request.user!.userId);
      if (!sub) throw new ProtocolError('NOT_FOUND', 'Submission not found');
      return reply.send({ submission: sub });
    },
  );

  // Delegate (own) or chair deletes a submission.
  app.delete(
    '/committee/:committeeId/submissions/:submissionId',
    { preHandler: [authPreHandler] },
    async (request, reply) => {
      const { submissionId } = request.params as { submissionId: string };
      const user = request.user!;
      const sub = await subService.getSubmission(submissionId);
      if (!sub) throw new ProtocolError('NOT_FOUND', 'Submission not found');
      // Delegate may delete only their own; chair may delete any.
      if (user.role === 'delegate' && sub.delegateId !== user.delegateId) {
        throw new ProtocolError('AUTH_FORBIDDEN', 'You can only delete your own submissions.');
      }
      if (user.role === 'chair') {
        const { rows } = await pool.query('SELECT chair_user_id FROM committees WHERE id = $1', [sub.committeeId]);
        if (rows[0].chair_user_id !== user.userId) {
          throw new ProtocolError('AUTH_FORBIDDEN', 'Not the chair of this committee.');
        }
      }
      await subService.deleteSubmission(submissionId, user.userId);
      return reply.send({ ok: true });
    },
  );
}

function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i >= 0 ? filename.slice(i).toLowerCase() : '';
}
