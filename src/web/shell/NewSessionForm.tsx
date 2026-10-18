import { FolderOpenIcon, FolderSearchIcon, PlusIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { LOCAL_HOST_ID, makeSessionKey, type ProfileId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { ProfileSummary } from '@shared/model';
import { windowsPathIssue, windowsPathKey } from '@shared/paths';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { shortPath } from '@web/lib/path-display';
import { errorPayloadOf } from '@web/state/connection';
import {
  sendCommand,
  useConnectionStatus,
  useHostState,
  useSelectedSession,
  useSummaries,
} from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { Spinner } from '@web/ui/spinner';
import { FolderBrowser } from './new-session/FolderBrowser';
import { ProfileIssueText, profileErrors } from './new-session/profile-status';
import { ProfileSelect } from './new-session/ProfileSelect';
import { filterRecentProjects, recentProjects } from './new-session/recent-projects';

/** Frames to wait for the new session's pane before giving up on focusing its message field. */
const FOCUS_FRAMES = 20;

/**
 * Moves the focus into the message field of a session pane once it is rendered (after "Create
 * session" – a user action, so no focus stealing). The pane is `[data-session-key]`
 * (SessionPane); its first text area is the composer slot.
 */
export function focusSessionInput(sessionKey: string, frames = FOCUS_FRAMES): void {
  const attempt = (left: number) => {
    const pane = document.querySelector(`[data-session-key="${sessionKey}"]`);
    const input = pane?.querySelector<HTMLTextAreaElement>('textarea:not([disabled])');
    if (input !== null && input !== undefined) {
      input.focus();
      return;
    }
    if (left > 0) {
      requestAnimationFrame(() => {
        attempt(left - 1);
      });
    }
  };
  requestAnimationFrame(() => {
    attempt(frames);
  });
}

/**
 * A recent project's path in one line (V3-01): the parent part gives way first (ellipsis), the
 * folder name stays visible as long as it fits; the full path is in the button's `title`.
 */
function ProjectPath({ path }: { path: string }) {
  const short = shortPath(path, 3);
  const cut = Math.max(short.lastIndexOf('\\'), short.lastIndexOf('/'));
  const head = short.slice(0, cut + 1);
  const name = short.slice(cut + 1);
  return (
    <>
      {/* Two flex parts would read as two words: the name for assistive tech is the plain text. */}
      <span aria-hidden className="flex min-w-0 font-mono text-2xs">
        <span className="min-w-0 truncate">{head}</span>
        <span className="max-w-full shrink-0 truncate">{name}</span>
      </span>
      <span className="sr-only">{short}</span>
    </>
  );
}

/**
 * The profile shown as chosen: the explicit choice (or the pre-filled one) if it still exists,
 * else the host's default profile (Plan "Claude-Profile": the default is always pre-selected).
 */
export function chosenProfile(
  profiles: readonly ProfileSummary[],
  choice: ProfileId | null,
  defaultProfileId: ProfileId | null,
): ProfileSummary | null {
  return (
    profiles.find((profile) => profile.id === choice) ??
    profiles.find((profile) => profile.id === defaultProfileId) ??
    profiles[0] ??
    null
  );
}

/**
 * "New session" (Plan "Neue Session", WP-36): project folder (typed, from the recent projects or
 * the folder browser) and profile (default pre-selected; profiles with error findings cannot be
 * picked) → `session.create {cwd, profileId}` with an explicit profile. Without a first prompt the
 * server creates a sleeping entry; the first message in the composer starts it. The new session
 * is selected and its message field focused. Unsafe paths (UNC, device, ADS …) are rejected
 * before sending (`@shared/paths`); server errors (CWD_NOT_FOUND …) are shown translated.
 */
export function NewSessionForm({
  initialCwd = '',
  initialProfileId,
  onCreated,
}: {
  initialCwd?: string;
  /** Pre-selected profile ("New session in this project…"); default: the host's default profile. */
  initialProfileId?: ProfileId;
  /** After the session was created and selected (e.g. close the dialog). */
  onCreated?: (sessionKey: string) => void;
}) {
  const { t, tError } = useI18n();
  const inputId = useId();
  const hintId = useId();
  const profileId = useId();
  const profileLabelId = useId();
  const profileHintId = useId();
  const [cwd, setCwd] = useState(initialCwd);
  const [choice, setChoice] = useState<ProfileId | null>(initialProfileId ?? null);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [pending, setPending] = useState(false);
  const [, select] = useSelectedSession();
  const entries = useSummaries();
  const hostState = useHostState();
  const online = useConnectionStatus() === 'open';
  const recent = useMemo(() => recentProjects(entries), [entries]);
  const shownRecent = useMemo(() => filterRecentProjects(recent, cwd), [recent, cwd]);
  const profiles = hostState?.profiles ?? [];
  const profile = chosenProfile(profiles, choice, hostState?.defaultProfileId ?? null);
  const blocking = profile === null ? [] : profileErrors(profile);
  const cwdKey = windowsPathKey(cwd.trim());

  const submit = async () => {
    const value = cwd.trim();
    if (value === '' || pending || profile === null || blocking.length > 0) return;
    const issue = windowsPathIssue(value);
    if (issue !== null) {
      setError(makeError('PATH_REJECTED', { reason: issue }));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await sendCommand(null, { name: 'session.create', cwd: value, profileId: profile.id });
      const sessionKey = makeSessionKey(LOCAL_HOST_ID, result.entryId);
      select(sessionKey);
      setCwd('');
      onCreated?.(sessionKey);
      focusSessionInput(sessionKey);
    } catch (caught) {
      setError(errorPayloadOf(caught));
    } finally {
      setPending(false);
    }
  };

  const defaults = profile?.defaults ?? { model: null, permissionMode: null, effort: null };
  const defaultParts: string[] = [];
  if (defaults.model !== null) defaultParts.push(t('newSession.profile.defaultModel', { model: defaults.model }));
  if (defaults.permissionMode !== null) {
    defaultParts.push(
      t('newSession.profile.defaultMode', { mode: t(`shell.permissionMode.${defaults.permissionMode}`) }),
    );
  }
  if (defaults.effort !== null) {
    defaultParts.push(t('newSession.profile.defaultEffort', { effort: t(`newSession.efforts.${defaults.effort}`) }));
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      data-slot="new-session-form"
      // One column that never grows with long paths (V3-01): they end with an ellipsis instead.
      className="grid w-full max-w-md grid-cols-[minmax(0,1fr)] gap-4"
      aria-label={t('newSession.title')}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
        <Label htmlFor={inputId}>{t('newSession.cwd.label')}</Label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            name="cwd"
            value={cwd}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('newSession.cwd.placeholder')}
            aria-invalid={error === null ? undefined : true}
            aria-describedby={hintId}
            className="font-mono text-xs"
            onChange={(event) => {
              setCwd(event.target.value);
              setError(null);
            }}
          />
          <FolderBrowser
            initialPath={cwd}
            onSelect={(path) => {
              setCwd(path);
              setError(null);
            }}
          >
            <Button variant="outline" data-action="browse-folder">
              <FolderSearchIcon aria-hidden />
              {t('newSession.cwd.browse')}
            </Button>
          </FolderBrowser>
        </div>
        <p id={hintId} className="text-muted-foreground text-2xs">
          {t('newSession.cwd.hint')}
        </p>
      </div>

      {shownRecent.length === 0 ? null : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1" data-slot="recent-projects">
          <span className="text-muted-foreground text-2xs font-medium tracking-wide uppercase">
            {t('newSession.recent.label')}
          </span>
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-px" aria-label={t('newSession.recent.label')}>
            {shownRecent.map((path) => {
              const current = windowsPathKey(path) === cwdKey;
              return (
                <li key={path}>
                  <button
                    type="button"
                    title={path}
                    data-recent-project={path}
                    aria-pressed={current}
                    onClick={() => {
                      setCwd(path);
                      setError(null);
                    }}
                    className={cn(
                      'hover:bg-accent focus-visible:ring-ring flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-xs outline-none focus-visible:ring-2',
                      current && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <FolderOpenIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                    <ProjectPath path={path} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
        <Label id={profileLabelId} htmlFor={profileId}>
          {t('newSession.profile.label')}
        </Label>
        <ProfileSelect
          id={profileId}
          labelId={profileLabelId}
          describedBy={defaultParts.length > 0 || blocking.length > 0 ? profileHintId : undefined}
          profiles={profiles}
          value={profile?.id ?? null}
          onValueChange={setChoice}
        />
        <div id={profileHintId} className="grid grid-cols-[minmax(0,1fr)] gap-1">
          {defaultParts.length === 0 ? null : (
            <p className="text-muted-foreground text-2xs">
              {t('newSession.profile.defaults', { list: defaultParts.join(' · ') })}
            </p>
          )}
          {blocking.length === 0 ? null : (
            <Alert tone="error" title={t('newSession.profile.unusable')} data-slot="profile-unusable">
              <span className="grid gap-1">
                {blocking.map((finding, index) => (
                  <ProfileIssueText key={`${finding.issue.code}-${String(index)}`} finding={finding} />
                ))}
              </span>
            </Alert>
          )}
        </div>
      </div>

      {error === null ? null : <Alert tone="error">{tError(error)}</Alert>}

      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={pending || !online || cwd.trim() === '' || profile === null || blocking.length > 0}
        >
          {pending ? <Spinner label={t('newSession.creating')} /> : <PlusIcon aria-hidden />}
          {pending ? t('newSession.creating') : t('newSession.submit')}
        </Button>
      </div>
    </form>
  );
}
