import { useMemo, type ReactNode } from 'react';
import { jsonValueSchema, type JsonValue } from '@shared/common';
import { blobPath } from '@shared/http';
import type { BlobRef, ToolCallItem } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { AnsiText } from '../components/AnsiText';
import { CappedContent, TruncationNotice } from '../components/CappedContent';
import { CodeBlock } from '../components/CodeBlock';
import { useFullText } from '../state/full-text';
import { normalizeTerminalText, resultImages, resultText, stripToolUseError } from '../lib/text';
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

/** Images of a tool result (blobs, same origin – CSP `img-src 'self'`). */
export function ResultImages({ images }: { images: readonly BlobRef[] }) {
  const t = useT();
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((image) =>
        image.mediaType.startsWith('image/') ? (
          <img
            key={image.blobId}
            src={blobPath(image.blobId)}
            alt={t('transcript.user.image', { name: image.name ?? t('transcript.user.unnamed') })}
            width={image.width ?? undefined}
            height={image.height ?? undefined}
            loading="lazy"
            className="max-h-80 max-w-full rounded-md border object-contain"
          />
        ) : null,
      )}
    </div>
  );
}

/**
 * The text result of a tool call (capped, ANSI-safe), error results in the error tone. Returns
 * null when there is no result yet.
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
  const images = resultImages(item);
  const isError = item.result.isError;
  const shown = isError ? stripToolUseError(text) : text;
  const content = (
    <>
      {parts === 0 || shown.trim() === '' ? (
        images.length === 0 ? (
          <p className="text-muted-foreground text-xs italic">
            {emptyLabel ?? t('transcript.tool.noOutput')}
          </p>
        ) : null
      ) : (
        <CappedContent text={shown} truncated={truncated} sessionKey={sessionKey}>
          {(value) => <TerminalOutput text={value} tone={isError ? 'error' : 'default'} />}
        </CappedContent>
      )}
      <ResultImages images={images} />
    </>
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
