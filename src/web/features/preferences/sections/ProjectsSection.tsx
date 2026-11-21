import type { HostState } from '@shared/model';
import { useT } from '@web/i18n';
import type { SettingsEditor } from '../state/settings-editor';

export interface ProjectsSectionProps {
  editor: SettingsEditor;
  hostState: HostState | null;
}

/**
 * Section "Projects" (WP-110 scaffolding, ADR-251; WP-114 fills it): per repository the setup and
 * teardown commands of new worktrees, their shell, the port block and whether "New session" starts in
 * a worktree by default (`settings.projects`, `ProjectSettings`). Until WP-114 only a hint.
 */
export function ProjectsSection(_props: ProjectsSectionProps) {
  const t = useT();
  return <p className="text-muted-foreground text-xs">{t('preferences.projects.unavailable')}</p>;
}
