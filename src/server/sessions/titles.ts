/**
 * WP-65 §1.3: generated session titles through `generateSessionTitle` (internal SDK method,
 * checked at runtime by the backend).
 *
 * - Auto title: after the first real turn of a conversation whose title is no AI or custom title
 *   (`none`/`prompt`): the first prompt + the start of the first answer, `persist: true` (the CLI
 *   writes it as its AI title – and answers a title the session already has instead). Once per
 *   conversation and server run, one request at a time; without a title (method missing, failure,
 *   empty) the caller falls back to the AI-title query of the session info (C.6).
 * - "Generate title again" (`session.regenerateTitle`): first prompt, last prompt, start of the
 *   last answer, `persist: false` (a new title, also over a custom one – the user asked for it).
 * - The CLI and the Remote Control bridge learn a generated title the way a rename does (WP-64):
 *   `/rename <title>` to the running process – its echo keeps `titleSource 'ai'`. Always after
 *   "generate again" (else the CLI keeps its old AI title and the session-info query would bring it
 *   back); after an auto title only while a bridge is active.
 */
import { isRemoteControlActive } from '@shared/model';
import { commandError, type EngineCore, type EntryState } from './entryState';
import { autoTitleDescription, regenerateTitleDescription } from './overview';
import { deliverPrompt } from './runtime';
import { capTitle } from './summary';

let unavailableLogged = false;

/** Test seam: the "method missing" note is logged once per process. */
export function resetTitleLogForTests(): void {
  unavailableLogged = false;
}

function noteUnavailable(core: EngineCore, entryId: string): void {
  if (unavailableLogged) {
    core.log.debug({ entryId }, 'generateSessionTitle unavailable');
    return;
  }
  unavailableLogged = true;
  core.log.warn({ entryId }, 'generateSessionTitle is not available – titles stay prompt/AI-query based');
}

/**
 * After a real turn: starts the auto title when it is due and answers true; false = not due (the
 * caller schedules the AI-title query as before).
 */
export function autoTitle(s: EntryState, core: EngineCore): boolean {
  const rt = s.runtime;
  const conversationId = s.conversationId();
  const source = s.entry.titleSource;
  if (
    rt === null ||
    !rt.alive ||
    core.shuttingDown() ||
    s.removed ||
    s.titleGenerating ||
    s.titleGeneratedFor === conversationId ||
    (source !== 'none' && source !== 'prompt')
  ) {
    return false;
  }
  s.titleGeneratedFor = conversationId;
  s.titleGenerating = true;
  void (async () => {
    let titled = false;
    try {
      const view = await s.loadView();
      const description = autoTitleDescription(view.items);
      if (description === null || s.runtime !== rt) return;
      const result = await rt.agent.generateTitle(description, { persist: true });
      if (!result.ok) {
        if (result.reason === 'unavailable') noteUnavailable(core, s.id);
        return;
      }
      if (result.title === null) return;
      titled = true;
      const current = s.entry.titleSource;
      // The user renamed meanwhile (custom wins) or a reset began another conversation.
      if (s.removed || s.conversationId() !== conversationId || (current !== 'none' && current !== 'prompt' && current !== 'ai')) {
        return;
      }
      const title = capTitle(result.title);
      if (title !== s.entry.title || current !== 'ai') s.patch((e) => ({ ...e, title, titleSource: 'ai' }));
      if (isRemoteControlActive(s.remote.state)) sendTitleToCli(s, core, title);
    } catch (error) {
      core.log.debug({ err: error, entryId: s.id }, 'auto title failed');
    } finally {
      s.titleGenerating = false;
      if (!titled) s.scheduleAiTitle();
    }
  })();
  return true;
}

/**
 * `session.regenerateTitle`: the running process (the caller started a dormant one) generates a new
 * title; failures → CLAUDE_CONTROL_FAILED (also when the method is missing or no title came).
 */
export async function regenerateTitle(s: EntryState, core: EngineCore): Promise<void> {
  const rt = s.runtime;
  if (rt === null || !rt.alive || rt.closing) throw commandError('SESSION_NOT_RUNNING', { entryId: s.id });
  const view = await s.loadView();
  const description = regenerateTitleDescription(view.items, s.entry.title);
  if (description === null) {
    throw commandError('CLAUDE_CONTROL_FAILED', { method: 'generateSessionTitle', detail: 'nothing to describe' });
  }
  const conversationId = s.conversationId();
  const result = await rt.agent.generateTitle(description, { persist: false });
  if (!result.ok) {
    if (result.reason === 'unavailable') noteUnavailable(core, s.id);
    throw commandError('CLAUDE_CONTROL_FAILED', { method: 'generateSessionTitle', detail: result.reason });
  }
  if (result.title === null) {
    throw commandError('CLAUDE_CONTROL_FAILED', { method: 'generateSessionTitle', detail: 'no title' });
  }
  const title = capTitle(result.title);
  s.titleGeneratedFor = conversationId;
  s.patch((e) => ({ ...e, title, titleSource: 'ai' }));
  sendTitleToCli(s, core, title);
}

/** `/rename <title>` to the running process – the echo keeps `ai` (deliverPrompt `renameSource`). */
function sendTitleToCli(s: EntryState, core: EngineCore, title: string): void {
  try {
    deliverPrompt(s, core, `/rename ${title}`, 'next', { renameSource: 'ai' });
  } catch (error) {
    core.log.warn({ err: error, entryId: s.id }, '/rename with the generated title could not be sent');
  }
}
