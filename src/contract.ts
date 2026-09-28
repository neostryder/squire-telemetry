// The batch format the Squire mod sends. Version 1.
//
// A batch belongs to one run and carries one consent level. `summary` is required at every level;
// `decisions` is required for "decisions" and "full" and refused for "summary"; `extra` and `backstory`
// are accepted only for "full", and `backstory` only when `backstory_consent` is true.

export type Level = 'summary' | 'decisions' | 'full';
export const LEVELS: readonly Level[] = ['summary', 'decisions', 'full'];

export const MAX_BYTES: Record<Level, number> = { summary: 32 * 1024, decisions: 1024 * 1024, full: 1536 * 1024 };
// D1 holds at most 2,000,000 bytes in one row, so the largest batch stays well under that.
export const MAX_DECISIONS = 5000;

export interface Summary {
  persona: { name: string; race: string; class: string };
  outcome: { ended: boolean; won: boolean; depth_max: number; turns: number; cause_of_death: string | null };
  top_kills: Array<{ name: string; count: number }>;
  tokens: { input: number; output: number; calls: number };
  calibration: Record<string, unknown>;
}

export interface Decision {
  t: number;
  kind: string;
  question: string;
  choice: string;
  confidence: number | null;
  probs: Record<string, number> | null;
  outcome: string | null;
}

export interface Batch {
  schema: 1;
  level: Level;
  install_id: string;
  run_id: string;
  seq: number;
  sent_at: string;
  mod_version: string;
  game_version: string;
  summary: Summary;
  decisions?: Decision[];
  extra?: Record<string, unknown>;
  backstory_consent?: boolean;
  backstory?: string;
}

export type Checked = { ok: true; batch: Batch } | { ok: false; field: string; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
// Matches keys like persona_note or backstory anywhere inside decisions, extra or calibration, so persona text is refused there even under another key name.
const PERSONA_KEYS = /backstory|persona|quirk|biography|lore/i;

class Invalid extends Error {
  constructor(readonly field: string, message: string) { super(message); }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown, field: string, max: number, nullable = false): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !v.trim()) throw new Invalid(field, nullable ? 'must be a non-empty string or null' : 'must be a non-empty string');
  if (v.length > max) throw new Invalid(field, `must be at most ${max} characters`);
  return v;
}

function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Invalid(field, `must be a whole number from ${min} to ${max}`);
  return v;
}

function num(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Invalid(field, `must be a number from ${min} to ${max}`);
  return v;
}

function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new Invalid(field, 'must be true or false');
  return v;
}

function obj(v: unknown, field: string): Record<string, unknown> {
  if (!isObj(v)) throw new Invalid(field, 'must be an object');
  return v;
}

function noPersonaKeys(v: unknown, field: string): void {
  if (Array.isArray(v)) v.forEach((x, i) => noPersonaKeys(x, `${field}[${i}]`));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) {
    if (PERSONA_KEYS.test(k)) throw new Invalid(`${field}.${k}`, 'persona text is not accepted in this part of a batch');
    noPersonaKeys(x, `${field}.${k}`);
  }
}

function summary(v: unknown): Summary {
  const s = obj(v, 'summary');
  const p = obj(s.persona, 'summary.persona');
  const o = obj(s.outcome, 'summary.outcome');
  const t = obj(s.tokens, 'summary.tokens');
  if (!Array.isArray(s.top_kills) || s.top_kills.length > 10) throw new Invalid('summary.top_kills', 'must be a list of at most 10 entries');
  const calibration = obj(s.calibration ?? {}, 'summary.calibration');
  noPersonaKeys(calibration, 'summary.calibration');
  if (JSON.stringify(calibration).length > 16 * 1024) throw new Invalid('summary.calibration', 'must be at most 16 KB as JSON');
  return {
    persona: { name: str(p.name, 'summary.persona.name', 40)!, race: str(p.race, 'summary.persona.race', 24)!, class: str(p.class, 'summary.persona.class', 24)! },
    outcome: {
      ended: bool(o.ended, 'summary.outcome.ended'), won: bool(o.won, 'summary.outcome.won'),
      depth_max: int(o.depth_max, 'summary.outcome.depth_max', 0, 127), turns: int(o.turns, 'summary.outcome.turns', 0, 1e12),
      cause_of_death: str(o.cause_of_death ?? null, 'summary.outcome.cause_of_death', 80, true),
    },
    top_kills: s.top_kills.map((k, i) => {
      const e = obj(k, `summary.top_kills[${i}]`);
      return { name: str(e.name, `summary.top_kills[${i}].name`, 48)!, count: int(e.count, `summary.top_kills[${i}].count`, 1, 1e9) };
    }),
    tokens: { input: int(t.input, 'summary.tokens.input', 0, 1e13), output: int(t.output, 'summary.tokens.output', 0, 1e13), calls: int(t.calls, 'summary.tokens.calls', 0, 1e10) },
    calibration,
  };
}

function decision(v: unknown, i: number): Decision {
  const f = `decisions[${i}]`;
  const d = obj(v, f);
  noPersonaKeys(d, f);
  let probs: Record<string, number> | null = null;
  if (d.probs != null) {
    probs = {};
    for (const [k, p] of Object.entries(obj(d.probs, `${f}.probs`))) probs[k] = num(p, `${f}.probs.${k}`, 0, 1);
  }
  return {
    t: int(d.t, `${f}.t`, 0, 1e12), kind: str(d.kind, `${f}.kind`, 32)!, question: str(d.question, `${f}.question`, 64)!,
    choice: str(d.choice, `${f}.choice`, 64)!, confidence: d.confidence == null ? null : num(d.confidence, `${f}.confidence`, 0, 1),
    probs, outcome: str(d.outcome ?? null, `${f}.outcome`, 64, true),
  };
}

/** Returns the first wrong field as a dotted path such as summary.outcome.depth_max, which the Worker sends back in its 400 answer. */
export function check(body: unknown): Checked {
  try {
    const b = obj(body, '(body)');
    if (b.schema !== 1) throw new Invalid('schema', 'must be 1');
    if (!LEVELS.includes(b.level as Level)) throw new Invalid('level', 'must be "summary", "decisions" or "full"');
    const level = b.level as Level;
    if (typeof b.install_id !== 'string' || !UUID.test(b.install_id)) throw new Invalid('install_id', 'must be a lowercase version 4 UUID');
    if (typeof b.run_id !== 'string' || !RUN_ID.test(b.run_id)) throw new Invalid('run_id', 'must be 1 to 64 letters, digits, dashes or underscores');
    const sent = str(b.sent_at, 'sent_at', 40)!;
    if (Number.isNaN(Date.parse(sent))) throw new Invalid('sent_at', 'must be an ISO 8601 time');
    for (const k of ['mod_version', 'game_version'] as const) if (typeof b[k] !== 'string' || !VERSION.test(b[k] as string)) throw new Invalid(k, 'must be a version such as 1.2.3');
    const batch: Batch = {
      schema: 1, level, install_id: b.install_id, run_id: b.run_id, seq: int(b.seq, 'seq', 0, 1e6), sent_at: sent,
      mod_version: b.mod_version as string, game_version: b.game_version as string, summary: summary(b.summary),
    };
    if (level === 'summary') {
      for (const k of ['decisions', 'extra', 'backstory']) if (b[k] !== undefined) throw new Invalid(k, `is not accepted at the "summary" level`);
      return { ok: true, batch };
    }
    if (!Array.isArray(b.decisions) || b.decisions.length > MAX_DECISIONS) throw new Invalid('decisions', `must be a list of at most ${MAX_DECISIONS} records`);
    batch.decisions = b.decisions.map(decision);
    if (level === 'decisions') {
      for (const k of ['extra', 'backstory']) if (b[k] !== undefined) throw new Invalid(k, `is only accepted at the "full" level`);
      return { ok: true, batch };
    }
    if (b.extra !== undefined) { batch.extra = obj(b.extra, 'extra'); noPersonaKeys(batch.extra, 'extra'); }
    if (b.backstory !== undefined) {
      if (b.backstory_consent !== true) throw new Invalid('backstory', 'is only accepted when backstory_consent is true');
      batch.backstory_consent = true;
      batch.backstory = str(b.backstory, 'backstory', 20000)!;
    }
    return { ok: true, batch };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, field: e.field, error: e.message };
    throw e;
  }
}
