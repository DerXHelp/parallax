import { LoaderCircleIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';

/** Busy indicator with an accessible label (default `common.loading`). */
export function Spinner({ className, label, ...props }: ComponentProps<'svg'> & { label?: string }) {
  const t = useT();
  return (
    <LoaderCircleIcon
      role="status"
      aria-label={label ?? t('common.loading')}
      className={cn('size-3.5 motion-safe:animate-spin', className)}
      {...props}
    />
  );
}
