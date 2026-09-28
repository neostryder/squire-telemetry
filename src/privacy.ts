/** The privacy note served at the root of the host. The retention period comes from the Worker's settings. */
export function privacyPage(days: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Squire telemetry</title>
<style>
  :root { --page: #f9f9f7; --ink: #1b1b1a; --muted: #5f5e5a; --line: #e1e0d9; --accent: #2a78d6; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --page: #111110; --ink: #ecebe6; --muted: #a3a29c; --line: #2c2c2a; --accent: #5598e7; color-scheme: dark; } }
  body { margin: 0; background: var(--page); color: var(--ink); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 32px 16px 48px; }
  h1 { font-size: 26px; margin: 0 0 12px; }
  h2 { font-size: 18px; margin: 28px 0 8px; padding-top: 16px; border-top: 1px solid var(--line); }
  a { color: var(--accent); }
  code { font-size: 14px; word-break: break-all; }
  dt { font-weight: 600; margin-top: 12px; }
  dd { margin: 2px 0 0; }
</style>
</head>
<body>
<main>
<h1>Squire telemetry</h1>
<p>The Squire mod for Neo Angband can send records of its runs to this service, which RPGM Tools, LLC runs. Nothing is sent until you turn it on in the mod's settings, and you can change the address the mod sends to, or clear it, at any time.</p>

<h2>What each level sends</h2>
<dl>
<dt>Summary</dt>
<dd>Summary sends how each run went: your character's name, race and class, the deepest level reached, the number of turns, what killed the character, the monsters killed most often, how many model calls and tokens the run used, and calibration numbers that show how well the model's confidence matched what happened.</dd>
<dt>Decisions</dt>
<dd>Decisions sends everything in Summary, plus one record for each decision Squire made: the turn, the kind of decision, the question asked, the choice taken, the model's confidence and what followed. These records never include your character's backstory or personality settings.</dd>
<dt>Full</dt>
<dd>Full sends everything in Decisions, plus the rest of the run log. Your character's backstory is left out unless you tick the separate box to include it.</dd>
</dl>

<h2>What is kept</h2>
<p>Each batch is stored with a random install id that the mod creates on your device, the run id, and the mod and game versions. Your IP address is used only to limit how often one address can send, and it is never stored. Everything is deleted ${days} days after it arrives. Cloudflare, which hosts this service, may keep short-lived request logs of its own.</p>

<h2>How it is used</h2>
<p>The records are used to improve the questions Squire asks its model and to train adapters for local models. When a run ends, the character's name, race and class, deepest level, cause of death, most-killed monsters and token count may be posted to the Neo Angband Discord server. The backstory is never posted.</p>

<h2>Seeing and deleting your data</h2>
<p>To see what is stored for your install, or to remove all of it, use the delete option in Squire's settings. Without the mod, you can use your install id directly: a GET request to <code>https://squire.rpgm.tools/v1/installs/</code> followed by the id lists what is stored, and a DELETE request to the same address removes it at once.</p>

<h2>Source code</h2>
<p>The code that runs this service is public at <a href="https://github.com/neostryder/squire-telemetry">github.com/neostryder/squire-telemetry</a>, so you can check that it does what this page says.</p>
</main>
</body>
</html>`;
}
