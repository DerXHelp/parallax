import type { TranscriptItem } from '@shared/model';

/**
 * WP-95: the `/rename <title>` echo. Parallax itself sends `/rename` to `claude` (automatic title
 * with Remote Control, "Regenerate title", renaming in the UI); the CLI answers with a local command
 * ("Session renamed to: …"). The transcript shows the message as one quiet line and hides the answer.
 */

const RENAME_COMMAND = '/rename';

/**
 * The title of a `/rename <title>` text: the text after the command, trimmed (like the server's
 * `parseRenameCommand`). Null for any other text and a `/rename` without a title.
 */
export function renameTitle(text: string): string | null {
  const match = /^\/rename\s+([\s\S]+)$/.exec(text.trim());
  const title = match?.[1]?.trim() ?? '';
  return title === '' ? null : title;
}

/**
 * The title of a `/rename <title>` message of the user (or of Parallax on their behalf). Null for
 * every other item, a message not typed by the user and a `/rename` without a title (that one stays
 * a normal message).
 */
export function renameEchoTitle(item: TranscriptItem): string | null {
  if (item.kind !== 'user_message' || item.origin !== 'human' || item.slashCommand !== RENAME_COMMAND)
    return null;
  return renameTitle(item.text.text);
}

/**
 * The CLI's answer to a `/rename` with a title: live an assistant text of the local command `rename`
 * (its title as `args`, or right after such a message), in the history the command output right
 * after the `/rename` message. `previous` = the top-level item before `item` (null at the start).
 */
export function isRenameReply(item: TranscriptItem, previous: TranscriptItem | null): boolean {
  const afterEcho = previous !== null && renameEchoTitle(previous) !== null;
  if (item.kind === 'assistant_text') {
    const command = item.localCommand;
    return command !== null && command.command === 'rename' && (afterEcho || command.args.trim() !== '');
  }
  return item.kind === 'system' && item.event === 'local_command_output' && afterEcho;
}
