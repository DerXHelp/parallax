import { describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { sampleId, sampleSearchHit, sampleTime } from '@shared/samples';
import { groupHits, mergeHostHits, snippetParts } from './results';

/** WP-115: hits of several computers mixed by time, grouped per session; marked snippet parts. */

const REMOTE = 'remote';
const A = sampleId('en', 1);
const B = sampleId('en', 2);

describe('mergeHostHits', () => {
  it('newest first across computers; equal times keep the host order, then the own order', () => {
    const merged = mergeHostHits(
      new Map([
        [
          REMOTE,
          [
            sampleSearchHit({ entryId: B, at: sampleTime(30) }),
            sampleSearchHit({ entryId: B, at: sampleTime(10) }),
          ],
        ],
        [
          LOCAL_HOST_ID,
          [
            sampleSearchHit({ entryId: A, at: sampleTime(20) }),
            sampleSearchHit({ entryId: A, at: sampleTime(10) }),
          ],
        ],
      ]),
      [LOCAL_HOST_ID, REMOTE],
    );
    expect(merged.map((item) => [item.hostId, item.hit.at])).toEqual([
      [REMOTE, sampleTime(30)],
      [LOCAL_HOST_ID, sampleTime(20)],
      [LOCAL_HOST_ID, sampleTime(10)],
      [REMOTE, sampleTime(10)],
    ]);
    expect(merged[0]?.sessionKey).toBe(makeSessionKey(REMOTE, B));
    expect(new Set(merged.map((item) => item.key)).size).toBe(4);
  });
});

describe('groupHits', () => {
  it('one group per session in the order of its newest hit; options numbered across groups', () => {
    const merged = mergeHostHits(
      new Map([
        [
          LOCAL_HOST_ID,
          [
            sampleSearchHit({ entryId: A, at: sampleTime(30) }),
            sampleSearchHit({ entryId: B, at: sampleTime(20) }),
            sampleSearchHit({ entryId: A, at: sampleTime(10) }),
          ],
        ],
      ]),
      [LOCAL_HOST_ID],
    );
    const groups = groupHits(merged);
    expect(groups.map((group) => [group.sessionKey, group.hits.length, group.start, group.latestAt])).toEqual(
      [
        [makeSessionKey(LOCAL_HOST_ID, A), 2, 0, sampleTime(30)],
        [makeSessionKey(LOCAL_HOST_ID, B), 1, 2, sampleTime(20)],
      ],
    );
  });
});

describe('snippetParts', () => {
  it('cuts the snippet into plain and marked parts', () => {
    expect(snippetParts('Please add a login form', [[13, 18]])).toEqual([
      { text: 'Please add a ', match: false },
      { text: 'login', match: true },
      { text: ' form', match: false },
    ]);
  });

  it('merges overlapping and touching ranges, sorts, clamps and drops empty ones', () => {
    expect(
      snippetParts('abcdefghij', [
        [6, 8],
        [0, 2],
        [1, 3],
        [3, 4],
        [5, 5],
        [9, 99],
      ]),
    ).toEqual([
      { text: 'abcd', match: true },
      { text: 'ef', match: false },
      { text: 'gh', match: true },
      { text: 'i', match: false },
      { text: 'j', match: true },
    ]);
  });

  it('without ranges: the whole snippet plain (also an empty one)', () => {
    expect(snippetParts('text', [])).toEqual([{ text: 'text', match: false }]);
    expect(snippetParts('', [])).toEqual([{ text: '', match: false }]);
  });
});
