import type { Summary } from './contract';

// Chronicle posts are public, and the persona name is free text a player typed, so each post is
// screened by TypeSafe's Jev model first. A wrong "unfit" only hides a name, while a missed slur
// reaches the whole server, so the threshold sits below one half.
export const UNFIT_AT = 0.35;

const QUESTIONS = {
  name_unfit: {
    type: 'noul',
    instructions: 'A player of Neo Angband, a free port of the fantasy roguelike Angband, named their character `persona.name`. The name will be shown in the game\'s public Discord server. Is the name unfit to show there: a slur, hate toward a group, sexual content, an insult or harassment aimed at a real person, a real person\'s contact details, or an advertisement? Fantasy names, silly names, puns, dark humor and violent-sounding names such as "Orcbane" or "Deathwish" are fit to show.',
  },
  rest_unfit: {
    type: 'noul',
    instructions: 'These details of a finished Neo Angband run will be shown in the game\'s public Discord server: the character\'s race and class (`persona.race`, `persona.class`), what killed it (`cause_of_death`) and the monsters it killed most (`top_kills`). They normally come from the game\'s own monster and class lists, so fantasy violence and monster names are fit to show. Is any of this text unfit to show: a slur, hate toward a group, sexual content, harassment of a real person, contact details or an advertisement?',
  },
} as const;

export interface Screen { hideName: boolean; skip: boolean }

/** Returns hideName and skip for one run. Without a key, on a failed request or with a missing noul, both are true, so nothing unscreened is posted. */
export async function screen(s: Summary, key: string | undefined): Promise<Screen> {
  if (!key) return { hideName: true, skip: true };
  const state = {
    persona: s.persona,
    cause_of_death: s.outcome.cause_of_death,
    top_kills: s.top_kills.slice(0, 3).map((k) => k.name),
  };
  try {
    const r = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state, questions: QUESTIONS }),
    });
    if (!r.ok) return { hideName: true, skip: true };
    const answers = ((await r.json()) as { answers?: Record<string, { noul?: number }> }).answers ?? {};
    const name = answers.name_unfit?.noul, rest = answers.rest_unfit?.noul;
    if (typeof name !== 'number' || typeof rest !== 'number') return { hideName: true, skip: true };
    return { hideName: name >= UNFIT_AT, skip: rest >= UNFIT_AT };
  } catch {
    return { hideName: true, skip: true };
  }
}
