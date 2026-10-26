import Anthropic from '@anthropic-ai/sdk';
import { check } from './guards.js';
import type {
  AgentState, Guard, MessageClient, RunResult, StopReason,
  ToolDefinition, ToolResult, Usage,
} from './types.js';

/**
 * The agent loop.
 *
 * Deliberately small. It does four things nothing else does well:
 *
 *   It keeps a token budget, checked BEFORE running tools, because a tool
 *   result returns as input on the next turn and continuing past the ceiling
 *   spends again.
 *
 *   It reads text by filtering content blocks, never `content[0]`. A model can
 *   finish cleanly and return no text at all when reasoning consumes the
 *   output budget; indexing there throws an error that says nothing about the
 *   cause.
 *
 *   It runs the guards after the model has finished, and refuses to call
 *   anything sendable unless the model finished AND the guards passed.
 *
 *   It explains itself in one sentence. `sendable: false` is useless to the
 *   person clearing a queue.
 */

export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_MAX_TOKENS = 1600;
export const DEFAULT_MAX_TURNS = 8;
export const DEFAULT_TOKEN_BUDGET = 60_000;

/**
 * Define an agent. Everything domain-specific lives here; nothing else does.
 *
 *   prompt(document, config)            -> the system prompt
 *   tools(document, config)             -> tool definitions
 *   runTool(document, config, name, input, state) -> tool result
 *   guards                              -> rules run on the finished draft
 *   grave                               -> rule names reported differently
 *   graveLabel                          -> what to call them
 *   graveAdvice                         -> the sentence that follows the label
 *
 * `grave` exists because not every failure is the same kind of failure. A
 * price typo and an unlawful statement both block a draft, and treating them
 * alike trains whoever reads the queue to ignore the label on both.
 */
export type AgentDefinition<Doc = any, Cfg = any> = {
  name: string;
  prompt: (document: Doc, config: Cfg & { mode: string }) => string;
  tools?: (document: Doc, config: Cfg) => ToolDefinition[];
  runTool?: (
    document: Doc, config: Cfg, name: string, input: any, state: AgentState,
  ) => Promise<ToolResult> | ToolResult;
  guards?: readonly Guard<Doc, Cfg>[];
  /** Rule names whose failure is a different KIND of failure. */
  grave?: readonly string[];
  graveLabel?: string;
  /**
   * The sentence after the label.
   *
   * It used to be the hardcoded "Do not send. This needs a person.", which is
   * right for a draft reply and wrong for anything else — the second agent
   * built on this framework extracts fields from a contract, and there is no
   * reply to withhold. A framework that assumes its own first use case puts
   * that assumption in front of the user.
   */
  graveAdvice?: string;
  model?: string;
  maxTokens?: number;
  maxTurns?: number;
  tokenBudget?: number;
  /** Throw here to refuse to run at all — a missing jurisdiction, say. */
  validate?: ((document: Doc, config: Cfg) => void) | null;
};

export type Agent<Doc = any, Cfg = any> = Required<
  Omit<AgentDefinition<Doc, Cfg>, 'validate'>
> & { validate: ((document: Doc, config: Cfg) => void) | null };

export function defineAgent<Doc = any, Cfg = any>({
  name,
  prompt,
  tools = () => [],
  runTool = async () => ({ error: 'no tools defined' }),
  guards = [],
  grave = [],
  graveLabel = 'SERIOUS',
  graveAdvice = 'This needs a person.',
  model = DEFAULT_MODEL,
  maxTokens = DEFAULT_MAX_TOKENS,
  maxTurns = DEFAULT_MAX_TURNS,
  tokenBudget = DEFAULT_TOKEN_BUDGET,
  validate = null,
}: AgentDefinition<Doc, Cfg>): Agent<Doc, Cfg> {
  if (!name) throw new Error('An agent needs a name.');
  if (typeof prompt !== 'function') throw new Error(`Agent "${name}" needs a prompt(document, config) function.`);
  return { name, prompt, tools, runTool, guards, grave, graveLabel, graveAdvice, model, maxTokens, maxTurns, tokenBudget, validate };
}

/** Why a draft cannot be sent. Null when it can. */
function blockedBecause(
  agent: Agent,
  { stop, text, verdict }: { stop: StopReason | null; text: string; verdict: ReturnType<typeof check> },
): string | null {
  if (stop === 'budget_exhausted') return 'The token budget ran out before the model finished.';
  if (stop === 'max_tokens') return 'The model hit max_tokens and the reply is cut off.';
  if (stop === 'refusal') return 'The model refused to answer.';
  if (stop === 'max_turns') return 'The tool loop ran out of turns without producing a reply.';
  if (stop !== 'end_turn') return `The model stopped for an unrecognised reason: ${stop}.`;
  if (!String(text).trim()) {
    return 'The model finished but produced no text, usually because reasoning consumed the output budget.';
  }
  if (!verdict.ok) {
    const grave = verdict.blocked.filter((r) => agent.grave.includes(r));
    return grave.length
      ? `${agent.graveLabel} — ${grave.join(', ')}. ${agent.graveAdvice}`
      : `Guardrails blocked it: ${verdict.blocked.join(', ')}.`;
  }
  return null;
}

/** Pull the text out, by type. Never by index. */
function textOf(messages: { role: string; content: unknown }[]): string {
  return messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string; text?: string }[]) : []))
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Run one input through an agent and return a draft.
 *
 * Returns the draft rather than sending it. Nothing in this file touches a
 * mail server, a queue, or a database — handing over is deliberately somebody
 * else's job.
 */
export type RunOptions<Doc, Cfg> = {
  document: Doc;
  config?: Cfg;
  input: string;
  mode?: string;
  expectLanguage?: string | null;
  /** Structural, so a scripted object works in tests and the SDK works live. */
  client?: MessageClient;
  tokenBudget?: number;
};

export async function run<Doc = any, Cfg = any>(
  agent: Agent<Doc, Cfg>,
  {
    document,
    config = {} as Cfg,
    input,
    mode = 'approve',
    expectLanguage = null,
    client,
    tokenBudget = agent.tokenBudget,
  }: RunOptions<Doc, Cfg>,
): Promise<RunResult<Doc, Cfg>> {
  if (agent.validate) agent.validate(document, config);

  const anthropic: MessageClient = client ?? (new Anthropic() as unknown as MessageClient);
  const started = Date.now();

  const system = agent.prompt(document, { ...config, mode } as Cfg & { mode: string });
  const tools = agent.tools(document, config);
  const state: AgentState = { escalations: [], record: {}, notes: {} };

  const messages: { role: string; content: unknown }[] = [{ role: 'user', content: input }];
  const toolResults: ToolResult[] = [];
  const toolCalls: { name: string; input: unknown; output: ToolResult }[] = [];
  let usage: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let stop: StopReason | null = null;

  for (let turn = 0; turn < agent.maxTurns; turn++) {
    const res = await anthropic.messages.create({
      model: agent.model,
      max_tokens: agent.maxTokens,
      // The document and the rules are identical for every input about this
      // subject, so they are worth caching. The input itself is not.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools,
      messages,
    });

    usage = {
      input: usage.input + (res.usage?.input_tokens ?? 0),
      output: usage.output + (res.usage?.output_tokens ?? 0),
      cache_read: usage.cache_read + (res.usage?.cache_read_input_tokens ?? 0),
      cache_write: usage.cache_write + (res.usage?.cache_creation_input_tokens ?? 0),
    };
    stop = res.stop_reason;
    messages.push({ role: 'assistant', content: res.content });

    if (stop === 'refusal' || stop === 'max_tokens') break;

    const uses = res.content.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use',
    );
    if (!uses.length) break;

    const spent = usage.input + usage.output + usage.cache_read + usage.cache_write;
    if (spent >= tokenBudget) { stop = 'budget_exhausted'; break; }
    if (turn === agent.maxTurns - 1) { stop = 'max_turns'; break; }

    const results: unknown[] = [];
    for (const u of uses) {
      let out: ToolResult;
      try {
        out = await agent.runTool(document, config, u.name, u.input, state);
      } catch (err) {
        // A tool that throws costs that call, not the run.
        out = { error: err instanceof Error ? err.message : String(err) };
      }
      toolCalls.push({ name: u.name, input: u.input, output: out });
      toolResults.push(out);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
  }

  const text = textOf(messages);
  const verdict = check(text, { toolResults, document, config, expectLanguage, state }, agent.guards);
  const reason = blockedBecause(agent, { stop, text, verdict });

  /*
   * Fields a tool refused to record.
   *
   * Surfaced here rather than buried in the tool log, because a model reaching
   * for data it may not keep is a signal about the prompt — and under most
   * data regimes the attempt is what an auditor asks about, whether or not
   * anything was stored.
   */
  const refusedFields: string[] = toolCalls.flatMap((t) => t.output?.refused ?? []);

  return {
    agent: agent.name,
    draft: text,
    stop_reason: stop,
    truncated: stop === 'max_tokens',
    refused: stop === 'refusal',
    budget_exhausted: stop === 'budget_exhausted',
    tool_calls: toolCalls,
    escalations: state.escalations,
    escalated: state.escalations.length > 0,
    record: state.record,
    notes: state.notes,
    refused_fields: refusedFields,
    guardrails: verdict,
    /** Only when the model finished AND every guard passed. */
    sendable: reason === null,
    /** Null when sendable; otherwise one sentence a person can act on. */
    blocked_because: reason,
    /** True when the reason is one the domain called grave. */
    grave: reason !== null && reason.startsWith(agent.graveLabel),
    mode,
    latency_ms: Date.now() - started,
    usage,
    token_budget: tokenBudget,
    tokens_used: usage.input + usage.output + usage.cache_read + usage.cache_write,
  };
}
