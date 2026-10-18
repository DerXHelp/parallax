import { useMemo, type ReactNode } from 'react';
import { jsonValueSchema, type JsonValue } from '@shared/common';
import type { BlobRef, ToolCallItem } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { AnsiText } from '../components/AnsiText';
import { CappedContent, TruncationNotice } from '../components/CappedContent';
import { CodeBlock } from '../components/CodeBlock';
import { ImageThumb } from '../components/ImageThumb';
import { useFullText } from '../state/full-text';
import { normalizeTerminalText, previewImages, resultText, stripToolUseError } from '../lib/text';
import type { Translate } from './types';

/** Building blocks shared by the tool renderers. */

const MCP_PREFIX = 'mcp__';

/** `mcp__<server>__<tool>` → `{ server, tool }`; null for built-in tools. */
export function parseMcpName(toolName: string): { server: string; tool: string } | null {
  if (!toolName.startsWith(MCP_PREFIX)) return null;
  const rest = toolName.slice(MCP_PREFIX.length);
  const split = rest.indexOf('__');
  if (split <= 0 || split + 2 >= rest.length) return null;
  return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

/** Display name of a tool (MCP tools as "tool · MCP server"). */
export function toolLabel(toolName: string, t: Translate): string {
  const mcp = parseMcpName(toolName);
  return mcp === null ? toolName : t('transcript.tool.mcp', { tool: mcp.tool, server: mcp.server });
}

/** A labeled part of a tool body ("Input", "Output" …). */
export function Section({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1', className)}>
      <h4 className="text-muted-foreground text-2xs font-medium tracking-wide uppercase">{label}</h4>
      {children}
    </section>
  );
}

/** Pretty JSON (generic input, structured results). */
export function JsonBlock({ value, label }: { value: JsonValue; label?: string }) {
  const text = JSON.stringify(value, null, 2);
  return <CodeBlock code={text} language="json" label={label ?? 'json'} maxHeightClassName="max-h-72" />;
}

/** Terminal-like output with ANSI colors and the cap notice. */
export function TerminalOutput({
  text,
  tone = 'default',
  className,
}: {
  text: string;
  tone?: 'default' | 'error';
  className?: string;
}) {
  const normalized = normalizeTerminalText(text);
  return (
    <pre
      data-slot="terminal-output"
      data-tone={tone}
      className={cn(
        'bg-muted/40 max-h-80 min-w-0 overflow-auto rounded-md border px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap [font-variant-ligatures:none]',
        tone === 'error' && 'border-destructive/40 bg-destructive/6',
        className,
      )}
    >
      <AnsiText text={normalized} />
    </pre>
  );
}

/**
 * Thumbnails of blob images (same origin – CSP `img-src 'self'`); a click opens the lightbox with
 * the full size. Other media types are skipped.
 */
export function ResultImages({ images, className }: { images: readonly BlobRef[]; className?: string }) {
  if (images.length === 0) return null;
  return (
    <div data-slot="tool-images" className={cn('flex flex-wrap items-start gap-2', className)}>
      {images.map((image, index) =>
        image.mediaType.startsWith('image/') ? (
          <ImageThumb
            key={`${image.blobId}:${String(index)}`}
            image={image}
            className="h-auto max-h-40 w-auto max-w-full object-contain"
          />
        ) : null,
      )}
    </div>
  );
}

/**
 * The pictures of a tool result as thumbnails below the tool line – visible without expanding it
 * and shown exactly once (R4W-03/V3-09, Plan "Bilder in Tool-Ergebnissen … inline als Thumbnail"):
 * the bodies (`ToolResultText`, Read) leave them out. Named after `input.file_path` when the blob
 * has no name (`previewImages`).
 */
export function ToolResultImages({ item, className }: { item: ToolCallItem; className?: string }) {
  return <ResultImages images={previewImages(item)} className={className} />;
}

/**
 * The text result of a tool call (capped, ANSI-safe), error results in the error tone. Returns
 * null when there is no result yet. Images are not part of it (`ToolResultImages` below the line).
 */
export function ToolResultText({
  item,
  sessionKey,
  emptyLabel,
  hideLabel = false,
}: {
  item: ToolCallItem;
  sessionKey: string;
  emptyLabel?: string;
  /** Without the "Result" heading (the caller has its own). */
  hideLabel?: boolean;
}) {
  const t = useT();
  if (item.result === null) return null;
  const { text, truncated, parts } = resultText(item);
  const hasImages = previewImages(item).length > 0;
  const isError = item.result.isError;
  const shown = isError ? stripToolUseError(text) : text;
  // Only pictures: they stand below the tool line – no "No output" here, and no empty section.
  if ((parts === 0 || shown.trim() === '') && hasImages) return null;
  const content =
    parts === 0 || shown.trim() === '' ? (
      <p className="text-muted-foreground text-xs italic">{emptyLabel ?? t('transcript.tool.noOutput')}</p>
    ) : (
      <CappedContent text={shown} truncated={truncated} sessionKey={sessionKey}>
        {(value) => <TerminalOutput text={value} tone={isError ? 'error' : 'default'} />}
      </CappedContent>
    );
  if (hideLabel) return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">{content}</div>;
  return (
    <Section label={isError ? t('transcript.tool.error') : t('transcript.tool.result')}>{content}</Section>
  );
}

/**
 * The tool input – after "Load full text" the uncut input from the blob (the normalizer stores the
 * full input JSON when it cuts long strings, WP-12 `capInput`).
 */
export function useToolInput(item: ToolCallItem): JsonValue {
  const full = useFullText(item.inputTruncated?.blobId ?? null);
  return useMemo(() => {
    if (full.status !== 'done' || full.text === null) return item.input;
    try {
      const raw: unknown = JSON.parse(full.text);
      const parsed = jsonValueSchema.safeParse(raw);
      return parsed.success ? parsed.data : item.input;
    } catch {
      return item.input;
    }
  }, [full, item.input]);
}

/** Notice + "Load full text" for an input whose long strings were cut. */
export function InputCapNotice({ item, sessionKey }: { item: ToolCallItem; sessionKey: string | null }) {
  if (item.inputTruncated === null) return null;
  return <TruncationNotice truncated={item.inputTruncated} sessionKey={sessionKey} kind="input" />;
}

/** First short string value of an input (summary of unknown/MCP tools). */
export function firstStringValue(input: JsonValue): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}
