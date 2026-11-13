/**
 * WP-70: `session.setOutputStyle` – the output style of the entry's project through the CLI's own
 * settings writer (`updateSettings('localSettings', { outputStyle })` → `<cwd>\.claude\settings.local.json`,
 * every session in this project, from the next turn on). Only that key of that file is ever
 * written. The caller has started a dormant entry (no turn), like `session.regenerateTitle`.
 * The summary shows the new style at once; the next `system/init` confirms it.
 */
import { CommandError } from '../sync/ports';
import { commandError, type EngineCore, type EntryState } from './entryState';

export async function setOutputStyle(core: EngineCore, s: EntryState, style: string): Promise<void> {
  const rt = s.runtime;
  if (rt === null || !rt.alive || rt.closing) throw commandError('SESSION_NOT_RUNNING', { entryId: s.id });
  const known = s.availableOutputStyles;
  if (known.length > 0 && !known.includes(style)) {
    throw commandError('VALIDATION_FAILED', { field: 'style', reason: 'unknown' });
  }
  const result = await rt.agent.setOutputStyle(style);
  if (!result.ok) throw new CommandError(result.error);
  core.log.info({ entryId: s.id, style }, 'output style of the project set');
  s.setOutputStyle(style);
}
