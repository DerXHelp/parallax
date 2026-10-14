/**
 * plan-mode – plan review over ExitPlanMode (point 6).
 * permissionMode 'plan'. ExitPlanMode #1 → deny with feedback (Claude stays in plan mode and
 * revises → v2). ExitPlanMode #2 → allow with an edited plan (updatedInput.plan) and
 * updatedPermissions [{type:'setMode', mode:'acceptEdits', destination:'session'}]; Claude then
 * implements. Afterwards the plan file (planFilePath) and the created file are checked on disk.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { allowOnce, deny, type PermissionPolicy } from '../session';
import { stringField, withSession, type Scenario } from './common';

const DESCRIPTION =
  'permissionMode plan; ExitPlanMode v1 denied with feedback, v2 allowed with edited plan + ' +
  'setMode acceptEdits (destination session); implementation without prompts; plan file and ' +
  'planWasEdited checked.';

const MARKER = '- [spike] edited in Parallax before approval';

export const planMode: Scenario = {
  name: 'plan-mode',
  description: DESCRIPTION,
  live: true,
  async run(ctx) {
    let exitCalls = 0;
    let planFilePath: string | undefined;
    const policy: PermissionPolicy = (tool, input) => {
      if (tool !== 'ExitPlanMode') return allowOnce(input);
      exitCalls += 1;
      const filePath = stringField(input, 'planFilePath');
      if (filePath !== '') planFilePath = filePath;
      if (exitCalls === 1) {
        return deny(
          'Feedback from the user: add a final step that reads hello.txt back with the Read tool to verify ' +
            'the content. Keep everything else. Then call ExitPlanMode again.',
        );
      }
      return {
        behavior: 'allow',
        updatedInput: { ...input, plan: `${stringField(input, 'plan').trimEnd()}\n${MARKER}\n` },
        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        decisionClassification: 'user_temporary',
      };
    };

    await withSession(
      ctx,
      'plan-mode',
      DESCRIPTION,
      { permissionMode: 'plan', maxTurns: 14, policy },
      async (session, rec) => {
        await session.turn(
          'Plan how to create the file hello.txt in the current directory containing the text: hello. ' +
            'Keep the plan very short (at most 3 bullet points) and do not explore the file system. ' +
            'When the plan is ready, call ExitPlanMode. After approval, implement the plan and finally ' +
            'reply with exactly: IMPLEMENTED',
          { timeoutMs: 300_000 },
        );
        const planFile = planFilePath;
        await session.call('fs.planFile', [planFile ?? null], () => {
          if (planFile === undefined) return Promise.resolve({ known: false });
          const exists = existsSync(planFile);
          const text = exists ? readFileSync(planFile, 'utf8') : '';
          return Promise.resolve({
            known: true,
            path: planFile,
            exists,
            bytes: text.length,
            containsMarker: text.includes(MARKER),
            content: text,
          });
        });
        const hello = path.join(session.config.cwd, 'hello.txt');
        await session.call('fs.helloTxt', [hello], () =>
          Promise.resolve({
            exists: existsSync(hello),
            content: existsSync(hello) ? readFileSync(hello, 'utf8') : null,
          }),
        );
        await session.call('getContextUsage', [{ detail: 'summary' }], (q) =>
          q.getContextUsage({ detail: 'summary' }),
        );
        rec.mark('plan-mode-summary', {
          exitPlanModeCalls: exitCalls,
          permissionModes: session.permissionModes,
        });
      },
    );
  },
};
