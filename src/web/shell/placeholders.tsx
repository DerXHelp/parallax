import { LayoutListIcon, MessageSquareIcon, MousePointerClickIcon } from 'lucide-react';
import type { DecisionId, JsonValue } from '@shared/common';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useDecision, useDecisions, useItem, useTopLevelItemIds } from '@web/state/hooks';
import type { ProfilesSettingsSlotProps } from './slots';

/**
 * Neutral stand-ins for feature slots that are not wired yet (architecture §2.3 d/e). WP-20
 * replaces them in App.tsx with the real components of WP-15/16. Safe by construction: plain text
 * only (no Markdown, no HTML).
 */

const PLACEHOLDER_ITEMS = 40;

/** Plain-text line of one item (kind + text); exercises the per-item selector `useItem`. */
function PlainItem({ sessionKey, itemId }: { sessionKey: string; itemId: string }) {
  const item = useItem(sessionKey, itemId);
  if (item === null) return null;
  let label: string = item.kind;
  let text = '';
  let streaming = false;
  switch (item.kind) {
    case 'user_message':
      text = item.text.text;
      break;
    case 'assistant_text':
      text = item.text;
      streaming = item.streaming;
      break;
    case 'thinking':
      text = item.text.text;
      streaming = item.streaming;
      break;
    case 'tool_call':
      label = `${item.kind} · ${item.toolName} · ${item.status}`;
      break;
    case 'system':
      label = `${item.kind} · ${item.event}`;
      break;
    case 'turn_result':
      label = `${item.kind} · ${item.outcome}`;
      break;
  }
  return (
    <li className="grid gap-0.5">
      <code className="text-muted-foreground text-2xs">{label}</code>
      {text === '' && !streaming ? null : (
        <p
          className={cn(
            'text-ui break-words whitespace-pre-wrap',
            item.kind === 'user_message' && 'text-muted-foreground',
          )}
        >
          {text}
          {streaming ? (
            <span
              aria-hidden
              className="bg-foreground/60 ml-0.5 inline-block h-3.5 w-1.5 align-middle motion-safe:animate-pulse"
            />
          ) : null}
        </p>
      )}
    </li>
  );
}

/**
 * Plain-text fallback until WP-15's TranscriptView is wired: the last items as kind + text
 * (never Markdown/HTML), streaming text grows with the deltas.
 */
export function TranscriptPlaceholder({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  // Top-level rows only (subagent items belong under their Agent card, R1W-02).
  const ids = useTopLevelItemIds(sessionKey);
  return (
    <div data-slot="transcript-placeholder" className="flex h-full min-h-0 flex-col">
      <div className="text-muted-foreground flex items-center gap-2 border-b border-dashed px-4 py-1.5 text-2xs">
        <LayoutListIcon aria-hidden className="size-3.5" />
        {t('shell.placeholders.transcript', { count: ids.length })}
      </div>
      <ol className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {ids.slice(-PLACEHOLDER_ITEMS).map((id) => (
          <PlainItem key={id} sessionKey={sessionKey} itemId={id} />
        ))}
      </ol>
    </div>
  );
}

export function DecisionBarPlaceholder({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const count = useDecisions(sessionKey).length;
  if (count === 0) return null;
  return (
    <div
      data-slot="decision-bar-placeholder"
      role="status"
      className="border-status-waiting/40 bg-status-waiting/8 text-foreground mx-3 mb-2 flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
    >
      <MousePointerClickIcon aria-hidden className="text-status-waiting size-3.5" />
      {t('shell.placeholders.decisionBar', { count })}
    </div>
  );
}

export function ComposerPlaceholder(_props: { sessionKey: string }) {
  const t = useT();
  return (
    <div data-slot="composer-placeholder" className="border-t px-3 py-2">
      <div className="text-muted-foreground flex h-14 items-center gap-2 rounded-md border border-dashed px-3 text-xs">
        <MessageSquareIcon aria-hidden className="size-3.5" />
        {t('shell.placeholders.composer')}
      </div>
    </div>
  );
}

export function SidePanelPlaceholder(_props: { sessionKey: string }) {
  return null;
}

/** Phase 2: until WP-38 fills the slot nothing opens (the menu keeps its quick settings). */
export function SettingsPagePlaceholder(_props: { section: string | null; onClose: () => void }) {
  return null;
}

/** Phase 2: until WP-36 fills the slot the settings page shows no profile editor. */
export function ProfilesSettingsPlaceholder(_props: ProfilesSettingsSlotProps) {
  return null;
}

/** Follows the DecisionCard rule (architecture §2.3e): nothing once the decision is resolved. */
export function DecisionCardPlaceholder({
  sessionKey,
  decisionId,
}: {
  sessionKey: string;
  decisionId: DecisionId;
  placement: 'transcript' | 'bar';
}) {
  const t = useT();
  const decision = useDecision(sessionKey, decisionId);
  if (decision === null) return null;
  return (
    <div
      data-slot="decision-card-placeholder"
      className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs"
    >
      {t('shell.placeholders.decisionCard')}
    </div>
  );
}

/** Plain text, line breaks kept – never interpreted as Markdown/HTML. */
export function MarkdownPlaceholder({ text }: { text: string; sessionKey?: string }) {
  return <div className="text-ui break-words whitespace-pre-wrap">{text}</div>;
}

export function ToolInputPreviewPlaceholder({
  input,
}: {
  toolName: string;
  input: JsonValue;
  sessionKey?: string;
}) {
  return (
    <pre className="bg-muted/50 max-h-60 overflow-auto rounded-md p-2 font-mono text-2xs whitespace-pre-wrap">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}
