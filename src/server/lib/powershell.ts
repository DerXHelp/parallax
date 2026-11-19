/**
 * Windows PowerShell 5.1 helpers for constant scripts (toast, console, autostart – ADR-082, -104,
 * -110): the absolute System32 path (never resolved through the PATH, R1-04) and the
 * `-EncodedCommand` encoding. Scripts are constant; data travels only in environment variables.
 * The process queries need no PowerShell (lib/processNative.ts, ADR-229).
 */
import path from 'node:path';
import { systemTool } from './process';

/**
 * `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` – the one place of this path
 * (R4-14).
 */
export function powerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  return systemTool(path.win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe'), env);
}

/**
 * .NET format of `DateTime.ToString(…)` for an ISO-8601 UTC time with milliseconds – no
 * culture-dependent specifier (system/console.ts).
 */
export const POWERSHELL_UTC_ISO_FORMAT = "yyyy-MM-dd'T'HH':'mm':'ss'.'fff'Z'";

/** `-EncodedCommand` wants base64 of UTF-16LE. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}
