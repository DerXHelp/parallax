/**
 * permissions – canUseTool decisions and tool results (points 3, 4, 13).
 * permissionMode 'default' (explicit, because the CLI default may be auto). Turns:
 *  1. Write → allow once; Bash X → allow "always" with only the addRules suggestions, destination
 *     rewritten to 'session' (what Parallax' "always (session)" sends)
 *  2. Edit → allow once; Bash X again → expected without prompt; PowerShell → allow once
 *  3. Bash `rm` → deny with message
 *  4. Bash `touch` → deny with interrupt:true
 *  5. plain text turn: is the session still usable after deny+interrupt?
 *  6. Bash Y → allow "always" with ALL suggestions unfiltered (setMode acceptEdits, localSettings …)
 *  7. Bash `touch` → still prompted? (policy denies if asked)
 * Finally .claude/settings.local.json in the cwd is read (written by a localSettings rule).
 */
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { allowAlways, allowOnce, deny, type PolicyOptions } from '../session';
import { withSession, type Scenario } from './common';

const DESCRIPTION =
  'permissionMode default; Write allow-once; Bash allow-always with addRules→session only (repeat runs ' +
  'without prompt); Edit/PowerShell allow-once; Bash deny with message; Bash deny with interrupt; follow-up ' +
  'turn; Bash allow-always with ALL suggestions (mode → acceptEdits, localSettings rule); tool_use_result ' +
  'of Write/Edit/Bash/PowerShell/Read; input_json_delta.';

/** "Always (this session)": only rule suggestions, all with destination 'session'. */
export function sessionRulesOnly(options: PolicyOptions): PermissionUpdate[] {
  return (options.suggestions ?? []).flatMap((update): PermissionUpdate[] =>
    update.type === 'addRules' ? [{ ...update, destination: 'session' }] : [],
  );
}

const SHELL_X = 'mkdir -p spike-dir && ls -1';

export const permissions: Scenario = {
  name: 'permissions',
  description: DESCRIPTION,
  live: true,
  async run(ctx) {
    await withSession(
      ctx,
      'permissions',
      DESCRIPTION,
      { permissionMode: 'default', maxTurns: 8 },
      async (session, rec) => {
        session.policy = (tool, input, options) => {
          if (tool === 'Write') return allowOnce(input);
          if (tool === 'Bash') {
            return {
              ...allowOnce(input),
              updatedPermissions: sessionRulesOnly(options),
              decisionClassification: 'user_permanent',
            };
          }
          return deny('Not part of this step.');
        };
        rec.mark('step-1', { expect: 'Write allow once; Bash allow always (addRules -> session)' });
        await session.turn(
          'Do exactly these two steps and nothing else: ' +
            '1) Use the Write tool to create the file notes.txt containing the single line: alpha ' +
            `2) Use the Bash tool to run exactly: ${SHELL_X} ` +
            'Then reply with exactly: DONE',
        );
        await session.call('getContextUsage', [{ detail: 'summary' }], (q) =>
          q.getContextUsage({ detail: 'summary' }),
        );

        session.policy = (tool, input) => {
          if (tool === 'Edit' || tool === 'PowerShell' || tool === 'Bash') return allowOnce(input);
          return deny('Not part of this step.');
        };
        rec.mark('step-2', {
          expect: 'Edit allow once; Bash X without prompt (session rule); PowerShell allow once',
        });
        await session.turn(
          'Do exactly these three steps and nothing else: ' +
            '1) Use the Edit tool to replace alpha with beta in notes.txt ' +
            `2) Use the Bash tool to run exactly: ${SHELL_X} ` +
            '3) Use the PowerShell tool to run exactly: New-Item -ItemType Directory -Name ps-dir | Out-Null; Get-ChildItem -Name ' +
            'Then reply with exactly: DONE',
        );

        session.policy = (tool, input) =>
          tool === 'Bash' || tool === 'PowerShell'
            ? deny('The user declined: keep notes.txt. Do not try again; reply with exactly: KEPT')
            : allowOnce(input);
        rec.mark('step-3', { expect: 'deny with message' });
        await session.turn('Use the Bash tool to run exactly: rm notes.txt');

        session.policy = () => deny('Stopped by the user.', true);
        rec.mark('step-4', { expect: 'deny with interrupt:true' });
        await session.turn(
          'Use the Bash tool to run exactly: touch final.txt   Then reply with exactly: DONE',
        );

        session.policy = () => deny('Not part of this step.');
        rec.mark('step-5', { expect: 'session usable after deny+interrupt' });
        await session.turn('Reply with exactly: STILL-HERE');

        session.policy = (tool, input, options) =>
          tool === 'Bash' ? allowAlways(input, options) : deny('Not part of this step.');
        rec.mark('step-6', { expect: 'Bash allow always with ALL suggestions (unfiltered)' });
        await session.turn(
          'Use the Bash tool to run exactly: mkdir -p accept-dir && ls -1   Then reply with exactly: DONE',
        );

        session.policy = () => deny('Recorder: this prompt was not expected after accept-all.');
        rec.mark('step-7', { expect: 'touch runs without prompt if the mode is acceptEdits now' });
        await session.turn(
          'Use the Bash tool to run exactly: touch after-accept.txt   Then reply with exactly: DONE',
        );

        const localSettings = path.join(session.config.cwd, '.claude', 'settings.local.json');
        await session.call('fs.localSettings', [localSettings], () =>
          Promise.resolve({
            exists: existsSync(localSettings),
            content: existsSync(localSettings)
              ? (JSON.parse(readFileSync(localSettings, 'utf8')) as unknown)
              : null,
          }),
        );
        await session.call('getContextUsage', [{ detail: 'summary' }], (q) =>
          q.getContextUsage({ detail: 'summary' }),
        );
      },
    );
  },
};
