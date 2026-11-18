import { LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import type { ErrorPayload } from '@shared/errors';
import {
  DEFAULT_MULTI_HOST_CONFIG,
  multiHostRoleSchema,
  type HostState,
  type MultiHostRole,
} from '@shared/model';
import { useI18n } from '@web/i18n';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Label } from '@web/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/ui/radio-group';
import { SettingField, SettingList } from '../components/SettingField';
import { ControlPart } from './multi-host/ControlPart';
import type { PeerConfirm } from './multi-host/PeerPanel';
import { SharePart } from './multi-host/SharePart';
import { useConfigure } from './multi-host/use-configure';

/** Which role the conflict is about (`REMOTE_ROLE_CONFLICT.params.role` = the role being left). */
function conflictRole(error: ErrorPayload): MultiHostRole | null {
  if (error.code !== 'REMOTE_ROLE_CONFLICT') return null;
  const role = multiHostRoleSchema.safeParse(error.params.role);
  return role.success ? role.data : null;
}

/**
 * Section "Several computers" (WP-78b, WP-75 §4.1): the role of this computer – Off / Share /
 * Control others – via `multiHost.configure`, below it the part of the role. "Share" is complete
 * here; "Control others" is the place WP-80 fills (`multi-host/ControlPart.tsx`). Every command
 * goes to this computer; errors (e.g. `REMOTE_ROLE_CONFLICT`) show next to the control.
 */
export function MultiHostSection({ hostState }: { hostState: HostState | null }) {
  const { t, tError } = useI18n();
  const configure = useConfigure(hostState?.multiHost ?? DEFAULT_MULTI_HOST_CONFIG);
  const [roleError, setRoleError] = useState<ErrorPayload | null>(null);
  const [peerConfirm, setPeerConfirm] = useState<PeerConfirm>(null);
  const { config, busy, pending } = configure;
  const remoteAccess = hostState?.remoteAccess ?? null;
  const conflict = roleError === null ? null : conflictRole(roleError);

  const changeRole = (value: string) => {
    const role = multiHostRoleSchema.safeParse(value);
    if (!role.success || role.data === config.role) return;
    setRoleError(null);
    configure.configure({ role: role.data }, setRoleError);
  };

  let conflictHint: string | null = null;
  if (conflict === 'share') conflictHint = t('preferences.multiHost.role.conflictShare');
  else if (conflict === 'control') conflictHint = t('preferences.multiHost.role.conflictControl');

  return (
    <div data-slot="multi-host-section" className="grid gap-6">
      <SettingList>
        <SettingField
          name="multiHostRole"
          label={t('preferences.multiHost.role.label')}
          description={t('preferences.multiHost.role.hint')}
          below={({ id, labelId, describedBy }) => (
            <div className="grid gap-3">
              <RadioGroup
                aria-labelledby={labelId}
                aria-describedby={describedBy}
                aria-busy={pending?.role === undefined ? undefined : true}
                value={config.role}
                disabled={hostState === null || busy}
                onValueChange={changeRole}
                className="grid gap-2.5"
              >
                {multiHostRoleSchema.options.map((role) => (
                  <div key={role} className="flex items-start gap-2">
                    <RadioGroupItem id={`${id}-${role}`} value={role} className="mt-0.5" />
                    <div className="grid gap-0.5">
                      <Label htmlFor={`${id}-${role}`} className="font-normal">
                        {t(`preferences.multiHost.role.options.${role}`)}
                      </Label>
                      <p className="text-muted-foreground text-2xs leading-relaxed">
                        {t(`preferences.multiHost.role.descriptions.${role}`)}
                      </p>
                    </div>
                  </div>
                ))}
              </RadioGroup>
              {pending?.role === undefined ? null : (
                <p className="text-muted-foreground flex items-center gap-1.5 text-xs" role="status">
                  <LoaderCircleIcon aria-hidden className="size-3.5 motion-safe:animate-spin" />
                  {t('preferences.multiHost.role.saving')}
                </p>
              )}
              {roleError === null ? null : (
                <Alert
                  tone="error"
                  data-slot="multi-host-role-error"
                  title={t('preferences.multiHost.role.failed')}
                  actions={
                    conflict === 'share' && (remoteAccess?.peer ?? null) !== null ? (
                      <Button
                        size="sm"
                        variant="outline"
                        data-action="role-conflict-unpair"
                        onClick={() => {
                          setRoleError(null);
                          setPeerConfirm('unpair');
                        }}
                      >
                        {t('preferences.multiHost.role.unpairAction')}
                      </Button>
                    ) : undefined
                  }
                >
                  {conflictHint === null ? tError(roleError) : `${tError(roleError)} ${conflictHint}`}
                </Alert>
              )}
            </div>
          )}
        />
      </SettingList>
      {config.role === 'share' ? (
        <SharePart
          state={hostState?.multiHost.role === 'share' ? remoteAccess : null}
          config={config}
          configure={configure}
          peerConfirm={peerConfirm}
          onPeerConfirmChange={setPeerConfirm}
        />
      ) : config.role === 'control' ? (
        <ControlPart />
      ) : (
        <p data-slot="multi-host-off" className="text-muted-foreground text-xs leading-relaxed">
          {t('preferences.multiHost.off')}
        </p>
      )}
    </div>
  );
}
