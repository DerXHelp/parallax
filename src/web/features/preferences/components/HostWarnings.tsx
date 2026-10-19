import type { ErrorCode } from '@shared/errors';
import type { HostState } from '@shared/model';
import { useI18n } from '@web/i18n';
import { Alert } from '@web/ui/alert';

/**
 * `params.reason` of AUTOSTART_FAILED / PROTOCOL_HANDLER_FAILED when the user or another program
 * owns `Parallax.lnk` or the `parallax:` key – the server never replaces them (R4-11, CR2-01,
 * CR2-03; server: system/autostart.ts `FOREIGN_SHORTCUT`, system/protocol.ts `FOREIGN_HANDLER`).
 */
const FOREIGN_REASON = 'foreign';

/**
 * The host warnings of some codes next to the setting they belong to (WP-38: PROTOCOL_HANDLER_FAILED
 * under "Notifications", AUTOSTART_FAILED under "Server"). The shell's warning banner shows them
 * as well; here they explain why the switch did not take effect – `foreignHint` says what to do
 * when the reason is a foreign shortcut/handler (CR2-03).
 */
export function HostWarnings({
  hostState,
  codes,
  foreignHint,
}: {
  hostState: HostState | null;
  codes: readonly ErrorCode[];
  foreignHint?: string;
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
        >
          {warning.error.params.reason === FOREIGN_REASON ? foreignHint : undefined}
        </Alert>
      ))}
    </div>
  );
}
