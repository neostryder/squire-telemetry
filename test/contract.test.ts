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
  it('holds or hides on the gate questions and names the reason from the categories', async () => {
    const { screen, QUESTIONS, UNFIT_AT } = await import('../src/screen');
    const all = [...Object.keys(QUESTIONS.name), ...Object.keys(QUESTIONS.details)];
    const answer = (set: Record<string, number>) => async (_url: string, init: RequestInit) => {
      const asked = Object.keys((JSON.parse(String(init.body)) as { questions: object }).questions);
      return new Response(JSON.stringify({ answers: Object.fromEntries(all.filter((q) => asked.includes(q)).map((q) => [q, { noul: set[q] ?? 0.01 }])) }));
    };
    const real = globalThis.fetch;
    try {
      globalThis.fetch = answer({ name_unfit: 0.9, name_sexual: 0.8, name_hate: 0.3 }) as typeof fetch;
      expect(await screen(summary, 'k')).toMatchObject({ checked: true, hideName: true, skip: false, nameCategory: 'sexual', restCategory: null });
      globalThis.fetch = answer({ rest_unfit: UNFIT_AT }) as typeof fetch;
      expect(await screen(summary, 'k')).toMatchObject({ hideName: false, skip: true, restCategory: 'general' });
      globalThis.fetch = answer({}) as typeof fetch;
      expect(await screen(summary, 'k')).toMatchObject({ checked: true, hideName: false, skip: false });
      globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch;
      expect(await screen(summary, 'k')).toMatchObject({ checked: false, hideName: true, skip: true, answers: null });
      expect(await screen(summary, undefined)).toMatchObject({ checked: false, skip: true });
    } finally { globalThis.fetch = real; }
    expect((runPost(summary, '0.2.0', true) as { embeds: Array<{ title: string }> }).embeds[0]!.title).toBe('An unnamed adventurer, Human Warrior');
  });
});

describe('admin review', () => {
  const row = async (over: Record<string, unknown>) => {
    const base = { id: '00000000-0000-4000-8000-000000000000', install_id: 'i', run_id: 'run-0001', created_at: 0, mod_version: '0.2.0', summary: JSON.stringify(summary), state: '{}', answers: JSON.stringify({ name_unfit: 0.6, rest_unfit: 0.1 }), checked: 1, name_category: null, rest_category: null, status: 'posted', review: null, decision: null, reviewer: null, reviewed_at: null, public_message: null, admin_message: null };
    return { ...base, ...over } as import('../src/chronicle').Row;
  };
  it('offers the choices that fit the run', async () => {
    const { choices } = await import('../src/chronicle');
    expect(choices(await row({ status: 'posted_without_name', name_category: 'hate', review: 'pending' }))).toEqual(['show_name', 'keep_name_hidden']);
    expect(choices(await row({ status: 'held', rest_category: 'advert', review: 'pending' }))).toEqual(['post', 'keep']);
    expect(choices(await row({ status: 'held', checked: 0, answers: null, review: 'pending' }))).toEqual(['post', 'post_without_name', 'keep']);
    expect(choices(await row({ status: 'held', review: 'done', decision: 'keep' }))).toEqual([]);
  });
  it('tells the player why, then what the admin chose', async () => {
    const { chronicleOf } = await import('../src/chronicle');
    const hidden = chronicleOf(await row({ status: 'posted_without_name', name_category: 'contact', review: 'pending' }));
    expect(hidden).toMatchObject({ status: 'posted_without_name', flagged: 'name', category: 'contact', review: 'pending' });
    expect(hidden.message).toContain('may contain contact details');
    expect(chronicleOf(await row({ status: 'held', checked: 0, answers: null, review: 'pending' }))).toMatchObject({ flagged: 'unchecked', category: null });
    expect(chronicleOf(await row({ status: 'posted', review: 'done', decision: 'show_name' })).message).toContain('now shows it');
  });
  it('sends admins a review button and never pings anyone', async () => {
    const { adminPost } = await import('../src/chronicle');
    const body = adminPost(await row({ status: 'held', rest_category: 'hate', review: 'pending' })) as { allowed_mentions: { parse: unknown[] }; components: Array<{ components: Array<{ url: string }> }>; embeds: Array<{ description: string }> };
    expect(body.allowed_mentions.parse).toEqual([]);
    expect(body.components[0]!.components[0]!.url).toBe('https://squire.rpgm.tools/admin/review/00000000-0000-4000-8000-000000000000');
    expect(body.embeds[0]!.description).toContain('may contain a slur');
  });
  it('refuses the admin routes without a valid Access token', async () => {
    const { accessIdentity } = await import('../src/access');
    expect(await accessIdentity(new Request('https://squire.rpgm.tools/admin/api/screens'), 'rpgm.cloudflareaccess.com', 'aud')).toBeNull();
    expect(await accessIdentity(new Request('https://x/', { headers: { 'cf-access-jwt-assertion': 'a.b.c' } }), 'rpgm.cloudflareaccess.com', 'aud')).toBeNull();
  });
});

describe('forum posts', () => {
  const run = (name: string, hideName = false) => runPost({ ...summary, persona: { ...summary.persona, name } }, '0.2.0', hideName) as { thread_name: string };

  it('always titles the forum thread, in 100 characters or fewer', async () => {
    const { threadName } = await import('../src/discord');
    expect(run('Beren').thread_name).toBe('Beren, Human Warrior, DL 12');
    expect(run('Beren', true).thread_name).toBe('An unnamed adventurer, Human Warrior, DL 12');
    for (const name of ['', '@@@', 'x'.repeat(500), '<@1> https://evil.example']) {
      const title = run(name).thread_name;
      expect(title.length).toBeGreaterThan(0);
      expect(title.length).toBeLessThanOrEqual(100);
    }
    const long = { ...summary, persona: { name: 'n'.repeat(90), race: 'r'.repeat(90), class: 'c'.repeat(90) } };
    expect(threadName(long).length).toBeLessThanOrEqual(100);
  });

  it('edits and deletes a forum post inside its thread', async () => {
    const { hookUrl, storedMessage } = await import('../src/chronicle');
    const url = 'https://discord.com/api/webhooks/1/tok';
    expect(hookUrl(url, null)).toBe(`${url}?wait=true&with_components=true`);
    expect(hookUrl(url, '77/77')).toBe(`${url}/messages/77?thread_id=77&with_components=true`);
    expect(hookUrl(url, '88')).toBe(`${url}/messages/88?with_components=true`);
    expect(hookUrl(`${url}?thread_id=5`, null)).toBe(`${url}?wait=true&with_components=true&thread_id=5`);
    expect(storedMessage({ id: '77', channel_id: '77' })).toBe('77/77');
    expect(storedMessage({ id: '88', channel_id: '12' })).toBe('88');
    expect(storedMessage({})).toBeNull();
  });

  it('keeps a failed post waiting, out of the daily count, and sends it on retry', async () => {
    const { publish, chronicleOf } = await import('../src/chronicle');
    const updates: unknown[][] = [];
    const DB = { prepare: () => ({ bind: (...args: unknown[]) => ({ run: async () => { updates.push(args); return { meta: { changes: 1 } }; } }) }) } as unknown as D1Database;
    const env = { DB, CHRONICLE_WEBHOOK: 'https://discord.com/api/webhooks/1/tok' };
    const row = { id: 'r1', install_id: 'i', run_id: 'run-0001', created_at: 0, mod_version: '0.2.0', summary: JSON.stringify(summary), state: '{}', answers: null, checked: 1, name_category: 'hate', rest_category: null, status: 'posted_without_name', review: null, decision: null, reviewer: null, reviewed_at: null, public_message: null, admin_message: null } as import('../src/chronicle').Row;
    const real = globalThis.fetch;
    const errors = console.error;
    const sent: string[] = [];
    try {
      console.error = () => {};
      globalThis.fetch = (async (_u: string, init: RequestInit) => { sent.push(String(init.body)); return new Response('{"code":220001}', { status: 400 }); }) as typeof fetch;
      await publish(env, row);
      expect(JSON.parse(sent[0]!).thread_name).toBe('An unnamed adventurer, Human Warrior, DL 12');
      expect(updates[0]).toEqual(['waiting_without_name', null, null, 'r1']);
      const waiting = chronicleOf({ ...row, status: 'waiting_without_name' });
      expect(waiting.status).toBe('waiting');
      expect(waiting.message).toContain('will be sent again');
      globalThis.fetch = (async () => new Response(JSON.stringify({ id: '77', channel_id: '77' }))) as typeof fetch;
      await publish(env, { ...row, status: 'waiting_without_name' });
      expect(updates[1]).toEqual(['posted_without_name', '77/77', null, 'r1']);
    } finally { globalThis.fetch = real; console.error = errors; }
  });
});
