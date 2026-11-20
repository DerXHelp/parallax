import { CircleSlashIcon, XIcon } from 'lucide-react';
import { useMemo } from 'react';
import type { ShellKind } from '@shared/model';
import type { TerminalId } from '@shared/terminal';
import { IconButton } from '@web/ui/icon-button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/ui/tabs';
import { useTerminalT } from '../i18n';
import { SHORT_SHELL_KEYS } from '../lib/shells';
import type { TerminalController } from '../state/controller';
import type { TerminalSessionState } from '../state/terminals';
import { AddTerminalMenu } from './AddTerminalMenu';
import { TerminalView } from './TerminalView';

export interface TerminalTabsProps {
  state: TerminalSessionState;
  controller: TerminalController;
  defaultShell: ShellKind;
  onOpen: (shell: ShellKind) => void;
}

/**
 * The strip of terminal tabs ("cmd 1", "PowerShell 1" – × closes) with "+" and below it every
 * terminal's view; only the active one is visible, the others stay mounted (their engines keep the
 * output). A click on a tab also moves the focus into its terminal; arrow keys only switch tabs.
 */
export function TerminalTabs({ state, controller, defaultShell, onOpen }: TerminalTabsProps) {
  const tt = useTerminalT();
  const { items, activeId, numbers } = state;
  const names = useMemo(
    () =>
      new Map<TerminalId, string>(
        items.map((item) => [
          item.terminalId,
          tt('tabs.name', { shell: tt(SHORT_SHELL_KEYS[item.shell]), number: numbers[item.terminalId] ?? 1 }),
        ]),
      ),
    [items, numbers, tt],
  );
  const atLimit = items.length + state.pending.length >= state.limits.perEntry;

  return (
    <Tabs
      value={activeId ?? ''}
      onValueChange={(value) => {
        const item = items.find((candidate) => candidate.terminalId === value);
        if (item !== undefined) controller.select(item.terminalId);
      }}
      className="min-h-0 flex-1 gap-0"
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b pr-1 pl-2">
        <TabsList
          aria-label={tt('tabs.label')}
          className="-mb-px h-8 w-auto min-w-0 flex-1 gap-2 overflow-x-auto overflow-y-hidden border-b-0 [scrollbar-width:none]"
        >
          {items.map((item) => {
            const name = names.get(item.terminalId) ?? '';
            const exited = item.state === 'exited';
            return (
              <span
                key={item.terminalId}
                data-slot="terminal-tab"
                data-terminal-id={item.terminalId}
                data-state={item.state}
                className="flex shrink-0 items-center"
              >
                <TabsTrigger
                  value={item.terminalId}
                  aria-label={exited ? tt('tabs.exited', { name }) : undefined}
                  className="h-8"
                  onClick={() => {
                    controller.focusActive();
                  }}
                >
                  {name}
                  {exited ? <CircleSlashIcon aria-hidden className="text-muted-foreground size-3" /> : null}
                </TabsTrigger>
                <IconButton
                  label={tt('tabs.close', { name })}
                  size="icon-xs"
                  showTooltip={false}
                  data-slot="terminal-tab-close"
                  className="text-muted-foreground"
                  onClick={() => {
                    controller.close(item.terminalId);
                  }}
                >
                  <XIcon aria-hidden />
                </IconButton>
              </span>
            );
          })}
        </TabsList>
        <AddTerminalMenu
          defaultShell={defaultShell}
          atLimit={atLimit}
          max={state.limits.perEntry}
          onOpen={onOpen}
        />
      </div>
      {items.map((item) => (
        <TabsContent
          key={item.terminalId}
          value={item.terminalId}
          forceMount
          tabIndex={-1}
          className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <TerminalView
            info={item}
            name={names.get(item.terminalId) ?? ''}
            active={item.terminalId === activeId}
            controller={controller}
            focusToken={state.focusToken}
            exitReason={state.exitReasons[item.terminalId] ?? null}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}
