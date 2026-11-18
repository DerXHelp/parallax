import { useId, type ReactNode } from 'react';

/**
 * One part of "Share" (status, paired computer, pairing, port and address, log): a labelled
 * region with a small heading, an optional hint and actions on the right.
 */
export function Part({
  name,
  heading,
  hint,
  actions,
  children,
}: {
  /** `data-part` for tests and screenshots. */
  name: string;
  heading: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      data-part={name}
      aria-labelledby={headingId}
      className="grid gap-3 border-t pt-5 first:border-t-0 first:pt-0"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="grid min-w-0 gap-1">
          <h4 id={headingId} className="text-xs font-semibold">
            {heading}
          </h4>
          {hint === undefined ? null : (
            <p className="text-muted-foreground text-2xs leading-relaxed">{hint}</p>
          )}
        </div>
        {actions === undefined ? null : <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
