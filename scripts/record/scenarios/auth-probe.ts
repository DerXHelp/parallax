/**
 * auth-probe – the first and gating live scenario (points 1, 2, 12).
 * One text turn with permissionMode omitted; verifies the subscription login (apiKeySource 'none',
 * no auth error), then exercises read-only and state-changing Query methods that need no API
 * request, and ends the session gracefully by closing the streaming input (EOF).
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { describe } from '../messages';
import { FatalError } from '../session';
import { withSession, type Scenario } from './common';

const DESCRIPTION =
  'Text turn "Reply with exactly: OK" with permissionMode omitted (CLI default); auth gate; ' +
  'getContextUsage/supportedCommands/supportedModels/supportedAgents/initializationResult/accountInfo/' +
  'mcpServerStatus; setPermissionMode/setModel/applyFlagSettings; close via input EOF.';

export const authProbe: Scenario = {
  name: 'auth-probe',
  description: DESCRIPTION,
  live: true,
  async run(ctx) {
    await withSession(
      ctx,
      'auth-probe',
      DESCRIPTION,
      { maxTurns: 1, closeMode: 'eof' },
      async (session, rec) => {
        const { result } = await session.turn('Reply with exactly: OK');
        const init = session.init;
        if (init === undefined) throw new FatalError('auth', 'no system/init received');
        if (result.subtype !== 'success' || result.is_error) {
          const text = result.subtype === 'success' ? result.result : result.errors.join(' | ');
          throw new FatalError(
            'auth',
            `auth probe failed: ${result.subtype}, is_error=${String(result.is_error)}: ${text}`,
          );
        }
        ctx.state.authProbeOk = true;
        ctx.save();
        rec.mark('auth-ok', {
          apiKeySource: init.apiKeySource,
          permissionMode: init.permissionMode,
          claude_code_version: init.claude_code_version,
          result: result.result,
        });

        await session.call('getContextUsage', [{ detail: 'summary' }], (q) =>
          q.getContextUsage({ detail: 'summary' }),
        );
        await session.call('supportedCommands', [], (q) => q.supportedCommands());
        await session.call('supportedModels', [], (q) => q.supportedModels());
        await session.call('supportedAgents', [], (q) => q.supportedAgents());
        await session.call('initializationResult', [], (q) => q.initializationResult());
        await session.call('accountInfo', [], (q) => q.accountInfo());
        // Only names/status: server configs may carry credentials in env/headers.
        await session.call('mcpServerStatus', [], async (q) =>
          (await q.mcpServerStatus()).map((server) => ({
            name: server.name,
            status: server.status,
            scope: server.scope ?? null,
            source: server.source ?? null,
            serverInfo: server.serverInfo ?? null,
            error: server.error ?? null,
            tools: server.tools?.length ?? 0,
          })),
        );

        const from = session.messages.length;
        await session.control('setPermissionMode', ['default'], (q) => q.setPermissionMode('default'));
        await session.control('setModel', ['haiku'], (q) => q.setModel('haiku'));
        await session.control('applyFlagSettings', [{ fastMode: false }], (q) =>
          q.applyFlagSettings({ fastMode: false }),
        );
        await sleep(2_000);
        await session.call('getContextUsage', [{ detail: 'summary' }], (q) =>
          q.getContextUsage({ detail: 'summary' }),
        );
        rec.mark('after-controls', { messagesSince: session.messages.slice(from).map(describe) });
      },
    );
  },
};
