# grounded-agents

A small TypeScript framework for agents that have to **refuse things**.

Grounded in a document, checked after the model has finished, and explicit
about why a draft cannot be sent.

```bash
npm test          # 17 tests, offline, no API key
npm run build
```

---

## Why it exists

I built four agents before I built this: hotel enquiries, property enquiries,
insurance enquiries, and a harness for evaluating them. By the third one I was
copying the agent loop with `sed` and changing the nouns.

So I measured it. `diff` between the insurance loop and the property loop:
**22 differing lines out of 171.** The other 149 — the turn loop, the token
budget, the stop-reason table, the number arithmetic, and the sentence
explaining why a draft could not be sent — were the same code twice over.

What actually differs per domain is three things — a prompt, some tools, and
the rules that are specific to that business. Everything else is this package.

---

## The shape

```ts
import { defineAgent, run, guards } from 'grounded-agents';

const agent = defineAgent<Listing, BranchConfig>({
  name: 'property-enquiry',

  prompt: (listing, { mode }) => `...`,
  tools: (listing) => [ /* ... */ ],
  runTool: async (listing, config, name, input, state) => { /* ... */ },

  guards: [
    guards.notEmpty(),
    guards.unauthorisedNumbers('unauthorised_price', {
      from: (ctx) => [ctx.toolResults, ctx.document.facts],
    }),
    guards.paymentDetails(),
    guards.wrongScript(),
    guards.hedging(),
  ],

  // Not every failure is the same KIND of failure.
  grave: ['protected_characteristic', 'steering'],
  graveLabel: 'RULE ZERO',
  graveAdvice: 'This needs a person before anything goes out.',
});

const result = await run(agent, { document: listing, input: enquiry });

result.sendable;         // only if the model finished AND every guard passed
result.blocked_because;  // one sentence a person can act on
result.grave;            // true when it is the serious kind
```

---

## Tools are typed from their schemas

Declare a tool with `as const` and the framework infers what it receives:

```ts
const TOOLS = [{
  name: 'get_rate',
  description: 'The only legitimate source of a price.',
  input_schema: {
    type: 'object',
    properties: {
      check_in:  { type: 'string' },
      room_type: { type: 'string', enum: ['Classic', 'Superior'] },
      guests:    { type: 'integer' },
    },
    required: ['check_in', 'room_type'],
  },
}] as const satisfies readonly ToolDefinition[];

type Input = ToolInput<typeof TOOLS, 'get_rate'>;
// { check_in: string; room_type: 'Classic' | 'Superior'; guests?: number }
```

The enum narrows to a union, required and optional split correctly, and a typo
in a property name is a compile error rather than a surprise in a tool that
runs once a week.

---

## Three things it gets right because they were bugs first

**A clean finish that returns no text.** A model can stop with `end_turn` and
produce no text block at all, because reasoning consumed the output budget.
Code that reads `content[0].text` throws an error naming nothing useful. This
reads text by filtering on type, and when there is none it says so:

> *"The model finished but produced no text, usually because reasoning consumed
> the output budget."*

**The budget checked before tools run, not after.** A tool result returns as
input on the next turn, so continuing past the ceiling spends again. There is a
test asserting a greedy loop stops at the ceiling instead of running to
`maxTurns`.

**A grave failure reported differently from a typo.** A price typo and an
unlawful statement both block a draft. Labelling them identically trains
whoever clears the queue to ignore the label on both — so a domain names which
rules are grave and what to call them.

```
DO NOT SEND — unauthorised_price. This needs a person.
Guardrails blocked it: hedged_fact.
```

---

## Guards

A guard is a function. It returns `null` to pass, or the match — so the finding
can quote the offending words back. A guard that throws fails **its own check**,
never the run: a bad regex in one rule should not cost you the other forty.

Built in, because almost every domain wants them:

| Guard | Catches |
| --- | --- |
| `unauthorisedNumbers` | Any figure nothing in the document or tool results returned |
| `paymentDetails` | Card, bank and IBAN details, across five scripts |
| `wrongScript` | A reply to a Russian guest with no Cyrillic in it — seven languages |
| `hedging` | *"policies like this usually include…"* — a gap filled from memory |
| `notEmpty` | The clean finish that returns nothing |

`numbersIn` reads European decimals properly. **`€1.234,56` is twelve hundred,
not one point two three** — and getting it wrong is silent, because it
authorises a figure the document never contained.

---

## Testing

Every agent built on this should be testable with no API key and no network.
That is not convenience: a suite that needs a key is a suite that gets skipped
in CI, and a guardrail nobody runs is a comment.

```ts
import { fakeClient, toolTurn, emptyTurn } from 'grounded-agents/testing';

const r = await run(agent, {
  document,
  input: 'How much is it?',
  client: fakeClient([
    toolTurn('get_rate', { check_in: '2026-11-01', room_type: 'Superior' }),
    { text: 'It is €240 a night.' },
  ]),
});
```

`emptyTurn()` scripts the failure people miss — a response that finishes
cleanly and carries no text block.

---

## Layout

```
src/
  types.ts     the types, which are the documentation
  loop.ts      the agent loop, the budget, the stop-reason table
  guards.ts    the guard framework and the common rules
  testing.ts   a scripted client and assertions
examples/
  hotel-enquiry.ts   a real agent, as proof the shape holds
```

The example exists as proof rather than demonstration. The framework was
extracted from agents that already worked, so the only honest test of it is
whether one of them can be expressed in it without the shape bending.

---

## Built on this

- [document-extraction-agent](https://github.com/jamiendreaj/document-extraction-agent) — contract fields, where a span that is not in the document is deleted

Building that one is what the extraction was for, and it immediately found an
assumption baked into this package: the sentence after the grave label was
hardcoded to "Do not send. This needs a person." An agent that reads fields out
of a contract has no reply to withhold, so `graveAdvice` is now the domain's to
write.

## The agents it was extracted from

- [direct-booking-agent](https://github.com/jamiendreaj/direct-booking-agent) — hotel enquiries, in the guest's own language
- [property-enquiry-agent](https://github.com/jamiendreaj/property-enquiry-agent) — fair housing, GDPR
- [insurance-enquiry-agent](https://github.com/jamiendreaj/insurance-enquiry-agent) — information, never advice
- [agent-evals](https://github.com/jamiendreaj/agent-evals) — did the change actually help?

MIT.
