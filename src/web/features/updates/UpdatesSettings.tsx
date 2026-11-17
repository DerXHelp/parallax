import { LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react';
import { memo, useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { errorSpec, type ErrorPayload } from '@shared/errors';
import type { ChangelogQuery, NoticeFile } from '@shared/http';
import { npmRegistryUrlSchema, type HostState, type UpdateState } from '@shared/model';
import type { CommandOf } from '@shared/protocol';
import { useI18n } from '@web/i18n';
import { formatFileSize } from '@web/lib/bytes';
import type { NoSlotProps } from '@web/shell/slots';
import { useNow } from '@web/state/clock';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useConnectionStatus, useHostState } from '@web/state/hooks';
import { updateSettings, useSettings } from '@web/state/settings';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { Progress } from '@web/ui/progress';
import { Switch } from '@web/ui/switch';
import { NoticesDialog } from './components/NoticesDialog';
import { SwitchDialog, type SwitchTarget } from './components/SwitchDialog';
import { UpdateErrorAlert } from './components/UpdateErrorAlert';
import { WhatsNewDialog } from './components/WhatsNewDialog';
import { updateHttpErrorOf, uploadUpdatePackage } from './lib/api';
import { isPackaged, isUpdateBusy } from './lib/update-state';

/** The dialog opened from the section (one at a time; each shows its own errors). */
type OpenDialog =
  | { kind: 'whatsNew'; query: ChangelogQuery; version: string }
  | { kind: 'notices'; file: NoticeFile }
  | { kind: 'switch'; target: SwitchTarget };

type Open = (dialog: OpenDialog) => void;

/** Statuses in which the server takes a package (WP-87 §2.1 "Aus Datei"). */
const UPLOAD_STATUSES: ReadonlySet<UpdateState['status']> = new Set(['idle', 'available', 'ready']);

/** Same code and params (every `host.state` is parsed anew: never compare the objects). */
function sameError(a: ErrorPayload | null, b: ErrorPayload | null): boolean {
  if (a === null || b === null) return a === b;
  return a.code === b.code && JSON.stringify(a.params) === JSON.stringify(b.params);
}

/**
 * "Package received – it is being checked" after a 202: `error` = `update.error` at the upload,
 * `checking` = the server was seen checking it (status `preparing`).
 */
interface UploadNote {
  error: ErrorPayload | null;
  checking: boolean;
}

/**
 * The note ends once the check shows: offered (`ready`), another error than before the upload, or
 * the check is over (an error the server clears does not end it).
 */
function uploadSettled(note: UploadNote, update: UpdateState): boolean {
  return (
    update.status === 'ready' ||
    (update.error !== null && !sameError(update.error, note.error)) ||
    (note.checking && update.status !== 'preparing')
  );
}

function Block({ name, title, children }: { name: string; title?: string; children: ReactNode }) {
  return (
    <section data-block={name} className="grid gap-2 py-3.5 first:pt-0 last:pb-0">
      {title === undefined ? null : <h4 className="text-xs font-medium">{title}</h4>}
      {children}
    </section>
  );
}

/** Installed version and build ID; a checkout says "development build – updates via git". */
function VersionBlock({ hostState, packaged }: { hostState: HostState; packaged: boolean }) {
  const { t } = useI18n();
  const { app } = hostState;
  if (!packaged && app !== null) {
    return (
      <Block name="version" title={t('updates.settings.installed')}>
        <p data-info="development" className="text-ui break-all select-text">
          {t('updates.settings.development', { buildId: app.buildId })}
        </p>
        <p className="text-muted-foreground text-2xs leading-relaxed">
          {t('updates.settings.developmentHint')}
        </p>
      </Block>
    );
  }
  return (
    <Block name="version" title={t('updates.settings.installed')}>
      <p data-info="version" className="text-ui select-text">
        {t('updates.settings.version', { version: app?.version ?? hostState.serverVersion })}
      </p>
      {app === null ? null : (
        <p data-info="build" className="text-muted-foreground font-mono text-2xs break-all select-text">
          {t('updates.settings.buildId', { buildId: app.buildId })}
        </p>
      )}
    </Block>
  );
}

/** The status line ("up to date", "<v> available", "Downloading <v>…" …), a live region. */
function statusLine(
  update: UpdateState,
  checkingUpload: boolean,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const version = update.available?.version ?? null;
  switch (update.status) {
    case 'unsupported':
    case 'idle':
      return t('updates.status.idle');
    case 'checking':
      return t('updates.status.checking');
    case 'available':
      return version === null ? t('updates.status.idle') : t('updates.status.available', { version });
    case 'downloading':
      return version === null
        ? t('updates.status.preparingFile')
        : t('updates.status.downloading', { version });
    case 'preparing':
      return checkingUpload || version === null
        ? t('updates.status.preparingFile')
        : t('updates.status.preparing', { version });
    case 'ready':
      if (version === null) return t('updates.status.idle');
      return update.available?.source === 'file'
        ? t('updates.status.readyFile', { version })
        : t('updates.status.ready', { version });
    case 'restarting':
      return t('updates.status.restarting');
  }
}

function StatusDetails({ hostState, onOpen }: { hostState: HostState; onOpen: Open }) {
  const { t, format } = useI18n();
  const now = useNow(30_000);
  const { update } = hostState;
  const { available } = update;
  const lines: ReactNode[] = [];
  if (available !== null && update.status !== 'idle' && update.status !== 'checking') {
    const meta =
      available.source === 'file'
        ? t('updates.settings.fromFile', { date: format.dateTime(available.createdAt) })
        : [
            t('updates.settings.released', { date: format.dateTime(available.createdAt) }),
            available.size === null ? null : formatFileSize(available.size, format),
          ]
            .filter((part) => part !== null)
            .join(' · ');
    lines.push(
      <p key="meta" data-info="release" className="text-muted-foreground text-2xs">
        {meta}
      </p>,
    );
    if (available.downgrade) {
      lines.push(
        <p key="downgrade" data-info="downgrade" className="text-warning text-2xs">
          {t('updates.settings.downgrade', { current: hostState.app?.version ?? hostState.serverVersion })}
        </p>,
      );
    }
    lines.push(
      <div key="whats-new">
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0"
          data-action="update-whats-new-available"
          onClick={() => {
            onOpen({ kind: 'whatsNew', query: { for: 'available' }, version: available.version });
          }}
        >
          {t('updates.settings.whatsNewIn', { version: available.version })}
        </Button>
      </div>,
    );
  }
  if (update.status === 'idle' || update.status === 'available') {
    lines.push(
      <p key="checked" data-info="checked" className="text-muted-foreground text-2xs">
        {update.checkedAt === null
          ? t('updates.settings.neverChecked')
          : t('updates.settings.lastChecked', { time: format.relative(update.checkedAt, now) })}
      </p>,
    );
  }
  return lines;
}

function ProgressLine({ progress }: { progress: number | null }) {
  const { t, format } = useI18n();
  if (progress === null) return null;
  const percent = Math.round(progress * 100);
  return (
    <div data-info="progress" className="flex items-center gap-2">
      <Progress value={percent} aria-label={t('updates.settings.progress')} className="max-w-72" />
      <span className="text-muted-foreground text-2xs tabular-nums">{format.percent(percent)}</span>
    </div>
  );
}

type UpdateCommand = CommandOf<'update.check'> | CommandOf<'update.prepare'> | CommandOf<'update.dismiss'>;

/** Status, progress, errors and the actions of an installation. */
function StatusBlock({ hostState, onOpen }: { hostState: HostState; onOpen: Open }) {
  const { t, format } = useI18n();
  const { update } = hostState;
  const connected = useConnectionStatus() === 'open';
  const [pending, setPending] = useState<UpdateCommand['name'] | null>(null);
  const [commandError, setCommandError] = useState<ErrorPayload | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<ErrorPayload | null>(null);
  const [uploadNote, setUploadNote] = useState<UploadNote | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const rollbackHintId = useId();

  // Follows the server's check of an uploaded package (state adjusted while rendering).
  if (uploadNote !== null) {
    if (uploadSettled(uploadNote, update)) setUploadNote(null);
    else if (!uploadNote.checking && update.status === 'preparing')
      setUploadNote({ ...uploadNote, checking: true });
  }
  const checkingUpload = uploadNote !== null && !uploadSettled(uploadNote, update);
  const busy = isUpdateBusy(update.status) || pending !== null || uploading || !connected;

  const run = (cmd: UpdateCommand) => {
    setPending(cmd.name);
    setCommandError(null);
    sendCommand(null, cmd).then(
      () => {
        setPending(null);
      },
      (caught: unknown) => {
        setPending(null);
        setCommandError(errorPayloadOf(caught));
      },
    );
  };

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // The same file again must fire `change` again.
    event.currentTarget.value = '';
    if (file === undefined) return;
    setUploading(true);
    setUploadError(null);
    setUploadNote(null);
    const errorBefore = update.error;
    uploadUpdatePackage(file).then(
      () => {
        setUploading(false);
        setUploadNote({ error: errorBefore, checking: false });
      },
      (caught: unknown) => {
        setUploading(false);
        setUploadError(updateHttpErrorOf(caught));
      },
    );
  };

  const { available, previous } = update;
  const rollbackBlocked = previous !== null && previous.needsRestore && previous.backupAt === null;
  const spinning =
    update.status === 'checking' ||
    update.status === 'restarting' ||
    (update.status === 'preparing' && update.progress === null);

  return (
    <Block name="status">
      <p role="status" data-info="status" className="text-ui flex items-center gap-2">
        {spinning ? (
          <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 motion-safe:animate-spin" />
        ) : null}
        <span>{statusLine(update, checkingUpload, t)}</span>
      </p>
      {update.status === 'downloading' || update.status === 'preparing' ? (
        <ProgressLine progress={update.progress} />
      ) : null}
      <StatusDetails hostState={hostState} onOpen={onOpen} />
      {checkingUpload ? (
        <p data-info="uploaded" className="text-muted-foreground text-2xs">
          {t('updates.settings.uploaded')}
        </p>
      ) : null}
      {update.error === null ? null : (
        <UpdateErrorAlert
          title={t('updates.status.lastError')}
          error={update.error}
          tone={errorSpec(update.error.code).severity === 'error' ? 'error' : 'warning'}
          actions={
            <Button
              size="sm"
              variant="outline"
              data-action="dismiss-update-error"
              disabled={!connected}
              onClick={() => {
                run({ name: 'update.dismiss', what: 'error' });
              }}
            >
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {commandError === null || sameError(commandError, update.error) ? null : (
        <UpdateErrorAlert
          title={t('updates.settings.commandFailed')}
          error={commandError}
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCommandError(null);
              }}
            >
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {uploadError === null ? null : (
        <UpdateErrorAlert
          title={t('updates.settings.uploadFailed')}
          error={uploadError}
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setUploadError(null);
              }}
            >
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {update.status === 'ready' && available !== null ? (
          <Button
            data-action="update-restart"
            disabled={busy}
            onClick={() => {
              onOpen({
                kind: 'switch',
                target: {
                  kind: 'apply',
                  version: available.version,
                  needsRestore: available.needsRestore,
                  backupAt: available.backupAt,
                },
              });
            }}
          >
            {t('updates.settings.restart')}
          </Button>
        ) : null}
        {update.status === 'available' && available !== null ? (
          <Button
            data-action="update-prepare"
            disabled={busy}
            onClick={() => {
              run({ name: 'update.prepare', version: available.version });
            }}
          >
            {t('updates.settings.prepare')}
          </Button>
        ) : null}
        <Button
          variant="outline"
          data-action="update-check"
          disabled={busy}
          onClick={() => {
            run({ name: 'update.check' });
          }}
        >
          {pending === 'update.check' || update.status === 'checking'
            ? t('updates.settings.checking')
            : t('updates.settings.checkNow')}
        </Button>
        <Button
          variant="outline"
          data-action="update-install-file"
          disabled={busy || !UPLOAD_STATUSES.has(update.status)}
          onClick={() => {
            fileInput.current?.click();
          }}
        >
          {uploading ? t('updates.settings.uploading') : t('updates.settings.installFile')}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".zip"
          hidden
          tabIndex={-1}
          aria-hidden
          data-slot="update-file-input"
          onChange={upload}
        />
        {previous === null ? null : (
          <Button
            variant="outline"
            data-action="update-rollback"
            disabled={busy || rollbackBlocked}
            aria-describedby={previous.needsRestore ? rollbackHintId : undefined}
            onClick={() => {
              onOpen({
                kind: 'switch',
                target: {
                  kind: 'rollback',
                  version: previous.version,
                  needsRestore: previous.needsRestore,
                  backupAt: previous.backupAt,
                },
              });
            }}
          >
            {t('updates.settings.rollback', { version: previous.version })}
          </Button>
        )}
      </div>
      {previous?.needsRestore === true ? (
        <p
          id={rollbackHintId}
          data-info="rollback-hint"
          className="text-muted-foreground flex items-start gap-1.5 text-2xs leading-relaxed"
        >
          <TriangleAlertIcon aria-hidden className="text-warning mt-0.5 size-3 shrink-0" />
          <span>
            {previous.backupAt === null
              ? t('updates.settings.rollbackBlocked', { version: previous.version })
              : t('updates.settings.rollbackLoss', { date: format.dateTime(previous.backupAt) })}
          </span>
        </p>
      ) : null}
    </Block>
  );
}

/** "Check for updates automatically" (`settings.updates.check`, saved at once). */
function AutoCheckBlock() {
  const { t, tError } = useI18n();
  const settings = useSettings();
  const [error, setError] = useState<ErrorPayload | null>(null);
  const id = useId();
  const hintId = useId();
  return (
    <Block name="auto-check">
      <div className="flex items-start justify-between gap-6">
        <div className="grid min-w-0 gap-1">
          <Label htmlFor={id} className="leading-snug">
            {t('updates.settings.autoCheck')}
          </Label>
          <p id={hintId} className="text-muted-foreground text-2xs leading-relaxed">
            {t('updates.settings.autoCheckHint')}
          </p>
        </div>
        <Switch
          id={id}
          aria-describedby={hintId}
          className="mt-0.5"
          checked={settings.updates.check}
          onCheckedChange={(check) => {
            setError(null);
            updateSettings({ updates: { ...settings.updates, check } }).catch((caught: unknown) => {
              setError(errorPayloadOf(caught));
            });
          }}
        />
      </div>
      {error === null ? null : (
        <Alert tone="error" title={t('updates.settings.autoCheckFailed')}>
          {tError(error)}
        </Alert>
      )}
    </Block>
  );
}

/**
 * npm registry for the Agent SDK of updates (`settings.updates.registry`): empty = the npm
 * configuration (`~/.npmrc`, NPM_CONFIG_REGISTRY). Saved with Enter or "Save"; checked like the server
 * does (https, no credentials – those stay in ~/.npmrc).
 */
function RegistryBlock() {
  const { t, tError } = useI18n();
  const settings = useSettings();
  const stored = settings.updates.registry ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const id = useId();
  const hintId = useId();
  const value = draft ?? stored;
  const save = () => {
    const text = value.trim();
    const parsed = text === '' ? null : npmRegistryUrlSchema.safeParse(text);
    if (parsed !== null && !parsed.success) {
      setInvalid(true);
      return;
    }
    const registry = parsed === null ? null : parsed.data;
    setInvalid(false);
    setError(null);
    if ((registry ?? '') === stored) {
      setDraft(null);
      return;
    }
    updateSettings({ updates: { ...settings.updates, registry } })
      .then(() => {
        setDraft(null);
      })
      .catch((caught: unknown) => {
        setError(errorPayloadOf(caught));
      });
  };
  return (
    <Block name="registry">
      <div className="grid gap-1.5">
        <Label htmlFor={id} className="leading-snug">
          {t('updates.settings.registry')}
        </Label>
        <div className="flex gap-2">
          <Input
            id={id}
            aria-describedby={hintId}
            aria-invalid={invalid || undefined}
            className="font-mono text-xs"
            value={value}
            placeholder={t('updates.settings.registryPlaceholder')}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
            }}
          />
          <Button size="sm" variant="outline" disabled={draft === null} onClick={save}>
            {t('updates.settings.registrySave')}
          </Button>
        </div>
        <p id={hintId} className="text-muted-foreground text-2xs leading-relaxed">
          {invalid ? t('updates.settings.registryInvalid') : t('updates.settings.registryHint')}
        </p>
      </div>
      {error === null ? null : (
        <Alert tone="error" title={t('updates.settings.autoCheckFailed')}>
          {tError(error)}
        </Alert>
      )}
    </Block>
  );
}

/** "What's new" (installed version), license and third-party notices (only in an installation). */
function LinksBlock({
  hostState,
  packaged,
  onOpen,
}: {
  hostState: HostState;
  packaged: boolean;
  onOpen: Open;
}) {
  const { t } = useI18n();
  const version = hostState.app?.version ?? hostState.serverVersion;
  const link = (action: string, label: string, dialog: OpenDialog) => (
    <Button
      key={action}
      variant="link"
      size="sm"
      className="h-auto px-0"
      data-action={action}
      onClick={() => {
        onOpen(dialog);
      }}
    >
      {label}
    </Button>
  );
  return (
    <Block name="links" title={t('updates.settings.links')}>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {link('update-whats-new-installed', t('updates.settings.whatsNew'), {
          kind: 'whatsNew',
          query: { for: 'installed' },
          version,
        })}
        {packaged
          ? [
              link('update-license', t('updates.settings.license'), { kind: 'notices', file: 'license' }),
              link('update-third-party', t('updates.settings.thirdParty'), {
                kind: 'notices',
                file: 'third-party',
              }),
            ]
          : null}
      </div>
    </Block>
  );
}

/**
 * Slot `UpdatesSettings` (settings section "Updates", WP-87 §2.3), always for the local host:
 * installed version and build ID, the update status with progress, "Check now", "Prepare update",
 * "Restart now" (confirmation with the sessions it stops), "Back to <previous>" (with the data loss
 * warning and tick when the store schemas differ, blocked without a backup), "Install from file…"
 * (zip upload), the automatic check, "What's new", license and third-party notices. A checkout
 * (`unsupported`, `app.packaged` false) shows "development build – updates via git" and "What's new"
 * only. Errors of the section show in it; the dialogs show their own.
 */
export const UpdatesSettings = memo(function UpdatesSettings(_props: NoSlotProps) {
  const { t } = useI18n();
  const hostState = useHostState();
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  if (hostState === null) return <p className="text-muted-foreground text-xs">{t('common.unknown')}</p>;
  const packaged = isPackaged(hostState);
  const close = () => {
    setDialog(null);
  };
  return (
    <div
      data-slot="updates-settings"
      data-status={hostState.update.status}
      className="divide-border grid divide-y"
    >
      <VersionBlock hostState={hostState} packaged={packaged} />
      {packaged ? <StatusBlock hostState={hostState} onOpen={setDialog} /> : null}
      {packaged ? <AutoCheckBlock /> : null}
      {packaged ? <RegistryBlock /> : null}
      <LinksBlock hostState={hostState} packaged={packaged} onOpen={setDialog} />
      {dialog?.kind === 'whatsNew' ? (
        <WhatsNewDialog query={dialog.query} version={dialog.version} onClose={close} />
      ) : null}
      {dialog?.kind === 'notices' ? <NoticesDialog file={dialog.file} onClose={close} /> : null}
      {dialog?.kind === 'switch' ? <SwitchDialog target={dialog.target} onClose={close} /> : null}
    </div>
  );
});

export default UpdatesSettings;
