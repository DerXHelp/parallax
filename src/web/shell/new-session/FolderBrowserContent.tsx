import {
  ArrowUpIcon,
  CheckIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
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
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { LIMITS, LOCAL_HOST_ID, type HostId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { FsEntry, FsListing } from '@shared/model';
import {
  NAME_MAX_CHARS,
  windowsNameIssue,
  windowsPathIssue,
  windowsPathKey,
  type PathIssue,
} from '@shared/paths';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { splitPathTail } from '@web/lib/path-display';
import { errorPayloadOf } from '@web/state/connection';
import { sendHostCommand } from '@web/state/hosts';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@web/ui/dialog';
import { IconButton } from '@web/ui/icon-button';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { Spinner } from '@web/ui/spinner';
import { Switch } from '@web/ui/switch';

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

/** Comparison key of an open folder (null = the roots). */
function openKey(path: string | null): string {
  return path === null ? '' : windowsPathKey(path);
}

/** Text of a name the server would reject (`windowsNameIssue`; an empty name is never shown). */
function nameIssueKey(issue: PathIssue): 'tooLong' | 'invalidChar' | 'dots' | 'trailingDot' | 'reserved' {
  switch (issue) {
    case 'too_long':
      return 'tooLong';
    case 'dot_segment':
      return 'dots';
    case 'trailing_dot_or_space':
      return 'trailingDot';
    case 'reserved_name':
      return 'reserved';
    default:
      return 'invalidChar';
  }
}

/** Rows moved by PageUp/PageDown. */
const PAGE = 10;
/** Typed letters within this time form one search ("pro" → "projects"). */
const TYPEAHEAD_MS = 700;

interface LoadOptions {
  /** Entry to highlight in the new listing (the folder we came from when going up). */
  highlight?: string | null;
  /** WP-94: the highlighted entry is also selected ("Choose" takes it) – a new folder. */
  select?: boolean;
  /** On failure, list the roots instead (the start folder is gone). The error stays visible. */
  fallbackToRoots?: boolean;
  /** Keep the current error (fallback after a failed start). */
  keepError?: boolean;
  showHidden?: boolean;
  /** Move the focus into the list afterwards (navigation from a toolbar button). */
  focusList?: boolean;
}

/**
 * The content of the folder browser dialog (`FolderBrowser.tsx`): a lazy chunk – it loads when the
 * dialog opens, not with the start chunk (bundle budget `scripts/bundle-budget.ts`, WP-64).
 */
export default function FolderBrowserContent({
  initialPath,
  hostId = LOCAL_HOST_ID,
  onChoose,
  onCancel,
}: {
  initialPath: string | null;
  /** WP-80: the computer whose folders are listed (host command over its connection). */
  hostId?: HostId;
  onChoose: (path: string) => void;
  onCancel: () => void;
}) {
  const { t, tError } = useI18n();
  const listId = useId();
  const hiddenId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLElement>(null);
  const requestRef = useRef(0);
  const typeahead = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [active, setActive] = useState(0);
  // WP-94: the active row is also SELECTED – "Choose" takes it instead of the open folder. A
  // listing starts without a selection (the open folder is the choice).
  const [selected, setSelected] = useState(false);
  // WP-94: "New folder" – the name field below the toolbar (null = closed).
  const [newName, setNewName] = useState<string | null>(null);
  const [createError, setCreateError] = useState<ErrorPayload | null>(null);
  const [creating, setCreating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const newFolderId = useId();
  const nameHintId = useId();
  /** The open folder of the last listing (also read after an await, WP-94). */
  const openRef = useRef<string | null>(null);

  /** Lists `path`; true when the listing came and holds `options.highlight` (if given). */
  const load = async (path: string | null, options: LoadOptions = {}): Promise<boolean> => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const result = await sendHostCommand(hostId, {
        name: 'fs.listDirectory',
        path,
        showHidden: options.showHidden ?? showHidden,
      });
      if (request !== requestRef.current) return false;
      // The name field belongs to the folder it was opened in.
      if (openKey(result.path) !== openKey(openRef.current)) {
        setNewName(null);
        setCreateError(null);
      }
      openRef.current = result.path;
      setListing(result);
      if (options.keepError !== true) setError(null);
      const highlight = options.highlight ?? null;
      const index =
        highlight === null
          ? -1
          : result.entries.findIndex((entry) => windowsPathKey(entry.path) === windowsPathKey(highlight));
      setActive(Math.max(0, index));
      setSelected(options.select === true && index >= 0);
      setLoading(false);
      if (options.focusList === true) listRef.current?.focus();
      return highlight === null || index >= 0;
    } catch (caught) {
      if (request !== requestRef.current) return false;
      setError(errorPayloadOf(caught));
      setLoading(false);
      if (options.fallbackToRoots === true && path !== null) {
        await load(null, { keepError: true, showHidden: options.showHidden });
      }
      return false;
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
  /** What "Choose this folder" takes: the selected entry, else the open folder (null at the roots). */
  const target = selected && activeEntry !== null ? activeEntry.path : current;

  const openEntry = (entry: FsEntry) => {
    void load(entry.path);
  };

  /** A click or a keyboard move selects what it lands on (selection follows the cursor, like Explorer). */
  const moveTo = (index: number) => {
    setActive(index);
    setSelected(true);
  };

  const trimmedName = newName?.trim() ?? '';
  const nameIssue = trimmedName === '' ? null : windowsNameIssue(trimmedName);

  const closeNewFolder = () => {
    setNewName(null);
    setCreateError(null);
  };

  /** Creates the named folder in the open one, then lists it there selected (WP-94). */
  const createFolder = async () => {
    if (current === null || trimmedName === '' || nameIssue !== null || creating) return;
    const parent = current;
    setCreating(true);
    setCreateError(null);
    let created: string;
    try {
      created = (
        await sendHostCommand(hostId, { name: 'fs.createDirectory', parent, folderName: trimmedName })
      ).path;
    } catch (caught) {
      setCreateError(errorPayloadOf(caught));
      setCreating(false);
      nameRef.current?.focus();
      return;
    }
    setCreating(false);
    setNewName(null);
    // The user went elsewhere while it was created: leave them there.
    if (openKey(openRef.current) !== openKey(parent)) return;
    // A dot name is hidden: show hidden folders so the new one can be selected.
    const reveal = trimmedName.startsWith('.') && !showHidden;
    if (reveal) setShowHidden(true);
    const shown = await load(parent, {
      highlight: created,
      select: true,
      focusList: true,
      showHidden: showHidden || reveal,
    });
    // Not in the listing (a system name the server hides, beyond the truncation): open the new
    // folder instead – "Choose this folder" takes it either way.
    if (!shown) await load(created, { focusList: true });
  };

  const goUp = () => {
    if (listing === null || current === null) return;
    void load(listing.parent, { highlight: current, focusList: true });
  };

  const goRoots = () => {
    void load(null, {
      highlight: current === null ? null : (breadcrumbs(current)[0]?.path ?? null),
      focusList: true,
    });
  };

  /** Type-ahead: typed letters within TYPEAHEAD_MS jump to the next name starting with them. */
  const typeAhead = (key: string): boolean => {
    const now = Date.now();
    const previous = typeahead.current;
    const text = now - previous.at < TYPEAHEAD_MS ? previous.text + key : key;
    typeahead.current = { text, at: now };
    const query = text.toLowerCase();
    const order = [...entries.keys()].map(
      (offset) => (active + (text.length === 1 ? 1 : 0) + offset) % entries.length,
    );
    const found = order.find((index) => entries[index]?.name.toLowerCase().startsWith(query) === true);
    if (found === undefined) return false;
    moveTo(found);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const last = entries.length - 1;
    let next: number | null = null;
    switch (event.key) {
      // Without a selection the first ↓/↑ selects the cursor row: after a mouse click the cursor
      // is not drawn, and moving would skip the row the user sees first.
      case 'ArrowDown':
        next = selected ? Math.min(last, active + 1) : active;
        break;
      case 'ArrowUp':
        if (event.altKey) {
          event.preventDefault();
          goUp();
          return;
        }
        next = selected ? Math.max(0, active - 1) : active;
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
      case ' ':
        if (activeEntry === null) return;
        event.preventDefault();
        // Within a type-ahead search ("my p…") Space is part of the name.
        if (typeahead.current.text !== '' && Date.now() - typeahead.current.at < TYPEAHEAD_MS) {
          typeAhead(' ');
          return;
        }
        // Otherwise it selects the cursor row or drops the selection (then the open folder is chosen).
        setSelected((value) => !value);
        return;
      case 'Backspace':
        event.preventDefault();
        goUp();
        return;
      default:
        if (
          event.key.length === 1 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          typeAhead(event.key)
        ) {
          event.preventDefault();
        }
        return;
    }
    if (entries.length === 0) return;
    event.preventDefault();
    moveTo(next);
  };

  useEffect(() => {
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${String(active)}"]`);
    // happy-dom and old engines may lack scrollIntoView.
    if (typeof option?.scrollIntoView === 'function') option.scrollIntoView({ block: 'nearest' });
  }, [active, listing]);

  // V3-01: a long path scrolls the breadcrumb bar – keep its end (the open folder) in view, also
  // when the language (the width of "This PC") changes.
  useLayoutEffect(() => {
    const bar = crumbsRef.current;
    if (bar !== null) bar.scrollLeft = bar.scrollWidth;
  }, [current, t]);

  const crumbs = current === null ? [] : breadcrumbs(current);
  const listLabel =
    current === null ? t('newSession.browser.listRoots') : t('newSession.browser.list', { path: current });
  const optionId = (index: number) => `${listId}-option-${String(index)}`;
  // The whole path split before its last name (`splitPathTail` with every segment).
  const footerPath = target === null ? null : splitPathTail(target, Number.MAX_SAFE_INTEGER);

  return (
    <DialogContent
      data-slot="folder-browser"
      className="sm:max-w-xl"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        listRef.current?.focus();
      }}
      onEscapeKeyDown={(event) => {
        // Esc while the name field is open closes only the field; Esc of an IME ends the composition.
        if (newName === null || current === null) return;
        event.preventDefault();
        if (event.isComposing) return;
        closeNewFolder();
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
        <nav
          ref={crumbsRef}
          aria-label={t('newSession.browser.location')}
          data-slot="folder-breadcrumbs"
          className="min-w-0 flex-1 overflow-x-auto"
        >
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
        <IconButton
          label={t('newSession.browser.newFolder')}
          data-action="folder-new"
          disabled={current === null}
          aria-expanded={newName !== null}
          aria-controls={newName === null ? undefined : newFolderId}
          onClick={() => {
            // Already open: back into the field (autoFocus works only when it appears).
            if (newName !== null) {
              nameRef.current?.focus();
              return;
            }
            setCreateError(null);
            setNewName('');
          }}
        >
          <FolderPlusIcon aria-hidden />
        </IconButton>
      </div>

      {newName === null || current === null ? null : (
        <div id={newFolderId} data-slot="folder-new" className="grid">
          <div className="flex items-center gap-2">
            <FolderPlusIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
            <Input
              ref={nameRef}
              // The field opens on a click of "New folder" – the user wants to type now.
              autoFocus
              name="folder-name"
              value={newName}
              spellCheck={false}
              autoComplete="off"
              aria-label={t('newSession.browser.newFolderName', { path: current })}
              aria-invalid={nameIssue !== null}
              aria-describedby={nameHintId}
              placeholder={t('newSession.browser.newFolderPlaceholder')}
              onChange={(event) => {
                setNewName(event.target.value);
                setCreateError(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void createFolder();
              }}
            />
            <Button
              size="sm"
              data-action="folder-create"
              disabled={trimmedName === '' || nameIssue !== null || creating}
              onClick={() => {
                void createFolder();
              }}
            >
              {t('newSession.browser.create')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                closeNewFolder();
                listRef.current?.focus();
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
          {/* Always there while the field is open, so a hint appearing while typing is announced. */}
          <p
            id={nameHintId}
            aria-live="polite"
            className="text-destructive text-2xs not-empty:pt-1.5"
            data-name-issue={nameIssue ?? undefined}
          >
            {nameIssue === null
              ? null
              : t(`newSession.browser.nameIssues.${nameIssueKey(nameIssue)}`, { count: NAME_MAX_CHARS })}
          </p>
          {createError === null ? null : (
            <Alert tone="error" className="mt-1.5" data-folder-create-error={createError.code}>
              {tError(createError)}
            </Alert>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Switch
          id={hiddenId}
          checked={showHidden}
          data-action="folder-show-hidden"
          onCheckedChange={(checked) => {
            setShowHidden(checked);
            void load(current, {
              showHidden: checked,
              highlight: activeEntry?.path ?? null,
              select: selected,
            });
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
          onClick={(event) => {
            // A click on the empty area drops the selection: the open folder is the choice again.
            if (event.target === event.currentTarget) setSelected(false);
          }}
          className={cn(
            'group focus-visible:ring-ring grid h-72 grid-cols-[minmax(0,1fr)] content-start gap-px overflow-y-auto rounded-md border p-1 outline-none focus-visible:ring-2',
            loading && 'opacity-60',
          )}
        >
          {entries.map((entry, index) => {
            const Icon = KIND_ICON[entry.kind];
            const isActive = index === active;
            const isSelected = isActive && selected;
            return (
              <div
                key={entry.path}
                id={optionId(index)}
                role="option"
                aria-selected={isSelected}
                data-index={index}
                data-path={entry.path}
                data-kind={entry.kind}
                onClick={() => {
                  moveTo(index);
                  listRef.current?.focus();
                }}
                onDoubleClick={() => {
                  openEntry(entry);
                }}
                className={cn(
                  'flex min-w-0 cursor-default items-center gap-2 rounded-sm px-2 py-1 text-ui select-none',
                  isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                  // The keyboard cursor on an unselected row (only while the list has keyboard focus).
                  isActive &&
                    !selected &&
                    'group-focus-visible:ring-ring group-focus-visible:ring-1 ring-inset',
                  entry.hidden && 'text-muted-foreground',
                )}
              >
                <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.kind === 'directory' ? null : (
                  <Badge variant="outline">{t(`newSession.browser.kinds.${entry.kind}`)}</Badge>
                )}
                {entry.hidden ? <Badge variant="outline">{t('newSession.browser.hidden')}</Badge> : null}
                {isSelected ? <CheckIcon aria-hidden className="text-brand size-3.5 shrink-0" /> : null}
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
        <p
          className="text-muted-foreground flex min-w-0 font-mono text-2xs"
          data-slot="folder-browser-current"
          data-target={target ?? ''}
          title={target ?? undefined}
        >
          {footerPath === null ? (
            <span className="truncate">{t('newSession.browser.nothingChosen')}</span>
          ) : (
            // The parent gives way first: the chosen folder's name stays readable. Two flex parts
            // would read as two words – assistive tech gets the plain path.
            <>
              <span aria-hidden className="flex min-w-0">
                <span className="min-w-0 truncate">{footerPath.head + footerPath.separator}</span>
                <span className="text-foreground max-w-[75%] shrink-0 truncate">{footerPath.last}</span>
              </span>
              <span className="sr-only">{target}</span>
            </>
          )}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            data-action="choose-folder"
            disabled={target === null || loading}
            onClick={() => {
              if (target !== null) onChoose(target);
            }}
          >
            {t('newSession.browser.choose')}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  );
}
