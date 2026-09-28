# squire-telemetry

The Cloudflare Worker behind squire.rpgm.tools. It takes telemetry batches from the Squire autoplayer mod for Neo Angband, keeps them in D1 for 180 days, posts a short summary of each finished run to Discord, and serves the privacy note at the root of the host. Players opt in inside the mod, and the mod can point at another endpoint or send nothing.

The privacy note players see is at [squire.rpgm.tools](https://squire.rpgm.tools).

## Endpoints

POST /v1/batches takes one JSON batch. GET /v1/installs/<install_id> reports how many batches and runs are stored for an install, and DELETE on the same path removes all of them. Every response is JSON with an ok field, and a refusal adds error, a sentence saying what to fix, and field, the path of the first bad value. CORS allows any origin, since the game runs from itch.io, installed web apps and self-hosted copies, and no request carries a credential.

## Batch format

A batch belongs to one run and one consent level. The top level holds schema (always 1), level, install_id (a lowercase version 4 UUID the mod creates once per install), run_id (1 to 64 letters, digits, dashes or underscores), seq (0 upward within the run, so a resent batch is stored once), sent_at, mod_version, game_version and summary. Summary level sends only summary. Decisions level adds decisions, a list of up to 5,000 records. Full level may add extra, an object for the rest of the run log, and backstory, which is accepted only when backstory_consent is true.

summary holds persona (name, race, class), outcome (ended, won, depth_max from 0 to 127, turns, cause_of_death or null), top_kills (up to 10 entries of name and count), tokens (input, output, calls) and calibration, a free-form object of up to 16 KB. A decision record holds t (the game turn), kind, question, choice, confidence from 0 to 1 or null, probs (option to probability) or null, and outcome or null. Any key naming a backstory, persona, quirk, biography or lore is refused inside decisions, extra and calibration.

```json
{
  "schema": 1,
  "level": "decisions",
  "install_id": "3f2b8c1e-4d5a-4b6c-9d7e-0a1b2c3d4e5f",
  "run_id": "run-0001",
  "seq": 0,
  "sent_at": "2026-09-27T20:00:00Z",
  "mod_version": "0.2.0",
  "game_version": "0.22.0",
  "summary": {
    "persona": { "name": "Beren", "race": "Human", "class": "Warrior" },
    "outcome": { "ended": true, "won": false, "depth_max": 12, "turns": 48211, "cause_of_death": "Grip, Farmer Maggot's Dog" },
    "top_kills": [{ "name": "Cave spider", "count": 41 }],
    "tokens": { "input": 120400, "output": 3100, "calls": 212 },
    "calibration": { "brier": 0.18 }
  },
  "decisions": [
    { "t": 1200, "kind": "fight", "question": "best_move", "choice": "melee", "confidence": 0.71, "probs": { "melee": 0.71, "flee": 0.29 }, "outcome": "won" }
  ]
}
```

## Limits and Discord posts

A batch can be at most 32 KB at the Summary level, 1 MB at Decisions and 1.5 MB at Full. One address can send 30 batches a minute and one install 10; past that the answer is 429 with Retry-After. When a batch reports outcome.ended as true, the run is posted to Discord once, with the persona's name, race and class, deepest level, turns, cause of death, top three kills and token count, and each install is limited to 10 posts a day.

Before a chronicle post, the persona's name, race, class, cause of death and top kills go to TypeSafe's Jev model as two yes-or-no questions: is the name unfit to show, and is the rest unfit to show. At 0.35 or above, the name becomes An unnamed adventurer or the post is dropped. With no TYPESAFE_API_KEY secret, or no answer from Jev, the post is dropped.

## Development

Tests run with pnpm test and the type check with pnpm typecheck. To deploy your own copy, create a D1 database, put its id in wrangler.toml, apply schema.sql with wrangler d1 execute, set the CHRONICLE_WEBHOOK secret if you want Discord posts, and run pnpm run deploy.

## License

MIT
