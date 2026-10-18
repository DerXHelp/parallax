import type { HostState } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { knownVersion } from '@web/lib/version';
import { defaultProfileOf } from './ShellBanners';

/** The default profile's claude (B "Claude-Auflösung": path + `claude --version`, rule C.7). */
function ClaudeInfo({ hostState }: { hostState: HostState }) {
  const t = useT();
  const claude = defaultProfileOf(hostState)?.claude;
  if (claude === undefined) return null;
  const version = knownVersion(claude.version);
  let line: string;
  if (claude.state === 'checking') line = t('shell.info.claudeChecking');
  else if (claude.state === 'not_found') line = t('shell.info.claudeMissing');
  else if (version === null) line = t('shell.info.claudeUnknown');
  else line = t('shell.info.claude', { version });
  return (
    <div data-info="claude" data-version-status={claude.versionStatus} className="grid gap-0.5">
      <span className={claude.versionStatus === 'too_old' ? 'text-destructive' : undefined}>{line}</span>
      {claude.path === null ? null : (
        <span className="text-muted-foreground font-mono break-all">{claude.path}</span>
      )}
      {claude.versionStatus === 'too_old' ? (
        <span className="text-destructive">
          {t('shell.info.claudeTooOld', { required: hostState.sdkClaudeCodeVersion })}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Read-only facts of the server (R3-01: the installed Claude Code and the Agent SDK – the WP-22
 * check "displayed version = `claude --version`"; R3-02: FakeBackend marked). Shown in the settings
 * menu ("About this server", `SettingsMenu.tsx`) and in the section "About" of the settings page
 * (WP-38) – one component, its own shell module (R4W-22; features import shell building blocks,
 * ADR-126).
 */
export function HostFacts({ hostState, className }: { hostState: HostState; className?: string }) {
  const t = useT();
  return (
    <div data-slot="host-info" className={cn('grid gap-1.5 text-2xs select-text', className)}>
      <ClaudeInfo hostState={hostState} />
      <span data-info="sdk">
        {t('shell.info.sdk', {
          version: hostState.sdkVersion,
          required: hostState.sdkClaudeCodeVersion,
        })}
      </span>
      <span data-info="parallax" className="text-muted-foreground">
        {t('shell.info.parallax', { version: hostState.serverVersion })}
      </span>
      <span data-info="data" className="text-muted-foreground break-all">
        {t('shell.info.data', { path: hostState.dataDirLabel })}
      </span>
      {hostState.backend === 'fake' ? (
        <span data-info="backend" className="text-warning font-medium">
          {t('shell.info.backendFake')}
        </span>
      ) : null}
    </div>
  );
}
