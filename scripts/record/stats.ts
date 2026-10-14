/**
 * `pnpm record --stats`: summary of all fixtures (message types/subtypes, event kinds) and of the
 * spike usage from .recordings/spike-state.json. No live call.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES_DIR, loadState, type ModelUsageLite } from './context';
import { parseFixture } from './format';
import { addUsage } from './session';

function messageKey(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '?';
  const type = 'type' in payload && typeof payload.type === 'string' ? payload.type : '?';
  if ('subtype' in payload && typeof payload.subtype === 'string') return `${type}/${payload.subtype}`;
  if (
    type === 'stream_event' &&
    'event' in payload &&
    typeof payload.event === 'object' &&
    payload.event !== null
  ) {
    const event = payload.event;
    const inner = 'type' in event && typeof event.type === 'string' ? event.type : '?';
    if (
      inner === 'content_block_delta' &&
      'delta' in event &&
      typeof event.delta === 'object' &&
      event.delta !== null
    ) {
      const delta = event.delta;
      return `stream_event/${inner}/${'type' in delta && typeof delta.type === 'string' ? delta.type : '?'}`;
    }
    return `stream_event/${inner}`;
  }
  return type;
}

export interface FixtureStats {
  files: Record<string, { events: number; kinds: Record<string, number> }>;
  messages: Record<string, Record<string, number>>;
}

export function collectStats(dir = FIXTURES_DIR): FixtureStats {
  const stats: FixtureStats = { files: {}, messages: {} };
  if (!existsSync(dir)) return stats;
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()) {
    const scenario = file.replace(/\.jsonl$/, '');
    const { events } = parseFixture(readFileSync(path.join(dir, file), 'utf8'), file);
    const kinds: Record<string, number> = {};
    for (const event of events) {
      kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
      if (event.kind !== 'message') continue;
      const key = messageKey(event.payload);
      const perFile = (stats.messages[key] ??= {});
      perFile[scenario] = (perFile[scenario] ?? 0) + 1;
    }
    stats.files[scenario] = { events: events.length, kinds };
  }
  return stats;
}

export function printStats(): void {
  const stats = collectStats();
  const scenarios = Object.keys(stats.files);
  const out: string[] = [];
  out.push('## Message types per fixture', '');
  out.push(`| type/subtype | total | ${scenarios.join(' | ')} |`);
  out.push(`|---|---|${scenarios.map(() => '---').join('|')}|`);
  for (const key of Object.keys(stats.messages).sort()) {
    const perFile = stats.messages[key] ?? {};
    const total = Object.values(perFile).reduce((sum, value) => sum + value, 0);
    out.push(`| ${key} | ${total} | ${scenarios.map((name) => String(perFile[name] ?? '')).join(' | ')} |`);
  }
  out.push('', '## Event kinds per fixture', '');
  for (const name of scenarios) {
    const file = stats.files[name];
    if (file === undefined) continue;
    const kinds = Object.entries(file.kinds)
      .map(([kind, count]) => `${kind} ${count}`)
      .join(', ');
    out.push(`- ${name}: ${file.events} events (${kinds})`);
  }

  const state = loadState();
  let usage: Record<string, ModelUsageLite> = {};
  let cost = 0;
  let numTurns = 0;
  let results = 0;
  let messageIds = 0;
  out.push('', '## Spike sessions', '');
  out.push('| scenario | stamp | ok | USD | results | num_turns | msg ids | exit ms | orphans | modes |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const session of state.sessions) {
    usage = addUsage(usage, session.modelUsage);
    cost += session.costUsd;
    numTurns += session.numTurns;
    results += session.results;
    messageIds += session.assistantMessageIds;
    out.push(
      `| ${session.scenario} | ${session.stamp} | ${session.ok ? 'yes' : 'no'} | ${session.costUsd.toFixed(4)} | ` +
        `${session.results} | ${session.numTurns} | ${session.assistantMessageIds} | ` +
        `${session.exitMsSinceClose ?? '-'} | ${session.orphans} | ${session.permissionModes.join('→')} |`,
    );
  }
  out.push('', '## Usage by model (sum over sessions)', '');
  out.push('| model | input | output | cache read | cache write | USD |');
  out.push('|---|---|---|---|---|---|');
  for (const [model, value] of Object.entries(usage)) {
    out.push(
      `| ${model} | ${value.inputTokens} | ${value.outputTokens} | ${value.cacheReadInputTokens} | ` +
        `${value.cacheCreationInputTokens} | ${value.costUSD.toFixed(4)} |`,
    );
  }
  out.push(
    '',
    `Total: ${cost.toFixed(4)} USD, ${state.sessions.length} sessions, ${results} results, ` +
      `${numTurns} num_turns, ${messageIds} distinct assistant message ids.`,
  );
  process.stdout.write(`${out.join('\n')}\n`);
}
