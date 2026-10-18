import type { ErrorCode } from '@shared/errors';
import type { HostState } from '@shared/model';
import { useI18n } from '@web/i18n';
import { Alert } from '@web/ui/alert';

/**
 * The host warnings of some codes next to the setting they belong to (WP-38: PROTOCOL_HANDLER_FAILED
 * under "Notifications", AUTOSTART_FAILED under "Server"). The shell's warning banner shows them
 * as well; here they explain why the switch did not take effect.
 */
export function HostWarnings({
  hostState,
  codes,
}: {
  hostState: HostState | null;
  codes: readonly ErrorCode[];
}) {
  const { tError } = useI18n();
  const warnings = (hostState?.warnings ?? []).filter((warning) => codes.includes(warning.error.code));
  if (warnings.length === 0) return null;
  return (
    <div className="grid gap-2 pt-3.5">
      {warnings.map((warning) => (
        <Alert
          key={warning.id}
          tone="warning"
          data-warning={warning.error.code}
          title={tError(warning.error)}
        />
      ))}
    </div>
  );
}
