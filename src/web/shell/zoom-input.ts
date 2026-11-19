import { DEFAULT_ZOOM, stepZoom } from '@web/lib/zoom';
import { getZoom, requestZoom } from '@web/state/zoom';
import { shortcuts as defaultRegistry, type ShortcutRegistry } from './shortcuts';

/**
 * Ctrl+wheel and Ctrl+Plus/Minus/0 change `settings.zoom` instead of Chrome's own page zoom (WP-92,
 * ADR-233) – everywhere, also in dialogs and text fields (like Chrome), so not through the shortcut
 * registry (it sleeps while a dialog is open); the registry only lists them in the `?` help.
 *
 * - Ctrl+Plus (`+`, `=`, numpad) / Ctrl+Minus (`-`, numpad): one step, Chrome's zoom is prevented.
 * - Ctrl+0: back to 100 % – deliberately without preventDefault, so Chrome also resets a page zoom
 *   left over from before WP-92 (both end at 100 %).
 * - Ctrl+wheel: one step per WHEEL_STEP_PX of accumulated delta; a touchpad pinch arrives as many
 *   small Ctrl+wheel events and must not race through every step. A wheel event someone else
 *   already handled (the lightbox zooms its picture) is left alone.
 */

/** Accumulated wheel delta (px) for one step – one notch of a mouse wheel. */
export const WHEEL_STEP_PX = 100;
/** A pause longer than this starts a new accumulation. */
export const WHEEL_IDLE_MS = 400;
const LINE_PX = 40;
const PAGE_PX = 800;

export type ZoomKeyAction = 'in' | 'out' | 'reset';

/** What a keydown means for the zoom (null = nothing; AltGr = Ctrl+Alt is never a zoom key). */
export function zoomKeyAction(event: KeyboardEvent): ZoomKeyAction | null {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return null;
  if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') return 'in';
  if (event.key === '-' || event.code === 'NumpadSubtract') return 'out';
  if (event.key === '0' || event.code === 'Numpad0') return 'reset';
  return null;
}

/** Help entries only: the listener below does the work (`run` never handles a key). */
const HELP_ENTRIES = [
  { id: 'shell.zoom.wheel', keys: 'Mod+Wheel', description: 'shell.shortcuts.zoomWheel' },
  { id: 'shell.zoom.in', keys: 'Mod+Plus', description: 'shell.shortcuts.zoomIn' },
  { id: 'shell.zoom.out', keys: 'Mod+Minus', description: 'shell.shortcuts.zoomOut' },
  { id: 'shell.zoom.reset', keys: 'Mod+0', description: 'shell.shortcuts.zoomReset' },
] as const;

/** Installs the key and wheel listeners and the help entries (ShellEffects); returns the cleanup. */
export function installZoomInput(
  target: Window = window,
  registry: ShortcutRegistry = defaultRegistry,
): () => void {
  let accumulated = 0;
  let lastWheelAt = 0;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const action = zoomKeyAction(event);
    if (action === null) return;
    if (action === 'reset') {
      requestZoom(DEFAULT_ZOOM);
      return;
    }
    event.preventDefault();
    requestZoom(stepZoom(getZoom(), action === 'in' ? 1 : -1));
  };

  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey || event.defaultPrevented) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? PAGE_PX : 1;
    const delta = event.deltaY * scale;
    if (delta === 0) return;
    const now = Date.now();
    if (now - lastWheelAt > WHEEL_IDLE_MS || Math.sign(delta) !== Math.sign(accumulated)) accumulated = 0;
    lastWheelAt = now;
    accumulated += delta;
    if (Math.abs(accumulated) < WHEEL_STEP_PX) return;
    // Wheel up (negative delta) zooms in, like Chrome.
    const direction = accumulated < 0 ? 1 : -1;
    accumulated = 0;
    requestZoom(stepZoom(getZoom(), direction));
  };

  // Keys in the capture phase (before any component could stop them); the wheel bubbles, so a
  // handler further in (the lightbox) decides first.
  target.addEventListener('keydown', onKeyDown, { capture: true });
  target.addEventListener('wheel', onWheel, { passive: false });
  const unregister = HELP_ENTRIES.map((entry) =>
    registry.register({ ...entry, allowInInputs: true, run: () => false }),
  );
  return () => {
    target.removeEventListener('keydown', onKeyDown, { capture: true });
    target.removeEventListener('wheel', onWheel);
    for (const remove of unregister) remove();
  };
}
