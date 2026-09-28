import type { Summary } from './contract';

// Chronicle posts are public, and the persona name is free text a player typed, so each post is
// screened by TypeSafe's Jev model first. A wrong "unfit" only sends the run to admin review, while
// a missed slur reaches the whole server, so the threshold sits below one half.
export const UNFIT_AT = 0.35;
// Once a gate fires, the highest-scoring category names the reason. Below this, the reason stays general.
export const REASON_AT = 0.2;

const FIT = 'Fantasy names, silly names, puns, dark humor and violent-sounding names such as "Orcbane" or "Deathwish" are fit to show.';
const GAME_TEXT = 'They normally come from the game\'s own monster and class lists, so fantasy violence and monster names are fit to show.';

/** What each category asks about, and the words the player's reason uses for it. */
export const CATEGORIES = {
  hate: { what: 'a slur, hate toward a group of people, or praise for a hate group or its leaders, such as the Nazis', reason: 'may contain a slur or hate toward a group' },
  sexual: { what: 'sexual content', reason: 'may contain sexual content' },
  harassment: { what: 'an insult or harassment aimed at a real person', reason: 'may insult or harass a real person' },
  contact: { what: 'a real person\'s contact details, such as an email address, phone number or social media handle', reason: 'may contain contact details' },
  advert: { what: 'an advertisement, such as for a website, a Discord server or gold selling', reason: 'may be an advertisement' },
} as const;
export type Category = keyof typeof CATEGORIES | 'general';
/** The player's words for a category, e.g. "may contain sexual content". */
export const reasonWords = (c: Category) => (c === 'general' ? 'may be offensive' : CATEGORIES[c].reason);

const NAME = 'A player of Neo Angband, a free port of the fantasy roguelike Angband, named their character `name`. The name will be shown in the game\'s public Discord server.';
const REST = 'These details of a finished Neo Angband run will be shown in the game\'s public Discord server: the character\'s race and class (`race`, `class`), what killed it (`cause_of_death`) and the monsters it killed most (`top_kills`).';

function categoryQuestions(prefix: 'name' | 'rest', lead: string, fit: string) {
  return Object.fromEntries(Object.entries(CATEGORIES).map(([k, c]) => [`${prefix}_${k}`, {
    type: 'noul', instructions: `${lead} Does it contain ${c.what}? ${fit}`,
  }]));
}

/**
 * The questions sent to Jev for one run, in two requests with separate states, so spam in a cause
 * of death cannot raise the name's score or the other way round. The two *_unfit Nouls decide; the
 * category Nouls only name the reason.
 */
export const NAME_QUESTIONS = {
  name_unfit: {
    type: 'noul',
    instructions: `${NAME} Is the name unfit to show there: a slur, hate toward a group, sexual content, an insult or harassment aimed at a real person, a real person's contact details, or an advertisement? ${FIT}`,
  },
  ...categoryQuestions('name', NAME, FIT),
} as const;

export const REST_QUESTIONS = {
  rest_unfit: {
    type: 'noul',
    instructions: `${REST} ${GAME_TEXT} Is any of this text unfit to show: a slur, hate toward a group, sexual content, harassment of a real person, contact details or an advertisement?`,
  },
  ...categoryQuestions('rest', REST, GAME_TEXT),
} as const;

export const QUESTIONS = { name: NAME_QUESTIONS, details: REST_QUESTIONS } as const;

export interface ScreenState {
  name: { name: string };
  details: { race: string; class: string; cause_of_death: string | null; top_kills: string[] };
}

export interface Screen {
  /** False when there was no key, the request failed or an answer was missing. Nothing is posted then. */
  checked: boolean;
  hideName: boolean;
  skip: boolean;
  /** Which category flagged the name or the other details, 'general' when no category stood out. */
  nameCategory: Category | null;
  restCategory: Category | null;
  state: ScreenState;
  /** Jev's probability for each question, null when unchecked. */
  answers: Record<string, number> | null;
}

export function screenState(s: Summary): ScreenState {
  return {
    name: { name: s.persona.name },
    details: { race: s.persona.race, class: s.persona.class, cause_of_death: s.outcome.cause_of_death, top_kills: s.top_kills.slice(0, 3).map((k) => k.name) },
  };
}

function category(prefix: 'name' | 'rest', answers: Record<string, number>): Category {
  let best: keyof typeof CATEGORIES | null = null;
  for (const k of Object.keys(CATEGORIES) as Array<keyof typeof CATEGORIES>) {
    const p = answers[`${prefix}_${k}`] ?? 0;
    if (p >= REASON_AT && (!best || p > (answers[`${prefix}_${best}`] ?? 0))) best = k;
  }
  return best ?? 'general';
}

/** Screens one run. Without a key, on a failed request or with a missing answer, checked is false and the run is held. */
export async function screen(s: Summary, key: string | undefined): Promise<Screen> {
  const state = screenState(s);
  const unchecked: Screen = { checked: false, hideName: true, skip: true, nameCategory: null, restCategory: null, state, answers: null };
  if (!key) return unchecked;
  try {
    const ask = async (part: keyof typeof QUESTIONS): Promise<Record<string, { noul?: number }>> => {
      const r = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'jev-latest', state: state[part], questions: QUESTIONS[part] }),
      });
      if (!r.ok) throw new Error(`jev ${r.status}`);
      return ((await r.json()) as { answers?: Record<string, { noul?: number }> }).answers ?? {};
    };
    const [name, details] = await Promise.all([ask('name'), ask('details')]);
    const raw = { ...name, ...details };
    const answers: Record<string, number> = {};
    for (const q of [...Object.keys(NAME_QUESTIONS), ...Object.keys(REST_QUESTIONS)]) {
      const p = raw[q]?.noul;
      if (typeof p !== 'number') return unchecked;
      answers[q] = p;
    }
    const hideName = answers.name_unfit! >= UNFIT_AT, skip = answers.rest_unfit! >= UNFIT_AT;
    return { checked: true, hideName, skip, nameCategory: hideName ? category('name', answers) : null, restCategory: skip ? category('rest', answers) : null, state, answers };
  } catch {
    return unchecked;
  }
}
