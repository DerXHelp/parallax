import { LogInIcon } from 'lucide-react';
import type { HostId, ProfileId } from '@shared/common';
import type { ClaudeInstallStatus } from '@shared/model';
import { useT } from '@web/i18n';
import { useHostState } from '@web/state/hooks';
import { Button } from '@web/ui/button';
import { requestShell } from '../requests';

/** The profile's `claude` runs but is not (or no longer) signed in – "Sign in" helps there. */
export function needsSignIn(claude: ClaudeInstallStatus): boolean {
  return claude.state === 'ok' && (claude.auth.state === 'logged_out' || claude.auth.state === 'error');
}

/**
 * WP-70: "Sign in" at a sign-in error (transcript, setup hint, new session, profiles) – opens the
 * sign-in dialog of the profile (shell request `login`; the dialog is a lazy chunk). Part of the
 * start chunk, so it stays this small. `since`: the time of the error – once the profile signed in
 * after it (`ProfileSummary.login`), the button is gone.
 */
export function LoginButton({
  profileId,
  hostId,
  since,
  className,
}: {
  profileId: ProfileId;
  hostId?: HostId;
  since?: string;
  className?: string;
}) {
  const t = useT();
  const login = useHostState(hostId)?.profiles.find((profile) => profile.id === profileId)?.login;
  if (since !== undefined && login?.state === 'done' && (login.at ?? '') >= since) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      data-slot="login-button"
      className={className}
      onClick={(event) => {
        const modal = event.currentTarget.closest('[role="dialog"]') !== null;
        requestShell({ kind: 'login', profileId, hostId, modal });
      }}
    >
      <LogInIcon aria-hidden />
      {t('navigation.actions.signIn')}
    </Button>
  );
}
