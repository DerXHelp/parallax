/**
 * permissions-rules – which "allow always" composition prevents a repeated prompt (point 3).
 * In `permissions`, a session addRules rule alone did not stop the second prompt for the same
 * Bash command (the CLI also suggested addDirectories for the blockedPath). Here:
 *  1. Bash X → allow with addRules + addDirectories, both destination 'session' (no setMode)
 *  2. Bash X again → prompted? (policy denies if asked)
 *  3. Bash Y → allow with the addRules suggestion unchanged (destination localSettings)
 *  4. Bash Y again → prompted? (policy denies if asked)
 */
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { allowOnce, deny, type PolicyOptions } from '../session';
import { withSession, type Scenario } from './common';

const DESCRIPTION =
  'Bash allow-always variants: addRules+addDirectories (session, no setMode) then the same command again; ' +
  'addRules (localSettings as suggested) then the same command again; is the repeat prompted?';

function withoutSetMode(options: PolicyOptions, destination?: 'session'): PermissionUpdate[] {
  return (options.suggestions ?? []).flatMap((update): PermissionUpdate[] => {
    if (update.type === 'setMode') return [];
    return [destination === undefined ? update : { ...update, destination }];
  });
}

function rulesOnly(options: PolicyOptions): PermissionUpdate[] {
  return (options.suggestions ?? []).filter((update) => update.type === 'addRules');
}

const X = 'mkdir -p rule-dir && ls -1';
const Y = 'mkdir -p rule-dir2 && ls -1';
const UNEXPECTED = 'Recorder: this repeated prompt was not expected; reply with exactly: PROMPTED';

export const permissionsRules: Scenario = {
  name: 'permissions-rules',
  description: DESCRIPTION,
  live: true,
  async run(ctx) {
    await withSession(
      ctx,
      'permissions-rules',
      DESCRIPTION,
      { permissionMode: 'default', maxTurns: 4 },
      async (session, rec) => {
        session.policy = (tool, input, options) =>
          tool === 'Bash'
            ? {
                ...allowOnce(input),
                updatedPermissions: withoutSetMode(options, 'session'),
                decisionClassification: 'user_permanent',
              }
            : deny('Not part of this step.');
        rec.mark('step-1', { expect: 'allow with addRules+addDirectories (session)' });
        await session.turn(`Use the Bash tool to run exactly: ${X}   Then reply with exactly: DONE`);

        session.policy = () => deny(UNEXPECTED);
        rec.mark('step-2', { expect: 'same command, no prompt?' });
        await session.turn(`Use the Bash tool to run exactly: ${X}   Then reply with exactly: DONE`);

        session.policy = (tool, input, options) =>
          tool === 'Bash'
            ? {
                ...allowOnce(input),
                updatedPermissions: rulesOnly(options),
                decisionClassification: 'user_permanent',
              }
            : deny('Not part of this step.');
        rec.mark('step-3', { expect: 'allow with addRules (localSettings, as suggested)' });
        await session.turn(`Use the Bash tool to run exactly: ${Y}   Then reply with exactly: DONE`);

        session.policy = () => deny(UNEXPECTED);
        rec.mark('step-4', { expect: 'same command, no prompt?' });
        await session.turn(`Use the Bash tool to run exactly: ${Y}   Then reply with exactly: DONE`);

        const localSettings = path.join(session.config.cwd, '.claude', 'settings.local.json');
        await session.call('fs.localSettings', [localSettings], () =>
          Promise.resolve({
            exists: existsSync(localSettings),
            content: existsSync(localSettings)
              ? (JSON.parse(readFileSync(localSettings, 'utf8')) as unknown)
              : null,
          }),
        );
      },
    );
  },
};
