import type { Summary } from './contract';

// Persona and monster names are typed by players, so each one is flattened to plain text before it
// reaches a public channel: no mentions, no links, no markdown.
export function plain(text: string, max: number): string {
  const flat = text
    .replace(/https?:\/\/\S+|www\.\S+|discord\.gg\/\S+/gi, '')
    .replace(/[@#<>*_~`|\\[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (flat.length > max ? flat.slice(0, max - 1) + '.' : flat) || 'Unnamed';
}

const feet = (depth: number) => (depth === 0 ? 'the town' : `${depth * 50} ft (level ${depth})`);
const count = (n: number) => n.toLocaleString('en-US');

/** The forum post title for a run: the persona line and the deepest level, at most 100 characters. */
export function threadName(s: Summary, hideName = false): string {
  const name = hideName ? 'An unnamed adventurer' : plain(s.persona.name, 40);
  return plain(`${name}, ${plain(s.persona.race, 24)} ${plain(s.persona.class, 24)}, DL ${s.outcome.depth_max}`, 100);
}

/**
 * A Discord webhook body for one finished run. Only Summary-level fields are read, whatever the batch's level.
 * CHRONICLE_WEBHOOK points at a forum, and Discord refuses a forum post without thread_name.
 */
export function runPost(s: Summary, modVersion: string, hideName = false): Record<string, unknown> {
  const who = `${hideName ? 'An unnamed adventurer' : plain(s.persona.name, 40)}, ${plain(s.persona.race, 24)} ${plain(s.persona.class, 24)}`;
  const fate = s.outcome.won ? 'Won the game' : s.outcome.cause_of_death ? `Killed by ${plain(s.outcome.cause_of_death, 80)}` : 'Retired';
  const kills = s.top_kills.slice(0, 3).map((k) => `${plain(k.name, 48)} x${count(k.count)}`).join(', ');
  const fields = [
    { name: 'Deepest', value: feet(s.outcome.depth_max), inline: true },
    { name: 'Turns', value: count(s.outcome.turns), inline: true },
    { name: 'Model calls', value: `${count(s.tokens.calls)} (${count(s.tokens.input + s.tokens.output)} tokens)`, inline: true },
  ];
  if (kills) fields.push({ name: 'Most killed', value: kills, inline: false });
  return {
    thread_name: threadName(s, hideName),
    allowed_mentions: { parse: [] },
    embeds: [{ title: who, description: fate, fields, footer: { text: `Squire ${modVersion}` } }],
  };
}
