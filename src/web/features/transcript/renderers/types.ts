import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { JsonValue } from '@shared/common';
import type { ToolCallItem } from '@shared/model';
import type { t } from '@web/i18n';

export type Translate = typeof t;

export interface ToolBodyProps {
  item: ToolCallItem;
  sessionKey: string;
}

export interface ToolPreviewProps {
  toolName: string;
  input: JsonValue;
  sessionKey?: string;
}

export interface ToolFileRef {
  /** As in the input: absolute, Git Bash or relative to the cwd. */
  path: string;
  line: number | null;
}

/**
 * Renderer of one tool (Plan "Chat-Ansicht": one line per tool call, expandable). Everything is
 * optional except the icon; missing parts fall back to the generic renderer (JSON/text). New and
 * MCP tools need no entry at all.
 */
export interface ToolRenderer {
  icon: LucideIcon;
  /** Plain-text summary next to the tool name (command, path, pattern …); null = none. */
  summary?(item: ToolCallItem, t: Translate): string | null;
  /**
   * The file the call works on (Write/Edit/Read/NotebookEdit, WP-55): the line shows it as a
   * `FileLink` (no `verify`) instead of the plain summary; `line` = where the change or read starts.
   */
  file?(item: ToolCallItem): ToolFileRef | null;
  /** Short meta at the end of the line ("+3 −1", "12 files"). */
  meta?(item: ToolCallItem, t: Translate): string | null;
  /** Details when expanded (default: generic input + result). */
  Body?: ComponentType<ToolBodyProps>;
  /** Expanded by default (e.g. small diffs). */
  defaultOpen?(item: ToolCallItem): boolean;
  /** Replaces the whole row (Agent card, plan card). */
  Row?: ComponentType<ToolBodyProps>;
  /** Input preview before the tool runs (ToolInputPreview slot → WP-16 permission cards). */
  Preview?: ComponentType<ToolPreviewProps>;
}
