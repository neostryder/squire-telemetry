import { describe, it, expect } from 'vitest';
import { check } from '../src/contract';
import { plain, runPost } from '../src/discord';

const summary = {
  persona: { name: 'Beren', race: 'Human', class: 'Warrior' },
  outcome: { ended: true, won: false, depth_max: 12, turns: 48211, cause_of_death: 'Grip, Farmer Maggot\'s Dog' },
  top_kills: [{ name: 'Cave spider', count: 41 }, { name: 'Kobold', count: 9 }],
  tokens: { input: 120400, output: 3100, calls: 212 },
  calibration: { brier: 0.18, buckets: [[0.5, 0.52], [0.9, 0.84]] },
};
const base = { schema: 1, install_id: '3f2b8c1e-4d5a-4b6c-9d7e-0a1b2c3d4e5f', run_id: 'run-0001', seq: 0, sent_at: '2026-09-27T20:00:00Z', mod_version: '0.2.0', game_version: '0.22.0', summary };
const decision = { t: 1200, kind: 'fight', question: 'best_move', choice: 'melee', confidence: 0.71, probs: { melee: 0.71, flee: 0.29 }, outcome: 'won' };

describe('batch contract', () => {
  it('accepts each level with its own parts', () => {
    expect(check({ ...base, level: 'summary' }).ok).toBe(true);
    expect(check({ ...base, level: 'decisions', decisions: [decision] }).ok).toBe(true);
    expect(check({ ...base, level: 'full', decisions: [decision], extra: { plan: 'descend' }, backstory_consent: true, backstory: 'Raised in Bree.' }).ok).toBe(true);
  });
  it('refuses parts that belong to a higher level', () => {
    expect(check({ ...base, level: 'summary', decisions: [decision] })).toMatchObject({ ok: false, field: 'decisions' });
    expect(check({ ...base, level: 'decisions', decisions: [decision], extra: {} })).toMatchObject({ ok: false, field: 'extra' });
  });
  it('keeps backstory out unless it was separately allowed', () => {
    expect(check({ ...base, level: 'full', decisions: [], backstory: 'Raised in Bree.' })).toMatchObject({ ok: false, field: 'backstory' });
  });
  it('refuses persona text inside decision records and extra data', () => {
    expect(check({ ...base, level: 'decisions', decisions: [{ ...decision, persona_note: 'brave' }] })).toMatchObject({ ok: false, field: 'decisions[0].persona_note' });
    expect(check({ ...base, level: 'full', decisions: [], extra: { log: { backstory: 'x' } } })).toMatchObject({ ok: false, field: 'extra.log.backstory' });
  });
  it('names the field that is wrong', () => {
    expect(check({ ...base, level: 'summary', install_id: 'not-a-uuid' })).toMatchObject({ ok: false, field: 'install_id' });
    expect(check({ ...base, level: 'summary', summary: { ...summary, outcome: { ...summary.outcome, depth_max: 400 } } })).toMatchObject({ ok: false, field: 'summary.outcome.depth_max' });
    expect(check({ ...base, level: 'nope' })).toMatchObject({ ok: false, field: 'level' });
  });
});

describe('Discord run post', () => {
  it('flattens player text so it cannot mention, link or format', () => {
    expect(plain('@everyone see https://evil.example **now**', 40)).toBe('everyone see now');
    expect(plain('<@123456> [x](http://a.b)', 40)).toBe('123456 x');
  });
  it('posts only summary fields and never pings anyone', () => {
    const body = runPost(summary, '0.2.0') as { allowed_mentions: { parse: unknown[] }; embeds: Array<{ title: string; description: string }> };
    expect(body.allowed_mentions.parse).toEqual([]);
    expect(body.embeds[0]!.title).toBe('Beren, Human Warrior');
    expect(body.embeds[0]!.description).toContain('Killed by Grip');
    expect(JSON.stringify(body)).not.toContain('backstory');
  });
});

describe('chronicle screen', () => {
  it('hides a flagged name and skips a post whose other text is flagged', async () => {
    const { screen, UNFIT_AT } = await import('../src/screen');
    const answer = (name: number, rest: number) => async () => new Response(JSON.stringify({ answers: { name_unfit: { noul: name }, rest_unfit: { noul: rest } } }));
    const real = globalThis.fetch;
    try {
      globalThis.fetch = answer(0.9, 0.01) as typeof fetch;
      expect(await screen(summary, 'k')).toEqual({ hideName: true, skip: false });
      globalThis.fetch = answer(0.02, UNFIT_AT) as typeof fetch;
      expect(await screen(summary, 'k')).toEqual({ hideName: false, skip: true });
      globalThis.fetch = answer(0.02, 0.01) as typeof fetch;
      expect(await screen(summary, 'k')).toEqual({ hideName: false, skip: false });
      globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch;
      expect(await screen(summary, 'k')).toEqual({ hideName: true, skip: true });
      expect(await screen(summary, undefined)).toEqual({ hideName: true, skip: true });
    } finally { globalThis.fetch = real; }
    expect((runPost(summary, '0.2.0', true) as { embeds: Array<{ title: string }> }).embeds[0]!.title).toBe('An unnamed adventurer, Human Warrior');
  });
});
