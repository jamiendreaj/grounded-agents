/**
 * Guardrails: the checks that run after the model has finished.
 *
 * The prompt tells a model what not to do. This checks whether it did it
 * anyway, which is a different job and needs different machinery. A prompt is
 * persuasion; a guard is arithmetic.
 *
 * Three things the design insists on, each learned from a real miss:
 *
 *   A guard that throws fails its own check rather than the run. A bad regex
 *   in one rule should not cost you the other forty.
 *
 *   Severity is binary — block or warn — and nothing in between. A "medium"
 *   severity is a decision nobody makes at three in the afternoon.
 *
 *   A rule names itself in its failure. "Blocked" is useless to whoever is
 *   clearing the queue; "unauthorised_price: states 310000, which no tool
 *   returned" is actionable.
 */

import type { Guard, GuardContext, Issue, Severity, Verdict } from './types.js';

/** One finding. `rule` is what the reviewer reads; `detail` is for a human. */
const issue = (rule: string, severity: Severity, detail: unknown): Issue =>
  ({ rule, severity, detail: String(detail) });

/**
 * A message from a thrown value.
 *
 * `catch` gives you `unknown`, which is honest: anything can be thrown, and
 * plenty of libraries throw strings. Casting to Error here would be a lie that
 * crashes the error handler itself.
 */
const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message
  : typeof err === 'string' ? err
  : String(err);

/**
 * Define a rule.
 *
 * `test` returns a truthy value to FAIL — usually the regex match, so the
 * detail can quote the offending words back. Returning the match rather than
 * a boolean is deliberate: a finding that cannot quote itself gets ignored.
 */
export function rule<Doc = unknown, Cfg = unknown>(
  name: string,
  {
    severity = 'block',
    test,
    detail,
  }: {
    severity?: Severity;
    test: (text: string, ctx: GuardContext<Doc, Cfg>) => unknown;
    detail?: string | ((hit: any, text: string, ctx: GuardContext<Doc, Cfg>) => string);
  },
): Guard<Doc, Cfg> {
  if (!name) throw new Error('A rule needs a name — it is what the reviewer reads.');
  if (typeof test !== 'function') throw new Error(`Rule "${name}" needs a test function.`);
  const fn: Guard<Doc, Cfg> = (text, ctx) => {
    const hit = test(text, ctx);
    if (!hit) return null;
    const d = typeof detail === 'function' ? detail(hit, text, ctx) : (detail ?? '');
    return issue(name, severity, d);
  };
  fn.ruleName = name;
  fn.severity = severity;
  return fn;
}

/** Any of these patterns matching fails the rule. The first match is quoted. */
export function patternRule<Doc = unknown, Cfg = unknown>(
  name: string,
  patterns: readonly RegExp[],
  { severity = 'block', detail }: {
    severity?: Severity;
    detail?: (m: RegExpMatchArray) => string;
  } = {},
): Guard<Doc, Cfg> {
  return rule(name, {
    severity,
    test: (text: string) => {
      for (const re of patterns) {
        const m = text.match(re);
        if (m) return m;
      }
      return null;
    },
    detail: detail ?? ((m: RegExpMatchArray) => `matched "${String(m[0]).trim()}"`),
  });
}

/** Run every rule over a draft. Never throws. */
export function check<Doc = unknown, Cfg = unknown>(
  text: string,
  ctx: GuardContext<Doc, Cfg>,
  rules: readonly Guard<Doc, Cfg>[] = [],
): Verdict {
  const issues: Issue[] = [];
  for (const r of rules) {
    try {
      const out = r(text ?? '', ctx);
      if (Array.isArray(out)) issues.push(...out.filter(Boolean));
      else if (out) issues.push(out);
    } catch (err) {
      // A rule that crashes is itself a failure, reported as one. Silently
      // skipping it would mean a broken guard reads as a clean pass.
      issues.push(issue(r.ruleName ?? 'guard', 'block', `rule threw: ${messageOf(err)}`));
    }
  }
  return {
    ok: !issues.some((i) => i.severity === 'block'),
    issues,
    blocked: issues.filter((i) => i.severity === 'block').map((i) => i.rule),
    warnings: issues.filter((i) => i.severity === 'warn').map((i) => i.rule),
  };
}

/* ── numbers ──────────────────────────────────────────────────────────── */

/**
 * Currency figures in a piece of text.
 *
 * Handles the European forms, because getting this wrong is silent: "€1.234,56"
 * is twelve hundred, not one point two three, and a naive parser authorises a
 * figure the document never contained.
 */
const MONEY = /(?:€|EUR\s?|£|\$|USD\s?)\s?(\d[\d.,]*)|(\d[\d.,]*)\s?(?:€|euro|EUR|£|\$|USD)/gi;

export function numbersIn(text: unknown): Set<number> {
  const out = new Set<number>();
  for (const m of String(text).matchAll(MONEY)) {
    const raw = (m[1] ?? m[2] ?? '')
      .replace(/[.,](?=\d{3}\b)/g, '')   // thousands separator, either style
      .replace(',', '.');                 // decimal comma
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

/**
 * Every number the agent is allowed to state.
 *
 * Walks raw numbers as well as currency strings. The first version of this
 * scanned documents as text, which meant a price stored as `285000` was
 * invisible — JSON carries no currency symbol — and the agent was blocked from
 * stating the one figure it was actually allowed to state.
 */
export function authorisedNumbers(...sources: unknown[]): Set<number> {
  const ok = new Set<number>();
  const walk = (v: unknown): void => {
    if (typeof v === 'number') ok.add(v);
    else if (typeof v === 'string') for (const n of numbersIn(v)) ok.add(n);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as object).forEach(walk);
  };
  sources.forEach(walk);
  return ok;
}

/**
 * No figure the agent was not given.
 *
 * `from(ctx)` returns the things that authorise a number — tool results and
 * whatever document the agent is grounded in.
 */
export function unauthorisedNumbers<Doc = any, Cfg = any>(
  name = 'unauthorised_figure',
  { from, severity = 'block' }: {
    from?: (ctx: GuardContext<Doc, Cfg>) => unknown[];
    severity?: Severity;
  } = {},
): Guard<Doc, Cfg> {
  return rule(name, {
    severity,
    test: (text, ctx) => {
      const sources = from ? from(ctx) : [ctx.toolResults ?? [], ctx.document ?? {}];
      const allowed = authorisedNumbers(...sources);
      const stated = [...numbersIn(text)].filter((n) => !allowed.has(n));
      return stated.length ? stated : null;
    },
    detail: (stated: number[]) =>
      `states ${stated.join(', ')}, which nothing in the document or the tool results returned`,
  });
}

/* ── the rules almost every domain wants ──────────────────────────────── */

/** Card, bank or payment details appearing in a reply. */
export const paymentDetails = (name = 'payment_detail'): Guard<any, any> =>
  patternRule(name, [
    /\b(?:card\s+number|cvv|cvc|iban|sort\s+code|routing\s+number|account\s+number)\b/i,
    /\b(?:bank\s+transfer\s+to|wire\s+(?:it\s+)?to|send\s+(?:the\s+)?(?:deposit|payment)\s+to\s+my)\b/i,
    /(?:numero\s+di\s+carta|kreditkartennummer|numéro\s+de\s+carte)/i,
    /(?:номер\s+карты|رقم\s*البطاقة|מספר\s*ה?כרטיס|卡号|卡號)/,
  ], { detail: (m) => `mentions payment details: "${String(m[0]).trim()}"` });

/**
 * Hedging, which usually marks a fact the document did not contain.
 *
 * A warning rather than a block, because sometimes a hedge is honest. It is
 * still worth surfacing: "policies like this usually include…" is the shape of
 * a model filling a gap from memory.
 */
export const hedging = (name = 'hedged_fact'): Guard<any, any> =>
  patternRule(name, [
    /\b(?:usually|typically|normally|generally|in\s+most\s+cases|as\s+a\s+rule)\b/i,
    /\b(?:i\s+think|i\s+believe|probably|should\s+be\s+fine|i'?d\s+imagine)\b/i,
  ], {
    severity: 'warn',
    detail: (m) => `hedges with "${String(m[0]).trim()}" — often a gap filled from memory`,
  });

/** An empty draft. Cheap, and catches the clean finish that returns nothing. */
export const notEmpty = (name = 'empty_draft'): Guard<any, any> =>
  rule(name, {
    test: (text) => (String(text).trim().length === 0 ? true : null),
    detail: () => 'the draft is empty',
  });

/**
 * A reply in the wrong script.
 *
 * The cheap half of a language check, and the one that actually fires: a model
 * answers a Cyrillic enquiry in English because English is where it is most
 * comfortable. A reply claiming to be Russian with no Cyrillic in it is wrong
 * whatever the words are — no vocabulary list required.
 */
const SCRIPTS: Record<string, { re: RegExp; name: string }> = {
  ru: { re: /[Ѐ-ӿ]/, name: 'Cyrillic' },
  zh: { re: /[一-鿿]/, name: 'Chinese characters' },
  ar: { re: /[؀-ۿ]/, name: 'Arabic script' },
  he: { re: /[֐-׿]/, name: 'Hebrew script' },
  el: { re: /[Ͱ-Ͽ]/, name: 'Greek script' },
  ja: { re: /[぀-ヿ]/, name: 'Japanese kana' },
  ko: { re: /[가-힯]/, name: 'Hangul' },
};

export const wrongScript = (name = 'wrong_language'): Guard<any, any> =>
  rule(name, {
    test: (text, ctx) => {
      const s = ctx.expectLanguage ? SCRIPTS[ctx.expectLanguage] : undefined;
      if (!s || !String(text).trim()) return null;
      return s.re.test(text) ? null : s;
    },
    detail: (s: { name: string }, _t: string, ctx: GuardContext) =>
      `the guest wrote in "${ctx.expectLanguage}" but the reply contains no ${s.name}`,
  });

export { SCRIPTS, MONEY };
