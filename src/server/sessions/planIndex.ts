/**
 * CR3-09: which plan versions (`plans/v<N>.md`, ADR-148) exist – without reading the text again
 * for every `plan.list`. The engine wraps the DecisionStore port: a successful `savePlan` and every
 * `readPlan` that found the text mark the version as stored; `planStored` answers known versions
 * from memory and reads an unknown one once (the port has no stat). Unknown, missing and unreadable
 * versions are asked again next time (nothing negative is cached). Only Parallax writes the plan
 * files and an entry's folder is never removed while the server runs, so a known version stays
 * true.
 */
import type { EntryId } from '@shared/common';
import type { DecisionStore } from '../sync/ports';

export interface PlanIndexedDecisionStore extends DecisionStore {
  /** plans/v<N>.md exists (known from this run, else read once); a read error propagates. */
  planStored(entryId: EntryId, version: number): Promise<boolean>;
}

export function withPlanIndex(inner: DecisionStore): PlanIndexedDecisionStore {
  const known = new Map<EntryId, Set<number>>();
  const mark = (entryId: EntryId, version: number): void => {
    let versions = known.get(entryId);
    if (versions === undefined) {
      versions = new Set();
      known.set(entryId, versions);
    }
    versions.add(version);
  };
  // Every call goes to `inner` at call time (tests replace methods of the memory store).
  const readPlan = async (entryId: EntryId, version: number): Promise<string | null> => {
    const text = await inner.readPlan(entryId, version);
    if (text !== null) mark(entryId, version);
    return text;
  };
  return {
    load: (entryId) => inner.load(entryId),
    save: (entryId, records) => {
      inner.save(entryId, records);
    },
    savePlan: async (entryId, version, text) => {
      await inner.savePlan(entryId, version, text);
      mark(entryId, version);
    },
    readPlan,
    flush: () => inner.flush(),
    planStored: async (entryId, version) =>
      known.get(entryId)?.has(version) === true || (await readPlan(entryId, version)) !== null,
  };
}
