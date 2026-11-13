/**
 * Lazy namespace of the transcript (WP-69): texts that only lazily loaded modules use – hook runs
 * (`SystemRow`, `StepGroupRow`), the Agent card's "Transcript" and the subagent tab. Those modules
 * import it, so the texts come with the transcript and subagent chunks, never with the start chunk
 * (start-chunk budget; pattern of WP-67 `useInfoT`). Keys without a namespace prefix:
 * `lt('subagent.finished')`.
 */
export const en = {
  group: {
    /** Hook runs in a step group. */
    hookCount: '{count}× Hook',
  },
  agent: {
    openTranscript: 'Transcript',
    openTranscriptLabel: 'Open the transcript of the agent “{title}”',
  },
  system: {
    /** Failed hook runs (exit code 2 = blocking). */
    hookBlockedTool: 'Hook {event} blocked {tool}',
    hookBlocked: 'Hook {name} blocked',
    hookFailed: 'Hook {name} failed',
    hookFailedCode: 'Hook {name} failed (exit code {code})',
    hookOutput: 'Output',
  },
  /** The side panel tab "Agent" – the read-only transcript of one subagent. */
  subagent: {
    label: 'Transcript of the agent “{title}”',
    running: 'Running – updates every few seconds',
    finished: 'Finished',
    count: { one: '{count} entry', other: '{count} entries' },
    loadEarlier: 'Load earlier entries',
    empty: 'The transcript is still empty.',
    failed: 'The transcript could not be loaded.',
    retry: 'Try again',
    refresh: 'Refresh',
  },
};
