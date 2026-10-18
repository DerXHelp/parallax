import {
  ArrowUpIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderSymlinkIcon,
  HardDriveIcon,
  HouseIcon,
  MonitorIcon,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { LIMITS } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { FsEntry, FsListing } from '@shared/model';
import { windowsPathIssue, windowsPathKey } from '@shared/paths';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@web/ui/dialog';
import { IconButton } from '@web/ui/icon-button';
import { Label } from '@web/ui/label';
import { Spinner } from '@web/ui/spinner';
import { Switch } from '@web/ui/switch';

/**
 * Folder browser (ADR-119, WP-36 requirement 2) over the host command `fs.listDirectory`: starts in
 * the given folder when it is a safe absolute path, else at the roots (drives + user folder).
 * Breadcrumbs, "Up" (`parent`), "This PC" (roots), "Show hidden folders"; Enter/double click opens
 * a folder, Backspace (or Alt+↑) goes up, arrows/Home/End/PageUp/PageDown move, typing jumps to a
 * name, Esc closes. "Choose this folder" hands over `listing.path` exactly as the server sent it.
 * The server decides what may be listed (unsafe paths, links, permissions) – its error codes are
 * shown inline. Used by "New session" and by the profile editor (`configDir`).
 */

export interface FolderBrowserProps {
  /** Start folder: used when it is a safe absolute path (`windowsPathIssue`), else the roots. */
  initialPath: string | null;
  onSelect: (path: string) => void;
  /** The trigger, e.g. a "Browse…" button (rendered as is; a click opens the dialog). */
  children: ReactElement;
  /** Start opened (playground). */
  defaultOpen?: boolean;
}

export function FolderBrowser({ initialPath, onSelect, children, defaultOpen = false }: FolderBrowserProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      {open ? (
        <FolderBrowserContent
          initialPath={initialPath}
          onChoose={(path) => {
            setOpen(false);
            onSelect(path);
          }}
          onCancel={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </Dialog>
  );
}

/** One step of the breadcrumb bar: label + the path to list. */
export interface Breadcrumb {
  label: string;
  path: string;
}

/**
 * Breadcrumbs of a listed folder: drive root, then one step per segment, in the separator style
 * of the path; the last step is exactly `path` (the server's spelling).
 */
export function breadcrumbs(path: string): Breadcrumb[] {
  const match = /^([A-Za-z]:)[\\/]*(.*)$/s.exec(path);
  if (match === null) return [{ label: path, path }];
  const separator = path.includes('\\') ? '\\' : '/';
  const root = `${match[1] ?? ''}${separator}`;
  const crumbs: Breadcrumb[] = [{ label: root, path: root }];
  let current = root;
  for (const segment of (match[2] ?? '').split(/[\\/]+/)) {
    if (segment === '') continue;
    current = current.endsWith(separator) ? `${current}${segment}` : `${current}${separator}${segment}`;
    crumbs.push({ label: segment, path: current });
  }
  const last = crumbs.at(-1);
  if (last !== undefined) last.path = path;
  return crumbs;
}

const KIND_ICON: Readonly<Record<FsEntry['kind'], LucideIcon>> = {
  drive: HardDriveIcon,
  home: HouseIcon,
  directory: FolderIcon,
  link: FolderSymlinkIcon,
};

/** Rows moved by PageUp/PageDown. */
const PAGE = 10;
/** Typed letters within this time form one search ("pro" → "projects"). */
const TYPEAHEAD_MS = 700;

interface LoadOptions {
  /** Entry to highlight in the new listing (the folder we came from when going up). */
  highlight?: string | null;
  /** On failure, list the roots instead (the start folder is gone). The error stays visible. */
  fallbackToRoots?: boolean;
  /** Keep the current error (fallback after a failed start). */
  keepError?: boolean;
  showHidden?: boolean;
  /** Move the focus into the list afterwards (navigation from a toolbar button). */
  focusList?: boolean;
}

function FolderBrowserContent({
  initialPath,
  onChoose,
  onCancel,
}: {
  initialPath: string | null;
  onChoose: (path: string) => void;
  onCancel: () => void;
}) {
  const { t, tError } = useI18n();
  const listId = useId();
  const hiddenId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const typeahead = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [active, setActive] = useState(0);

  const load = async (path: string | null, options: LoadOptions = {}): Promise<void> => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const result = await sendCommand(null, {
        name: 'fs.listDirectory',
        path,
        showHidden: options.showHidden ?? showHidden,
      });
      if (request !== requestRef.current) return;
      setListing(result);
      if (options.keepError !== true) setError(null);
      const highlight = options.highlight ?? null;
      const index =
        highlight === null
          ? -1
          : result.entries.findIndex((entry) => windowsPathKey(entry.path) === windowsPathKey(highlight));
      setActive(Math.max(0, index));
      setLoading(false);
      if (options.focusList === true) listRef.current?.focus();
    } catch (caught) {
      if (request !== requestRef.current) return;
      setError(errorPayloadOf(caught));
      setLoading(false);
      if (options.fallbackToRoots === true && path !== null) {
        await load(null, { keepError: true, showHidden: options.showHidden });
      }
    }
  };

  const loadStart = useEffectEvent(() => {
    const start = initialPath?.trim() ?? '';
    const safe = start !== '' && windowsPathIssue(start) === null;
    void load(safe ? start : null, { fallbackToRoots: true });
  });
  // Mount only: the dialog content is mounted anew for every opening.
  useEffect(() => {
    loadStart();
  }, []);

  const entries = listing?.entries ?? [];
  const current = listing?.path ?? null;
  const activeEntry = entries[active] ?? null;
  const atRoots = listing !== null && current === null;

  const openEntry = (entry: FsEntry) => {
    void load(entry.path);
  };

  const goUp = () => {
    if (listing === null || current === null) return;
    void load(listing.parent, { highlight: current, focusList: true });
  };

  const goRoots = () => {
    void load(null, { highlight: current === null ? null : (breadcrumbs(current)[0]?.path ?? null), focusList: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const last = entries.length - 1;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(last, active + 1);
        break;
      case 'ArrowUp':
        if (event.altKey) {
          event.preventDefault();
          goUp();
          return;
        }
        next = Math.max(0, active - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      case 'PageDown':
        next = Math.min(last, active + PAGE);
        break;
      case 'PageUp':
        next = Math.max(0, active - PAGE);
        break;
      case 'Enter':
        if (activeEntry === null) return;
        event.preventDefault();
        openEntry(activeEntry);
        return;
      case 'Backspace':
        event.preventDefault();
        goUp();
        return;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
          const now = Date.now();
          const previous = typeahead.current;
          const text = now - previous.at < TYPEAHEAD_MS ? previous.text + event.key : event.key;
          typeahead.current = { text, at: now };
          const query = text.toLowerCase();
          const order = [...entries.keys()].map((offset) => (active + (text.length === 1 ? 1 : 0) + offset) % entries.length);
          const found = order.find((index) => entries[index]?.name.toLowerCase().startsWith(query) === true);
          if (found !== undefined) {
            event.preventDefault();
            setActive(found);
          }
        }
        return;
    }
    if (entries.length === 0) return;
    event.preventDefault();
    setActive(next);
  };

  useEffect(() => {
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${String(active)}"]`);
    // happy-dom and old engines may lack scrollIntoView.
    if (typeof option?.scrollIntoView === 'function') option.scrollIntoView({ block: 'nearest' });
  }, [active, listing]);

  const crumbs = current === null ? [] : breadcrumbs(current);
  const listLabel = current === null ? t('newSession.browser.listRoots') : t('newSession.browser.list', { path: current });
  const optionId = (index: number) => `${listId}-option-${String(index)}`;

  return (
    <DialogContent
      data-slot="folder-browser"
      className="sm:max-w-xl"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        listRef.current?.focus();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('newSession.browser.title')}</DialogTitle>
        <DialogDescription>{t('newSession.browser.description')}</DialogDescription>
      </DialogHeader>

      <div className="flex min-w-0 items-center gap-1">
        <IconButton
          label={t('newSession.browser.up')}
          data-action="folder-up"
          disabled={listing === null || atRoots}
          onClick={goUp}
        >
          <ArrowUpIcon aria-hidden />
        </IconButton>
        <nav aria-label={t('newSession.browser.location')} className="min-w-0 flex-1 overflow-x-auto">
          <ol className="flex min-w-0 items-center gap-0.5 text-xs whitespace-nowrap">
            <li className="flex items-center">
              <Button
                variant="ghost"
                size="sm"
                data-action="folder-roots"
                aria-current={atRoots ? 'location' : undefined}
                onClick={goRoots}
              >
                <MonitorIcon aria-hidden />
                {t('newSession.browser.roots')}
              </Button>
            </li>
            {crumbs.map((crumb, index) => {
              const isCurrent = index === crumbs.length - 1;
              return (
                <li key={crumb.path} className="flex items-center gap-0.5">
                  <ChevronRightIcon aria-hidden className="text-muted-foreground size-3 shrink-0" />
                  <Button
                    variant="ghost"
                    size="sm"
                    data-crumb={crumb.path}
                    aria-current={isCurrent ? 'location' : undefined}
                    className={cn('max-w-48 font-mono', isCurrent && 'font-semibold')}
                    onClick={() => {
                      void load(crumb.path, { focusList: true });
                    }}
                  >
                    <span className="truncate">{crumb.label}</span>
                  </Button>
                </li>
              );
            })}
          </ol>
        </nav>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id={hiddenId}
          checked={showHidden}
          data-action="folder-show-hidden"
          onCheckedChange={(checked) => {
            setShowHidden(checked);
            void load(current, { showHidden: checked, highlight: activeEntry?.path ?? null });
          }}
        />
        <Label htmlFor={hiddenId} className="font-normal">
          {t('newSession.browser.showHidden')}
        </Label>
      </div>

      {error === null ? null : (
        <Alert tone="error" data-folder-error={error.code}>
          {tError(error)}
        </Alert>
      )}

      <div className="relative">
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={0}
          aria-label={listLabel}
          aria-busy={loading}
          aria-activedescendant={activeEntry === null ? undefined : optionId(active)}
          data-slot="folder-list"
          data-path={current ?? ''}
          onKeyDown={onKeyDown}
          className={cn(
            'focus-visible:ring-ring grid h-72 grid-cols-[minmax(0,1fr)] content-start gap-px overflow-y-auto rounded-md border p-1 outline-none focus-visible:ring-2',
            loading && 'opacity-60',
          )}
        >
          {entries.map((entry, index) => {
            const Icon = KIND_ICON[entry.kind];
            const isActive = index === active;
            return (
              <div
                key={entry.path}
                id={optionId(index)}
                role="option"
                aria-selected={isActive}
                data-index={index}
                data-path={entry.path}
                data-kind={entry.kind}
                onClick={() => {
                  setActive(index);
                  listRef.current?.focus();
                }}
                onDoubleClick={() => {
                  openEntry(entry);
                }}
                className={cn(
                  'flex min-w-0 cursor-default items-center gap-2 rounded-sm px-2 py-1 text-ui select-none',
                  isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                  entry.hidden && 'text-muted-foreground',
                )}
              >
                <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.kind === 'directory' ? null : (
                  <Badge variant="outline">{t(`newSession.browser.kinds.${entry.kind}`)}</Badge>
                )}
                {entry.hidden ? <Badge variant="outline">{t('newSession.browser.hidden')}</Badge> : null}
              </div>
            );
          })}
          {!loading && listing !== null && entries.length === 0 ? (
            <p role="presentation" className="text-muted-foreground px-2 py-6 text-center text-xs">
              {atRoots ? t('newSession.browser.emptyRoots') : t('newSession.browser.empty')}
            </p>
          ) : null}
        </div>
        {loading ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Spinner label={t('newSession.browser.loading')} className="size-4" />
          </div>
        ) : null}
      </div>
      {listing?.truncated === true ? (
        <p className="text-muted-foreground text-2xs" data-slot="folder-browser-truncated">
          {t('newSession.browser.truncated', { count: LIMITS.fsListMax })}
        </p>
      ) : null}

      <DialogFooter className="items-center sm:justify-between">
        <p className="text-muted-foreground min-w-0 truncate font-mono text-2xs" data-slot="folder-browser-current">
          {current ?? t('newSession.browser.nothingChosen')}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            data-action="choose-folder"
            disabled={current === null || loading}
            onClick={() => {
              if (current !== null) onChoose(current);
            }}
          >
            {t('newSession.browser.choose')}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  );
}
