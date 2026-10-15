/**
 * `location.hash` as `&`-separated parameters (`#session=local:en_…&playground=shell`), the format
 * of `takeAuthCodeFromHash` (@shared/http). Keys without `=` are flags (value `null`).
 */
export type HashParams = readonly (readonly [key: string, value: string | null])[];

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `:` stays readable (allowed in fragments), everything else is percent-encoded. */
function encode(value: string): string {
  return encodeURIComponent(value).replaceAll('%3A', ':');
}

export function parseHash(hash: string): HashParams {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const params: (readonly [string, string | null])[] = [];
  for (const part of body.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    params.push(eq < 0 ? [decode(part), null] : [decode(part.slice(0, eq)), decode(part.slice(eq + 1))]);
  }
  return params;
}

/** '' for no parameters, otherwise `#k=v&flag`. */
export function formatHash(params: HashParams): string {
  if (params.length === 0) return '';
  return `#${params.map(([key, value]) => (value === null ? encode(key) : `${encode(key)}=${encode(value)}`)).join('&')}`;
}

/** Value of the first `key`: string, `null` for a flag, `undefined` if absent. */
export function getHashParam(hash: string, key: string): string | null | undefined {
  return parseHash(hash).find(([k]) => k === key)?.[1];
}

/**
 * Sets `key` (replacing every occurrence, keeping the position of the first one) or removes it
 * (`undefined`). `null` writes a flag. Other parameters keep their order.
 */
export function setHashParam(hash: string, key: string, value: string | null | undefined): string {
  const params = parseHash(hash);
  const result: (readonly [string, string | null])[] = [];
  let written = false;
  for (const param of params) {
    if (param[0] !== key) {
      result.push(param);
      continue;
    }
    if (!written && value !== undefined) result.push([key, value]);
    written = true;
  }
  if (!written && value !== undefined) result.push([key, value]);
  return formatHash(result);
}
