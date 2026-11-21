import { LIMITS } from '@shared/common';
import type { SearchHit, SessionSummary, TranscriptItem } from '@shared/model';
import type { Command, SessionSnapshot } from '@shared/protocol';
import type { FakeAck } from '@web/state/fake-host';

/**
 * The full-text search of the README showcase (WP-118): `search.query` over the showcase data the way
 * the server's worker does it (ADR-255) – titles, turn summaries, prompts, answers, side questions
 * (tool output only with the switch), case-insensitive, newest first, a snippet with the matches.
 * Deterministic, so `#playground=showcase-search` always shows the same hits.
 */

/** Characters of the snippet before the first match (the server's SEARCH_SNIPPET_LEAD). */
const SNIPPET_LEAD = 80;

type Query = Extract<Command, { name: 'search.query' }>;
type Base = Omit<SearchHit, 'snippet' | 'ranges'>;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Snippet around the first match (null = no match); line breaks become spaces 1:1. */
function snippetOf(text: string, pattern: string): Pick<SearchHit, 'snippet' | 'ranges'> | null {
  const first = new RegExp(pattern, 'iu').exec(text);
  if (first === null) return null;
  let begin = 0;
  let end = text.length;
  if (text.length > LIMITS.searchSnippetChars) {
    begin = Math.max(0, Math.min(first.index - SNIPPET_LEAD, text.length - LIMITS.searchSnippetChars));
    end = begin + LIMITS.searchSnippetChars;
  }
  const slice = text.slice(begin, end);
  const ranges: [number, number][] = [];
  for (const match of slice.matchAll(new RegExp(pattern, 'giu'))) {
    if (ranges.length >= LIMITS.searchRangesMax) break;
    ranges.push([match.index, match.index + match[0].length]);
  }
  // eslint-disable-next-line no-control-regex -- the server maps control characters the same way
  return { snippet: slice.replace(/[\u0000-\u001f\u007f]/g, ' '), ranges };
}

function itemTexts(item: TranscriptItem, toolOutput: boolean): { kind: SearchHit['kind']; text: string }[] {
  switch (item.kind) {
    case 'user_message':
      return [{ kind: 'prompt', text: item.text.text }];
    case 'assistant_text':
      return [{ kind: 'answer', text: item.text }];
    case 'side_question':
      return [
        { kind: 'prompt', text: item.question },
        { kind: 'answer', text: item.response ?? '' },
      ];
    case 'tool_call': {
      if (!toolOutput || item.result === null) return [];
      return item.result.content.flatMap((block) =>
        block.type === 'text' ? [{ kind: 'tool' as const, text: block.text.text }] : [],
      );
    }
    default:
      return [];
  }
}

export function showcaseSearch(
  cmd: Query,
  summaries: readonly SessionSummary[],
  sessions: readonly SessionSnapshot[],
): FakeAck {
  const pattern = escapeRegExp(cmd.text.trim());
  const hits: SearchHit[] = [];
  const add = (base: Base, text: string) => {
    const found = snippetOf(text, pattern);
    if (found !== null) hits.push({ ...base, ...found });
  };
  for (const summary of summaries) {
    if (summary.archived && !cmd.includeArchived) continue;
    const entryId = summary.entryId;
    add(
      { entryId, conversationId: null, itemId: null, kind: 'title', at: summary.lastActivityAt },
      summary.title,
    );
    const turn = summary.turnSummary;
    if (turn !== null) {
      add({ entryId, conversationId: null, itemId: null, kind: 'summary', at: turn.at }, turn.text);
    }
    const snapshot = sessions.find((candidate) => candidate.entryId === entryId);
    if (snapshot === undefined) continue;
    for (const item of snapshot.items) {
      // One hit per item: the first of its texts that matches.
      for (const { kind, text } of itemTexts(item, cmd.includeToolOutput)) {
        const before = hits.length;
        add(
          { entryId, conversationId: snapshot.detail.conversationId, itemId: item.id, kind, at: item.at },
          text,
        );
        if (hits.length > before) break;
      }
    }
  }
  hits.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    ok: true,
    result: { hits: hits.slice(0, LIMITS.searchHitsMax), truncated: hits.length > LIMITS.searchHitsMax },
  };
}
