import type { ReactNode } from 'react';
import { cn } from '@web/lib/cn';
import { pathTail } from '@web/lib/path-display';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';

/**
 * The plain-text form of a file reference (WP-54): what `FileLink` shows while its stat check
 * runs, for missing, refused and unsafe paths – and the fallback of the lazy `FileLink` slot
 * (index.ts) while its chunk loads. Kept free of the stat cache and the actions, so the start
 * chunk only carries this file.
 */

export type FileLinkState = 'link' | 'checking' | 'missing' | 'refused' | 'unsafe';

/** Default visible text of a reference: the last two path segments plus `:line`. */
export function defaultFileLinkLabel(path: string, line: number | null): string {
  const tail = pathTail(path, 2);
  return line === null ? tail : `${tail}:${String(line)}`;
}

export function PlainReference({
  state,
  label,
  tooltip,
}: {
  state: Exclude<FileLinkState, 'link'>;
  label: ReactNode;
  tooltip: string | null;
}) {
  const text = (
    <span
      data-slot="file-link"
      data-state={state}
      // A tooltip trigger must be reachable by keyboard (the reason is not only on hover).
      tabIndex={tooltip === null ? undefined : 0}
      className={cn(
        'break-all',
        tooltip !== null && 'decoration-muted-foreground/60 underline decoration-dotted',
      )}
    >
      {label}
    </span>
  );
  if (tooltip === null) return text;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{text}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
