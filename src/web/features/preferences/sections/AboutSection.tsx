import type { HostState } from '@shared/model';
import { useT } from '@web/i18n';
import { HostFacts } from '@web/shell/SettingsMenu';

/** About: the server facts of the settings menu (one component, `HostFacts`, R3-01/R3-02). */
export function AboutSection({ hostState }: { hostState: HostState | null }) {
  const t = useT();
  if (hostState === null) return <p className="text-muted-foreground text-xs">{t('common.unknown')}</p>;
  return <HostFacts hostState={hostState} className="gap-2 text-xs" />;
}
