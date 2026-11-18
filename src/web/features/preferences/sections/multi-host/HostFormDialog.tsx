import { LoaderCircleIcon } from 'lucide-react';
import { useId, useState } from 'react';
import type { HostId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import {
  HOST_COLORS,
  REMOTE_ACCESS_DEFAULT_PORT,
  hostAddressSchema,
  hostNameSchema,
  remotePortSchema,
  type HostColor,
  type RemoteHost,
} from '@shared/model';
import { isValidPairingCode } from '@shared/pairing';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { HOST_BG } from '@web/lib/host-colors';
import { numberRange } from '@web/lib/zod-range';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/ui/dialog';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/ui/radio-group';

/**
 * What the dialog does (WP-80, WP-75 §4.3): add a computer with its pairing code (`hosts.add`),
 * pair a computer again whose pairing was removed (a new `hosts.add`, then the old entry's color
 * and place move to the new one and the old entry goes – `hosts.update`, `hosts.move`,
 * `hosts.remove`), or edit name, color, address and port (`hosts.update`, only what changed).
 */
export type HostFormMode =
  | { kind: 'add' }
  | { kind: 'pairAgain'; host: RemoteHost; index: number }
  | { kind: 'edit'; host: RemoteHost };

const PORT_RANGE = numberRange(remotePortSchema);

interface Fields {
  name: string;
  address: string;
  port: string;
  code: string;
  color: HostColor | null;
}

function initialFields(mode: HostFormMode): Fields {
  if (mode.kind === 'add') {
    return { name: '', address: '', port: String(REMOTE_ACCESS_DEFAULT_PORT), code: '', color: null };
  }
  const { host } = mode;
  return { name: host.name, address: host.address, port: String(host.port), code: '', color: host.color };
}

function parsePort(value: string): number | null {
  if (!/^\d{1,5}$/u.test(value.trim())) return null;
  const parsed = remotePortSchema.safeParse(Number(value.trim()));
  return parsed.success ? parsed.data : null;
}

/** Characters of a typed code without separators (the code hint shows only from a full length). */
function codeLength(code: string): number {
  return code.replace(/[\s-]/gu, '').length;
}

function isColor(value: string): value is HostColor {
  return (HOST_COLORS as readonly string[]).includes(value);
}

export function HostFormDialog({
  mode,
  onClose,
  onDone,
}: {
  mode: HostFormMode;
  onClose: () => void;
  /** After success, with the computer the result is about. */
  onDone: (hostId: HostId) => void;
}) {
  const { t, tError } = useI18n();
  const ids = { name: useId(), address: useId(), port: useId(), code: useId(), color: useId() };
  const hintIds = { name: useId(), address: useId(), port: useId(), code: useId() };
  const [fields, setFields] = useState<Fields>(() => initialFields(mode));
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [pending, setPending] = useState(false);
  const withCode = mode.kind !== 'edit';
  const hostName = mode.kind === 'add' ? '' : mode.host.name;

  const name = hostNameSchema.safeParse(fields.name);
  const address = hostAddressSchema.safeParse(fields.address);
  const port = parsePort(fields.port);
  const codeOk = !withCode || isValidPairingCode(fields.code);
  const showCodeError = withCode && !codeOk && (tried || codeLength(fields.code) >= 28);
  const valid = name.success && address.success && port !== null && codeOk;

  const set = (patch: Partial<Fields>) => {
    setFields((current) => ({ ...current, ...patch }));
  };

  const submitAdd = async (displayName: string, hostAddress: string, hostPort: number): Promise<HostId> => {
    const { hostId } = await sendCommand(null, {
      name: 'hosts.add',
      address: hostAddress,
      port: hostPort,
      code: fields.code.trim(),
      displayName,
      // Pair again in one step: hostId, color and place stay (so do the sessionKeys of its sessions).
      ...(mode.kind === 'pairAgain' ? { replaceHostId: mode.host.hostId } : {}),
    });
    return hostId;
  };

  const submitEdit = async (host: RemoteHost, displayName: string, hostAddress: string, hostPort: number) => {
    const change = {
      ...(displayName === host.name ? {} : { displayName }),
      ...(fields.color === null || fields.color === host.color ? {} : { color: fields.color }),
      ...(hostAddress === host.address ? {} : { address: hostAddress }),
      ...(hostPort === host.port ? {} : { port: hostPort }),
    };
    if (Object.keys(change).length > 0)
      await sendCommand(null, { name: 'hosts.update', hostId: host.hostId, ...change });
    return host.hostId;
  };

  const submit = async () => {
    setTried(true);
    if (!name.success || !address.success || port === null || !codeOk || pending) return;
    setPending(true);
    setError(null);
    try {
      const hostId =
        mode.kind === 'edit'
          ? await submitEdit(mode.host, name.data, address.data, port)
          : await submitAdd(name.data, address.data, port);
      onDone(hostId);
    } catch (caught) {
      setError(errorPayloadOf(caught));
    } finally {
      setPending(false);
    }
  };

  let title = t('preferences.multiHost.control.form.addTitle');
  let description: string | null = t('preferences.multiHost.control.form.addDescription');
  let submitLabel = t('preferences.multiHost.control.form.submitAdd');
  if (mode.kind === 'pairAgain') {
    title = t('preferences.multiHost.control.form.pairAgainTitle', { name: hostName });
    description = t('preferences.multiHost.control.form.pairAgainDescription', { name: hostName });
    submitLabel = t('preferences.multiHost.control.form.submitPairAgain');
  } else if (mode.kind === 'edit') {
    title = t('preferences.multiHost.control.form.editTitle', { name: hostName });
    description = null;
    submitLabel = t('preferences.multiHost.control.form.save');
  }

  const invalid = (ok: boolean) => (tried && !ok ? true : undefined);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent data-slot="host-form" data-mode={mode.kind} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description === null ? null : <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          className="grid gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor={ids.name}>{t('preferences.multiHost.control.form.name')}</Label>
            <Input
              id={ids.name}
              name="name"
              value={fields.name}
              maxLength={64}
              autoComplete="off"
              aria-describedby={hintIds.name}
              aria-invalid={invalid(name.success)}
              disabled={pending}
              onChange={(event) => {
                set({ name: event.target.value });
              }}
            />
            <p id={hintIds.name} className="text-muted-foreground text-2xs">
              {t('preferences.multiHost.control.form.nameHint')}
            </p>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <div className="grid gap-1">
              <Label htmlFor={ids.address}>{t('preferences.multiHost.control.form.address')}</Label>
              <Input
                id={ids.address}
                name="address"
                value={fields.address}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                aria-describedby={hintIds.address}
                aria-invalid={invalid(address.success)}
                disabled={pending}
                onChange={(event) => {
                  set({ address: event.target.value });
                }}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor={ids.port}>{t('preferences.multiHost.control.form.port')}</Label>
              <Input
                id={ids.port}
                name="port"
                value={fields.port}
                inputMode="numeric"
                autoComplete="off"
                className="font-mono"
                aria-describedby={hintIds.port}
                aria-invalid={invalid(port !== null)}
                disabled={pending}
                onChange={(event) => {
                  set({ port: event.target.value });
                }}
              />
            </div>
          </div>
          <p id={hintIds.address} className="text-muted-foreground -mt-2 text-2xs">
            {t('preferences.multiHost.control.form.addressHint')}
          </p>
          <p
            id={hintIds.port}
            className={cn(
              '-mt-2 text-2xs',
              tried && port === null ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {tried && port === null
              ? t('preferences.multiHost.control.form.portInvalid', {
                  min: String(PORT_RANGE.min),
                  max: String(PORT_RANGE.max),
                })
              : t('preferences.multiHost.control.form.portHint', {
                  port: String(REMOTE_ACCESS_DEFAULT_PORT),
                })}
          </p>
          {withCode ? (
            <div className="grid gap-1">
              <Label htmlFor={ids.code}>{t('preferences.multiHost.control.form.code')}</Label>
              <Input
                id={ids.code}
                name="code"
                value={fields.code}
                autoComplete="one-time-code"
                spellCheck={false}
                autoCapitalize="characters"
                className="font-mono tracking-wider"
                aria-describedby={hintIds.code}
                aria-invalid={showCodeError ? true : undefined}
                disabled={pending}
                onChange={(event) => {
                  set({ code: event.target.value });
                }}
              />
              <p
                id={hintIds.code}
                data-slot="host-form-code-hint"
                className={cn('text-2xs', showCodeError ? 'text-destructive' : 'text-muted-foreground')}
              >
                {showCodeError
                  ? t('preferences.multiHost.control.form.codeInvalid')
                  : t('preferences.multiHost.control.form.codeHint')}
              </p>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <span id={ids.color} className="text-xs font-medium">
                {t('preferences.multiHost.control.form.color')}
              </span>
              <RadioGroup
                aria-labelledby={ids.color}
                value={fields.color ?? ''}
                disabled={pending}
                onValueChange={(value) => {
                  if (isColor(value)) set({ color: value });
                }}
                className="grid grid-cols-4 gap-2"
              >
                {HOST_COLORS.map((color) => (
                  <div key={color} className="flex items-center gap-1.5">
                    <RadioGroupItem id={`${ids.color}-${color}`} value={color} data-host-color={color} />
                    <Label
                      htmlFor={`${ids.color}-${color}`}
                      className="flex items-center gap-1 text-xs font-normal"
                    >
                      <span aria-hidden className={cn('size-2.5 rounded-full', HOST_BG[color])} />
                      {t(`preferences.multiHost.control.form.colors.${color}`)}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>
          )}
          {error === null ? null : (
            <Alert
              tone="error"
              data-slot="host-form-error"
              title={
                mode.kind === 'edit'
                  ? t('preferences.multiHost.control.form.saveFailed')
                  : t('preferences.multiHost.control.form.addFailed')
              }
            >
              {tError(error)}
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onClose}>
              {t('preferences.multiHost.control.form.cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={pending || (tried && !valid)}
              data-action="host-form-submit"
            >
              {pending ? <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" /> : null}
              {pending
                ? mode.kind === 'edit'
                  ? t('preferences.multiHost.control.form.saving')
                  : t('preferences.multiHost.control.form.pairing')
                : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
