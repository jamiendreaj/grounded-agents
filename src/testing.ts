/**
 * Test helpers.
 *
 * Every agent built on this should be testable with no API key and no network.
 * That is not a convenience — a suite that needs a key is a suite that gets
 * skipped in CI, and a guardrail nobody runs is a comment.
 */

/**
 * A client that replays scripted turns.
 *
 *   fakeClient([{ text: 'hello' }])
 *   fakeClient([{ content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
 *               { text: 'done' }])
 *   fakeClient([{ stop: 'max_tokens', text: 'cut o' }])
 *
 * The last turn repeats if the loop asks for more, so a scripted tool call
 * does not fall off the end.
 */
import type { ContentBlock, MessageClient, ModelResponse, RunResult, StopReason } from './types.js';

export type ScriptedTurn = {
  text?: string;
  content?: ContentBlock[];
  stop?: StopReason;
  input?: number;
  output?: number;
  cache_read?: number;
};

export type FakeClient = MessageClient & { sent: Record<string, unknown>[] };

export function fakeClient(turns: ScriptedTurn[] = [{ text: '' }]): FakeClient {
  let i = 0;
  const sent: Record<string, unknown>[] = [];
  const client: FakeClient = {
    sent,
    messages: {
      create: async (req: Record<string, unknown>): Promise<ModelResponse> => {
        sent.push(req);
        // The last turn repeats, so a scripted tool call does not fall off the end.
        const t = turns[Math.min(i, turns.length - 1)] ?? { text: '' };
        i += 1;
        return {
          stop_reason: t.stop ?? 'end_turn',
          content: t.content ?? [{ type: 'text', text: t.text ?? '' }],
          usage: {
            input_tokens: t.input ?? 2000,
            output_tokens: t.output ?? 150,
            cache_read_input_tokens: t.cache_read ?? 0,
            cache_creation_input_tokens: 0,
          },
        };
      },
    },
  };
  return client;
}

/** A turn that calls one tool. */
export const toolTurn = (name: string, input: unknown = {}, id = 't1'): ScriptedTurn =>
  ({ content: [{ type: 'tool_use', id, name, input }] });

/**
 * A turn that finishes cleanly and returns NO text block.
 *
 * The failure that catches people out: reasoning consumed the output budget,
 * so the response carries content blocks and none of them are text. Code that
 * reads content[0].text throws something unrelated to the cause.
 */
export const emptyTurn = (): ScriptedTurn =>
  ({ content: [{ type: 'thinking', thinking: 'at length, and to no visible end' }] });

/** Assert a draft is blocked, optionally by a named rule. */
type Asserter = { equal(a: unknown, b: unknown, m?: string): void; ok(v: unknown, m?: string): void };

export function assertBlocked(assert: Asserter, result: RunResult, rule?: string): void {
  assert.equal(result.sendable, false, `should have been blocked: ${result.draft}`);
  if (rule) {
    assert.ok(result.guardrails.blocked.includes(rule),
      `expected ${rule}, got [${result.guardrails.blocked}]`);
  }
}

/** Assert a draft passes every guard. */
export function assertSendable(assert: Asserter, result: RunResult): void {
  assert.equal(result.sendable, true,
    `should have been sendable — blocked on [${result.guardrails.blocked}]: ${result.blocked_because}`);
}
