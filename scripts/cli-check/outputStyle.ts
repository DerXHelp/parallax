/**
 * Step 2f of `pnpm cli-check` (WP-70 §1.4): login methods and the output style per project.
 * - Login: `claudeAuthenticate`, `claudeOAuthCallback`, `claudeOAuthWaitForCompletion` exist on the
 *   probe's Query – NEVER called (no login, no browser, nothing changes on the account).
 * - Output style: in a second short session WITHOUT a prompt (no model request, no cost) in the
 *   probe's scratch folder with `settingSources: ['local']` (`updateSettings` refuses sessions whose
 *   setting sources exclude the target): `initializationResult()` lists the styles;
 *   `updateSettings('localSettings', { outputStyle })` with another style; the file
 *   `<cwd>\.claude\settings.local.json` must hold it and `getSettings().effective.outputStyle` must
 *   report it. Afterwards the scratch folder is restored (file and `.claude` removed when the probe
 *   created them, an earlier file written back).
 * The results go into the profile (`login`, `outputStyleSetting`, observation.ts); a change against
 * the profile is a finding (compare.ts). A failure here never stops the check.
 */
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { hasLoginMethods } from '../../src/server/backend/login';
import { outputStylesOf } from '../../src/server/backend/outputStyle';
import { withTimeout } from '../../src/server/backend/sdkBackend';

/** The probe session's Query: the public methods of the output-style step. */
export interface OutputStyleProbeHandle {
  initializationResult?(): Promise<unknown>;
  updateSettings?(source: 'localSettings' | 'userSettings', settings: Record<string, unknown>): Promise<void>;
  getSettings?(): Promise<unknown>;
}

export const outputStyleCheckSchema = z.object({
  available: z.boolean(),
  /** Why not (English, for the report); null when available. */
  detail: z.string().nullable(),
  /** The style the probe wrote (a built-in style name, no user data). */
  style: z.string().nullable(),
  /** Number of styles `initializationResult()` listed. */
  styles: z.number().int().nonnegative(),
  written: z.boolean(),
  effective: z.boolean(),
  restored: z.boolean(),
});
export type OutputStyleCheck = z.infer<typeof outputStyleCheckSchema>;

export const outputStyleProbeResultSchema = z.object({
  /** The three login methods exist (never called). */
  login: z.boolean(),
  outputStyle: outputStyleCheckSchema,
});
export type OutputStyleProbeResult = z.infer<typeof outputStyleProbeResultSchema>;

/** File access of the step (tests: a memory map). */
export interface ProbeFs {
  read(file: string): Promise<string | null>;
  write(file: string, text: string): Promise<void>;
  remove(file: string): Promise<void>;
  /** Removes the folder when it is empty; ignores anything else. */
  removeEmptyDir(dir: string): Promise<void>;
  ensureDir(dir: string): Promise<void>;
}

export const nodeProbeFs: ProbeFs = {
  async read(file) {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return null;
    }
  },
  write: (file, text) => writeFile(file, text, 'utf8'),
  remove: (file) => rm(file, { force: true }),
  async removeEmptyDir(dir) {
    try {
      await rmdir(dir);
    } catch {
      // Not empty or already gone.
    }
  },
  async ensureDir(dir) {
    await mkdir(dir, { recursive: true });
  },
};

export interface OutputStyleProbeOptions {
  /** The probe's scratch folder (the session's cwd). */
  cwd: string;
  controlMs: number;
  log?: (line: string) => void;
  fs?: ProbeFs;
  /** How long the written file is awaited (live: 65 ms). */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const settingsFileSchema = z.looseObject({ outputStyle: z.string().optional() });
const effectiveSchema = z.looseObject({ effective: z.looseObject({ outputStyle: z.unknown().optional() }) });

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function fileStyle(text: string | null): string | null {
  if (text === null) return null;
  try {
    const parsed = settingsFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? (parsed.data.outputStyle ?? null) : null;
  } catch {
    return null;
  }
}

/** A style other than the current one (`Explanatory` first – the live probe's choice). */
export function probeStyleFor(current: string | null, available: readonly string[]): string | null {
  const others = available.filter((style) => style !== current);
  return others.find((style) => style === 'Explanatory') ?? others[0] ?? null;
}

/** True when the probe Query has every login method (never calls one). */
export function loginMethodsPresent(handle: object): boolean {
  return hasLoginMethods(handle);
}

/** Runs the output-style round trip against the settings session (pure apart from handle and fs). */
export async function probeOutputStyle(
  handle: OutputStyleProbeHandle,
  o: OutputStyleProbeOptions,
): Promise<OutputStyleCheck> {
  const fs = o.fs ?? nodeProbeFs;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const dir = path.win32.join(o.cwd, '.claude');
  const file = path.win32.join(dir, 'settings.local.json');
  const gitignore = path.win32.join(o.cwd, '.gitignore');
  const result: OutputStyleCheck = {
    available: false,
    detail: null,
    style: null,
    styles: 0,
    written: false,
    effective: false,
    restored: false,
  };
  if (typeof handle.updateSettings !== 'function')
    return { ...result, detail: 'Query.updateSettings is missing (SDK)' };
  if (typeof handle.initializationResult !== 'function') {
    return { ...result, detail: 'Query.initializationResult is missing (SDK)' };
  }
  let styles: ReturnType<typeof outputStylesOf>;
  try {
    styles = outputStylesOf(
      await withTimeout(handle.initializationResult(), o.controlMs, 'initializationResult'),
    );
  } catch (error) {
    return { ...result, detail: `initializationResult failed: ${message(error)}` };
  }
  if (styles === null)
    return { ...result, detail: 'initializationResult has no output_style/available_output_styles' };
  result.styles = styles.available.length;
  const style = probeStyleFor(styles.current, styles.available);
  if (style === null) return { ...result, detail: 'no second output style to switch to' };
  result.style = style;

  const before = await fs.read(file);
  const gitignoreBefore = await fs.read(gitignore);
  try {
    await withTimeout(
      handle.updateSettings('localSettings', { outputStyle: style }),
      o.controlMs,
      'updateSettings',
    );
    const waitMs = o.waitMs ?? 2_000;
    const pollMs = o.pollMs ?? 50;
    for (let waited = 0; ; waited += pollMs) {
      if (fileStyle(await fs.read(file)) === style) {
        result.written = true;
        break;
      }
      if (waited >= waitMs) break;
      await sleep(pollMs);
    }
    if (typeof handle.getSettings === 'function') {
      const effective = effectiveSchema.safeParse(
        await withTimeout(handle.getSettings(), o.controlMs, 'getSettings'),
      );
      result.effective = effective.success && effective.data.effective.outputStyle === style;
    }
    if (!result.written) result.detail = 'settings.local.json does not hold the written style';
    else if (!result.effective)
      result.detail = 'getSettings().effective.outputStyle does not report the style';
  } catch (error) {
    result.detail = `updateSettings failed: ${message(error)}`;
  } finally {
    try {
      if (before === null) {
        await fs.remove(file);
        await fs.removeEmptyDir(dir);
      } else {
        await fs.ensureDir(dir);
        await fs.write(file, before);
      }
      if (gitignoreBefore === null) await fs.remove(gitignore);
      result.restored = true;
    } catch (error) {
      result.detail ??= `restoring the scratch folder failed: ${message(error)}`;
    }
  }
  result.available = result.written && result.effective && result.detail === null;
  o.log?.(
    `cli-check: output style ${result.available ? `ok ("${style}", ${String(result.styles)} styles)` : `NOT ok (${result.detail ?? '?'})`}` +
      (result.restored ? '' : ' – scratch folder NOT restored'),
  );
  return result;
}
