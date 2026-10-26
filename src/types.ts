/**
 * The types are the documentation.
 *
 * A framework's API is whatever the editor says it is when someone types a
 * dot. Everything here exists so that `defineAgent` tells a caller what it
 * wants before they run anything — and so that `runTool` knows which tool it
 * is handling without a cast.
 */

/* ── JSON Schema, narrowed to the part tools actually use ─────────────── */

export type JsonSchemaString = {
  type: 'string';
  description?: string;
  /** A literal union on the way in: `enum: ['a', 'b'] as const` infers 'a' | 'b'. */
  enum?: readonly string[];
};

export type JsonSchemaNumber = { type: 'number' | 'integer'; description?: string };
export type JsonSchemaBoolean = { type: 'boolean'; description?: string };
export type JsonSchemaArray = { type: 'array'; description?: string; items?: JsonSchema };

export type JsonSchemaObject = {
  type: 'object';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
};

export type JsonSchema =
  | JsonSchemaString
  | JsonSchemaNumber
  | JsonSchemaBoolean
  | JsonSchemaArray
  | JsonSchemaObject;

/* ── schema → TypeScript ──────────────────────────────────────────────── */

/**
 * Infer the shape a tool actually receives, from the schema it declares.
 *
 * This is the part that earns the conversion. Without it `input` is `any` and
 * a typo in a property name is a runtime surprise in a tool that may run once
 * a week. With it, the compiler knows that `get_rate` is handed
 * `{ check_in: string; room_type: 'Classic' | 'Superior' }` and says so.
 */
export type FromSchema<S> =
  S extends { type: 'string'; enum: readonly (infer E)[] } ? E
  : S extends { type: 'string' } ? string
  : S extends { type: 'number' | 'integer' } ? number
  : S extends { type: 'boolean' } ? boolean
  : S extends { type: 'array'; items: infer I } ? FromSchema<I>[]
  : S extends { type: 'array' } ? unknown[]
  : S extends { type: 'object'; properties: infer P; required: readonly (infer R)[] }
    ? // Required keys stay required; everything else becomes optional. Getting
      // this backwards is how a framework ends up insisting on fields the model
      // was never asked for.
      { [K in Extract<keyof P, R>]: FromSchema<P[K]> } &
      { [K in Exclude<keyof P, R>]?: FromSchema<P[K]> }
  : S extends { type: 'object'; properties: infer P }
    ? { [K in keyof P]?: FromSchema<P[K]> }
  : unknown;

/* ── tools ────────────────────────────────────────────────────────────── */

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: JsonSchemaObject;
};

/** The input a named tool receives, derived from the tool list it came from. */
export type ToolInput<T extends readonly ToolDefinition[], N extends T[number]['name']> =
  FromSchema<Extract<T[number], { name: N }>['input_schema']>;

/* ── guards ───────────────────────────────────────────────────────────── */

export type Severity = 'block' | 'warn';

export type Issue = {
  /** What a reviewer reads. "Blocked" on its own is useless. */
  rule: string;
  severity: Severity;
  detail: string;
};

/** What a guard can see. Deliberately everything, because rules are domain code. */
export type GuardContext<Doc = unknown, Cfg = unknown> = {
  toolResults: unknown[];
  document: Doc;
  config: Cfg;
  expectLanguage: string | null;
  state: AgentState;
};

/** Returns null to pass. Returning the match lets the detail quote it back. */
export type Guard<Doc = unknown, Cfg = unknown> =
  ((text: string, ctx: GuardContext<Doc, Cfg>) => Issue | Issue[] | null) & {
    ruleName?: string;
    severity?: Severity;
  };

export type Verdict = {
  ok: boolean;
  issues: Issue[];
  blocked: string[];
  warnings: string[];
};

/* ── running ──────────────────────────────────────────────────────────── */

export type Escalation = { at: string; reason?: string; summary?: string; [k: string]: unknown };

/** Mutable scratch space a tool may write to during one run. */
export type AgentState = {
  escalations: Escalation[];
  record: Record<string, unknown>;
  notes: Record<string, unknown>;
};

export type ToolResult = {
  /** Tools return this rather than throwing when they have no answer. */
  known?: boolean;
  /** Fields a tool declined to store. Surfaced on the result, not buried. */
  refused?: string[];
  error?: string;
  [k: string]: unknown;
};

export type Usage = { input: number; output: number; cache_read: number; cache_write: number };

export type StopReason =
  | 'end_turn' | 'max_tokens' | 'refusal' | 'tool_use' | 'pause_turn'
  /** Ours, not the API's: the loop stopped itself. */
  | 'budget_exhausted' | 'max_turns'
  | (string & {});

export type RunResult<Doc = unknown, Cfg = unknown> = {
  agent: string;
  draft: string;
  stop_reason: StopReason | null;
  truncated: boolean;
  refused: boolean;
  budget_exhausted: boolean;
  tool_calls: { name: string; input: unknown; output: ToolResult }[];
  escalations: Escalation[];
  escalated: boolean;
  record: Record<string, unknown>;
  notes: Record<string, unknown>;
  refused_fields: string[];
  guardrails: Verdict;
  /** True only when the model finished AND every guard passed. */
  sendable: boolean;
  /** Null when sendable; otherwise one sentence a person can act on. */
  blocked_because: string | null;
  /** True when the reason is one this domain called grave. */
  grave: boolean;
  mode: string;
  latency_ms: number;
  usage: Usage;
  token_budget: number;
  tokens_used: number;
};

/* ── the client ───────────────────────────────────────────────────────── */

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: string; [k: string]: unknown };

export type ModelResponse = {
  stop_reason: StopReason;
  content: ContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

/**
 * The minimum this framework needs from a client.
 *
 * Structural rather than a concrete SDK type, so a test can pass a scripted
 * object and a caller can pass the real SDK, and neither has to pretend to be
 * the other.
 */
export type MessageClient = {
  messages: { create(request: Record<string, unknown>): Promise<ModelResponse> };
};
