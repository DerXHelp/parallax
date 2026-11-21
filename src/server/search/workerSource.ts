/**
 * Source of the search worker (WP-112, ADR-255), run with `new Worker(source, {eval: true})` by
 * search/service.ts – plain JavaScript (CommonJS eval script) without imports of project code, like
 * backend/history/workerSource.ts, so it runs the same under tsx, Vitest and in dist/server.js.
 *
 * One worker per search: `workerData` is the job (SearchJob in service.ts), the answer one message
 * `{ok: true, hits, truncated, skippedLines}` or `{ok: false, message}`; then the worker ends.
 *
 * Memory and CPU: files are read in 64-KiB chunks, never whole; a line longer than `maxLineBytes`
 * is skipped (counted); a line is parsed only when its raw JSON contains the search text (or it
 * is a `remove` line) – a later version of an item that no longer matches drops the earlier hit by
 * its id, read without parsing – and only the newest `limit` hits are kept (pruned on the way). Entries come
 * newest first; once `limit` hits are kept and an entry's last activity is older than the oldest
 * kept hit, the scan stops (`truncated`).
 *
 * Matching: case-insensitive (`iu`), on the text as the user saw it – prompts (user messages, side
 * questions), answers (assistant text, side answers), with `includeToolOutput` also tool calls
 * (string values of the input, text parts of the result); thinking and system items never. Titles,
 * turn summaries and plans (`plans/v<N>.md`, first matching line) are searched as well. The snippet is
 * at most `snippetChars` UTF-16 units around the first match, control characters (line breaks) as
 * spaces; `ranges` are the matches inside it (at most `rangesMax`).
 */
export const SEARCH_WORKER_SOURCE = String.raw`'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');

const job = workerData;
const CHUNK_BYTES = 64 * 1024;
const MAX_STRINGS = 2000;
let skippedLines = 0;

function escapeRegExp(text) {
  return text.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

const pattern = escapeRegExp(job.text);
const matcher = new RegExp(pattern, 'iu');
// The log lines are JSON.stringify output: the search text appears in its escaped form.
const rawMatcher = new RegExp(escapeRegExp(JSON.stringify(job.text).slice(1, -1)), 'iu');
/** The id of an upserted item without parsing the line (ids without escapes only). */
const ITEM_ID = /"item":\{"id":"([^"\\]*)"/;

function timeOf(value, fallback) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : fallback;
}

function isHigh(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Snippet around the first match of text (null = no match). */
function snippetOf(text) {
  if (typeof text !== 'string') return null;
  const first = matcher.exec(text);
  if (first === null) return null;
  let begin = 0;
  let end = text.length;
  if (text.length > job.snippetChars) {
    begin = Math.max(0, Math.min(first.index - job.snippetLead, text.length - job.snippetChars));
    end = begin + job.snippetChars;
    if (begin > 0 && isLow(text.charCodeAt(begin)) && isHigh(text.charCodeAt(begin - 1))) begin += 1;
    if (end < text.length && isHigh(text.charCodeAt(end - 1))) end -= 1;
  }
  const slice = text.slice(begin, end);
  const ranges = [];
  const all = new RegExp(pattern, 'giu');
  let match;
  while (ranges.length < job.rangesMax && (match = all.exec(slice)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  // A single line: control characters (line breaks, tabs) become spaces, 1:1 so the ranges stay.
  const snippet = slice.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return { snippet, ranges };
}

function hitOf(base, text) {
  const found = snippetOf(text);
  return found === null ? null : Object.assign({}, base, found);
}

/** String values of a JSON value (tool input), depth-first, at most MAX_STRINGS. */
function stringsOf(value, out, depth) {
  if (out.length >= MAX_STRINGS || depth > 20) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out, depth + 1);
  else if (value !== null && typeof value === 'object') for (const k of Object.keys(value)) stringsOf(value[k], out, depth + 1);
  return out;
}

function cappedText(value) {
  return value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : null;
}

/** The hit of one transcript item (null = no match or a kind that is not searched). */
function itemHit(entry, conversationId, item) {
  const base = {
    entryId: entry.entryId,
    conversationId,
    itemId: item.id,
    kind: 'prompt',
    at: typeof item.at === 'string' ? item.at : entry.lastActivityAt,
    t: timeOf(item.at, entry.t),
  };
  switch (item.kind) {
    case 'user_message':
      return hitOf(base, cappedText(item.text));
    case 'assistant_text':
      return hitOf(Object.assign(base, { kind: 'answer' }), item.text);
    case 'side_question':
      return hitOf(base, item.question) || hitOf(Object.assign(base, { kind: 'answer' }), item.response);
    case 'tool_call': {
      if (!job.includeToolOutput) return null;
      base.kind = 'tool';
      for (const text of stringsOf(item.input, [], 0)) {
        const hit = hitOf(base, text);
        if (hit !== null) return hit;
      }
      const content = item.result !== null && typeof item.result === 'object' ? item.result.content : null;
      if (Array.isArray(content)) {
        for (const part of content) {
          const hit = part !== null && typeof part === 'object' ? hitOf(base, cappedText(part.text)) : null;
          if (hit !== null) return hit;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/** Calls onLine for every line of file (UTF-8); over-long lines are skipped. Missing file = no lines. */
function forEachLine(file, onLine) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return;
    throw error;
  }
  try {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let parts = [];
    let partBytes = 0;
    let skipping = false;
    const flush = () => {
      if (!skipping && partBytes > 0) onLine(Buffer.concat(parts, partBytes).toString('utf8'));
      parts = [];
      partBytes = 0;
      skipping = false;
    };
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, CHUNK_BYTES, null);
      if (n === 0) break;
      let start = 0;
      while (start < n) {
        let nl = chunk.indexOf(10, start);
        if (nl >= n) nl = -1;
        const end = nl === -1 ? n : nl;
        if (!skipping) {
          if (partBytes + end - start > job.maxLineBytes) {
            skipping = true;
            skippedLines += 1;
            parts = [];
            partBytes = 0;
          } else if (nl !== -1 && partBytes === 0) {
            // The whole line is inside this chunk: decode without a copy.
            if (end > start) onLine(chunk.toString('utf8', start, end));
            start = nl + 1;
            continue;
          } else if (end > start) {
            parts.push(Buffer.from(chunk.subarray(start, end)));
            partBytes += end - start;
          }
        }
        if (nl === -1) break;
        flush();
        start = nl + 1;
      }
    }
    flush();
  } finally {
    fs.closeSync(fd);
  }
}

// ---- the newest hits ----

let kept = [];
let dropped = false;

function prune() {
  kept.sort((a, b) => b.t - a.t);
  if (kept.length > job.limit) {
    kept.length = job.limit;
    dropped = true;
  }
}

function keep(hit) {
  kept.push(hit);
  if (kept.length >= job.limit * 2) prune();
}

/** The oldest time a new hit must beat once the list is full; -Infinity while there is room. */
function threshold() {
  if (kept.length < job.limit) return -Infinity;
  prune();
  const last = kept[kept.length - 1];
  return last === undefined ? -Infinity : last.t;
}

function scanConversation(entry, conversation) {
  const found = new Map();
  forEachLine(conversation.file, (line) => {
    const remove = line.includes('"op":"remove"');
    if (!remove && !rawMatcher.test(line)) {
      // A later version of an item that no longer matches replaces its earlier hit (the item id
      // is the first key of every stored item; another layout simply does not match here).
      if (found.size > 0) {
        const id = ITEM_ID.exec(line);
        if (id !== null) found.delete(id[1]);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    if (parsed.op === 'remove') {
      if (typeof parsed.itemId === 'string') found.delete(parsed.itemId);
      return;
    }
    const item = parsed.op === 'upsert' ? parsed.item : null;
    if (item === null || typeof item !== 'object' || typeof item.id !== 'string') return;
    const hit = itemHit(entry, conversation.conversationId, item);
    if (hit === null) found.delete(item.id);
    else found.set(item.id, hit);
    if (found.size > job.limit * 4) {
      // Keep this file's newest hits only (a later removal may then miss a replacement – rare).
      const newest = [...found.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, job.limit * 2);
      found.clear();
      for (const [id, h] of newest) found.set(id, h);
    }
  });
  for (const hit of found.values()) keep(hit);
}

function scanPlans(entry) {
  let names;
  try {
    names = fs.readdirSync(entry.plansDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^v\d+\.md$/.test(name)) continue;
    const file = path.join(entry.plansDir, name);
    let mtime;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      mtime = stat.mtime;
    } catch {
      continue;
    }
    let hit = null;
    const base = {
      entryId: entry.entryId,
      conversationId: null,
      itemId: null,
      kind: 'plan',
      at: mtime.toISOString(),
      t: mtime.getTime(),
    };
    forEachLine(file, (line) => {
      if (hit === null) hit = hitOf(base, line);
    });
    if (hit !== null) keep(hit);
  }
}

function scanEntry(entry) {
  const base = { entryId: entry.entryId, conversationId: null, itemId: null };
  const title = hitOf(Object.assign({}, base, { kind: 'title', at: entry.lastActivityAt, t: entry.t }), entry.title);
  if (title !== null) keep(title);
  if (entry.summary !== null) {
    const summary = hitOf(
      Object.assign({}, base, { kind: 'summary', at: entry.summary.at, t: timeOf(entry.summary.at, entry.t) }),
      entry.summary.text,
    );
    if (summary !== null) keep(summary);
  }
  for (const conversation of entry.conversations) scanConversation(entry, conversation);
  scanPlans(entry);
}

try {
  let stoppedEarly = false;
  for (const entry of job.entries) {
    entry.t = timeOf(entry.lastActivityAt, 0);
    if (entry.t < threshold()) {
      stoppedEarly = true;
      break;
    }
    scanEntry(entry);
  }
  prune();
  const hits = kept.map((hit) => {
    const out = Object.assign({}, hit);
    delete out.t;
    return out;
  });
  parentPort.postMessage({ ok: true, hits, truncated: dropped || stoppedEarly, skippedLines });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
}
`;
