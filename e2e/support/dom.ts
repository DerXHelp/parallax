/// <reference lib="dom" />
/**
 * DOM types for the callbacks that run in the page (`page.evaluate`, init scripts). The e2e files
 * are type-checked by tsconfig.tools.json (Node: lib ES2024); this reference adds `lib.dom` for
 * them. Wish (coordinator, root configs): an own `e2e/tsconfig.json` with `lib: ["ES2024", "DOM"]`.
 */
export {};
