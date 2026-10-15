import type { JsonValue } from '@shared/common';

/**
 * One-line summary of a tool input for permission cards (Plan "Permission-Karten": tool + input
 * summary). The full input (diff preview for Edit/Write) comes from the `ToolInputPreview` slot
 * (WP-15). Display only – never used to decide anything.
 */

export type InputSummaryKind = 'command' | 'path' | 'url' | 'query' | 'text' | 'json';

export interface InputSummary {
  kind: InputSummaryKind;
  text: string;
}

const SUMMARY_MAX = 400;

/** Tools whose input is a file change: the card shows the diff preview open by default. */
const DIFF_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function isFileChangeTool(toolName: string): boolean {
  return DIFF_TOOLS.has(toolName);
}

function field(input: JsonValue, key: string): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = input[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function clip(text: string): string {
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1)}…`;
}

function compactJson(input: JsonValue): string {
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

/** Command, file path, URL, query … of a tool input, or compact JSON for unknown tools. */
export function summarizeToolInput(toolName: string, input: JsonValue): InputSummary {
  const command = field(input, 'command');
  if (command !== null) return { kind: 'command', text: clip(command) };
  const path = field(input, 'file_path') ?? field(input, 'notebook_path') ?? field(input, 'path');
  const pattern = field(input, 'pattern');
  if (pattern !== null) {
    return { kind: 'query', text: clip(path === null ? pattern : `${pattern} · ${path}`) };
  }
  if (path !== null) return { kind: 'path', text: clip(path) };
  const url = field(input, 'url');
  if (url !== null) return { kind: 'url', text: clip(url) };
  const query = field(input, 'query');
  if (query !== null) return { kind: 'query', text: clip(query) };
  const description = field(input, 'description') ?? field(input, 'prompt');
  if (description !== null && !toolName.startsWith('mcp__')) return { kind: 'text', text: clip(description) };
  return { kind: 'json', text: clip(compactJson(input)) };
}

/** `Bash(mkdir build)` – how a remembered rule reads (CLI notation). */
export function ruleLabel(rule: { toolName: string; ruleContent: string | null }): string {
  return rule.ruleContent === null || rule.ruleContent === ''
    ? rule.toolName
    : `${rule.toolName}(${rule.ruleContent})`;
}
