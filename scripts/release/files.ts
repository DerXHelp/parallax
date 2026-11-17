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
