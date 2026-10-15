import { FolderOpenIcon, LayersIcon, PlayIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import { windowsPathIssue } from '@shared/paths';
import { PRODUCT_NAME } from '@shared/product';
import { useI18n } from '@web/i18n';
import { pathTail } from '@web/lib/path-display';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useSelectedSession, useSummaries } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { Spinner } from '@web/ui/spinner';

const RECENT_PROJECTS = 5;

/**
 * Minimal "new session" (Phase 1): folder + start. `session.create` without a first prompt
 * creates a sleeping entry; the composer (WP-16) sends the first prompt. The full dialog with
 * folder browser and profile choice follows in Phase 2.
 */
export function NewSessionForm({ initialCwd = '' }: { initialCwd?: string }) {
  const { t, tError } = useI18n();
  const inputId = useId();
  const [cwd, setCwd] = useState(initialCwd);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [pending, setPending] = useState(false);
  const [, select] = useSelectedSession();
  const entries = useSummaries();
  const recent = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    const sorted = [...entries].sort(
      (a, b) => Date.parse(b.summary.lastActivityAt) - Date.parse(a.summary.lastActivityAt),
    );
    for (const { summary } of sorted) {
      const key = summary.cwd.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(summary.cwd);
      if (result.length >= RECENT_PROJECTS) break;
    }
    return result;
  }, [entries]);

  const submit = async () => {
    const value = cwd.trim();
    if (value === '') return;
    const issue = windowsPathIssue(value);
    if (issue !== null) {
      setError(makeError('PATH_REJECTED', { reason: issue }));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await sendCommand(null, { name: 'session.create', cwd: value });
      select(makeSessionKey(LOCAL_HOST_ID, result.entryId));
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
      className="grid w-full max-w-md gap-2"
      aria-label={t('shell.newSession.title')}
    >
      <Label htmlFor={inputId}>{t('shell.newSession.cwdLabel')}</Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={cwd}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('shell.newSession.cwdPlaceholder')}
          aria-invalid={error === null ? undefined : true}
          className="font-mono text-xs"
          onChange={(event) => {
            setCwd(event.target.value);
            setError(null);
          }}
        />
        <Button type="submit" disabled={pending || cwd.trim() === ''}>
          {pending ? <Spinner label={t('shell.newSession.starting')} /> : <PlayIcon aria-hidden />}
          {pending ? t('shell.newSession.starting') : t('shell.newSession.submit')}
        </Button>
      </div>
      {error === null ? null : <Alert tone="error">{tError(error)}</Alert>}
      {recent.length === 0 ? null : (
        <div className="mt-2 grid gap-1">
          <span className="text-muted-foreground text-2xs font-medium tracking-wide uppercase">
            {t('shell.empty.recentProjects')}
          </span>
          <ul className="grid gap-px">
            {recent.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  title={path}
                  onClick={() => {
                    setCwd(path);
                    setError(null);
                  }}
                  className="hover:bg-accent focus-visible:ring-ring flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-xs outline-none focus-visible:ring-2"
                >
                  <FolderOpenIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="truncate font-mono text-2xs">{pathTail(path, 3)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}

/** Right side without a selected session: welcome (no sessions yet) or "pick a session". */
export function EmptyState() {
  const { t } = useI18n();
  const entries = useSummaries();
  const hasSessions = entries.some((entry) => !entry.summary.archived);
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto p-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <LayersIcon aria-hidden className="text-brand size-8" />
        <h1 className="text-base font-semibold">
          {hasSessions ? t('shell.empty.title') : t('shell.empty.welcomeTitle', { product: PRODUCT_NAME })}
        </h1>
        <p className="text-muted-foreground max-w-sm text-xs">
          {hasSessions ? t('shell.empty.description') : t('shell.empty.welcomeDescription')}
        </p>
      </div>
      <NewSessionForm />
    </div>
  );
}
