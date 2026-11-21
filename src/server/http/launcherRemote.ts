/**
 * `POST /api/launcher/remote` (WP-107, docs/wp/WP-76.md §B.13): "Share" and the coupling from the
 * command line – `parallax remote status|enable|disable|pair [--level manage]|cancel|unpair|level
 * <level>`, e.g. on a computer without a desktop. Guarded like `/api/launcher/code` (origin.ts class
 * `launcher`: no Origin, Sec-Fetch-Site absent or `none`; here the bearer launcher token and no
 * cookie), so only a process that can read the lock file of this data folder gets here.
 *
 * Every action runs as the local user (`CommandContext.access = 'local'`) through the same command
 * handlers the settings page uses – no second path for the role, pairing or level rules. The pairing
 * code is only in the answer to `pair` (the calling terminal shows it); it is never logged.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { clientIdSchema } from '@shared/common';
import { makeError } from '@shared/errors';
import {
  API_PATHS,
  launcherRemoteRequestSchema,
  launcherRemoteResponseSchema,
  type LauncherRemoteRequest,
  type LauncherRemoteResponse,
} from '@shared/http';
import type { HostState } from '@shared/model';
import { commandResultSchemas, type Command } from '@shared/protocol';
import { logger as rootLogger } from '../lib/logger';
import { CommandError, type CommandContext } from '../sync/ports';
import type { AuthService } from './auth';
import { sendError } from './reply';

export interface LauncherRemoteTarget {
  /** The host state now (`remoteAccess` = null while not sharing). */
  hostState(): HostState;
  /** The hub's command source (engine, remote access, role); throws CommandError. */
  handleCommand(cmd: Command, ctx: CommandContext): Promise<unknown>;
}

export interface LauncherRemoteRouteOptions {
  auth: Pick<AuthService, 'verifyLauncherToken'>;
  target: LauncherRemoteTarget;
  logger?: Logger;
}

/** The command of an action (null = only the state). */
export function launcherRemoteCommand(request: LauncherRemoteRequest): Command | null {
  switch (request.action) {
    case 'status':
      return null;
    case 'enable':
      return { name: 'multiHost.configure', role: 'share' };
    case 'disable':
      return { name: 'multiHost.configure', role: 'off' };
    case 'pair':
      return { name: 'remoteAccess.pair', level: request.level };
    case 'cancel':
      return { name: 'remoteAccess.cancelPairing' };
    case 'unpair':
      return { name: 'remoteAccess.unpair' };
    case 'level':
      return { name: 'remoteAccess.setPeerLevel', level: request.level };
  }
}

/** A context of its own per request: a window id nobody else has, access `local`. */
function launcherContext(): CommandContext {
  return {
    clientId: clientIdSchema.parse(`cl_${randomBytes(16).toString('hex')}`),
    cmdId: `launcher-${randomBytes(6).toString('hex')}`,
    access: 'local',
  };
}

export function registerLauncherRemoteRoute(app: FastifyInstance, options: LauncherRemoteRouteOptions): void {
  const log = options.logger ?? rootLogger;
  app.post(API_PATHS.launcherRemote, async (request, reply) => {
    if (!options.auth.verifyLauncherToken(request.headers.authorization)) {
      return sendError(reply, makeError('LAUNCHER_TOKEN_INVALID'));
    }
    // Defense in depth on top of origin.ts: a browser never gets here, not even with its cookie.
    if (request.headers.cookie !== undefined) {
      return sendError(reply, makeError('ORIGIN_REJECTED', { reason: 'cookie' }));
    }
    const body = launcherRemoteRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, makeError('VALIDATION_FAILED', { reason: 'body' }));
    const cmd = launcherRemoteCommand(body.data);
    let code: string | null = null;
    let expiresAt: string | null = null;
    if (cmd !== null) {
      try {
        const result = await options.target.handleCommand(cmd, launcherContext());
        if (cmd.name === 'remoteAccess.pair') {
          const pair = commandResultSchemas['remoteAccess.pair'].safeParse(result);
          if (!pair.success) return sendError(reply, makeError('INTERNAL_ERROR'));
          code = pair.data.code;
          expiresAt = pair.data.expiresAt;
        }
      } catch (error) {
        if (error instanceof CommandError) {
          log.info({ action: body.data.action, code: error.error.code }, 'launcher remote action refused');
          return sendError(reply, error.error);
        }
        log.error({ err: error, action: body.data.action }, 'launcher remote action failed');
        return sendError(reply, makeError('INTERNAL_ERROR'));
      }
    }
    // Only the action – never the pairing code.
    log.info({ action: body.data.action }, 'launcher remote action');
    const response: LauncherRemoteResponse = launcherRemoteResponseSchema.parse({
      remoteAccess: options.target.hostState().remoteAccess ?? null,
      code,
      expiresAt,
    });
    return response;
  });
}
