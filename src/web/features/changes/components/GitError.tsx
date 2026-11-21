import { TerminalIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { gitFailedParamsSchema, gitPushFailedParamsSchema, type ErrorPayload } from '@shared/errors';
import { useI18n } from '@web/i18n';
import { requestShell } from '@web/shell/requests';
import { useTerminalAvailable } from '@web/state/hosts';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { CopyButton } from '@web/ui/copy-button';

/**
 * An error of the git service in the panel (`Alert role="alert"`): the translated code, git's first
 * line (`params.detail`) and for a failed push its reason. A push refused at the sign-in
 * (`GIT_PUSH_FAILED {reason: 'auth'}`, ADR-252) offers "Push in terminal": the terminal tab of the
 * session opens and the hint says to run `git push` there (the terminal can ask for credentials).
 */

export const PUSH_COMMAND = 'git push';

export function GitError({
  sessionKey,
  title,
  error,
  actions,
}: {
  sessionKey: string;
  title: string;
  error: ErrorPayload;
  /** More buttons (e.g. "Try again"). */
  actions?: ReactNode;
}) {
  const { t, tError } = useI18n();
  const terminal = useTerminalAvailable(sessionKey);
  const push = error.code === 'GIT_PUSH_FAILED' ? gitPushFailedParamsSchema.safeParse(error.params) : null;
  const detail =
    push?.success === true
      ? push.data.detail
      : error.code === 'GIT_FAILED'
        ? gitFailedParamsSchema.safeParse(error.params).data?.detail
        : undefined;
  const reason = push?.success === true ? push.data.reason : null;
  const auth = reason === 'auth';
  return (
    <Alert
      tone="error"
      title={title}
      data-slot="changes-error"
      data-code={error.code}
      actions={
        auth && terminal ? (
          <>
            <Button
              variant="outline"
              size="sm"
              data-action="push-in-terminal"
              onClick={() => {
                requestShell({ kind: 'sidePanel', sessionKey, tab: 'terminal' });
              }}
            >
              <TerminalIcon aria-hidden />
              {t('changes.push.terminal')}
            </Button>
            {actions}
          </>
        ) : (
          actions
        )
      }
    >
      <span className="grid gap-1">
        <span>
          {reason === null
            ? tError(error)
            : t(reason === 'other' ? 'changes.push.reason.unknown' : `changes.push.reason.${reason}`)}
        </span>
        {detail === undefined || detail === '' ? null : (
          <span className="font-mono text-2xs break-words">{t('changes.panel.gitDetail', { detail })}</span>
        )}
        {auth ? (
          <span className="flex flex-wrap items-center gap-1" data-slot="push-terminal-hint">
            {t('changes.push.terminalHint', { command: PUSH_COMMAND })}
            <CopyButton text={PUSH_COMMAND} label={t('changes.push.copyCommand')} />
          </span>
        ) : null}
      </span>
    </Alert>
  );
}
