import { choices, summaryOf, type Decision, type Row } from './chronicle';
import { reasonWords, UNFIT_AT } from './screen';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const LABELS: Record<Decision, string> = {
  show_name: 'Add the name back', keep_name_hidden: 'Keep the name hidden', post: 'Post it', post_without_name: 'Post it without the name', keep: 'Keep it off Discord',
};
const DONE: Record<Decision, string> = {
  show_name: 'Name added back', keep_name_hidden: 'Name kept hidden', post: 'Posted', post_without_name: 'Posted without the name', keep: 'Kept off Discord',
};

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Squire review</title>
<style>
  :root { --page: #f9f9f7; --ink: #1b1b1a; --muted: #5f5e5a; --line: #e1e0d9; --accent: #2a78d6; --warn: #b3380a; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --page: #111110; --ink: #ecebe6; --muted: #a3a29c; --line: #2c2c2a; --accent: #5598e7; --warn: #f0875a; color-scheme: dark; } }
  body { margin: 0; background: var(--page); color: var(--ink); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 32px 16px 48px; }
  h1 { font-size: 24px; margin: 0 0 8px; }
  p { margin: 8px 0; }
  .muted { color: var(--muted); }
  .reason { color: var(--warn); font-weight: 600; }
  dl { margin: 20px 0; padding: 16px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  dt { font-weight: 600; margin-top: 10px; }
  dt:first-child { margin-top: 0; }
  dd { margin: 2px 0 0; overflow-wrap: anywhere; }
  form { display: flex; flex-wrap: wrap; gap: 10px; }
  button { font: inherit; padding: 10px 16px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--ink); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
${body}
</main>
</body>
</html>`;
}

export function reviewPage(r: Row | null, who: string): string {
  if (!r) return page('Not found', '<p>No held run has this id. It may have been deleted along with its install.</p>');
  const s = summaryOf(r);
  const answers = r.answers ? (JSON.parse(r.answers) as Record<string, number>) : null;
  const reasons = [
    r.name_category ? `The name ${reasonWords(r.name_category)}.` : '',
    r.rest_category ? `The race, class, cause of death or monster names ${reasonWords(r.rest_category)}.` : '',
  ].filter(Boolean).join(' ');
  const intro = r.checked
    ? 'Jev flagged this run before it reached #squire-chronicles. Whatever you pick here is sent back to the player\'s mod, along with the reason.'
    : 'The Jev check could not run, so this run was held before it reached #squire-chronicles. Whatever you pick here is sent back to the player\'s mod.';
  const open = choices(r);
  const actions = open.length
    ? `<form method="post">${open.map((d, i) => `<button name="decision" value="${d}"${i === 0 ? ' class="primary"' : ''}>${LABELS[d]}</button>`).join('')}</form>`
    : `<p class="muted">${r.decision ? `${DONE[r.decision]} by ${esc(r.reviewer ?? 'an admin')}, ${new Date(r.reviewed_at ?? 0).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : 'This run needs no review.'}</p>`;
  const kills = s.top_kills.slice(0, 3).map((k) => `${k.name} x${k.count}`).join(', ') || 'None';
  return page(r.status === 'posted_without_name' && !r.decision ? 'Name hidden in a chronicle post' : 'Chronicle post held', `
<p>${esc(intro)}</p>
${reasons ? `<p class="reason">${esc(reasons)}</p>` : ''}
<dl>
<dt>Name</dt><dd>${esc(s.persona.name)}</dd>
<dt>Race and class</dt><dd>${esc(`${s.persona.race} ${s.persona.class}`)}</dd>
<dt>Cause of death</dt><dd>${esc(s.outcome.cause_of_death ?? 'None')}</dd>
<dt>Most killed</dt><dd>${esc(kills)}</dd>
${answers ? `<dt>Jev</dt><dd>name ${answers.name_unfit!.toFixed(2)}, details ${answers.rest_unfit!.toFixed(2)} (flagged at ${UNFIT_AT} or above)</dd>` : ''}
<dt>Run</dt><dd>${esc(r.run_id)}, Squire ${esc(r.mod_version)}, ${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC</dd>
</dl>
${actions}
<p class="muted">Signed in as ${esc(who)}.</p>`);
}
