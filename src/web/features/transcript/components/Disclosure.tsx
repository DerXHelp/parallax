import type { ReactNode } from 'react';
import { Disclosure as DisclosurePrimitive } from '@web/ui/disclosure';
import { useExpanded } from '../state/expansion';

/**
 * One collapsible part of the transcript (Plan "Pro Tool-Call eine Zeile, aufklappbar"): the
 * `Disclosure` primitive (`@web/ui/disclosure`) with the open state kept outside the row – it
 * survives the virtualized list re-mounting the row (`state/expansion.ts`).
 */
export function Disclosure({
  stateKey,
  defaultOpen = false,
  ...props
}: {
  /** `expansionKey(sessionKey, itemId, part)`. */
  stateKey: string;
  defaultOpen?: boolean;
  /** Accessible name of the toggle (from `t()`) when the visible header alone is not enough. */
  label?: string;
  header: ReactNode;
  /** Controls next to the toggle (never inside the button). */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
}) {
  const [open, setOpen] = useExpanded(stateKey, defaultOpen);
  return <DisclosurePrimitive open={open} onOpenChange={setOpen} {...props} />;
}
