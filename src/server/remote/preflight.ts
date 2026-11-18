/**
 * The "Several computers" part of `pnpm preflight` (WP-82, docs/wp/WP-75.md §4.2): the same building
 * blocks as the checks in the app (remote/checks.ts) – TLS self-test (ML-KEM, ML-DSA), the Windows key
 * store (DPAPI) and, for the role "Share", port and addresses. Strictly read-only: the role
 * comes from `multi-host.json` without quarantine or migration, no key is created, nothing listens
 * longer than the port probe. English output like the rest of the preflight.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_MULTI_HOST_CONFIG,
  MULTI_HOST_SCHEMA_VERSION,
  multiHostFileSchema,
  type MultiHostConfig,
} from '@shared/model';
import type { PreflightCheck, PreflightLevel } from '../claude/preflight';
import { fsErrorCode } from '../lib/paths';
import type { SelfTestFailure } from '../secure/selfTest';
import type { PortProbe } from './checks';

/** File name of the role settings (multihost/store.ts MULTI_HOST_FILE, kept literal: no store import). */
const MULTI_HOST_FILE = 'multi-host.json';

export type MultiHostRoleSource =
  | { kind: 'file'; config: MultiHostConfig }
  | { kind: 'missing' }
  | { kind: 'unusable'; reason: 'json' | 'schema' | 'newer' | 'read' };

export interface MultiHostPreflightDeps {
  /** The data folder (null: not determined – the role counts as off). */
  home: string | null;
  readText?: (file: string) => Promise<string>;
  selfTest: () => Promise<SelfTestFailure | null>;
  keyStoreAvailable: () => Promise<boolean>;
  /** Addresses a listener on `bindAddress` is reachable at (remote/addresses.ts listenerAddresses). */
  addresses: (bindAddress: string) => string[];
  probe: (address: string, port: number) => Promise<PortProbe>;
}

/** Reads the role without touching the file (no quarantine, unlike the server's store). */
export async function readMultiHostRole(
  home: string,
  readText: (file: string) => Promise<string> = (file) => readFile(file, 'utf8'),
): Promise<MultiHostRoleSource> {
  let text: string;
  try {
    text = await readText(path.join(home, MULTI_HOST_FILE));
  } catch (error) {
    return fsErrorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unusable', reason: 'read' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'unusable', reason: 'json' };
  }
  const version =
    typeof raw === 'object' && raw !== null && 'schemaVersion' in raw ? raw.schemaVersion : undefined;
  if (typeof version === 'number' && version > MULTI_HOST_SCHEMA_VERSION)
    return { kind: 'unusable', reason: 'newer' };
  const parsed = multiHostFileSchema.safeParse(raw);
  return parsed.success
    ? { kind: 'file', config: parsed.data.config }
    : { kind: 'unusable', reason: 'schema' };
}

function roleCheck(source: MultiHostRoleSource): PreflightCheck {
  const base = { id: 'multihost-role', title: 'Several computers' };
  if (source.kind === 'missing') return { ...base, level: 'info', detail: 'role off (default)' };
  if (source.kind === 'unusable') {
    return {
      ...base,
      level: 'warn',
      detail: `${MULTI_HOST_FILE} not usable (${source.reason}) - the server starts with role off`,
      hint:
        source.reason === 'newer'
          ? 'written by a newer Parallax version; update Parallax'
          : 'choose the role again in Settings > Several computers',
    };
  }
  const { role, port, bindAddress } = source.config;
  const detail = role === 'share' ? `role share (port ${port}, address ${bindAddress})` : `role ${role}`;
  return { ...base, level: role === 'off' ? 'info' : 'ok', detail };
}

export async function multiHostPreflight(deps: MultiHostPreflightDeps): Promise<PreflightCheck[]> {
  const source: MultiHostRoleSource =
    deps.home === null ? { kind: 'missing' } : await readMultiHostRole(deps.home, deps.readText);
  const config = source.kind === 'file' ? source.config : DEFAULT_MULTI_HOST_CONFIG;
  const active = config.role !== 'off';
  // Needed only for a role: without one a problem is a hint for later, not a failure.
  const missing: PreflightLevel = active ? 'fail' : 'warn';
  const checks: PreflightCheck[] = [roleCheck(source)];

  const selfTest = await deps.selfTest().catch((): SelfTestFailure => 'handshake');
  checks.push(
    selfTest === null
      ? {
          id: 'multihost-tls',
          title: 'Remote TLS',
          level: 'ok',
          detail: 'TLS 1.3 with ML-KEM and ML-DSA works',
        }
      : {
          id: 'multihost-tls',
          title: 'Remote TLS',
          level: missing,
          detail: `self-test failed (${selfTest})`,
          hint: 'this Node.js lacks ML-KEM/ML-DSA; update Node.js',
        },
  );
  const keyStore = await deps.keyStoreAvailable().catch(() => false);
  checks.push(
    keyStore
      ? { id: 'multihost-keystore', title: 'Key store', level: 'ok', detail: 'Windows DPAPI available' }
      : {
          id: 'multihost-keystore',
          title: 'Key store',
          level: missing,
          detail: 'Windows DPAPI not available - keys cannot be stored safely',
          hint: 'needs Node.js 26.9 or newer (node:ffi) on Windows x64',
        },
  );
  if (config.role !== 'share') return checks;

  const probe = await deps.probe(config.bindAddress, config.port);
  if (probe === 'ok') {
    checks.push({ id: 'multihost-port', title: 'Remote port', level: 'ok', detail: `${config.port} free` });
  } else if (probe === 'port_in_use') {
    checks.push({
      id: 'multihost-port',
      title: 'Remote port',
      level: 'warn',
      detail: `${config.port} in use`,
      hint: 'fine while this Parallax shares; otherwise choose another port in the settings',
    });
  } else {
    checks.push({
      id: 'multihost-port',
      title: 'Remote port',
      level: 'fail',
      detail: `cannot listen on ${config.bindAddress}:${config.port}`,
      hint: 'the address does not belong to this computer; choose another one in the settings',
    });
  }
  const addresses = deps.addresses(config.bindAddress);
  checks.push(
    addresses.length > 0
      ? { id: 'multihost-addresses', title: 'Addresses', level: 'ok', detail: addresses.join(', ') }
      : {
          id: 'multihost-addresses',
          title: 'Addresses',
          level: 'warn',
          detail: 'no network address found',
          hint: 'the other computer cannot reach this one',
        },
  );
  // No firewall query (ADR-228): the user sets up the Windows Firewall; a reminder only.
  checks.push({
    id: 'multihost-firewall',
    title: 'Firewall',
    level: 'info',
    detail: 'not checked by Parallax',
    hint: `allow inbound TCP ${String(config.port)} for Node.js in private networks (Windows Firewall)`,
  });
  return checks;
}
