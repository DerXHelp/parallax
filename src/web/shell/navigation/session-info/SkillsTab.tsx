import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, RotateCwIcon } from 'lucide-react';
import { useState } from 'react';
import { parseSessionKey } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { ReloadTarget, SessionInfoOf } from '@shared/model';
import { useFormat } from '@web/i18n';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { Spinner } from '@web/ui/spinner';
import { useInfoT, type InfoKey, type InfoT } from './i18n';
import { ExtraRows, InfoError, SectionFrame, TruncatedNote } from './SectionFrame';
import { useSessionInfo } from './use-session-info';

type Skill = SessionInfoOf<'skills'>['skills'][number];
type Sort = 'none' | 'desc' | 'asc';

const NEXT_SORT: Readonly<Record<Sort, Sort>> = { none: 'desc', desc: 'asc', asc: 'none' };
const ARIA_SORT = { none: 'none', desc: 'descending', asc: 'ascending' } as const;

const STATE_KEY: Readonly<Record<string, InfoKey>> = {
  on: 'skills.states.on',
  'name-only': 'skills.states.nameOnly',
  'user-invocable-only': 'skills.states.userInvocableOnly',
  off: 'skills.states.off',
};

const LOCK_KEY: Readonly<Record<string, InfoKey>> = {
  author: 'skills.locks.author',
  plugin: 'skills.locks.plugin',
  policy: 'skills.locks.policy',
  flag: 'skills.locks.flag',
  'reserved-name': 'skills.locks.reservedName',
};

function stateLabel(it: InfoT, state: string): string {
  const key = STATE_KEY[state];
  return key === undefined ? state : it(key);
}

function lockLabel(it: InfoT, lock: string): string {
  const key = LOCK_KEY[lock];
  return it('skills.lockedBy', { reason: key === undefined ? lock : it(key) });
}

function sorted(skills: readonly Skill[], sort: Sort): readonly Skill[] {
  if (sort === 'none') return skills;
  const sign = sort === 'desc' ? -1 : 1;
  // Unknown token counts last in both directions.
  return [...skills].sort((a, b) => {
    if (a.tokens === null || b.tokens === null) return a.tokens === b.tokens ? 0 : a.tokens === null ? 1 : -1;
    return sign * (a.tokens - b.tokens);
  });
}

interface Outcome {
  what: ReloadTarget;
  error: ErrorPayload | null;
}

/**
 * Skills tab (WP-67): name, source, token estimate and state (with what locks it) of every skill,
 * the sum of the listed ones, sortable by tokens; "Reload skills" / "Reload plugins"
 * (`session.reload`), then the list again.
 */
export function SkillsTab({ sessionKey }: { sessionKey: string }) {
  const it = useInfoT();
  const format = useFormat();
  const query = useSessionInfo(sessionKey, 'skills');
  const [sort, setSort] = useState<Sort>('none');
  const [reloading, setReloading] = useState<ReloadTarget | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const entryId = parseSessionKey(sessionKey)?.entryId ?? null;

  const reload = (what: ReloadTarget): void => {
    if (entryId === null) return;
    setReloading(what);
    setOutcome(null);
    sendCommand(sessionKey, { name: 'session.reload', entryId, what })
      .then(
        () => {
          setOutcome({ what, error: null });
          query.refresh();
        },
        (caught: unknown) => {
          setOutcome({ what, error: errorPayloadOf(caught) });
        },
      )
      .finally(() => {
        setReloading(null);
      });
  };

  const reloadButton = (what: ReloadTarget) => (
    <Button
      size="sm"
      variant="outline"
      data-action={`reload-${what}`}
      disabled={reloading !== null}
      onClick={() => {
        reload(what);
      }}
    >
      {reloading === what ? <Spinner aria-hidden /> : <RotateCwIcon aria-hidden />}
      {it(what === 'skills' ? 'skills.reloadSkills' : 'skills.reloadPlugins')}
    </Button>
  );

  return (
    <SectionFrame
      query={query}
      toolbar={
        <>
          {reloadButton('skills')}
          {reloadButton('plugins')}
        </>
      }
    >
      {(data) => {
        const listed = data.skills.filter((skill) => skill.state !== 'off' && skill.tokens !== null);
        const total = listed.reduce((sum, skill) => sum + (skill.tokens ?? 0), 0);
        const SortIcon = sort === 'desc' ? ArrowDownIcon : sort === 'asc' ? ArrowUpIcon : ArrowUpDownIcon;
        return (
          <div className="grid gap-3">
            {outcome === null ? null : outcome.error === null ? (
              <p role="status" className="text-success text-xs" data-slot="skills-outcome">
                {it(`skills.reloaded.${outcome.what}`)}
              </p>
            ) : (
              <InfoError title={it('skills.reloadFailed')} error={outcome.error} />
            )}
            {data.skills.length === 0 ? (
              <p className="text-muted-foreground text-xs">{it('skills.empty')}</p>
            ) : (
              <>
                <p className="text-muted-foreground text-xs" data-slot="skills-total">
                  {it('skills.total', { tokens: total, count: listed.length })}
                </p>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-muted/50 text-muted-foreground">
                      <tr>
                        <th scope="col" className="px-3 py-1.5 font-medium">
                          {it('skills.name')}
                        </th>
                        <th scope="col" className="px-3 py-1.5 font-medium">
                          {it('skills.source')}
                        </th>
                        <th
                          scope="col"
                          className="px-3 py-1.5 text-right font-medium"
                          aria-sort={ARIA_SORT[sort]}
                        >
                          <Button
                            size="sm"
                            variant="ghost"
                            className="-mr-2 h-6 px-2 text-xs"
                            title={it('skills.sortByTokens')}
                            data-action="skills-sort-tokens"
                            onClick={() => {
                              setSort(NEXT_SORT[sort]);
                            }}
                          >
                            {it('skills.tokens')}
                            <SortIcon aria-hidden />
                          </Button>
                        </th>
                        <th scope="col" className="px-3 py-1.5 font-medium">
                          {it('skills.state')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-border divide-y">
                      {sorted(data.skills, sort).map((skill, index) => (
                        <tr key={`${skill.source}:${skill.name}:${String(index)}`} data-skill={skill.name}>
                          <td className="max-w-64 px-3 py-1.5" title={skill.description}>
                            <span className="block truncate font-mono">{skill.displayName}</span>
                          </td>
                          <td className="text-muted-foreground px-3 py-1.5">{skill.source}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {skill.tokens === null ? '–' : format.number(skill.tokens)}
                          </td>
                          <td className="px-3 py-1.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant={skill.state === 'off' ? 'outline' : 'secondary'}>
                                {stateLabel(it, skill.state)}
                              </Badge>
                              {skill.lockedBy === null ? null : (
                                <span className="text-muted-foreground text-2xs">
                                  {lockLabel(it, skill.lockedBy)}
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <TruncatedNote truncated={data.truncated} />
            <ExtraRows rows={data.extra} />
          </div>
        );
      }}
    </SectionFrame>
  );
}
