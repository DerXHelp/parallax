/**
 * Source of the history worker (WP-13 §3.2, A.3, F.15), run with `new Worker(source, {eval: true})`
 * by history/pool.ts. Plain JavaScript (CommonJS eval script), no imports of project code, so no
 * second bundle entry is needed: it works the same under tsx, Vitest and in dist/server.js.
 *
 * The worker loads the SDK from `workerData.sdkUrl` (a file: URL of sdk.mjs; tests pass a data: URL)
 * and answers `{id, op}` requests with `{id, ok: true, result}` or `{id, ok: false, error: {name,
 * message}}`. Its `process.env` is the profile env given by the pool, so `CLAUDE_CONFIG_DIR` (read
 * by the SDK on every call, F.15) is isolated per worker – the main process never changes its env.
 * Lookups go by session id without `dir` (B "Lookups per ID").
 */
export const HISTORY_WORKER_SOURCE = String.raw`'use strict';
const { parentPort, workerData } = require('node:worker_threads');

let sdkPromise = null;
function loadSdk() {
  if (sdkPromise === null) sdkPromise = import(workerData.sdkUrl);
  return sdkPromise;
}

function describe(error) {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

async function run(op) {
  const sdk = await loadSdk();
  switch (op.op) {
    case 'messages':
      return sdk.getSessionMessages(op.sessionId);
    case 'subagents':
      return sdk.listSubagents(op.sessionId);
    case 'subagentMessages':
      return sdk.getSubagentMessages(op.sessionId, op.agentId);
    case 'info': {
      const info = await sdk.getSessionInfo(op.sessionId);
      return info === undefined ? null : info;
    }
    case 'rename':
      await sdk.renameSession(op.sessionId, op.title);
      return null;
    default:
      throw new TypeError('unknown history op: ' + String(op.op));
  }
}

parentPort.on('message', (request) => {
  const id = request === null || typeof request !== 'object' ? -1 : request.id;
  Promise.resolve()
    .then(() => run(request.op))
    .then(
      (result) => {
        parentPort.postMessage({ id, ok: true, result: result === undefined ? null : result });
      },
      (error) => {
        parentPort.postMessage({ id, ok: false, error: describe(error) });
      },
    )
    .catch((error) => {
      // postMessage failed (e.g. a result that cannot be cloned).
      parentPort.postMessage({ id, ok: false, error: describe(error) });
    });
});
`;
