import { FolderOpenIcon, PlusIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import { windowsPathIssue, windowsPathKey } from '@shared/paths';
import { useI18n } from '@web/i18n';
import { shortPath } from '@web/lib/path-display';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useConnectionStatus, useSelectedSession, useSummaries } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { Spinner } from '@web/ui/spinner';

const RECENT_PROJECTS = 5;
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

/** Up to five distinct folders of the existing sessions, most recent activity first (case-insensitive). */
export function recentProjects(
  entries: readonly { summary: { cwd: string; lastActivityAt: string } }[],
  limit = RECENT_PROJECTS,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const sorted = [...entries].sort(
    (a, b) => Date.parse(b.summary.lastActivityAt) - Date.parse(a.summary.lastActivityAt),
  );
  for (const { summary } of sorted) {
    const key = windowsPathKey(summary.cwd);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(summary.cwd);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * "New session", Phase-1 minimum (Plan "Neue Session", B "Empty State mit zuletzt genutzten
 * Projekten"): folder path as text + the recent projects (derived from the sessions – the
 * contract has no separate list) → `session.create {cwd}`. Without a first prompt the server
 * creates a sleeping entry; the first message in the composer starts it. The new session is
 * selected and its message field focused. Unsafe paths (UNC, device, ADS …) are rejected before
 * sending (`@shared/paths`); server errors (CWD_NOT_FOUND …) are shown translated. Folder browser
 * and profile choice: Phase 2.
 */
export function NewSessionForm({
  initialCwd = '',
  onCreated,
}: {
  initialCwd?: string;
  /** After the session was created and selected (e.g. close the dialog). */
  onCreated?: (sessionKey: string) => void;
}) {
  const { t, tError } = useI18n();
  const inputId = useId();
  const hintId = useId();
  const [cwd, setCwd] = useState(initialCwd);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [pending, setPending] = useState(false);
  const [, select] = useSelectedSession();
  const entries = useSummaries();
  const online = useConnectionStatus() === 'open';
  const recent = useMemo(() => recentProjects(entries), [entries]);

  const submit = async () => {
    const value = cwd.trim();
    if (value === '' || pending) return;
    const issue = windowsPathIssue(value);
    if (issue !== null) {
      setError(makeError('PATH_REJECTED', { reason: issue }));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await sendCommand(null, { name: 'session.create', cwd: value });
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

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      data-slot="new-session-form"
      className="grid w-full max-w-md gap-2"
      aria-label={t('shell.newSession.title')}
    >
      <Label htmlFor={inputId}>{t('shell.newSession.cwdLabel')}</Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          name="cwd"
          value={cwd}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('shell.newSession.cwdPlaceholder')}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={hintId}
          className="font-mono text-xs"
          onChange={(event) => {
            setCwd(event.target.value);
            setError(null);
          }}
        />
        <Button type="submit" disabled={pending || !online || cwd.trim() === ''}>
          {pending ? <Spinner label={t('shell.newSession.starting')} /> : <PlusIcon aria-hidden />}
          {pending ? t('shell.newSession.starting') : t('shell.newSession.submit')}
        </Button>
      </div>
      <p id={hintId} className="text-muted-foreground text-2xs">
        {t('shell.newSession.hint')}
      </p>
      {error === null ? null : <Alert tone="error">{tError(error)}</Alert>}
      {recent.length === 0 ? null : (
        <div className="mt-2 grid gap-1">
          <span className="text-muted-foreground text-2xs font-medium tracking-wide uppercase">
            {t('shell.empty.recentProjects')}
          </span>
          <ul className="grid gap-px" aria-label={t('shell.empty.recentProjects')}>
            {recent.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  title={path}
                  data-recent-project={path}
                  onClick={() => {
                    setCwd(path);
                    setError(null);
                  }}
                  className="hover:bg-accent focus-visible:ring-ring flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-xs outline-none focus-visible:ring-2"
                >
                  <FolderOpenIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="truncate font-mono text-2xs">{shortPath(path, 3)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
