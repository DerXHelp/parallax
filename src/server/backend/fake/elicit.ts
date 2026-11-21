/**
 * WP-112 (ADR-256): the interactive keywords of MCP elicitations.
 * - `fake:elicit-form` – an MCP tool asks for a form (text, number, choice, yes/no); the answer
 *   text names what came back (accept with content, decline, cancel).
 * - `fake:elicit-url` – an MCP tool asks to open a URL; the server reports `elicitation_complete`
 *   after FAKE_ELICIT_COMPLETE_MS (× speed), which closes the card unless it was answered before.
 * - `fake:elicit-unsupported` – a form outside the subset (multi-select): the card offers only "Decline".
 */
import type { ElicitationAnswer, ElicitationRequestInfo } from '../types';
import {
  elicitationComplete,
  elicitationStep,
  events,
  streamedText,
  toolResultMessage,
  toolUseBlock,
  turnClose,
  turnOpen,
  type DslContext,
} from './dsl';
import { ELICITATION_FORM_SCHEMA } from './elicitation-form';
import type { Turn } from './turn';
import type { FakeScriptContext } from './types';

export const FAKE_ELICIT_KEYWORDS = [
  'fake:elicit-form',
  'fake:elicit-url',
  'fake:elicit-unsupported',
] as const;
export type FakeElicitKeyword = (typeof FAKE_ELICIT_KEYWORDS)[number];

/** How long the fake MCP server takes to finish a URL request (× speed, ≤ maxDelayMs). */
export const FAKE_ELICIT_COMPLETE_MS = 5_000;
export const FAKE_ELICIT_URL = 'https://auth.example/authorize?state=fake';
export const FAKE_ELICIT_URL_DONE = 'Fake: the sign-in finished.';

export function isFakeElicitKeyword(keyword: string): keyword is FakeElicitKeyword {
  return (FAKE_ELICIT_KEYWORDS as readonly string[]).includes(keyword);
}

function request(fields: Partial<ElicitationRequestInfo> & { requestId: string }): ElicitationRequestInfo {
  return {
    serverName: 'fake-mcp',
    message: '',
    mode: 'form',
    url: null,
    elicitationId: null,
    requestedSchema: null,
    title: null,
    displayName: null,
    description: null,
    ...fields,
  };
}

/** The answer as the fake MCP tool reports it. */
export function elicitAnswerText(answer: ElicitationAnswer): string {
  switch (answer.action) {
    case 'accept':
      return answer.content === null
        ? 'Fake: accepted.'
        : `Fake: accepted with ${JSON.stringify(answer.content)}.`;
    case 'decline':
      return 'Fake: declined.';
    case 'cancel':
      return 'Fake: cancelled.';
  }
}

async function finishTurn(
  ctx: FakeScriptContext,
  c: DslContext,
  turn: Turn,
  toolUseId: string,
  text: string,
) {
  await ctx.play(
    events(
      toolResultMessage(c, toolUseId, text),
      streamedText(c, text),
      turnClose(c, turn.prompt, { result: { result: text } }),
    ),
  );
}

export async function elicitKeyword(
  ctx: FakeScriptContext,
  c: DslContext,
  turn: Turn,
  keyword: FakeElicitKeyword,
): Promise<void> {
  const toolUseId = ctx.ids.toolUseId();
  turn.toolUseId = toolUseId;
  const tool = keyword === 'fake:elicit-url' ? 'mcp__fake-mcp__connect' : 'mcp__fake-mcp__ask';
  await ctx.play(events(turnOpen(c, turn.prompt), toolUseBlock(c, tool, {}, { toolUseId })));
  const requestId = ctx.ids.uuid();
  switch (keyword) {
    case 'fake:elicit-form': {
      const answer = await ctx.elicit(
        request({
          requestId,
          message: 'Fake: please fill in the reservation.',
          requestedSchema: ELICITATION_FORM_SCHEMA,
        }),
      );
      await finishTurn(ctx, c, turn, toolUseId, elicitAnswerText(answer));
      return;
    }
    case 'fake:elicit-unsupported': {
      const answer = await ctx.elicit(
        request({
          requestId,
          message: 'Fake: which topics interest you?',
          requestedSchema: {
            type: 'object',
            properties: { topics: { type: 'array', items: { type: 'string', enum: ['news', 'tech'] } } },
          },
        }),
      );
      await finishTurn(ctx, c, turn, toolUseId, elicitAnswerText(answer));
      return;
    }
    case 'fake:elicit-url': {
      const elicitationId = `fake-elicitation-${requestId}`;
      // The request stays open (parallel) while the fake server finishes the sign-in.
      await ctx.play(
        elicitationStep(c, {
          serverName: 'fake-mcp',
          message: 'Fake: sign in to continue.',
          mode: 'url',
          url: FAKE_ELICIT_URL,
          elicitationId,
          requestId,
          parallel: true,
        }),
      );
      await ctx.pause(FAKE_ELICIT_COMPLETE_MS);
      await ctx.play(elicitationComplete(c, 'fake-mcp', elicitationId));
      await finishTurn(ctx, c, turn, toolUseId, FAKE_ELICIT_URL_DONE);
      return;
    }
  }
}
