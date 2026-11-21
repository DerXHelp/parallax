/**
 * The small part of the npm configuration the installer needs for its own download of the Agent SDK
 * (WP-86 §2, docs/wp/WP-83.md §8.2 way 2): the user `.npmrc` (`NPM_CONFIG_USERCONFIG`, else
 * `%USERPROFILE%\.npmrc`, Linux `$HOME/.npmrc`), the registry for a scope and the `Authorization`
 * header for one URL.
 *
 * Parsing follows npm (`ini` + `@npmcli/config`): `key=value` lines, `;`/`#` comments (also after an
 * unquoted value), quoted values, `${VAR}` / `${VAR?}` from the environment in keys and values.
 * Sections (`[name]`) and array keys (`key[]`) carry nothing the download needs and are skipped.
 * Auth keys are nerf-darted (`//host[:port][/path]/:_authToken` …); the longest matching prefix of
 * the requested URL wins, so a token only ever goes to the host it was written for.
 *
 * Environment names (WP-108) like npm: `npm_config_*` in any case on every platform; `${VAR}` and
 * the home folder exactly on POSIX (`platform`, default `process.platform`), case-insensitive on
 * Windows.
 */
import { readFile as nodeReadFile } from 'node:fs/promises';
import path from 'node:path';
import { fsErrorCode } from '../lib/paths';
import { getEnvVar } from '../lib/windows';
import { installPathRules } from './layout';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

/** Parsed `.npmrc`: key → value (after unquoting and `${VAR}` replacement); later lines win. */
export type Npmrc = ReadonlyMap<string, string>;

export type ReadTextFn = (file: string) => Promise<string>;

type Env = Readonly<Record<string, string | undefined>>;

const defaultReadText: ReadTextFn = (file) => nodeReadFile(file, 'utf8');

/** `${NAME}` (kept literally when unset) and `${NAME?}` (empty when unset); `\${` escapes. */
const ENV_EXPR = /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/gu;

/** `npm_config_<name>` in any spelling (npm reads these case-insensitively on every platform). */
function npmConfigVar(env: Env, name: string): string | undefined {
  const wanted = `npm_config_${name}`;
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted && value !== undefined) return value;
  }
  return undefined;
}

export function replaceEnv(text: string, env: Env, platform: NodeJS.Platform = process.platform): string {
  return text.replace(ENV_EXPR, (orig: string, esc: string, name: string, modifier?: string) => {
    if (esc.length % 2 === 1) return orig.slice((esc.length + 1) / 2);
    const value = getEnvVar(env, name, platform) ?? (modifier === '?' ? '' : `\${${name}}`);
    return esc.slice(esc.length / 2) + value;
  });
}

function isQuoted(text: string): boolean {
  return (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  );
}

/** Same rules as `ini`'s `unsafe`: quotes, `\;` `\#` `\\` escapes, `;`/`#` start a comment. */
function unquote(raw: string): string {
  const text = raw.trim();
  if (isQuoted(text)) {
    if (text.startsWith("'")) return text.slice(1, -1);
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'string' ? parsed : text;
    } catch {
      return text;
    }
  }
  let out = '';
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      out += '\\;#'.includes(char) ? char : `\\${char}`;
      escaped = false;
    } else if (char === ';' || char === '#') {
      break;
    } else if (char === '\\') {
      escaped = true;
    } else {
      out += char;
    }
  }
  if (escaped) out += '\\';
  return out.trim();
}

/** `//Registry.Example:8443/npm/:_authToken` → host part lower case (URL hosts are case-insensitive). */
function normalizeKey(key: string): string {
  if (!key.startsWith('//')) return key;
  const slash = key.indexOf('/', 2);
  const colon = key.indexOf(':', 2);
  const end = slash === -1 ? colon : slash;
  if (end === -1) return key;
  return key.slice(0, end).toLowerCase() + key.slice(end);
}

export function parseNpmrc(text: string, env: Env, platform: NodeJS.Platform = process.platform): Npmrc {
  const values = new Map<string, string>();
  let inSection = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    if (/^\[[^\]]*\]$/u.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = replaceEnv(unquote(line.slice(0, eq)), env, platform);
    if (key === '' || key.endsWith('[]')) continue;
    values.set(normalizeKey(key), replaceEnv(unquote(line.slice(eq + 1)), env, platform));
  }
  return values;
}

/**
 * Path of the user config (`NPM_CONFIG_USERCONFIG`, else `.npmrc` in `%USERPROFILE%` resp. `$HOME`),
 * or null when no variable names one. Not checked here (`readNpmrc` checks it).
 */
export function userNpmrcPath(env: Env, platform: NodeJS.Platform = process.platform): string | null {
  const explicit = npmConfigVar(env, 'userconfig');
  if (explicit !== undefined && explicit !== '') return explicit;
  const windows = platform === 'win32';
  const profile = getEnvVar(env, windows ? 'USERPROFILE' : 'HOME', platform);
  if (profile === undefined || profile === '') return null;
  return (windows ? path.win32 : path.posix).join(profile, '.npmrc');
}

/**
 * Reads the user `.npmrc`. Missing file (or no usable path) = empty. A UNC/device/relative path is
 * never touched (an fs call on a UNC path would leak the NTLM hash) and counts as empty.
 */
export async function readNpmrc(
  env: Env,
  readFile: ReadTextFn = defaultReadText,
  platform: NodeJS.Platform = process.platform,
): Promise<Npmrc> {
  const file = userNpmrcPath(env, platform);
  if (file === null || installPathRules(platform).issue(file) !== null) return new Map();
  let text: string;
  try {
    text = await readFile(file);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT' || fsErrorCode(error) === 'ENOTDIR') return new Map();
    throw error;
  }
  return parseNpmrc(text, env, platform);
}

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Registry for a package scope (`@anthropic-ai` or null): `NPM_CONFIG_REGISTRY`/`npm_config_registry`
 * > `<scope>:registry` > `registry` from `.npmrc` > registry.npmjs.org. Always ends with `/`.
 * Not validated here (the caller checks the protocol).
 */
export function registryFor(scope: string | null, npmrc: Npmrc, env: Env): string {
  const candidates = [
    npmConfigVar(env, 'registry'),
    scope === null ? undefined : npmrc.get(`${scope}:registry`),
    npmrc.get('registry'),
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value !== undefined && value !== '') return withSlash(value);
  }
  return DEFAULT_REGISTRY;
}

/** Auth configured exactly at `prefix` (`//host/path/`), in npm's order: token > _auth > user + password. */
function authAt(prefix: string, npmrc: Npmrc): string | null {
  const token = npmrc.get(`${prefix}:_authToken`);
  if (token !== undefined && token !== '') return `Bearer ${token}`;
  const auth = npmrc.get(`${prefix}:_auth`);
  if (auth !== undefined && auth !== '') return `Basic ${auth}`;
  const username = npmrc.get(`${prefix}:username`);
  const password = npmrc.get(`${prefix}:_password`);
  if (username !== undefined && username !== '' && password !== undefined && password !== '') {
    const plain = Buffer.from(password, 'base64').toString('utf8');
    return `Basic ${Buffer.from(`${username}:${plain}`, 'utf8').toString('base64')}`;
  }
  return null;
}

/**
 * `Authorization` header for `url` from the auth keys of `.npmrc`, or null. Walks up the path like
 * npm-registry-fetch (`//host/a/b/`, `//host/a/b`, `//host/a/`, … `//host/`, `//host`): the longest
 * prefix with any auth wins; another host (or port) never matches.
 */
export function authFor(url: string, npmrc: Npmrc): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  let key = `//${parsed.host.toLowerCase()}${parsed.pathname}`;
  while (key.length > 2) {
    const auth = authAt(key, npmrc);
    if (auth !== null) return auth;
    key = key.replace(/(?:[^/]+|\/)$/u, '');
  }
  return null;
}
