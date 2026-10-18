/**
 * Windows PowerShell 5.1 helpers for constant scripts (toast, console, autostart – ADR-082, -104,
 * -110): the absolute System32 path (never resolved through the PATH, R1-04) and the
 * `-EncodedCommand` encoding. Scripts are constant; data travels only in environment variables.
 * `powerShellPath` and `POWERSHELL_UTC_ISO_FORMAT` are defined once in lib/process.ts (its process
 * queries use them too, R4-14) and re-exported here.
 */
export { POWERSHELL_UTC_ISO_FORMAT, powerShellPath } from './process';

/** `-EncodedCommand` wants base64 of UTF-16LE. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}
