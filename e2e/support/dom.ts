/// <reference lib="dom" />
/**
 * DOM types for the callbacks that run in the page (`page.evaluate`, init scripts). The e2e files
 * are type-checked by tsconfig.tools.json (Node: lib ES2024); this reference adds `lib.dom` for
 * them. Wish (coordinator, root configs): an own `e2e/tsconfig.json` with `lib: ["ES2024", "DOM"]`.
 *
 * The recorders of the init scripts live on `window` (R4W-27: typed here instead of
 * `window as unknown as …`); optional – a page without the init script has none of them.
 */

/** A Web Notification as the app created it (support/presence.ts). */
export interface RecordedToast {
  title: string;
  body: string | undefined;
  tag: string | undefined;
  silent: boolean | null | undefined;
}

/** A started oscillator of a notification sound (support/presence.ts). */
export interface RecordedTone {
  type: string;
  frequency: number | null;
}

/** Focus and visibility of the last presence the page sent to the server (support/presence.ts). */
export interface SentPresence {
  focused: boolean;
  visible: boolean;
}

declare global {
  interface Window {
    /** CSP violations go to the test (support/fixtures.ts, exposed function). */
    __e2eCsp?: (blocked: string, detail: string) => void;
    // ---- support/presence.ts (`recordNotifications`) ----
    __e2eFocused?: boolean;
    __e2eVisible?: boolean;
    __e2eToasts?: RecordedToast[];
    __e2eToastObjects?: Notification[];
    __e2eTones?: RecordedTone[];
    __e2ePresence?: SentPresence | null;
    // ---- phase2-sessions.spec.ts (status recorder of the session header) ----
    __e2eStatus?: string[];
  }
}
