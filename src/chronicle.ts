import type { Batch, Summary } from './contract';
import { plain, runPost } from './discord';
import { reasonWords, screen, type Category } from './screen';

export const POSTS_PER_INSTALL_PER_DAY = 10;
const REVIEW_URL = 'https://squire.rpgm.tools/admin/review/';

/** waiting and waiting_without_name mark a run whose Discord post failed; it is sent again later. */
export type Status = 'posted' | 'posted_without_name' | 'held' | 'over_limit' | 'waiting' | 'waiting_without_name';

const WAITING: readonly Status[] = ['waiting', 'waiting_without_name'];
/** The post a waiting run is still owed. */
const intended = (s: Status): Status => (s === 'waiting' ? 'posted' : s === 'waiting_without_name' ? 'posted_without_name' : s);
const waitingFor = (s: Status): Status => (s === 'posted' ? 'waiting' : s === 'posted_without_name' ? 'waiting_without_name' : s);
/** How long a waiting run keeps being retried. */
const RETRY_FOR_MS = 3 * 86400_000;
export type Decision = 'show_name' | 'keep_name_hidden' | 'post' | 'post_without_name' | 'keep';

/** One row of the screens table: a finished run, its Jev check, and any admin review. */
export interface Row {
  id: string;
  install_id: string;
  run_id: string;
  created_at: number;
  mod_version: string;
  summary: string;
  state: string;
  answers: string | null;
  checked: number;
  name_category: Category | null;
  rest_category: Category | null;
  status: Status;
  review: 'pending' | 'done' | null;
  decision: Decision | null;
  reviewer: string | null;
  reviewed_at: number | null;
  public_message: string | null;
  admin_message: string | null;
}

export interface ChronicleEnv {
  DB: D1Database;
  CHRONICLE_WEBHOOK?: string;
  ADMIN_WEBHOOK?: string;
  TYPESAFE_API_KEY?: string;
}

const DETAIL_WORDS = 'race, class, cause of death or monster names';
const DETAILS = `the ${DETAIL_WORDS}`;
const WAITING_MESSAGE = 'Your run has not reached Discord yet because the post failed. It will be sent again within the hour.';

/** The sentence the mod can show the player as it is. */
export function playerMessage(r: Pick<Row, 'status' | 'checked' | 'name_category' | 'rest_category' | 'decision'>): string {
  switch (r.decision) {
    case 'show_name': return 'An admin checked your character\'s name, and the post in #squire-chronicles now shows it.';
    case 'keep_name_hidden': return 'An admin checked your character\'s name, and the post in #squire-chronicles still says An unnamed adventurer.';
    case 'post': return 'An admin checked your run and posted it to #squire-chronicles.';
    case 'post_without_name': return 'An admin checked your run and posted it to #squire-chronicles as An unnamed adventurer.';
    case 'keep': return 'An admin checked your run and left it out of #squire-chronicles.';
  }
  if (r.status === 'over_limit') return `Your run was not posted to Discord because this install has already posted ${POSTS_PER_INSTALL_PER_DAY} runs today.`;
  if (WAITING.includes(r.status)) return WAITING_MESSAGE;
  if (r.status === 'posted') return 'Your run was posted to #squire-chronicles on the RPGM Tools Discord server.';
  if (r.status === 'posted_without_name') return `Your character's name was left out of the Discord post because it ${reasonWords(r.name_category ?? 'general')}. An admin will look at it and can add the name back.`;
  if (!r.checked) return 'Your run was not posted to Discord because the check for offensive text could not run. An admin will look at it and can post it.';
  return `Your run was not posted to Discord because ${DETAILS} ${reasonWords(r.rest_category ?? 'general')}. An admin will look at it and can post it.`;
}

/** The chronicle object returned to the mod, in the final batch's reply and under GET /v1/installs/<id>. */
export function chronicleOf(r: Row) {
  const flagged = r.status === 'over_limit' ? null : !r.checked ? 'unchecked' : r.rest_category ? 'details' : r.name_category ? 'name' : null;
  return {
    run_id: r.run_id,
    status: WAITING.includes(r.status) ? 'waiting' : r.status,
    flagged,
    category: flagged === 'details' ? r.rest_category : flagged === 'name' ? r.name_category : null,
    review: r.review,
    decision: r.decision,
    message: playerMessage(r),
  };
}

export const summaryOf = (r: Row) => JSON.parse(r.summary) as Summary;

/**
 * Checks a finished run and records what happens to it. Posting to Discord happens afterwards in
 * publish(), so the reply to the batch is not held up by Discord. Returns null when the run was
 * already recorded by an earlier copy of the batch.
 */
export async function decide(env: ChronicleEnv, b: Batch): Promise<Row | null> {
  const since = Date.now() - 86400_000;
  // A run whose post failed does not use up the install's daily posts until it is sent.
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM screens WHERE install_id = ? AND created_at > ? AND status NOT IN ('over_limit', 'waiting', 'waiting_without_name')").bind(b.install_id, since).first<{ n: number }>();
  const over = (recent?.n ?? 0) >= POSTS_PER_INSTALL_PER_DAY;
  const v = over ? null : await screen(b.summary, env.TYPESAFE_API_KEY);
  const status: Status = over ? 'over_limit' : v!.skip ? 'held' : v!.hideName ? 'posted_without_name' : 'posted';
  const row: Row = {
    id: crypto.randomUUID(), install_id: b.install_id, run_id: b.run_id, created_at: Date.now(), mod_version: b.mod_version,
    summary: JSON.stringify(b.summary), state: JSON.stringify(v?.state ?? {}), answers: v?.answers ? JSON.stringify(v.answers) : null,
    checked: v?.checked ? 1 : 0, name_category: v?.nameCategory ?? null, rest_category: v?.restCategory ?? null, status,
    review: status === 'held' || status === 'posted_without_name' ? 'pending' : null,
    decision: null, reviewer: null, reviewed_at: null, public_message: null, admin_message: null,
  };
  const inserted = await env.DB.prepare(
    `INSERT INTO screens (id, install_id, run_id, created_at, mod_version, summary, state, answers, checked, name_category, rest_category, status, review)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (install_id, run_id) DO NOTHING`,
  ).bind(row.id, row.install_id, row.run_id, row.created_at, row.mod_version, row.summary, row.state, row.answers, row.checked, row.name_category, row.rest_category, row.status, row.review).run();
  return inserted.meta.changes ? row : null;
}

export async function rowFor(env: ChronicleEnv, install: string, run: string): Promise<Row | null> {
  return env.DB.prepare('SELECT * FROM screens WHERE install_id = ? AND run_id = ?').bind(install, run).first<Row>();
}

/**
 * The URL for one webhook call. A stored message is "<thread>/<message>" when it opened a forum thread, because
 * editing or deleting a message inside a thread needs thread_id; a message in an ordinary channel is its id alone.
 */
export function hookUrl(url: string, message: string | null): string {
  const [base, query] = url.split('?');
  const [thread, id] = message?.includes('/') ? message.split('/') : [null, message];
  // with_components lets a webhook made by the bot send the Review link button.
  const params = [...(id ? [] : ['wait=true']), ...(thread ? [`thread_id=${thread}`] : []), 'with_components=true', ...(query ? [query] : [])];
  return `${base}${id ? `/messages/${id}` : ''}?${params.join('&')}`;
}

/** What to store for a posted message. A forum's first message shares its id with the thread it opens. */
export function storedMessage(sent: { id?: string; channel_id?: string }): string | null {
  if (!sent.id) return null;
  return sent.channel_id === sent.id ? `${sent.id}/${sent.id}` : sent.id;
}

/** Discord message flag 1 << 12: new posts and review notices never push a notification. Sent on POST only, since an edit cannot set it. */
const SUPPRESS_NOTIFICATIONS = 1 << 12;

async function hook(url: string | undefined, method: 'POST' | 'PATCH' | 'DELETE', message: string | null, body?: unknown): Promise<string | null> {
  if (!url) return null;
  try {
    const r = await fetch(hookUrl(url, message), { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(method === 'POST' ? { ...(body as object), flags: SUPPRESS_NOTIFICATIONS } : body) } : {}) });
    if (!r.ok) {
      console.error(`Discord webhook ${method} failed with ${r.status}: ${(await r.text()).slice(0, 300)}`);
      return null;
    }
    if (method === 'DELETE') return null;
    return storedMessage((await r.json()) as { id?: string; channel_id?: string });
  } catch (err) {
    console.error(`Discord webhook ${method} did not complete: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const TITLES: Record<Decision, string> = {
  show_name: 'Name added back', keep_name_hidden: 'Name kept hidden', post: 'Posted', post_without_name: 'Posted without the name', keep: 'Kept off Discord',
};

/** The #admins message for a flagged run. */
export function adminPost(r: Row): Record<string, unknown> {
  const s = summaryOf(r);
  const answers = r.answers ? (JSON.parse(r.answers) as Record<string, number>) : null;
  const title = r.decision ? `${TITLES[r.decision]}: ${plain(s.persona.name, 60)}`
    : r.status === 'posted_without_name' ? 'Name hidden in a chronicle post'
    : r.checked ? 'Chronicle post held' : 'Chronicle post held: the check did not run';
  const reasons: string[] = [];
  if (r.name_category) reasons.push(`The name ${reasonWords(r.name_category)}.`);
  if (r.rest_category) reasons.push(`The ${DETAIL_WORDS} ${reasonWords(r.rest_category)}.`);
  const fields = [
    { name: 'Name', value: plain(s.persona.name, 200), inline: true },
    { name: 'Race and class', value: `${plain(s.persona.race, 60)} ${plain(s.persona.class, 60)}`, inline: true },
    { name: 'Cause of death', value: s.outcome.cause_of_death ? plain(s.outcome.cause_of_death, 200) : 'None', inline: false },
    { name: 'Most killed', value: s.top_kills.slice(0, 3).map((k) => plain(k.name, 80)).join(', ') || 'None', inline: false },
    ...(answers ? [{ name: 'Jev', value: `name ${answers.name_unfit!.toFixed(2)}, details ${answers.rest_unfit!.toFixed(2)}`, inline: true }] : []),
    ...(r.reviewer ? [{ name: 'Reviewed by', value: plain(r.reviewer, 100), inline: true }] : []),
  ];
  return {
    allowed_mentions: { parse: [] },
    embeds: [{ title, description: reasons.join(' ') || undefined, color: r.decision ? 0x808080 : r.status === 'held' ? 0xd93f0b : 0xfbca04, fields, footer: { text: `Squire ${r.mod_version}, run ${plain(r.run_id, 64)}` } }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Review', url: REVIEW_URL + r.id }] }],
  };
}

/**
 * Sends the public post and, for a flagged run, the #admins post, then records their message ids. A public post
 * that fails leaves the run waiting, and retryWaiting() sends it again; a post already made is not repeated.
 */
export async function publish(env: ChronicleEnv, r: Row): Promise<void> {
  if (r.status === 'over_limit') return;
  const s = summaryOf(r);
  const owed = intended(r.status);
  let status = owed, pub = r.public_message;
  if (owed !== 'held' && !pub) {
    pub = await hook(env.CHRONICLE_WEBHOOK, 'POST', null, runPost(s, r.mod_version, owed === 'posted_without_name'));
    if (!pub && env.CHRONICLE_WEBHOOK) status = waitingFor(owed);
  }
  const adm = r.admin_message ?? (r.review === 'pending' ? await hook(env.ADMIN_WEBHOOK, 'POST', null, adminPost(r)) : null);
  await env.DB.prepare('UPDATE screens SET status = ?, public_message = ?, admin_message = ? WHERE id = ?').bind(status, pub, adm, r.id).run();
}

/** Sends again every recent run whose Discord post failed, oldest first. */
export async function retryWaiting(env: ChronicleEnv, limit = 20): Promise<number> {
  const rows = (await env.DB.prepare("SELECT * FROM screens WHERE status IN ('waiting', 'waiting_without_name') AND created_at > ? ORDER BY created_at LIMIT ?")
    .bind(Date.now() - RETRY_FOR_MS, limit).all<Row>()).results;
  for (const r of rows) await publish(env, r);
  return rows.length;
}

/** Which decisions an admin can make on a run in its current state. */
export function choices(r: Row): Decision[] {
  if (r.review !== 'pending') return [];
  if (intended(r.status) === 'posted_without_name') return ['show_name', 'keep_name_hidden'];
  if (r.status !== 'held') return [];
  return r.checked && !r.name_category ? ['post', 'keep'] : ['post', 'post_without_name', 'keep'];
}

/** Applies an admin's decision: posts or edits the public message, then updates the #admins message. */
export async function applyDecision(env: ChronicleEnv, r: Row, d: Decision, reviewer: string): Promise<boolean> {
  if (!choices(r).includes(d)) return false;
  const s = summaryOf(r);
  let status = r.status, pub = r.public_message;
  if (d === 'show_name') {
    if (pub) await hook(env.CHRONICLE_WEBHOOK, 'PATCH', pub, runPost(s, r.mod_version, false));
    else pub = await hook(env.CHRONICLE_WEBHOOK, 'POST', null, runPost(s, r.mod_version, false));
    status = pub ? 'posted' : 'waiting';
  } else if (d === 'post' || d === 'post_without_name') {
    pub = await hook(env.CHRONICLE_WEBHOOK, 'POST', null, runPost(s, r.mod_version, d === 'post_without_name'));
    const owed: Status = d === 'post' ? 'posted' : 'posted_without_name';
    status = pub ? owed : waitingFor(owed);
  }
  const done: Row = { ...r, status, public_message: pub, review: 'done', decision: d, reviewer, reviewed_at: Date.now() };
  await env.DB.prepare("UPDATE screens SET status = ?, public_message = ?, review = 'done', decision = ?, reviewer = ?, reviewed_at = ? WHERE id = ?")
    .bind(done.status, done.public_message, d, reviewer, done.reviewed_at, r.id).run();
  if (r.admin_message) await hook(env.ADMIN_WEBHOOK, 'PATCH', r.admin_message, adminPost(done));
  return true;
}

/** Removes the Discord posts of every run from one install, before its rows are deleted. */
export async function forgetPosts(env: ChronicleEnv, install: string): Promise<void> {
  const rows = (await env.DB.prepare('SELECT public_message, admin_message FROM screens WHERE install_id = ?').bind(install).all<Pick<Row, 'public_message' | 'admin_message'>>()).results;
  await Promise.all(rows.flatMap((r) => [
    r.public_message ? hook(env.CHRONICLE_WEBHOOK, 'DELETE', r.public_message) : null,
    r.admin_message ? hook(env.ADMIN_WEBHOOK, 'DELETE', r.admin_message) : null,
  ]));
}
