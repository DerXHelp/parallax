/**
 * Embedded terminal (WP-99, ADR-239): protocol v1 of the socket `API_PATHS.terminalWs`. One socket per
 * mounted terminal panel, bound to one entry by `hello`; a shell runs in a pseudo console on this
 * computer (ConPTY, `src/server/terminal`). Never for sessions of another computer: the route is not
 * in `HOST_API_PATHS`, the forwarder never passes it on.
 *
 * - Client → server: JSON text frames (`terminalClientMessageSchema`). Keys travel as `input` text.
 * - Server → client: JSON text frames (`terminalServerMessageSchema`) and binary output frames
 *   `[channel u8][UTF-8 bytes]`; `attached` names the channel of a terminal on this socket. The bytes
 *   of one frame may end inside a UTF-8 sequence (the terminal decodes as a stream).
 * - Order: `hello` → `welcome` + `terminals`; `open` → `opened` (or `error` with `requestId`);
 *   `attach` → `attached`, then the replay (scrollback) and live output as binary frames.
 * - `terminals` is pushed on every change of the entry's list (open, exit, close, rename, move); its
 *   order is the order of the tabs (`move` changes it for every window).
 * - Exited terminals stay listed (`state: 'exited'`) until `close`, so the panel can show the exit
 *   code and offer "Restart".
 */
import { z } from 'zod';
import { entryIdSchema, isoDateTimeSchema } from './common';
import { errorPayloadSchema } from './errors';
import { shellKindSchema } from './model';

export const TERMINAL_PROTOCOL_VERSION = 1;

export const TERMINAL_LIMITS = {
  /** Terminals per entry (running or exited, until closed). */
  perEntry: 4,
  /** Terminals on this computer. */
  total: 16,
  /** Output kept per terminal for the replay after `attach`. */
  scrollbackBytes: 262_144,
  /** Characters of one `input` message. */
  inputMaxChars: 65_536,
  colsMin: 2,
  colsMax: 500,
  rowsMin: 1,
  rowsMax: 300,
  /** Client-chosen id of an `open` request. */
  requestIdMaxChars: 64,
  /** Highest output channel number (one byte). */
  channelMax: 255,
  /** Characters of a terminal name chosen by the user (`rename`). */
  titleMaxChars: 64,
} as const;

/** WebSocket close codes of the terminal socket. */
export const TERMINAL_CLOSE_CODES = {
  /** Too many invalid messages, or a message before `hello`. */
  invalid: 4400,
  /** The device lost its sign-in (`auth.onRevoked`). */
  unauthorized: 4401,
  /** `hello` named an entry this computer does not know. */
  entryNotFound: 4404,
  /** Protocol version not supported. */
  protocol: 4426,
  /** The socket did not keep up (output backlog over the limit); the client reconnects. */
  overloaded: 1013,
} as const;

/** `tm_` + 32 hex (server-generated). */
export const terminalIdSchema = z.string().regex(/^tm_[0-9a-f]{32}$/);
export type TerminalId = z.infer<typeof terminalIdSchema>;

const colsSchema = z.number().int().min(TERMINAL_LIMITS.colsMin).max(TERMINAL_LIMITS.colsMax);
const rowsSchema = z.number().int().min(TERMINAL_LIMITS.rowsMin).max(TERMINAL_LIMITS.rowsMax);
const requestIdSchema = z.string().min(1).max(TERMINAL_LIMITS.requestIdMaxChars);

export const TERMINAL_STATES = ['running', 'exited'] as const;
export const terminalStateSchema = z.enum(TERMINAL_STATES);
export type TerminalState = z.infer<typeof terminalStateSchema>;

/** Why a terminal ended: the shell exited, `close`, the entry was archived or removed, the server stops, or the start failed. */
export const TERMINAL_EXIT_REASONS = [
  'exited',
  'closed',
  'archived',
  'removed',
  'shutdown',
  'failed',
] as const;
export const terminalExitReasonSchema = z.enum(TERMINAL_EXIT_REASONS);
export type TerminalExitReason = z.infer<typeof terminalExitReasonSchema>;

export const terminalInfoSchema = z.object({
  terminalId: terminalIdSchema,
  entryId: entryIdSchema,
  shell: shellKindSchema,
  /** Folder the shell started in (the entry's `cwd` at that time). */
  cwd: z.string(),
  createdAt: isoDateTimeSchema,
  cols: colsSchema,
  rows: rowsSchema,
  state: terminalStateSchema,
  /** Set once `state` is `exited` (null if unknown). */
  exitCode: z.number().int().nullable(),
  /** Name chosen by the user (`rename`); null = the default name of the tab ("cmd 1"). */
  title: z.string().min(1).max(TERMINAL_LIMITS.titleMaxChars).nullable().default(null),
});
export type TerminalInfo = z.infer<typeof terminalInfoSchema>;

// ---- client → server ----

export const terminalClientMessageSchema = z.discriminatedUnion('type', [
  /** First message: protocol version and the entry this socket serves. */
  z.object({ type: z.literal('hello'), protocol: z.number().int(), entryId: entryIdSchema }),
  /** Start a shell in the entry's folder. */
  z.object({
    type: z.literal('open'),
    requestId: requestIdSchema,
    shell: shellKindSchema,
    cols: colsSchema,
    rows: rowsSchema,
  }),
  /** Receive the output of a terminal of this entry: replay of the scrollback, then live. */
  z.object({ type: z.literal('attach'), terminalId: terminalIdSchema, cols: colsSchema, rows: rowsSchema }),
  /** Stop receiving its output (the shell keeps running). */
  z.object({ type: z.literal('detach'), terminalId: terminalIdSchema }),
  z.object({
    type: z.literal('input'),
    terminalId: terminalIdSchema,
    data: z.string().min(1).max(TERMINAL_LIMITS.inputMaxChars),
  }),
  z.object({ type: z.literal('resize'), terminalId: terminalIdSchema, cols: colsSchema, rows: rowsSchema }),
  /** End the shell (if running) and remove the terminal from the list. */
  z.object({ type: z.literal('close'), terminalId: terminalIdSchema }),
  /** Name the terminal (trimmed by the server; empty or null = back to the default name). */
  z.object({
    type: z.literal('rename'),
    terminalId: terminalIdSchema,
    title: z.string().max(TERMINAL_LIMITS.titleMaxChars).nullable(),
  }),
  /** Move the terminal to position `index` of the entry's list (clamped to the list). */
  z.object({
    type: z.literal('move'),
    terminalId: terminalIdSchema,
    index: z
      .number()
      .int()
      .min(0)
      .max(TERMINAL_LIMITS.perEntry - 1),
  }),
]);
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;

// ---- server → client ----

export const terminalServerMessageSchema = z.discriminatedUnion('type', [
  /** Answer to `hello`. `available: false` (no ConPTY, `node:ffi` missing) carries the reason as an error. */
  z.object({
    type: z.literal('welcome'),
    protocol: z.literal(TERMINAL_PROTOCOL_VERSION),
    available: z.boolean(),
    error: errorPayloadSchema.nullable(),
    limits: z.object({ perEntry: z.number().int().positive(), total: z.number().int().positive() }),
  }),
  /** The entry's terminals, oldest first; pushed after `hello` and on every change. */
  z.object({
    type: z.literal('terminals'),
    items: z.array(terminalInfoSchema).max(TERMINAL_LIMITS.perEntry),
  }),
  z.object({ type: z.literal('opened'), requestId: requestIdSchema, terminal: terminalInfoSchema }),
  z.object({
    type: z.literal('attached'),
    terminalId: terminalIdSchema,
    channel: z.number().int().min(0).max(TERMINAL_LIMITS.channelMax),
  }),
  z.object({
    type: z.literal('exit'),
    terminalId: terminalIdSchema,
    exitCode: z.number().int().nullable(),
    reason: terminalExitReasonSchema,
  }),
  /** A request failed; `requestId`/`terminalId` name it when known. */
  z.object({
    type: z.literal('error'),
    requestId: requestIdSchema.optional(),
    terminalId: terminalIdSchema.optional(),
    error: errorPayloadSchema,
  }),
]);
export type TerminalServerMessage = z.infer<typeof terminalServerMessageSchema>;

/** A binary output frame: channel byte + UTF-8 bytes. */
export function encodeTerminalFrame(channel: number, data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(data.length + 1);
  frame[0] = channel;
  frame.set(data, 1);
  return frame;
}

/** Channel and bytes of a binary output frame; null if it is empty. */
export function decodeTerminalFrame(frame: Uint8Array): { channel: number; data: Uint8Array } | null {
  const channel = frame[0];
  if (channel === undefined) return null;
  return { channel, data: frame.subarray(1) };
}
