import type { FastifyReply } from 'fastify';
import { ERROR_CATALOG, type ErrorPayload } from '@shared/errors';

/**
 * HTTP error answers: the body is always an `ErrorPayload`, the status comes from
 * `ERROR_CATALOG[code].http` (src/shared/http.ts). Returns the payload so sync route handlers can
 * `return sendError(reply, …)`.
 */
export function sendError(reply: FastifyReply, error: ErrorPayload): ErrorPayload {
  void reply.code(ERROR_CATALOG[error.code].http).type('application/json; charset=utf-8');
  return error;
}

/** For hooks: sends the error response immediately. */
export function replyError(reply: FastifyReply, error: ErrorPayload): void {
  void reply.code(ERROR_CATALOG[error.code].http).type('application/json; charset=utf-8').send(error);
}
