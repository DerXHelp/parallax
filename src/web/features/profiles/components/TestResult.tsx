import type { ClaudeInstallStatus } from '@shared/model';
import { useI18n, type TranslationKey } from '@web/i18n';
import { ProfileStatus } from '@web/shell/new-session/profile-status';

const LOGIN_KEYS: Readonly<Record<ClaudeInstallStatus['auth']['state'], TranslationKey>> = {
  logged_in: 'profiles.test.loggedIn',
  logged_out: 'profiles.test.loggedOut',
  unknown: 'profiles.test.unknown',
  error: 'profiles.test.loginError',
};

/**
 * Result of "Test profile" (`profile.test` → `claude --version` + `claude auth status` with this
 * profile's environment): version, program, sign-in (method, plan), time of the check. Never an
 * e-mail or organization (F.17 – the server does not send them).
 */
export function TestResult({ claude }: { claude: ClaudeInstallStatus }) {
  const { t, tError, format } = useI18n();
  const login =
    claude.auth.state === 'logged_in' && claude.auth.method !== null
      ? t('profiles.test.loggedInVia', { method: claude.auth.method })
      : t(LOGIN_KEYS[claude.auth.state]);
  return (
    <div
      role="status"
      data-slot="profile-test-result"
      data-state={claude.state}
      className="bg-muted/40 grid gap-1.5 rounded-md border px-3 py-2 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{t('profiles.test.title')}</span>
        <ProfileStatus claude={claude} className="text-xs" />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
        <dt className="text-muted-foreground">{t('profiles.test.version')}</dt>
        <dd className="font-mono" data-field="version">
          {claude.version ?? t('profiles.test.unknown')}
          {claude.versionStatus === 'too_old' ? (
            <span className="text-warning ml-2 font-sans">{t('profiles.test.tooOld')}</span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">{t('profiles.test.path')}</dt>
        <dd className="truncate font-mono" title={claude.path ?? undefined}>
          {claude.path ?? t('profiles.test.unknown')}
        </dd>
        <dt className="text-muted-foreground">{t('profiles.test.login')}</dt>
        <dd data-field="login">{login}</dd>
        {claude.auth.subscriptionType === null ? null : (
          <>
            <dt className="text-muted-foreground">{t('profiles.test.plan')}</dt>
            <dd data-field="plan">{claude.auth.subscriptionType}</dd>
          </>
        )}
        {claude.checkedAt === null ? null : (
          <>
            <dt className="text-muted-foreground">{t('profiles.test.checkedAt')}</dt>
            <dd>{format.dateTime(claude.checkedAt)}</dd>
          </>
        )}
      </dl>
      {claude.error === null ? null : <p className="text-destructive">{tError(claude.error)}</p>}
    </div>
  );
}
