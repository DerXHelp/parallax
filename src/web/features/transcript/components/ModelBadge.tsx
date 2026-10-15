import { SparklesIcon } from 'lucide-react';
import { useT } from '@web/i18n';
import { useTranscriptSettings } from '../context';

/** Local commands carry this model name (F.8) – never a real model. */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * The model of one assistant message when it differs from the session model (F.6, WP-01: plan
 * mode with Haiku plans on Sonnet). Assistant texts always show it; thinking and tool calls only
 * on the first block of a message (`blockIndex` 0), so a message gets it once or twice, not per block.
 */
export function ModelBadge({ model, blockIndex }: { model: string | null; blockIndex: number | null }) {
  const t = useT();
  const settings = useTranscriptSettings();
  const sessionModel = settings?.sessionModel ?? null;
  if ((blockIndex !== null && blockIndex !== 0) || model === null || model === SYNTHETIC_MODEL) return null;
  if (sessionModel === null || model === sessionModel) return null;
  const label = t('transcript.assistant.model', { model });
  return (
    <span
      data-slot="model-badge"
      title={label}
      className="text-muted-foreground inline-flex max-w-48 shrink-0 items-center gap-1 truncate rounded-sm border px-1 text-2xs"
    >
      <SparklesIcon aria-hidden className="size-3 shrink-0" />
      <span className="sr-only">{label}</span>
      <span aria-hidden className="truncate">
        {model}
      </span>
    </span>
  );
}
