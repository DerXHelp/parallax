import { lazy, memo, Suspense } from 'react';
import type { JsonValue } from '@shared/common';
import { useT } from '@web/i18n';
import type { FeatureSlots } from '@web/shell/slots';
import { Skeleton } from '@web/ui/skeleton';
import { Markdown } from './markdown/Markdown';

/**
 * The slots this feature provides (architecture §2.3d): WP-20 spreads `TRANSCRIPT_SLOTS` into
 * `APP_SLOTS` (App.tsx); the playground discovers them via `playground.tsx`. Transcript and
 * ToolInputPreview are lazy chunks (architecture §2.3j, ADR-035: the start bundle stays as it is);
 * Markdown is a small wrapper that loads its renderer lazily itself. A module constant – a new
 * object per render would re-render every slot consumer.
 */

const LazyTranscriptView = lazy(() =>
  import('./TranscriptView').then((module) => ({ default: module.TranscriptView })),
);
const LazyToolInputPreview = lazy(() =>
  import('./ToolInputPreview').then((module) => ({ default: module.ToolInputPreview })),
);

function TranscriptLoading() {
  const t = useT();
  return (
    <div aria-busy="true" aria-label={t('transcript.list.label')} className="flex flex-col gap-3 p-4">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-16 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

/** Slot `Transcript` (lazy `TranscriptView`). */
export const TranscriptSlot = memo(function TranscriptSlot({ sessionKey }: { sessionKey: string }) {
  return (
    <Suspense fallback={<TranscriptLoading />}>
      <LazyTranscriptView sessionKey={sessionKey} />
    </Suspense>
  );
});

/** Slot `ToolInputPreview` (lazy); plain JSON until the renderers have loaded – never HTML. */
export const ToolInputPreviewSlot = memo(function ToolInputPreviewSlot(props: {
  toolName: string;
  input: JsonValue;
  sessionKey?: string;
}) {
  return (
    <Suspense
      fallback={
        <pre className="bg-muted/40 max-h-60 overflow-auto rounded-md border p-2 font-mono text-2xs whitespace-pre-wrap">
          {JSON.stringify(props.input, null, 2)}
        </pre>
      }
    >
      <LazyToolInputPreview {...props} />
    </Suspense>
  );
});

export const TRANSCRIPT_SLOTS: Partial<FeatureSlots> = {
  Transcript: TranscriptSlot,
  Markdown,
  ToolInputPreview: ToolInputPreviewSlot,
};
