import type { ComponentProps } from 'react';
import { cn } from '@web/lib/cn';
import { splitPathTail } from '@web/lib/path-display';

/**
 * The last `count` segments of a path on one line (WP41-02): the segments before the last one
 * shrink with an ellipsis (`parallax-live2-20…\p1`), the last one – the project folder – keeps its
 * full width; only a folder name wider than the whole box is cut itself. The text is exactly
 * `pathTail(path, count)`; the caller shows the full path in its tooltip.
 */
export function PathTail({
  path,
  count = 2,
  className,
  ...props
}: { path: string; count?: number } & Omit<ComponentProps<'span'>, 'children'>) {
  const { head, separator, last } = splitPathTail(path, count);
  return (
    <span className={cn('flex min-w-0', className)} {...props}>
      {head === '' ? null : (
        <span data-slot="path-head" className="min-w-0 truncate">
          {head}
        </span>
      )}
      <span data-slot="path-last" className="max-w-full shrink-0 truncate">
        {separator}
        {last}
      </span>
    </span>
  );
}
