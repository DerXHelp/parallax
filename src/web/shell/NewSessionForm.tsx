import { FolderOpenIcon, FolderSearchIcon, PlusIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { LOCAL_HOST_ID, makeSessionKey, type HostId, type ProfileId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { ProfileSummary } from '@shared/model';
import { windowsPathIssue, windowsPathKey } from '@shared/paths';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { shortPath } from '@web/lib/path-display';
import { STORAGE_KEYS, readStorage, writeStorage } from '@web/lib/storage';
import { errorPayloadOf } from '@web/state/connection';
import { useConnectionStatus, useHostState, useSelectedSession, useSummaries } from '@web/state/hooks';
import { sendHostCommand, useHostLabels, type HostLabels } from '@web/state/hosts';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { Spinner } from '@web/ui/spinner';
import { HostSelect } from './hosts/HostSelect';
import { FolderBrowser } from './new-session/FolderBrowser';
import { LoginButton, needsSignIn } from './login/LoginButton';
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
 * WP-80: the computer "New session" starts on – the pre-filled one, else the last used one, as long
 * as it is still part of the window; else this computer.
 */
export function initialHost(hosts: HostLabels, prefill: HostId | undefined): HostId {
  const known = (hostId: string | null | undefined): hostId is HostId =>
    hostId === LOCAL_HOST_ID || (typeof hostId === 'string' && hosts.get(hostId) !== undefined);
  if (known(prefill)) return prefill;
  const last = readStorage('local', STORAGE_KEYS.newSessionHost);
  return known(last) ? last : LOCAL_HOST_ID;
}

/**
 * "New session" (Plan "Neue Session", WP-36): project folder (typed, from the recent projects or
 * the folder browser) and profile (default pre-selected; profiles with error findings cannot be
 * picked) → `session.create {cwd, profileId}` with an explicit profile. Without a first prompt the
 * server creates a sleeping entry; the first message in the composer starts it. The new session
 * is selected and its message field focused. Unsafe paths (UNC, device, ADS …) are rejected
 * before sending (`@shared/paths`); server errors (CWD_NOT_FOUND …) are shown translated.
 * WP-80 (WP-75 §4.4): with other computers the computer comes first (last used pre-selected);
 * folder browser, profiles, default profile and recent folders come from it; switching the computer
 * clears a folder that came from the other one; the session key carries the chosen computer.
 */
export function NewSessionForm({
  initialCwd = '',
  initialProfileId,
  initialHostId,
  onCreated,
}: {
  initialCwd?: string;
  /** WP-80: pre-chosen computer ("New session here" of another computer); default: the last used one. */
  initialHostId?: HostId;
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
  const hostLabelId = useId();
  const hostHintId = useId();
  const hosts = useHostLabels();
  const [hostId, setHostId] = useState<HostId>(() => initialHost(hosts, initialHostId));
  const [cwd, setCwdValue] = useState(initialCwd);
  /** Computer the folder in the field belongs to (a switch clears a folder of the other one). */
  const [cwdHost, setCwdHost] = useState<HostId>(hostId);
  const [choice, setChoice] = useState<ProfileId | null>(initialProfileId ?? null);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [pending, setPending] = useState(false);
  const [, select] = useSelectedSession();
  const entries = useSummaries();
  const hostState = useHostState(hostId);
  const host = hosts.get(hostId);
  const hostUsable = host === undefined || host.availability === 'available';
  const online = useConnectionStatus(hostId) === 'open' && hostUsable;
  const setCwd = (value: string) => {
    setCwdValue(value);
    setCwdHost(hostId);
  };
  const chooseHost = (next: HostId) => {
    if (next === hostId) return;
    setHostId(next);
    // Profiles belong to a computer: its default applies again.
    setChoice(null);
    setError(null);
    if (cwd.trim() !== '' && cwdHost !== next) setCwdValue('');
    setCwdHost(next);
  };
  const recent = useMemo(
    () => recentProjects(entries.filter((entry) => entry.hostId === hostId)),
    [entries, hostId],
  );
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
      const result = await sendHostCommand(hostId, {
        name: 'session.create',
        cwd: value,
        profileId: profile.id,
      });
      const sessionKey = makeSessionKey(hostId, result.entryId);
      writeStorage('local', STORAGE_KEYS.newSessionHost, hostId === LOCAL_HOST_ID ? null : hostId);
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
  if (defaults.model !== null)
    defaultParts.push(t('newSession.profile.defaultModel', { model: defaults.model }));
  if (defaults.permissionMode !== null) {
    defaultParts.push(
      t('newSession.profile.defaultMode', { mode: t(`shell.permissionMode.${defaults.permissionMode}`) }),
    );
  }
  if (defaults.effort !== null) {
    defaultParts.push(
      t('newSession.profile.defaultEffort', { effort: t(`newSession.efforts.${defaults.effort}`) }),
    );
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
      {hosts.list.length === 0 ? null : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5" data-slot="new-session-host">
          <Label id={hostLabelId}>{t('hosts.newSession.host')}</Label>
          <HostSelect
            hosts={hosts.list}
            value={hostId}
            labelId={hostLabelId}
            describedBy={hostHintId}
            onValueChange={chooseHost}
          />
          <p id={hostHintId} className="text-muted-foreground text-2xs">
            {host === undefined || hostUsable
              ? t('hosts.newSession.hostHint')
              : t('hosts.newSession.unavailable', {
                  name: host.name,
                  status: t(`hosts.status.${host.availability}`),
                })}
          </p>
        </div>
      )}
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
            key={hostId}
            hostId={hostId}
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
          {profile !== null && needsSignIn(profile.claude) ? (
            host === undefined ? (
              <LoginButton profileId={profile.id} className="justify-self-start" />
            ) : (
              // WP-80: signing in runs on the other computer's desktop – never from here (ADR-208).
              <p data-slot="sign-in-there" className="text-warning text-2xs">
                {t('hosts.newSession.signInThere', { name: host.name })}
              </p>
            )
          ) : null}
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
