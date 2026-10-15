/**
 * Types of the i18n dictionaries. A dictionary is a nested object whose leaves are strings or
 * plural forms. Keys are dot paths (`shell.sidebar.label`); a namespace object must not use the
 * key `other` (that marks plural forms).
 */

/** Plural forms after `Intl.PluralRules` categories; `other` is required (fallback). */
export interface PluralForms {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

export type DictionaryLeaf = string | PluralForms;

/** Dot paths of all leaves of a dictionary type (`{ a: { b: string } }` → `'a.b'`). */
export type KeyPaths<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends DictionaryLeaf ? `${Prefix}${K}` : KeyPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Interpolation values: `{name}` in a text. Numbers are formatted for the current language. */
export type TranslationParams = Readonly<Record<string, string | number>>;
