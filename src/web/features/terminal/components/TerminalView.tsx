import { ClipboardPasteIcon, CopyIcon, EraserIcon, RotateCcwIcon, TextSelectIcon, XIcon } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { TerminalExitReason, TerminalInfo } from '@shared/terminal';
import { useT } from '@web/i18n';
import { shortcuts, shortcutKeyLabels } from '@web/shell/shortcuts';
import { useZoom } from '@web/state/zoom';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@web/ui/context-menu';
import { useTerminalT } from '../i18n';
import type { TerminalController } from '../state/controller';
import { useTerminalEnvironment } from '../state/environment';
import { setScreenReaderMode, useScreenReaderMode } from '../state/terminals';
import { TerminalViewRuntime } from '../state/view';
import { ExitBar } from './ExitBar';

export interface TerminalViewProps {
  info: TerminalInfo;
  /** Tab name ("cmd 1"). */
  name: string;
  active: boolean;
  controller: TerminalController;
  /** Raised when the active terminal should take the focus. */
  focusToken: number;
  exitReason: TerminalExitReason | null;
}

/** Esc inside the terminal belongs to the shell: handled (nothing to do), so the side panel stays open. */
const keepEscape = () => true;

/**
 * Focus may move into the terminal only from nowhere or from inside the side panel – never away from
 * the composer or another pane the user went to while the socket connected.
 */
function mayTakeFocus(root: HTMLElement): boolean {
  const focused = root.ownerDocument.activeElement;
  if (focused === null || focused === root.ownerDocument.body) return true;
  const area = root.closest('[data-slot="side-panel"]') ?? root.closest('[data-slot="terminal-panel"]');
  return area?.contains(focused) === true;
}

/**
 * One terminal (WP-99b): the engine (xterm) in a host with the context menu, the exit bar once the
 * shell ended. The engine opens when the view is active for the first time and stays while the view
 * is mounted (hidden behind other tabs it keeps receiving output). Root `data-slot="terminal-view"`
 * with `data-active="true"` – the shell's Alt+T focuses its `.xterm-helper-textarea`.
 */
export function TerminalView({ info, name, active, controller, focusToken, exitReason }: TerminalViewProps) {
  const tt = useTerminalT();
  const t = useT();
  const env = useTerminalEnvironment();
  const zoom = useZoom();
  const screenReader = useScreenReaderMode();
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<TerminalViewRuntime | null>(null);
  const [everActive, setEverActive] = useState(active);
  if (active && !everActive) setEverActive(true);
  const [hasSelection, setHasSelection] = useState(false);
  const [pasteFailed, setPasteFailed] = useState(false);
  const { terminalId } = info;
  const running = info.state === 'running';

  // Esc stays in the terminal: the newest Esc handler of the registry wins, so it is pushed again
  // whenever the focus enters the terminal (after the side panel's handler). `focus` in the capture
  // phase sees the focus of xterm's text area. Declared before the effects that open and focus the
  // engine, so the listener is there for the first focus.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    let remove: (() => void) | null = null;
    const onFocus = () => {
      remove?.();
      remove = shortcuts.pushEscape(keepEscape, { scopeRef: hostRef });
    };
    host.addEventListener('focus', onFocus, true);
    if (host.contains(host.ownerDocument.activeElement)) onFocus();
    return () => {
      host.removeEventListener('focus', onFocus, true);
      remove?.();
    };
  }, []);

  const onInput = useEffectEvent((data: string) => {
    if (info.state === 'running') controller.input(terminalId, data);
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!everActive || host === null) return undefined;
    const runtime = new TerminalViewRuntime({
      host,
      env,
      controller,
      terminalId,
      onInput: (data) => {
        onInput(data);
      },
    });
    runtimeRef.current = runtime;
    return () => {
      runtime.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [everActive, env, controller, terminalId]);

  useEffect(() => {
    runtimeRef.current?.updateFont();
  }, [zoom]);

  useEffect(() => {
    runtimeRef.current?.setScreenReaderMode(screenReader);
  }, [screenReader]);

  useEffect(() => {
    const root = rootRef.current;
    if (!active || root === null || !mayTakeFocus(root)) return;
    runtimeRef.current?.focus();
  }, [active, focusToken]);

  const restart = () => {
    controller.restart(terminalId);
  };
  const close = () => {
    controller.close(terminalId);
  };
  const paste = () => {
    const runtime = runtimeRef.current;
    if (runtime === null) return;
    void runtime.paste().then((ok) => {
      setPasteFailed(!ok);
    });
  };

  return (
    <div
      ref={rootRef}
      data-slot="terminal-view"
      data-active={active ? 'true' : 'false'}
      data-terminal-id={terminalId}
      data-state={info.state}
      role="group"
      aria-label={tt('view.label', { name })}
      className="flex min-h-0 flex-1 flex-col"
    >
      <ContextMenu
        onOpenChange={(open) => {
          if (open) setHasSelection(runtimeRef.current?.engine?.hasSelection() ?? false);
        }}
      >
        <ContextMenuTrigger asChild>
          <div data-slot="terminal-screen" className="relative min-h-0 flex-1 bg-(--terminal-background)">
            {/* No padding on the host: the fit addon measures it. */}
            <div
              ref={hostRef}
              data-slot="terminal-host"
              className="absolute top-1 right-0 bottom-1 left-2 font-mono text-xs"
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          className="min-w-52"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            runtimeRef.current?.focus();
          }}
        >
          <ContextMenuItem
            data-action="terminal-copy"
            disabled={!hasSelection}
            onSelect={() => {
              runtimeRef.current?.copySelection();
            }}
          >
            <CopyIcon aria-hidden />
            {tt('menu.copy')}
            <ContextMenuShortcut>{shortcutKeyLabels('Mod+C', t).join('+')}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem data-action="terminal-paste" disabled={!running} onSelect={paste}>
            <ClipboardPasteIcon aria-hidden />
            {tt('menu.paste')}
            <ContextMenuShortcut>{shortcutKeyLabels('Mod+V', t).join('+')}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            data-action="terminal-select-all"
            onSelect={() => {
              runtimeRef.current?.engine?.selectAll();
            }}
          >
            <TextSelectIcon aria-hidden />
            {tt('menu.selectAll')}
          </ContextMenuItem>
          <ContextMenuItem
            data-action="terminal-clear"
            onSelect={() => {
              runtimeRef.current?.engine?.clear();
            }}
          >
            <EraserIcon aria-hidden />
            {tt('menu.clear')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem
            data-action="terminal-screen-reader"
            checked={screenReader}
            onCheckedChange={(checked) => {
              setScreenReaderMode(checked);
            }}
          >
            {tt('menu.screenReader')}
          </ContextMenuCheckboxItem>
          <ContextMenuSeparator />
          <ContextMenuItem data-action="terminal-restart" onSelect={restart}>
            <RotateCcwIcon aria-hidden />
            {tt('menu.restart')}
          </ContextMenuItem>
          <ContextMenuItem data-action="terminal-close" variant="destructive" onSelect={close}>
            <XIcon aria-hidden />
            {tt('menu.close')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {pasteFailed ? (
        <div className="shrink-0 border-t p-2">
          <Alert
            tone="warning"
            data-slot="terminal-paste-failed"
            title={tt('menu.pasteFailed')}
            actions={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPasteFailed(false);
                }}
              >
                {tt('panel.dismiss')}
              </Button>
            }
          />
        </div>
      ) : null}
      {running ? null : (
        <ExitBar exitCode={info.exitCode} reason={exitReason} onRestart={restart} onClose={close} />
      )}
    </div>
  );
}
