/** Small, typed predicates over SDKMessage for the recorder scenarios. */
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSessionStateChangedMessage,
  SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';

export function isInit(message: SDKMessage): message is SDKSystemMessage {
  return message.type === 'system' && message.subtype === 'init';
}

export function isResult(message: SDKMessage): message is SDKResultMessage {
  return message.type === 'result';
}

export function isAssistant(message: SDKMessage): message is SDKAssistantMessage {
  return message.type === 'assistant';
}

export function isState(message: SDKMessage, state?: SDKSessionStateChangedMessage['state']): boolean {
  return (
    message.type === 'system' &&
    message.subtype === 'session_state_changed' &&
    (state === undefined || message.state === state)
  );
}

export interface ToolUseBlock {
  id: string;
  name: string;
  input: unknown;
}

/** tool_use blocks of an assistant message (main thread or subagent). */
export function toolUses(message: SDKMessage): ToolUseBlock[] {
  if (!isAssistant(message)) return [];
  const blocks: ToolUseBlock[] = [];
  for (const block of message.message.content) {
    if (block.type === 'tool_use') blocks.push({ id: block.id, name: block.name, input: block.input });
  }
  return blocks;
}

export function hasToolUse(message: SDKMessage, name: string): boolean {
  return toolUses(message).some((block) => block.name === name);
}

/** Text of an assistant message (all text blocks joined). */
export function assistantText(message: SDKMessage): string {
  if (!isAssistant(message)) return '';
  return message.message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();
}

/** `user_message_uuids` of a result (falls back to user_message_uuid). */
export function resultUuids(message: SDKMessage): string[] {
  if (!isResult(message)) return [];
  if (message.user_message_uuids !== undefined) return message.user_message_uuids;
  return message.user_message_uuid === undefined ? [] : [message.user_message_uuid];
}

export function describe(message: SDKMessage): string {
  const subtype = 'subtype' in message && typeof message.subtype === 'string' ? `/${message.subtype}` : '';
  return `${message.type}${subtype}`;
}
