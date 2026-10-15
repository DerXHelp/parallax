import { Fragment } from 'react';
import { useSelectedSession } from '@web/state/hooks';
import { Separator } from '@web/ui/separator';
import { EmptyState } from './EmptyState';
import { SessionPane } from './SessionPane';

/**
 * Pane-capable layout (Plan "Layout": split view is backlog, the component is built for it).
 * Phase 1 shows the selected session only; `panes` lets a later split view pass several keys.
 */
export function PaneLayout({ panes }: { panes?: readonly string[] }) {
  const [selected] = useSelectedSession();
  const keys = panes ?? (selected === null ? [] : [selected]);
  if (keys.length === 0) return <EmptyState />;
  return (
    <div className="flex min-h-0 flex-1">
      {keys.map((key, index) => (
        <Fragment key={key}>
          {index > 0 ? <Separator orientation="vertical" /> : null}
          <div className="min-h-0 min-w-0 flex-1">
            <SessionPane sessionKey={key} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}
