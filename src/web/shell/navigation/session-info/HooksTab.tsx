import type { SessionInfoOf } from '@shared/model';
import { revealInvisible } from '@web/lib/invisible';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { useInfoT, type InfoT } from './i18n';
import { sourceLabel } from './labels';
import { ExtraRows, SectionFrame, SettingsErrors, TruncatedNote } from './SectionFrame';
import { useSessionInfo } from './use-session-info';

type Hooks = SessionInfoOf<'hooks'>;
type Hook = Hooks['hooks'][number];

/** The policy and mode notes above the list (managed settings, `--safe-mode`, `--bare`). */
function ModeNotes({ data, it }: { data: Hooks; it: InfoT }) {
  const notes: string[] = [];
  const policy = data.policy;
  if (policy !== null) {
    if (policy.allDisabled) notes.push(it('hooks.allDisabled'));
    if (policy.disabledByPolicy) notes.push(it('hooks.disabledByPolicy'));
    if (policy.managedOnly) notes.push(it('hooks.managedOnly'));
    if (policy.pluginOnly) notes.push(it('hooks.pluginOnly'));
    if (policy.policyUnreadable) notes.push(it('hooks.policyUnreadable'));
  }
  if (data.safeMode !== null) {
    notes.push(it('hooks.safeMode'));
    if (data.safeMode.managedHooksStillApply) notes.push(it('hooks.safeModeManaged'));
  }
  if (data.bareMode !== null) notes.push(it('hooks.bareMode'));
  if (notes.length === 0) return null;
  return (
    <Alert tone="warning" data-slot="hooks-mode">
      <ul className="grid gap-0.5">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </Alert>
  );
}

function HookLine({ hook, it }: { hook: Hook; it: InfoT }) {
  const known = sourceLabel(it, hook.source);
  // An untranslated source: the CLI's own label when it sent one.
  const source = known === hook.source && hook.sourceLabel !== '' ? hook.sourceLabel : known;
  return (
    <li className="grid gap-1 py-1.5" data-hook-type={hook.type} data-disabled={hook.disabled || undefined}>
      <div className="flex flex-wrap items-center gap-1.5 text-2xs">
        <Badge variant="outline">{hook.type}</Badge>
        <span className="text-muted-foreground">
          {hook.pluginName === null ? source : it('hooks.plugin', { name: hook.pluginName })}
        </span>
        {hook.disabled ? <Badge variant="warning">{it('hooks.disabled')}</Badge> : null}
        {hook.once ? <Badge variant="secondary">{it('hooks.once')}</Badge> : null}
        {hook.background ? <Badge variant="secondary">{it('hooks.background')}</Badge> : null}
        {hook.timeoutSec === null ? null : (
          <span className="text-muted-foreground">{it('hooks.timeout', { seconds: hook.timeoutSec })}</span>
        )}
        {hook.condition === null ? null : (
          <span className="text-muted-foreground font-mono">
            {it('hooks.condition', { condition: hook.condition })}
          </span>
        )}
      </div>
      <pre
        className="bg-muted/60 overflow-x-auto rounded-sm px-2 py-1 font-mono text-2xs whitespace-pre-wrap break-all"
        aria-label={hook.contentLabel}
      >
        {revealInvisible(hook.command, { keepLayout: true })}
      </pre>
      {hook.statusMessage === null ? null : (
        <p className="text-muted-foreground text-2xs">{hook.statusMessage}</p>
      )}
    </li>
  );
}

/**
 * Hooks tab (WP-67): the hooks by event (lifecycle order) and matcher, the command in monospace,
 * source/plugin, timeout and condition; notes for managed policy, safe mode and bare mode.
 */
export function HooksTab({ sessionKey }: { sessionKey: string }) {
  const it = useInfoT();
  const query = useSessionInfo(sessionKey, 'hooks');

  return (
    <SectionFrame query={query}>
      {(data) => {
        // Events in the CLI's order, then any event only the hooks name (newer CLI).
        const order = [...data.events.map((event) => event.name)];
        for (const hook of data.hooks) if (!order.includes(hook.event)) order.push(hook.event);
        const summaries = new Map(data.events.map((event) => [event.name, event.summary]));
        return (
          <div className="grid gap-4">
            <ModeNotes data={data} it={it} />
            <SettingsErrors title={it('hooks.errors')} errors={data.errors} />
            {data.hooks.length === 0 ? (
              <p className="text-muted-foreground text-xs">{it('hooks.empty')}</p>
            ) : null}
            {order.map((eventName) => {
              const hooks = data.hooks.filter((hook) => hook.event === eventName);
              if (hooks.length === 0) return null;
              const byMatcher = new Map<string, Hook[]>();
              for (const hook of hooks) {
                const list = byMatcher.get(hook.matcher);
                if (list === undefined) byMatcher.set(hook.matcher, [hook]);
                else list.push(hook);
              }
              const summary = summaries.get(eventName);
              return (
                <section key={eventName} className="grid gap-1.5" data-event={eventName}>
                  <h3 className="flex flex-wrap items-baseline gap-2 text-sm font-medium">
                    <span className="font-mono">{eventName}</span>
                    <span className="text-muted-foreground text-2xs font-normal">
                      {it('hooks.count', { count: hooks.length })}
                    </span>
                  </h3>
                  {summary === undefined || summary === '' ? null : (
                    <p className="text-muted-foreground text-2xs">{summary}</p>
                  )}
                  {[...byMatcher].map(([matcher, list]) => (
                    <div key={matcher} className="grid rounded-md border px-3 py-1" data-matcher={matcher}>
                      <h4 className="text-muted-foreground pt-1 font-mono text-2xs">
                        {matcher === '' ? it('hooks.anyMatcher') : revealInvisible(matcher)}
                      </h4>
                      <ul className="divide-border divide-y">
                        {list.map((hook, index) => (
                          <HookLine key={`${hook.source}:${String(index)}`} hook={hook} it={it} />
                        ))}
                      </ul>
                    </div>
                  ))}
                </section>
              );
            })}
            <TruncatedNote truncated={data.truncated} />
            <ExtraRows rows={data.extra} />
          </div>
        );
      }}
    </SectionFrame>
  );
}
