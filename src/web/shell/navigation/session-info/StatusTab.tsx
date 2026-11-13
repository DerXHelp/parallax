import { useInfoT } from './i18n';
import { ExtraRows, SectionFrame } from './SectionFrame';
import { useSessionInfo } from './use-session-info';

/**
 * Status tab (WP-67): the rows of the CLI's `/status` screen in its sections and order, values as
 * the CLI rendered them. Never logged or stored (they can carry account data).
 */
export function StatusTab({ sessionKey }: { sessionKey: string }) {
  const it = useInfoT();
  const query = useSessionInfo(sessionKey, 'status');

  return (
    <SectionFrame query={query}>
      {(data) => (
        <div className="grid gap-4">
          {data.groups.length === 0 ? (
            <p className="text-muted-foreground text-xs">{it('status.empty')}</p>
          ) : null}
          {data.groups.map((group, groupIndex) => (
            <section
              key={`${group.title}:${String(groupIndex)}`}
              className="grid gap-1.5"
              data-slot="status-group"
            >
              {group.title === '' ? null : <h3 className="text-sm font-medium">{group.title}</h3>}
              <dl className="grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
                {group.rows.map((row, rowIndex) =>
                  row.label === null ? (
                    <dd key={String(rowIndex)} className="col-span-2 min-w-0 break-words">
                      {row.value}
                    </dd>
                  ) : (
                    <div key={`${row.label}:${String(rowIndex)}`} className="contents">
                      <dt className="text-muted-foreground">{row.label}</dt>
                      <dd className="min-w-0 break-words whitespace-pre-wrap">{row.value}</dd>
                    </div>
                  ),
                )}
              </dl>
            </section>
          ))}
          <ExtraRows rows={data.extra} />
        </div>
      )}
    </SectionFrame>
  );
}
