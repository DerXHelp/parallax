/** Read-only helpers for the CLI's own transcripts under <configDir>/projects (no API calls). */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function projectsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects');
}

/** Project folder + file of a session transcript, searched in all project folders. */
export function findTranscript(
  sessionId: string,
  root = projectsDir(),
): { folder: string; file: string } | undefined {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, `${sessionId}.jsonl`);
    if (existsSync(file)) return { folder: entry.name, file };
  }
  return undefined;
}

export interface TranscriptSummary {
  folder: string;
  lines: number;
  entryTypes: Record<string, number>;
  /** Top-level keys seen on user/assistant entries (e.g. toolUseResult, timestamp, parentUuid). */
  entryKeys: string[];
  withToolUseResult: number;
  withTimestamp: number;
  titles: { type: string; value: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function summarizeTranscript(sessionId: string): TranscriptSummary | undefined {
  const found = findTranscript(sessionId);
  if (found === undefined) return undefined;
  const summary: TranscriptSummary = {
    folder: found.folder,
    lines: 0,
    entryTypes: {},
    entryKeys: [],
    withToolUseResult: 0,
    withTimestamp: 0,
    titles: [],
  };
  const keys = new Set<string>();
  for (const line of readFileSync(found.file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    summary.lines += 1;
    let entry: unknown;
    try {
      entry = JSON.parse(line) as unknown;
    } catch {
      summary.entryTypes['<invalid>'] = (summary.entryTypes['<invalid>'] ?? 0) + 1;
      continue;
    }
    if (!isRecord(entry)) continue;
    const type = typeof entry.type === 'string' ? entry.type : '<none>';
    summary.entryTypes[type] = (summary.entryTypes[type] ?? 0) + 1;
    if (type === 'user' || type === 'assistant') for (const key of Object.keys(entry)) keys.add(key);
    if ('toolUseResult' in entry) summary.withToolUseResult += 1;
    if (typeof entry.timestamp === 'string') summary.withTimestamp += 1;
    for (const titleKey of ['customTitle', 'aiTitle', 'summary', 'title']) {
      const value = entry[titleKey];
      if (typeof value === 'string') summary.titles.push({ type: `${type}.${titleKey}`, value });
    }
  }
  summary.entryKeys = [...keys].sort();
  return summary;
}

/** Project folders created by the spike (scratch cwd under parallax-spike-<stamp>). */
export function spikeProjectFolders(root = projectsDir()): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /parallax-spike-\d{8}-\d{6}/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}
