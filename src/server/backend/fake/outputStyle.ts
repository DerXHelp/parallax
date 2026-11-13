/**
 * WP-70: output styles of the fake CLI – the list of the live probe (13.11.2026) and one style per
 * project (case-insensitive cwd, like `<cwd>\.claude\settings.local.json`), shared by every fake
 * session of a backend: `initializationResult` reads it, `updateSettings('localSettings')` writes
 * it, the next turn's `system/init.output_style` reports it.
 */
import { windowsPathKey } from '@shared/paths';

/** `available_output_styles` of the fake CLI (the built-in styles of claude 2.1.323). */
export const FAKE_OUTPUT_STYLES: readonly string[] = ['default', 'Proactive', 'Concise', 'Explanatory', 'Learning'];

export const FAKE_DEFAULT_OUTPUT_STYLE = 'default';

export class FakeOutputStyles {
  private readonly byProject = new Map<string, string>();
  /** Every write (assertions): project cwd as given and the style. */
  readonly writes: { cwd: string; style: string }[] = [];

  get(cwd: string): string {
    return this.byProject.get(windowsPathKey(cwd)) ?? FAKE_DEFAULT_OUTPUT_STYLE;
  }

  set(cwd: string, style: string): void {
    this.byProject.set(windowsPathKey(cwd), style);
    this.writes.push({ cwd, style });
  }
}
