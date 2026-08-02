/**
 * @mun/server — voting & key-registration REST routes
 *
 * POST   /committee/:cid/vote                — chair opens a vote
 * GET    /committee/:cid/votes               — list votes
 * GET    /committee/:cid/vote/:vid           — public vote state (counts only)
 * POST   /committee/:cid/vote/:vid/cast      — delegate casts a vote (also via WS)
 * POST   /committee/:cid/vote/:vid/close     — chair closes the vote
 * POST   /committee/:cid/vote/:vid/reveal    — chair reveals results (completion-gated)
 * POST   /delegate/register-key             — delegate registers voting public key (once)
 * GET    /server-key                         — server receipt-signing public key
 */

import type { FastifyInstance } from 'fastify';
import {
  ProtocolError,
  safeParse,
  formatZodIssues,
  VoteChoiceSchema,
  envelope,
} from '@mun/protocol';
import { authPreHandler, requireRole, requireCommitteeChair } from '../auth/context.js';
import * as voteService from './service.js';
import { getServerPublicKey } from './serverkeys.js';
import { broker } from '../realtime/broker.js';
import { pool } from '../db/pool.js';
import { audit } from '../audit/service.js';

export async function registerVotingRoutes(app: FastifyInstance): Promise<void> {
  // ─── Server public key (for receipt verification; public) ───────────────────
  app.get('/server-key', async (_request, reply) => {
    const publicKey = await getServerPublicKey();
    return reply.send({ publicKey });
  });

  // ─── Delegate registers voting public key (once) ────────────────────────────
  app.post(
    '/delegate/register-key',
    { preHandler: [authPreHandler, requireRole('delegate')] },
    async (request, reply) => {
      const { publicKey } = request.body as { publicKey?: string };
      if (!publicKey || typeof publicKey !== 'string') {
        throw new ProtocolError('VALIDATION_ERROR', 'publicKey required');
      }
      const user = request.user!;
      const { rows: drows } = await pool.query(
        'SELECT id, public_key FROM delegates WHERE user_id = $1',
        [user.userId],
      );
      if (drows.length === 0) throw new ProtocolError('DELEGATE_NOT_FOUND', 'No delegate record');
      // Always set/overwrite the voting key. A delegate re-joining (e.g. on a
      // new device after the chair force-logged them out) re-registers their
      // current device key, so vote verification matches. Old vote records keep
      // their own recorded key+signature for retroactive verification. An admin
      // can still clear the key via the reset-key endpoint if abuse is suspected.
      await pool.query('UPDATE delegates SET public_key = $1 WHERE id = $2', [
        publicKey,
        drows[0].id,
      ]);
      return reply.send({ ok: true });
    },
  );

  // ─── Chair opens a vote ──────────────────────────────────────────────────────
  app.post(
    '/committee/:committeeId/vote',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const { question } = request.body as { question?: string };
      if (!question || typeof question !== 'string') {
        throw new ProtocolError('VALIDATION_ERROR', 'question required');
      }
      const vote = await voteService.createVote({
        committeeId,
        question,
        chairUserId: request.user!.userId,
      });
      return reply.send({ vote });
    },
  );

  app.get(
    '/committee/:committeeId/votes',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const votes = await voteService.listCommitteeVotes(committeeId);
      return reply.send({ votes });
    },
  );

  app.get(
    '/committee/:committeeId/vote/:voteId',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { voteId } = request.params as { voteId: string };
      const state = await voteService.getVotePublicState(voteId);
      return reply.send(state);
    },
  );

  // ─── Delegate casts a vote (REST; the WS cast_vote path is equivalent) ───────
  app.post(
    '/committee/:committeeId/vote/:voteId/cast',
    { preHandler: [authPreHandler, requireRole('delegate')] },
    async (request, reply) => {
      const { voteId, committeeId } = request.params as { voteId: string; committeeId: string };
      const user = request.user!;
      if (user.committeeId !== committeeId) {
        throw new ProtocolError('AUTH_FORBIDDEN', 'Not a member of this committee');
      }
      const body = request.body as {
        choice?: string;
        signature?: string;
        publicKey?: string;
        clientCastId?: string;
      };
      const choiceParsed = safeParse(VoteChoiceSchema, body.choice);
      if (!choiceParsed.success) {
        throw new ProtocolError('VOTE_INVALID_CHOICE', 'choice must be "for" or "against"', {
          details: formatZodIssues(choiceParsed.error),
        });
      }
      if (!body.signature || !body.publicKey || !body.clientCastId) {
        throw new ProtocolError('VALIDATION_ERROR', 'signature, publicKey, clientCastId required');
      }
      const result = await voteService.castVote({
        voteId,
        delegateId: user.delegateId!,
        committeeId,
        choice: choiceParsed.data,
        signature: body.signature,
        publicKey: body.publicKey,
        clientCastId: body.clientCastId,
      });
      // Ack to the delegate (targeted).
      broker.sendToDelegate(
        user.delegateId!,
        envelope('vote_cast_ack', {
          voteId,
          clientCastId: body.clientCastId,
          accepted: result.accepted,
          receipt: result.receipt,
          reason: result.reason,
          submittedCount: result.submittedCount,
          requiredCount: result.requiredCount,
        }),
      );
      return reply.send(result);
    },
  );

  app.post(
    '/committee/:committeeId/vote/:voteId/close',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { voteId } = request.params as { voteId: string };
      const vote = await voteService.closeVote(voteId, request.user!.userId);
      return reply.send({ vote });
    },
  );

  app.post(
    '/committee/:committeeId/vote/:voteId/reveal',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { voteId } = request.params as { voteId: string };
      try {
        const result = await voteService.revealVote(voteId, request.user!.userId);
        return reply.send({ result });
      } catch (err) {
        if (err instanceof ProtocolError) throw err;
        throw new ProtocolError('INTERNAL_ERROR', 'Reveal failed');
      }
    },
  );

  // Suppress unused-import warnings for audit (used in future admin reset).
  void audit;
}
