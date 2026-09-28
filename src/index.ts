import { accessIdentity } from './access';
import { reviewPage } from './admin';
import { applyDecision, chronicleOf, decide, forgetPosts, publish, rowFor, type Decision, type Row } from './chronicle';
import { check, MAX_BYTES, type Batch } from './contract';
import { privacyPage } from './privacy';
import { QUESTIONS, UNFIT_AT } from './screen';

interface Env {
  DB: D1Database;
  /** cf-connecting-ip is the IP_LIMIT counter key and is never written to D1. */
  IP_LIMIT?: RateLimit;
  INSTALL_LIMIT?: RateLimit;
  /** Discord webhook for finished-run posts. With no webhook set, nothing is posted. */
  CHRONICLE_WEBHOOK?: string;
  /** TypeSafe key for the Jev screen each chronicle post passes first. */
  TYPESAFE_API_KEY?: string;
  /** Discord webhook in the admins channel, for runs the screen flagged. */
  ADMIN_WEBHOOK?: string;
  /** The Cloudflare Access team domain and the audience tag of the app that covers /admin. */
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
  RETENTION_DAYS?: string;
}

const LARGEST = Math.max(...Object.values(MAX_BYTES));
const INSTALL = /^\/v1\/installs\/([0-9a-f-]{36})$/;
const REVIEW = /^\/admin\/review\/([0-9a-f-]{36})$/;
const SITE = 'https://squire.rpgm.tools';

// The game runs from many origins (itch.io, installed web apps, self-hosted copies), and no request
// carries a credential, so every origin is allowed.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...extra } });
}

const refuse = (status: number, error: string, field?: string, extra?: Record<string, string>) => json(status, { ok: false, error, ...(field ? { field } : {}) }, extra);

async function over(limit: RateLimit | undefined, key: string): Promise<boolean> {
  return !!limit && !(await limit.limit({ key })).success;
}

const blobKey = (b: Batch) => `${b.install_id}/${b.run_id}/${b.seq}`;

async function receive(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (await over(env.IP_LIMIT, ip)) return refuse(429, 'Too many batches from this address. Wait a minute and send again.', undefined, { 'retry-after': '60' });
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) return refuse(415, 'Send the batch as application/json.');
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > LARGEST) return refuse(413, `A batch can be at most ${LARGEST} bytes.`);
  const text = await request.text();
  if (text.length > LARGEST) return refuse(413, `A batch can be at most ${LARGEST} bytes.`);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return refuse(400, 'The body is not valid JSON.'); }
  const checked = check(body);
  if (!checked.ok) return refuse(400, `${checked.field} ${checked.error}.`, checked.field);
  const b = checked.batch;
  if (text.length > MAX_BYTES[b.level]) return refuse(413, `A "${b.level}" batch can be at most ${MAX_BYTES[b.level]} bytes.`);
  if (await over(env.INSTALL_LIMIT, b.install_id)) return refuse(429, 'Too many batches from this install. Wait a minute and send again.', undefined, { 'retry-after': '60' });

  const id = crypto.randomUUID();
  const hasBlob = b.level !== 'summary';
  const inserted = await env.DB.prepare(
    `INSERT INTO batches (id, install_id, run_id, seq, level, received_at, mod_version, game_version, summary, blob_key, bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (install_id, run_id, seq) DO NOTHING`,
  ).bind(id, b.install_id, b.run_id, b.seq, b.level, Date.now(), b.mod_version, b.game_version, JSON.stringify(b.summary), hasBlob ? blobKey(b) : null, text.length).run();
  const ended = b.summary.outcome.ended && !!env.CHRONICLE_WEBHOOK;
  if (!inserted.meta.changes) {
    const earlier = ended ? await rowFor(env, b.install_id, b.run_id) : null;
    return json(200, { ok: true, duplicate: true, ...(earlier ? { chronicle: chronicleOf(earlier) } : {}) });
  }
  if (hasBlob) {
    const blob = { decisions: b.decisions, ...(b.level === 'full' ? { extra: b.extra, ...(b.backstory ? { backstory: b.backstory } : {}) } : {}) };
    await env.DB.prepare('INSERT INTO blobs (key, install_id, received_at, body) VALUES (?, ?, ?, ?)').bind(blobKey(b), b.install_id, Date.now(), JSON.stringify(blob)).run();
  }
  // A run is checked once, when its first batch with outcome.ended arrives. The reply says what
  // happens to it; Discord is posted to after the reply.
  let row: Row | null = ended ? await decide(env, b) : null;
  if (ended && !row) row = await rowFor(env, b.install_id, b.run_id);
  else if (row) ctx.waitUntil(publish(env, row));
  return json(202, { ok: true, id, level: b.level, ...(row ? { chronicle: chronicleOf(row) } : {}) });
}

async function describe(env: Env, install: string): Promise<Response> {
  const r = await env.DB.prepare('SELECT COUNT(*) AS batches, COUNT(DISTINCT run_id) AS runs, MIN(received_at) AS oldest, MAX(received_at) AS newest FROM batches WHERE install_id = ?')
    .bind(install).first<{ batches: number; runs: number; oldest: number | null; newest: number | null }>();
  const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);
  const runs = (await env.DB.prepare('SELECT * FROM screens WHERE install_id = ? ORDER BY created_at').bind(install).all<Row>()).results;
  return json(200, { ok: true, install_id: install, batches: r?.batches ?? 0, runs: r?.runs ?? 0, oldest: iso(r?.oldest), newest: iso(r?.newest), chronicle: runs.map(chronicleOf) });
}

async function erase(env: Env, install: string): Promise<Response> {
  const blobs = (await env.DB.prepare('DELETE FROM blobs WHERE install_id = ?').bind(install).run()).meta.changes;
  const rows = await env.DB.prepare('DELETE FROM batches WHERE install_id = ?').bind(install).run();
  await forgetPosts(env, install);
  await env.DB.prepare('DELETE FROM screens WHERE install_id = ?').bind(install).run();
  return json(200, { ok: true, install_id: install, deleted_batches: rows.meta.changes, deleted_files: blobs });
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' } });

/** The review page and the screen export. Both need a valid Cloudflare Access token for the /admin app. */
async function admin(request: Request, env: Env, url: URL): Promise<Response> {
  const who = await accessIdentity(request, env.ACCESS_TEAM, env.ACCESS_AUD);
  if (!who) return new Response('Sign in through Cloudflare Access to use this page.', { status: 403 });
  if (url.pathname === '/admin/api/screens' && request.method === 'GET') {
    // Every check since a time, new or newly reviewed, for training a local copy of the screen.
    const since = Number(url.searchParams.get('since') ?? 0) || 0;
    const rows = (await env.DB.prepare('SELECT id, created_at, state, answers, checked, name_category, rest_category, status, review, decision, reviewed_at FROM screens WHERE created_at > ? OR reviewed_at > ? ORDER BY created_at LIMIT 500')
      .bind(since, since).all<Record<string, unknown>>()).results;
    return json(200, {
      ok: true, questions: QUESTIONS, unfit_at: UNFIT_AT,
      screens: rows.map((r) => ({ ...r, state: JSON.parse(String(r.state)), answers: r.answers ? JSON.parse(String(r.answers)) : null })),
    });
  }
  const m = url.pathname.match(REVIEW);
  if (!m) return new Response('Not found.', { status: 404 });
  const row = await env.DB.prepare('SELECT * FROM screens WHERE id = ?').bind(m[1]!).first<Row>();
  if (request.method === 'POST') {
    // The form only ever posts from this host, so a post from anywhere else is refused.
    if (request.headers.get('origin') !== SITE) return new Response('Refused: this form only works from squire.rpgm.tools.', { status: 403 });
    const decision = String((await request.formData()).get('decision') ?? '') as Decision;
    if (row) await applyDecision(env, row, decision, who);
    return new Response(null, { status: 303, headers: { location: url.pathname } });
  }
  return html(reviewPage(row, who), row ? 200 : 404);
}

/** Deletes everything older than the retention period. */
async function sweep(env: Env): Promise<void> {
  const cutoff = Date.now() - Number(env.RETENTION_DAYS ?? 180) * 86400_000;
  await env.DB.prepare('DELETE FROM blobs WHERE received_at < ?').bind(cutoff).run();
  await env.DB.prepare('DELETE FROM batches WHERE received_at < ?').bind(cutoff).run();
  await env.DB.prepare('DELETE FROM screens WHERE created_at < ?').bind(cutoff).run();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(privacyPage(Number(env.RETENTION_DAYS ?? 180)), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });
    }
    if (url.pathname === '/v1/batches') return request.method === 'POST' ? receive(request, env, ctx) : refuse(405, 'Use POST to send a batch.');
    if (url.pathname.startsWith('/admin')) return admin(request, env, url);
    const m = url.pathname.match(INSTALL);
    if (m) {
      if (request.method === 'GET') return describe(env, m[1]!);
      if (request.method === 'DELETE') return erase(env, m[1]!);
      return refuse(405, 'Use GET to see what is stored for an install, or DELETE to remove it.');
    }
    return refuse(404, 'Not found. Batches go to POST /v1/batches.');
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await sweep(env);
  },
} satisfies ExportedHandler<Env>;
