/**
 * What `release-pack` leaves out of node_modules (WP-85).
 */
import { isLicenseFileName } from './notices';

/**
 * Files in node_modules that no runtime reads: type declarations, TypeScript sources, source maps and
 * Markdown. License and NOTICE files stay (THIRD_PARTY_NOTICES, license terms).
 */
export function isPrunable(name: string): boolean {
  if (isLicenseFileName(name)) return false;
  return /\.(?:[cm]?ts|map|md|markdown)$/iu.test(name);
}

/**
 * Folders directly in a package's root that hold its own test suite, CI setup or benchmarks - never
 * loaded at runtime. They also carry odd names (`@fastify/send` test fixture `snow ☃`, which crashes
 * Windows tar 3.8.9, see `walkPackage`). Only applied at a package root, never deeper.
 */
export function isPrunableFolder(name: string): boolean {
  return /^(?:test|tests|__tests__|\.github|benchmarks?)$/iu.test(name);
}
