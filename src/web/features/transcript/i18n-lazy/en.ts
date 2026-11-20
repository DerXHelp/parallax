/**
 * Lazy namespace of the transcript (WP-69): texts that only lazily loaded modules use – hook runs
 * (`SystemRow`, `StepGroupRow`), the Agent card's "Transcript", the subagent tab and since WP-95 the
 * notices of newer CLI messages (permission check, missing attachments, held peer messages, the
 * `/rename` echo). Those modules
 * import it, so the texts come with the transcript and subagent chunks, never with the start chunk
 * (start-chunk budget; pattern of WP-67 `useInfoT`). Keys without a namespace prefix:
 * `lt('subagent.finished')`.
 */
export const en = {
  group: {
    /** Hook runs in a step group. */
    hookCount: '{count}× Hook',
    /** WP-95: the running step waits for the automatic permission check. */
    checkingPermission: 'checking permission: {step}',
  },
  tool: {
    /** WP-95: the CLI's automatic permission check holds the call longer than usual. */
    checkingPermission: 'Checking permission…',
  },
  user: {
    /** WP-95: `/rename <title>` passed on to Claude Code (sent by Parallax or typed in the composer). */
    renamed: 'Title passed to Claude Code: {title}',
    /** WP-95: `/rename <title>` typed in the Claude app (Remote Control). */
    renamedRemote: 'Renamed in the Claude app: {title}',
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
    /** WP-95: files a message sent by reference (Remote Control, the Claude app) did not arrive. */
    attachmentsMissing: {
      /** Some of them: {count} missing of {sent}. */
      some: {
        one: '{count} of {sent} attached files did not arrive',
        other: '{count} of {sent} attached files did not arrive',
      },
      /** All of them ({count} files). */
      all: { one: 'The attached file did not arrive', other: 'None of the {count} attached files arrived' },
      /** No count reported. */
      unknown: 'Attached files did not arrive',
      detail: { one: 'Claude continues without it.', other: 'Claude continues without them.' },
    },
    /** WP-95: a message of another session that the receive rule held back ({from} = its sender). */
    peerHold: {
      held: 'Message from {from} held back',
      released: 'Held message from {from} let through',
      dropped: 'Message from {from} not delivered',
      /** A state Parallax does not know, as the CLI sent it. */
      unknownState: 'Message from {from}: {state}',
      /** No sender reported. */
      anotherSession: 'another session',
      /** Why it is held; unknown causes are shown as sent. */
      cause: {
        explicitSetting: 'set in your settings',
        managedSetting: 'required by managed settings',
        repoSetting: 'set in the project settings',
        invalidSetting: 'the setting is invalid',
        bypassDefault: 'default in the mode “Bypass permissions”',
        modeUnknown: 'the sender’s permission mode is not recognized',
        modeMismatch: 'the sender uses a different permission mode',
        noModeAsserted: 'the sender did not state a permission mode',
      },
      /** Why it was not delivered; unknown outcomes are shown as sent. */
      outcome: {
        expired: 'expired',
        refused: 'refused',
        dropped: 'dropped',
        discarded: 'discarded',
      },
    },
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
