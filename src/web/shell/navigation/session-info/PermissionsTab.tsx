import { SearchIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { PERMISSION_BEHAVIORS, type PermissionBehavior, type SessionInfoOf } from '@shared/model';
import { revealInvisible } from '@web/lib/invisible';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { Input } from '@web/ui/input';
import { useInfoT, type InfoT } from './i18n';
import { matchesFilter, sourceLabel } from './labels';
import { ExtraRows, SectionFrame, SettingsErrors, TruncatedNote } from './SectionFrame';
import { useSessionInfo } from './use-session-info';

type Rule = SessionInfoOf<'permissions'>['rules'][number];

function RuleLine({ rule, it }: { rule: Rule; it: InfoT }) {
  const description = rule.description;
  return (
    <li className="grid gap-0.5 py-1" data-rule={rule.rule}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="font-mono text-xs break-all">{revealInvisible(rule.rule)}</code>
        {rule.notInEffect ? <Badge variant="warning">{it('permissions.notInEffect')}</Badge> : null}
        {rule.editability === 'session' ? (
          <Badge variant="secondary">{it('permissions.sessionOnly')}</Badge>
        ) : null}
        {rule.editability === 'readonly' ? (
          <Badge variant="outline">{it('permissions.readOnly')}</Badge>
        ) : null}
      </div>
      {description === null ? null : (
        <p className="text-muted-foreground text-2xs">
          {description.prefix}
          {description.emphasis === null ? null : (
            <strong className="text-foreground ml-1 font-medium">{description.emphasis}</strong>
          )}
          {description.suffix === null ? null : <span className="ml-1">{description.suffix}</span>}
        </p>
      )}
    </li>
  );
}

/** Rules of one behavior, grouped by their source (in the order the CLI lists them). */
function BehaviorGroup({
  behavior,
  rules,
  it,
}: {
  behavior: PermissionBehavior;
  rules: readonly Rule[];
  it: InfoT;
}) {
  const bySource = new Map<string, Rule[]>();
  for (const rule of rules) {
    const list = bySource.get(rule.source);
    if (list === undefined) bySource.set(rule.source, [rule]);
    else list.push(rule);
  }
  return (
    <section className="grid gap-1.5" data-behavior={behavior}>
      <h3 className="flex items-baseline gap-2 text-sm font-medium">
        {it(`permissions.behaviors.${behavior}`)}
        <span className="text-muted-foreground text-2xs font-normal">
          {it('permissions.count', { count: rules.length })}
        </span>
      </h3>
      {[...bySource].map(([source, list]) => (
        <div key={source} className="grid gap-0.5 rounded-md border px-3 py-1.5" data-source={source}>
          <h4 className="text-muted-foreground text-2xs font-medium uppercase">{sourceLabel(it, source)}</h4>
          <ul className="divide-border divide-y">
            {list.map((rule, index) => (
              <RuleLine key={`${rule.rule}:${String(index)}`} rule={rule} it={it} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/**
 * Permissions tab (WP-67): the session's live rules grouped by Allow / Ask / Deny and their source,
 * a filter over rule, reading and source, the working directory and the added ones (read-only).
 */
export function PermissionsTab({ sessionKey }: { sessionKey: string }) {
  const it = useInfoT();
  const query = useSessionInfo(sessionKey, 'permissions');
  const [filter, setFilter] = useState('');
  const filterId = useId();

  return (
    <SectionFrame
      query={query}
      toolbar={
        <div className="relative min-w-48 flex-1">
          <label htmlFor={filterId} className="sr-only">
            {it('permissions.filter')}
          </label>
          <SearchIcon
            aria-hidden
            className="text-muted-foreground absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
          />
          <Input
            id={filterId}
            type="search"
            value={filter}
            placeholder={it('permissions.filterPlaceholder')}
            className="h-8 pl-7 text-xs"
            data-slot="permissions-filter"
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        </div>
      }
    >
      {(data) => {
        const visible = data.rules.filter((rule) =>
          matchesFilter(
            filter,
            rule.rule,
            rule.source,
            sourceLabel(it, rule.source),
            rule.description === null
              ? null
              : [rule.description.prefix, rule.description.emphasis, rule.description.suffix].join(' '),
          ),
        );
        return (
          <div className="grid gap-4">
            {data.managedOnly ? <Alert tone="info">{it('permissions.managedOnly')}</Alert> : null}
            <SettingsErrors title={it('permissions.settingsErrors')} errors={data.errors} />
            {data.rules.length === 0 ? (
              <p className="text-muted-foreground text-xs">{it('permissions.empty')}</p>
            ) : null}
            {data.rules.length > 0 && visible.length === 0 ? (
              <p className="text-muted-foreground text-xs">{it('permissions.noMatch')}</p>
            ) : null}
            {PERMISSION_BEHAVIORS.map((behavior) => {
              const rules = visible.filter((rule) => rule.behavior === behavior);
              return rules.length === 0 ? null : (
                <BehaviorGroup key={behavior} behavior={behavior} rules={rules} it={it} />
              );
            })}
            <TruncatedNote truncated={data.truncated} />
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
              {data.cwd === null ? null : (
                <>
                  <dt className="text-muted-foreground">{it('permissions.cwd')}</dt>
                  <dd className="font-mono break-all" data-slot="permissions-cwd">
                    {revealInvisible(data.cwd)}
                  </dd>
                </>
              )}
              {data.directories.length === 0 ? null : (
                <>
                  <dt className="text-muted-foreground">{it('permissions.directories')}</dt>
                  <dd>
                    <ul className="grid gap-0.5">
                      {data.directories.map((directory) => (
                        <li key={directory.path} className="flex flex-wrap gap-2">
                          <span className="font-mono break-all">{revealInvisible(directory.path)}</span>
                          <span className="text-muted-foreground text-2xs">
                            {sourceLabel(it, directory.source)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </dd>
                </>
              )}
            </dl>
            <ExtraRows rows={data.extra} />
          </div>
        );
      }}
    </SectionFrame>
  );
}
