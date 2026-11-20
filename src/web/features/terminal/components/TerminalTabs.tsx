import { ArrowLeftIcon, ArrowRightIcon, CircleSlashIcon, PencilIcon, XIcon } from 'lucide-react';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import type { ShellKind } from '@shared/model';
import { TERMINAL_LIMITS, type TerminalId } from '@shared/terminal';
import { cn } from '@web/lib/cn';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@web/ui/context-menu';
import { IconButton } from '@web/ui/icon-button';
import { Input } from '@web/ui/input';
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

/** Drag data of a terminal tab (its id). Neither files nor links, so the window's drop guard ignores it. */
export const TERMINAL_TAB_DRAG_TYPE = 'application/x-parallax-terminal-tab';

/** Where a dragged tab would land: before or after the tab under the pointer. */
interface DropMark {
  terminalId: TerminalId;
  after: boolean;
}

function draggedTab(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(TERMINAL_TAB_DRAG_TYPE);
}

/** Inline name field of a tab: Enter or leaving it saves, Esc cancels (and stays in the panel). */
function TabNameInput({
  initial,
  label,
  onDone,
}: {
  initial: string;
  label: string;
  onDone: (title: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const [done, setDone] = useState(false);
  const finish = (title: string | null) => {
    if (done) return;
    setDone(true);
    onDone(title);
  };
  return (
    <Input
      data-slot="terminal-tab-name"
      aria-label={label}
      value={value}
      maxLength={TERMINAL_LIMITS.titleMaxChars}
      autoFocus
      onFocus={(event) => {
        event.currentTarget.select();
      }}
      onChange={(event) => {
        setValue(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(value);
        } else if (event.key === 'Escape') {
          // Cancels the edit only – the side panel stays open.
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
      onBlur={() => {
        finish(value);
      }}
      className="h-6 w-36 px-1 text-xs"
    />
  );
}

/**
 * The strip of terminal tabs ("cmd 1", "PowerShell 1", or the name the user gave – × closes) with
 * "+" and below it every terminal's view; only the active one is visible, the others stay mounted
 * (their engines keep the output). A click on a tab also moves the focus into its terminal; arrow
 * keys only switch tabs. A double click, F2 or the tab's context menu renames it (empty = default name);
 * dragging a tab, or "Move left/right" in its context menu, changes the order – both are kept by the
 * server for every window.
 */
export function TerminalTabs({ state, controller, defaultShell, onOpen }: TerminalTabsProps) {
  const tt = useTerminalT();
  const { items, activeId, numbers } = state;
  const [editing, setEditing] = useState<TerminalId | null>(null);
  const [dragging, setDragging] = useState<TerminalId | null>(null);
  const [dropMark, setDropMark] = useState<DropMark | null>(null);
  const pendingRename = useRef<TerminalId | null>(null);
  const defaultNames = useMemo(
    () =>
      new Map<TerminalId, string>(
        items.map((item) => [
          item.terminalId,
          tt('tabs.name', { shell: tt(SHORT_SHELL_KEYS[item.shell]), number: numbers[item.terminalId] ?? 1 }),
        ]),
      ),
    [items, numbers, tt],
  );
  const nameOf = (terminalId: TerminalId, title: string | null): string =>
    title ?? defaultNames.get(terminalId) ?? '';
  const atLimit = items.length + state.pending.length >= state.limits.perEntry;

  const endDrag = () => {
    setDragging(null);
    setDropMark(null);
  };
  const drop = (target: DropMark) => {
    if (dragging === null) return;
    const from = items.findIndex((item) => item.terminalId === dragging);
    const at = items.findIndex((item) => item.terminalId === target.terminalId);
    if (from < 0 || at < 0) return;
    let to = target.after ? at + 1 : at;
    if (from < to) to -= 1;
    controller.move(dragging, to);
  };

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
          {items.map((item, index) => {
            const name = nameOf(item.terminalId, item.title);
            const exited = item.state === 'exited';
            const mark = dropMark?.terminalId === item.terminalId ? dropMark : null;
            return (
              <ContextMenu key={item.terminalId}>
                <ContextMenuTrigger asChild>
                  <span
                    data-slot="terminal-tab"
                    data-terminal-id={item.terminalId}
                    data-state={item.state}
                    data-dragging={dragging === item.terminalId ? 'true' : undefined}
                    data-drop={mark === null ? undefined : mark.after ? 'after' : 'before'}
                    className={cn(
                      'flex shrink-0 items-center border-x-2 border-transparent',
                      dragging === item.terminalId && 'opacity-50',
                      mark !== null && (mark.after ? 'border-r-brand' : 'border-l-brand'),
                    )}
                    onDragOver={(event) => {
                      if (!draggedTab(event) || dragging === null) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      const box = event.currentTarget.getBoundingClientRect();
                      const after = event.clientX > box.left + box.width / 2;
                      if (mark?.after !== after) setDropMark({ terminalId: item.terminalId, after });
                    }}
                    onDrop={(event) => {
                      if (!draggedTab(event)) return;
                      event.preventDefault();
                      drop(mark ?? { terminalId: item.terminalId, after: false });
                      endDrag();
                    }}
                  >
                    {editing === item.terminalId ? (
                      <TabNameInput
                        initial={item.title ?? ''}
                        label={tt('tabs.nameLabel', { name })}
                        onDone={(title) => {
                          setEditing(null);
                          if (title !== null) controller.rename(item.terminalId, title);
                          controller.focusActive();
                        }}
                      />
                    ) : (
                      <TabsTrigger
                        value={item.terminalId}
                        aria-label={exited ? tt('tabs.exited', { name }) : undefined}
                        title={tt('tabs.hint')}
                        className="h-8 max-w-48"
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData(TERMINAL_TAB_DRAG_TYPE, item.terminalId);
                          event.dataTransfer.effectAllowed = 'move';
                          setDragging(item.terminalId);
                        }}
                        onDragEnd={endDrag}
                        onClick={(event) => {
                          // The second click of a double click renames instead.
                          if (event.detail < 2) controller.focusActive();
                        }}
                        onDoubleClick={() => {
                          setEditing(item.terminalId);
                        }}
                        onKeyDown={(event) => {
                          // F2 on a tab renames the terminal (handled here, the session's F2 stays out).
                          if (event.key === 'F2') {
                            event.preventDefault();
                            setEditing(item.terminalId);
                          }
                        }}
                      >
                        <span className="truncate">{name}</span>
                        {exited ? (
                          <CircleSlashIcon aria-hidden className="text-muted-foreground size-3" />
                        ) : null}
                      </TabsTrigger>
                    )}
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
                </ContextMenuTrigger>
                <ContextMenuContent
                  className="min-w-44"
                  onCloseAutoFocus={(event) => {
                    // "Rename": the name field opens once the menu gave the focus back (it would
                    // take the focus from the field and so end the edit at once).
                    if (pendingRename.current === item.terminalId) {
                      event.preventDefault();
                      pendingRename.current = null;
                      setEditing(item.terminalId);
                    }
                  }}
                >
                  <ContextMenuItem
                    data-action="terminal-tab-rename"
                    onSelect={() => {
                      pendingRename.current = item.terminalId;
                    }}
                  >
                    <PencilIcon aria-hidden />
                    {tt('tabs.rename')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    data-action="terminal-tab-left"
                    disabled={index === 0}
                    onSelect={() => {
                      controller.move(item.terminalId, index - 1);
                    }}
                  >
                    <ArrowLeftIcon aria-hidden />
                    {tt('tabs.moveLeft')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    data-action="terminal-tab-right"
                    disabled={index === items.length - 1}
                    onSelect={() => {
                      controller.move(item.terminalId, index + 1);
                    }}
                  >
                    <ArrowRightIcon aria-hidden />
                    {tt('tabs.moveRight')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    data-action="terminal-tab-close"
                    onSelect={() => {
                      controller.close(item.terminalId);
                    }}
                  >
                    <XIcon aria-hidden />
                    {tt('menu.close')}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
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
            name={nameOf(item.terminalId, item.title)}
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
