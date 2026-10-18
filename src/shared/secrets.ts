/**
 * The one rule for secret environment variable names (ADR-124, R4-07/R4W-09). The server registers
 * the values of such names with the log redaction (R9) and keeps them out of copied console
 * commands (ADR-123); the profile editor masks them. Never duplicate this rule.
 */

/** Name parts (split at every non-alphanumeric character, case-insensitive) that mark a secret. */
export const SECRET_NAME_PARTS: readonly string[] = [
  'KEY',
  'APIKEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'CREDENTIALS',
];

/** Whole names that carry secrets without a marking part (e.g. `Authorization` headers). */
export const SECRET_NAMES: readonly string[] = ['ANTHROPIC_CUSTOM_HEADERS'];

/**
 * True when the value of the env variable `name` is a secret: a name part is one of
 * `SECRET_NAME_PARTS` (`ANTHROPIC_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `GH_TOKEN_CI`), the name
 * contains `PASSWORD` anywhere (`DBPASSWORD`), or it is listed in `SECRET_NAMES`. Not secret:
 * `KEYBOARD_LAYOUT`, `TOKENIZER_PATH`.
 */
export function isSecretEnvKey(name: string): boolean {
  const upper = name.toUpperCase();
  if (SECRET_NAMES.includes(upper) || upper.includes('PASSWORD')) return true;
  return upper.split(/[^A-Z0-9]+/).some((part) => SECRET_NAME_PARTS.includes(part));
}
