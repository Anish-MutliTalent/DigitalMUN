/**
 * @mun/server — resolution/directive submission service
 *
 * Delegates submit a resolution or directive as an uploaded file (PDF/DOC) or a
 * Google Doc link. Submissions are stored in `submissions` (metadata) + an
 * uploads directory (files). The chair reviews them in real time.
 */

import { pool } from '../db/pool.js';
import { audit } from '../audit/service.js';
import { broker } from '../realtime/broker.js';
import { envelope, type Submission, type SubmissionType } from '@mun/protocol';
import { randomUuid } from '@mun/crypto';

/** Directory for uploaded files (created on demand). */
export function uploadDir(): string {
  return process.env.MUN_UPLOAD_DIR ?? 'uploads';
}

async function rowToSubmission(r: Record<string, unknown>): Promise<Submission> {
  return {
    id: r.id as string,
    committeeId: r.committee_id as string,
    delegateId: r.delegate_id as string,
    delegateName: r.delegate_name as string,
    country: r.country as string,
    type: r.type as SubmissionType,
    title: r.title as string,
    kind: r.kind as 'file' | 'link',
    fileName: (r.file_name as string | null) ?? null,
    url: (r.url as string | null) ?? null,
    status: r.status as 'submitted' | 'reviewed',
    submittedAt: Number(r.submitted_at as number),
    reviewedAt: r.reviewed_at ? Number(r.reviewed_at) : null,
    reviewedBy: (r.reviewed_by as string | null) ?? null,
  };
}

const SUBMISSION_COLS = `
  s.id, s.committee_id, s.delegate_id, s.type, s.title, s.kind,
  s.file_name, s.url, s.status, s.submitted_at, s.reviewed_at, s.reviewed_by,
  u.display_name AS delegate_name, d.country
`;

export async function createLinkSubmission(params: {
  committeeId: string;
  delegateId: string;
  type: SubmissionType;
  title: string;
  url: string;
}): Promise<Submission> {
  const id = randomUuid();
  const now = Date.now();
  await pool.query(
    `INSERT INTO submissions (id, committee_id, delegate_id, type, title, kind, url, submitted_at)
     VALUES ($1, $2, $3, $4, $5, 'link', $6, $7)`,
    [id, params.committeeId, params.delegateId, params.type, params.title, params.url, now],
  );
  const sub = await getSubmission(id);
  await audit({
    actor: params.delegateId,
    action: 'submission_submit',
    subject: id,
    detail: `${params.type} link: "${params.title}"`,
  });
  broadcastSubmission(params.committeeId, sub!);
  return sub!;
}

export async function createFileSubmission(params: {
  committeeId: string;
  delegateId: string;
  type: SubmissionType;
  title: string;
  fileName: string;
  storagePath: string;
  mime: string;
}): Promise<Submission> {
  const id = randomUuid();
  const now = Date.now();
  await pool.query(
    `INSERT INTO submissions (id, committee_id, delegate_id, type, title, kind, file_name, storage_path, mime, submitted_at)
     VALUES ($1, $2, $3, $4, $5, 'file', $6, $7, $8, $9)`,
    [id, params.committeeId, params.delegateId, params.type, params.title, params.fileName, params.storagePath, params.mime, now],
  );
  const sub = await getSubmission(id);
  await audit({
    actor: params.delegateId,
    action: 'submission_submit',
    subject: id,
    detail: `${params.type} file: "${params.title}" (${params.fileName})`,
  });
  broadcastSubmission(params.committeeId, sub!);
  return sub!;
}

export async function getSubmission(id: string): Promise<Submission | null> {
  const { rows } = await pool.query(
    `SELECT ${SUBMISSION_COLS}
     FROM submissions s
     JOIN delegates d ON d.id = s.delegate_id
     JOIN users u ON u.id = d.user_id
     WHERE s.id = $1`,
    [id],
  );
  return rows.length ? rowToSubmission(rows[0]) : null;
}

export async function listSubmissions(committeeId: string): Promise<Submission[]> {
  const { rows } = await pool.query(
    `SELECT ${SUBMISSION_COLS}
     FROM submissions s
     JOIN delegates d ON d.id = s.delegate_id
     JOIN users u ON u.id = d.user_id
     WHERE s.committee_id = $1
     ORDER BY s.submitted_at DESC`,
    [committeeId],
  );
  return Promise.all(rows.map(rowToSubmission));
}

export async function getSubmissionFile(
  id: string,
): Promise<{ storagePath: string; fileName: string; mime: string } | null> {
  const { rows } = await pool.query(
    "SELECT storage_path, file_name, mime FROM submissions WHERE id = $1 AND kind = 'file'",
    [id],
  );
  if (rows.length === 0) return null;
  return {
    storagePath: rows[0].storage_path as string,
    fileName: rows[0].file_name as string,
    mime: (rows[0].mime as string) ?? 'application/octet-stream',
  };
}

export async function markReviewed(id: string, reviewerUserId: string): Promise<Submission | null> {
  const now = Date.now();
  const { rows } = await pool.query(
    `UPDATE submissions
       SET status = CASE WHEN status = 'reviewed' THEN 'submitted' ELSE 'reviewed' END,
           reviewed_at = CASE WHEN status = 'reviewed' THEN NULL ELSE $1::bigint END,
           reviewed_by = CASE WHEN status = 'reviewed' THEN NULL ELSE $2::uuid END
     WHERE id = $3 RETURNING committee_id`,
    [now, reviewerUserId, id],
  );
  if (rows.length === 0) return null;
  const sub = await getSubmission(id);
  await audit({
    actor: reviewerUserId,
    action: 'submission_review',
    subject: id,
    detail: `${sub?.status === 'reviewed' ? 'marked reviewed' : 'marked unreviewed'}: "${sub?.title}"`,
  });
  if (sub) broadcastSubmissionUpdate(sub.committeeId, sub);
  return sub;
}

export async function deleteSubmission(id: string, byUserId: string): Promise<void> {
  const { rows } = await pool.query('SELECT committee_id, storage_path FROM submissions WHERE id = $1', [id]);
  if (rows.length === 0) return;
  const committeeId = rows[0].committee_id as string;
  await pool.query('DELETE FROM submissions WHERE id = $1', [id]);
  await audit({ actor: byUserId, action: 'submission_delete', subject: id, detail: 'Submission deleted' });
  // Notify the chair: re-broadcast the current list is overkill; emit a deletion via a list refresh.
  void committeeId;
}

function broadcastSubmission(committeeId: string, sub: Submission): void {
  broker.broadcastCommittee(committeeId, envelope('submission', { submission: sub }));
}

function broadcastSubmissionUpdate(committeeId: string, sub: Submission): void {
  broker.broadcastCommittee(committeeId, envelope('submission_update', { submission: sub }));
}
