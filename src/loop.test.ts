/**
 * Tests for the framework.
 *
 * This library exists so that five agents do not each reimplement a token
 * budget, a stop-reason table, and a sentence explaining why a draft cannot be
 * sent. If it gets any of those wrong, it gets them wrong five times, so the
 * suite leans on the three things that were genuinely bugs before they were
 * tests:
 *
 *   A clean finish that returns NO text block, because reasoning consumed the
 *   output budget. Code that reads content[0].text throws something unrelated.
 *
 *   The budget checked BEFORE tools run, because a tool result returns as
 *   input on the next turn and continuing past the ceiling spends again.
 *
 *   A grave failure reported differently from a typo. Treating them alike
 *   trains whoever reads the queue to ignore the label on both.
 *
 * Everything runs offline against a scripted client.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { defineAgent, run } from './loop.js';
import * as guards from './guards.js';
import { fakeClient, toolTurn, emptyTurn } from './testing.js';
import type { ToolDefinition } from './types.js';

type Doc = { title: string; facts: Record<string, string | number> };

const document: Doc = { title: 'Example', facts: { price: 285000, excess: '€250' } };

const TOOLS: ToolDefinition[] = [{
  name: 'lookup',
  description: 'Look one fact up.',
  input_schema: { type: 'object', properties: { field: { type: 'string' } }, required: ['field'] },
}];

const agent = defineAgent<Doc, Record<string, never>>({
  name: 'test-agent',
  prompt: (doc) => `You answer about ${doc.title}.`,
  tools: () => TOOLS,
  runTool: async (doc, _cfg, name, input: { field: string }, state) => {
    if (name === 'explode') throw new Error('tool exploded');
    if (name === 'record') {
      const kept: Record<string, unknown> = {};
      const refused: string[] = [];
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (k === 'allowed') kept[k] = v; else refused.push(k);
      }
      Object.assign(state.record, kept);
      return { recorded: Object.keys(kept), refused };
    }
    const value = doc.facts[input.field];
    return value === undefined ? { known: false } : { known: true, value };
  },
  guards: [
    guards.notEmpty(),
    guards.unauthorisedNumbers('unauthorised_price', {
      from: (ctx) => [ctx.toolResults, (ctx.document as Doc).facts],
    }),
    guards.paymentDetails(),
    guards.hedging(),
  ],
  grave: ['unauthorised_price', 'payment_detail'],
  graveLabel: 'DO NOT SEND',
});

const go = (turns: Parameters<typeof fakeClient>[0], opts = {}) =>
  run(agent, { document, input: 'a question', client: fakeClient(turns), ...opts });

/* ── the three that were bugs first ───────────────────────────────────── */

test('a clean finish with no text block is named, not crashed on', async () => {
  const r = await go([emptyTurn()]);
  assert.equal(r.sendable, false);
  assert.equal(r.draft, '');
  assert.match(r.blocked_because!, /no text/);
  assert.match(r.blocked_because!, /reasoning consumed/);
});

test('the budget is checked before tools run, not after', async () => {
  // Every turn asks for a tool and spends heavily. Without a ceiling this runs
  // to maxTurns; with one it stops as soon as the budget is gone.
  const greedy = { ...toolTurn('lookup', { field: 'price' }), input: 9000, output: 1000 };
  const r = await go([greedy], { tokenBudget: 25_000 });
  assert.equal(r.budget_exhausted, true);
  assert.ok(r.tokens_used >= 25_000, 'it stops at the ceiling');
  assert.ok(r.tokens_used < 60_000, `spent ${r.tokens_used} — should not have run to maxTurns`);
  assert.match(r.blocked_because!, /budget/);
});

test('a grave failure is reported differently from an ordinary one', async () => {
  const grave = await go([{ text: 'The price is €999,999.' }]);
  assert.equal(grave.grave, true);
  assert.match(grave.blocked_because!, /^DO NOT SEND/);

  const ordinary = defineAgent<Doc, Record<string, never>>({
    ...agent, grave: [], name: 'no-grave-rules',
  });
  const plain = await run(ordinary, {
    document, input: 'q', client: fakeClient([{ text: 'The price is €999,999.' }]),
  });
  assert.equal(plain.grave, false);
  assert.match(plain.blocked_because!, /^Guardrails blocked it/);
});

/* ── the loop ─────────────────────────────────────────────────────────── */

test('a clean draft is sendable', async () => {
  const r = await go([{ text: 'The asking price is €285,000 and the excess is €250.' }]);
  assert.equal(r.sendable, true);
  assert.equal(r.blocked_because, null);
});

test('a figure from the document is allowed, one from nowhere is not', async () => {
  assert.equal((await go([{ text: 'It is €285,000.' }])).sendable, true);
  assert.equal((await go([{ text: 'It is €310,000.' }])).sendable, false);
});

test('a figure a tool returned is allowed', async () => {
  const r = await go([toolTurn('lookup', { field: 'price' }), { text: 'It is €285,000.' }]);
  assert.equal(r.sendable, true);
});

test('a tool that throws costs that call, not the run', async () => {
  const r = await go([toolTurn('explode'), { text: 'The excess is €250.' }]);
  assert.equal(r.tool_calls.length, 1);
  assert.ok('error' in r.tool_calls[0]!.output);
  assert.equal(r.sendable, true, 'the model still got to answer');
});

test('truncation and refusal are never sendable', async () => {
  assert.equal((await go([{ stop: 'max_tokens', text: 'The price is' }])).truncated, true);
  assert.equal((await go([{ stop: 'max_tokens', text: 'The price is' }])).sendable, false);
  assert.equal((await go([{ stop: 'refusal', text: '' }])).refused, true);
});

test('usage accumulates across turns', async () => {
  const r = await go([
    { ...toolTurn('lookup', { field: 'price' }), input: 100, output: 20 },
    { text: 'It is €285,000.', input: 150, output: 30 },
  ]);
  assert.equal(r.usage.input, 250);
  assert.equal(r.usage.output, 50);
});

test('the system prompt is cached, and the document is in it', async () => {
  const client = fakeClient([{ text: 'The excess is €250.' }]);
  await run(agent, { document, input: 'q', client });
  const sent = client.sent[0]! as { system: { text: string; cache_control: { type: string } }[] };
  assert.equal(sent.system[0]!.cache_control.type, 'ephemeral');
  assert.match(sent.system[0]!.text, /Example/);
});

/* ── refusal to run at all ────────────────────────────────────────────── */

test('validate can refuse to run before anything is spent', async () => {
  const strict = defineAgent<Doc, { jurisdiction?: string }>({
    name: 'strict',
    prompt: () => 'x',
    validate: (_doc, cfg) => {
      if (!cfg.jurisdiction) throw new Error('This config has no `jurisdiction`.');
    },
  });
  await assert.rejects(
    () => run(strict, { document, config: {}, input: 'q', client: fakeClient([{ text: 'hi' }]) }),
    /jurisdiction/,
  );
});

test('an agent without a prompt is refused at definition time', () => {
  // @ts-expect-error prompt is required
  assert.throws(() => defineAgent({ name: 'broken' }), /needs a prompt/);
});

/* ── what a tool refused to record ────────────────────────────────────── */

test('fields a tool refused are surfaced on the result', async () => {
  const r = await go([
    toolTurn('record', { allowed: 'yes', salary: '55000', health: 'private' }),
    { text: 'The excess is €250.' },
  ]);
  assert.deepEqual(r.refused_fields.sort(), ['health', 'salary']);
  assert.deepEqual(Object.keys(r.record), ['allowed']);
});

/* ── guards in isolation ──────────────────────────────────────────────── */

test('a guard that throws fails its own check, not the run', async () => {
  const broken = defineAgent<Doc, Record<string, never>>({
    name: 'broken-guard',
    prompt: () => 'x',
    guards: [
      guards.rule('explodes', { test: () => { throw new Error('bad regex'); } }),
      guards.notEmpty(),
    ],
  });
  const r = await run(broken, { document, input: 'q', client: fakeClient([{ text: 'fine' }]) });
  assert.equal(r.sendable, false);
  assert.ok(r.guardrails.blocked.includes('explodes'));
  assert.match(r.guardrails.issues[0]!.detail, /rule threw: bad regex/);
});

test('European decimals are read correctly', () => {
  // "€1.234,56" is twelve hundred, not one point two three. Getting this wrong
  // is silent: it authorises a figure the document never contained.
  assert.deepEqual([...guards.numbersIn('€1.234,56')], [1234.56]);
  assert.deepEqual([...guards.numbersIn('€1,234.56')], [1234.56]);
  assert.deepEqual([...guards.numbersIn('built in 1890')], [], 'a bare year is not a price');
});

test('authorisedNumbers walks raw numbers as well as strings', () => {
  // The first version scanned documents as text, so a price stored as 285000
  // was invisible — JSON carries no currency symbol.
  const ok = guards.authorisedNumbers({ price: 285000 }, [{ nightly: 240 }], { fee: '€18' });
  assert.ok(ok.has(285000));
  assert.ok(ok.has(240));
  assert.ok(ok.has(18));
});

test('the script guard catches a reply in the wrong alphabet', () => {
  const g = guards.wrongScript();
  const ctx = { toolResults: [], document: {}, config: {}, state: { escalations: [], record: {}, notes: {} } };
  assert.ok(g('Yes, the room sleeps four.', { ...ctx, expectLanguage: 'ru' }));
  assert.equal(g('Да, номер вмещает четверых.', { ...ctx, expectLanguage: 'ru' }), null);
  assert.equal(g('anything at all', { ...ctx, expectLanguage: null }), null);
});
