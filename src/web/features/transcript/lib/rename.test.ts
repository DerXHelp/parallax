import { describe, expect, it } from 'vitest';
import type { UserMessageItem } from '@shared/model';
import { sampleItems, sampleSystemItems } from '@shared/samples';
import { isRenameReply, renameEchoTitle, renameTitle } from './rename';

/** WP-95: the `/rename <title>` echo and the CLI's answer to it. */

const message = (text: string, patch: Partial<UserMessageItem> = {}) =>
  sampleItems.userMessage({ text: { text, truncated: null }, slashCommand: '/rename', ...patch });

describe('renameTitle', () => {
  it('like the server: /rename, whitespace, a title; anything else null', () => {
    expect(renameTitle('/rename Queued title')).toBe('Queued title');
    expect(renameTitle('  /rename   spaced   out  ')).toBe('spaced   out');
    expect(renameTitle('/rename')).toBeNull();
    expect(renameTitle('/renamex foo')).toBeNull();
    expect(renameTitle('please /rename this')).toBeNull();
  });
});

describe('renameEchoTitle', () => {
  it('the text after /rename, trimmed', () => {
    expect(renameEchoTitle(message('/rename Fix the login flow'))).toBe('Fix the login flow');
    expect(renameEchoTitle(message('  /rename   Release 1.2  \n'))).toBe('Release 1.2');
    expect(renameEchoTitle(message('/rename Bericht „März“', { source: 'remote' }))).toBe('Bericht „März“');
  });

  it('null without a title, for other commands, foreign messages and other items', () => {
    expect(renameEchoTitle(message('/rename'))).toBeNull();
    expect(renameEchoTitle(message('/rename   '))).toBeNull();
    expect(renameEchoTitle(message('/clear', { slashCommand: '/clear' }))).toBeNull();
    expect(renameEchoTitle(message('/rename Title', { origin: 'other', originKind: 'peer' }))).toBeNull();
    expect(renameEchoTitle(message('plain text', { slashCommand: null }))).toBeNull();
    expect(renameEchoTitle(sampleItems.assistantText())).toBeNull();
  });
});

describe('isRenameReply', () => {
  const echo = message('/rename New title');
  const output = sampleSystemItems.local_command_output();

  it('live answer: by its args or right after the echo', () => {
    const reply = sampleItems.assistantText({ localCommand: { command: 'rename', args: 'New title' } });
    expect(isRenameReply(reply, null)).toBe(true);
    const bare = sampleItems.assistantText({ localCommand: { command: 'rename', args: '' } });
    expect(isRenameReply(bare, null)).toBe(false);
    expect(isRenameReply(bare, echo)).toBe(true);
    expect(isRenameReply(sampleItems.assistantText(), echo)).toBe(false);
  });

  it('history answer: the command output right after the echo', () => {
    expect(isRenameReply(output, echo)).toBe(true);
    expect(isRenameReply(output, null)).toBe(false);
    expect(isRenameReply(output, sampleItems.userMessage())).toBe(false);
    expect(isRenameReply(output, message('/rename'))).toBe(false);
    expect(isRenameReply(sampleSystemItems.notification(), echo)).toBe(false);
  });
});
