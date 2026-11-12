import { SmartphoneIcon } from 'lucide-react';
import { isClaudeSessionUrl, type RemoteControlState, type RemoteControlSummary } from '@shared/model';
import { useI18n } from '@web/i18n';
import { copyText } from '@web/lib/clipboard';
import { cn } from '@web/lib/cn';
import { showTextNotice } from '@web/state/notices';

/**
 * WP-64 Remote Control in the shell: one icon (lucide `Smartphone`) for the sidebar row and the
 * header – connected = quiet, connecting/reconnecting (and a wanted, dormant session in the header)
 * = muted, failed = warning colour – plus the status text with the readable error and the link
 * actions (open only `https://claude.ai/…`, copy).
 */

const TONE: Readonly<Record<RemoteControlState, string>> = {
  off: 'text-muted-foreground opacity-50',
  connecting: 'text-muted-foreground opacity-50',
  reconnecting: 'text-muted-foreground opacity-50',
  connected: 'text-muted-foreground',
  failed: 'text-warning',
};

/** The sidebar row shows the icon for every live state except `off`. */
export function showsRemoteInRow(remote: RemoteControlSummary): boolean {
  return remote.state !== 'off';
}

/** The header shows it as well for a wanted session without a live bridge (it connects at its start). */
export function showsRemoteInHeader(remote: RemoteControlSummary): boolean {
  return remote.state !== 'off' || remote.wanted;
}

export function RemoteControlIcon({ remote, className }: { remote: RemoteControlSummary; className?: string }) {
  return (
    <SmartphoneIcon
      aria-hidden
      data-remote-state={remote.state}
      className={cn('size-3 shrink-0', TONE[remote.state], className)}
    />
  );
}

/** "Remote Control: connected …" (or "connects when the session starts") and the error text, if any. */
export function useRemoteControlTexts(remote: RemoteControlSummary): { status: string; error: string | null } {
  const { t, tError } = useI18n();
  const status =
    remote.state === 'off' && remote.wanted
      ? t('navigation.remote.waiting')
      : t('navigation.remote.status', { state: t(`navigation.remote.states.${remote.state}`) });
  return { status, error: remote.error === null ? null : tError(remote.error) };
}

/** The link of the session, only when it is a claude.ai link (anything else is never offered). */
export function remoteLinkOf(remote: RemoteControlSummary): string | null {
  return remote.sessionUrl !== null && isClaudeSessionUrl(remote.sessionUrl) ? remote.sessionUrl : null;
}

/** "Copy link": the clipboard, confirmed (or refused) as a notice. */
export function copyRemoteLink(url: string): void {
  void copyText(url).then((copied) => {
    showTextNotice(copied ? 'navigation.remote.copied' : 'navigation.remote.copyFailed', undefined, {
      tone: copied ? 'info' : 'error',
      id: 'navigation-remote',
    });
  });
}
