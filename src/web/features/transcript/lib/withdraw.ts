import { parseSessionKey } from '@shared/common';
import { copyText } from '@web/lib/clipboard';
import { requestShell } from '@web/shell/requests';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { showErrorNotice, showTextNotice } from '@web/state/notices';

/**
 * WP-66 §1.5 „Zurückholen“: takes a waiting message back (`session.withdrawQueued`). Withdrawn →
 * its text goes back into the composer (shell request `composerText`; appended to a draft); without
 * a composer in this window it goes to the clipboard instead, so it is never lost. Already taken
 * over by Claude → the notice "already taken over" (nothing changed). Attachments of the message
 * do not come back (the server returns the text only). Resolves when done; never rejects.
 */
export async function withdrawQueuedMessage(sessionKey: string, messageUuid: string): Promise<void> {
  const entryId = parseSessionKey(sessionKey)?.entryId;
  if (entryId === undefined) return;
  const id = `transcript.withdraw.${sessionKey}`;
  try {
    const result = await sendCommand(sessionKey, { name: 'session.withdrawQueued', entryId, messageUuid });
    if (!result.withdrawn) {
      showTextNotice('transcript.user.alreadyTaken', undefined, { id });
      return;
    }
    const text = result.text ?? '';
    if (text === '' || requestShell({ kind: 'composerText', sessionKey, text })) return;
    const copied = await copyText(text);
    showTextNotice(copied ? 'transcript.user.withdrawnCopied' : 'transcript.code.copyFailed', undefined, {
      id,
      tone: copied ? 'info' : 'error',
    });
  } catch (caught) {
    showErrorNotice(errorPayloadOf(caught), { sessionKey, id });
  }
}
