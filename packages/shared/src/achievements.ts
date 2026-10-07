/** Achievement catalog — the single source of truth for DISPLAY (the locked/unlocked grid)
 * and for the `AchievementType` union shared by client + Worker. The unlock *evaluation*
 * lives in SQL (archive_game / submit_game_summary / supercali_win), where the game data is;
 * this file only describes them. Keep the string ids stable — they're persisted in
 * achievements.type.
 *
 * `hidden` achievements (Phase 4 "mystery" achievements) render as "???" with their `hint`
 * until unlocked, then by their real title/description — see achievementDisplay(). */

export type AchievementType =
  | 'speed_peeler'
  | 'marathon_mind'
  | 'no_dumps_given'
  | 'word_nerd'
  | 'alphabet_soup'
  | 'century_club'
  | 'peel_machine'
  | 'full_house'
  | 'nail_biter'
  | 'egg_hunter'
  | 'mind_and_hand'
  | 'practically_perfect'
  | 'collector'
  | 'speedrun';

export interface AchievementDef {
  title: string;
  description: string;
  /** Mystery achievement: shown as "???" + `hint` until unlocked. */
  hidden?: boolean;
  /** Vague clue shown on a locked hidden achievement. Required when `hidden`. */
  hint?: string;
}

/** Ordered for display (roughly easiest → rarest); mystery achievements last. */
export const ACHIEVEMENT_DEFS: Record<AchievementType, AchievementDef> = {
  speed_peeler: {
    title: 'Speed Peeler',
    description: 'Peel within 60 seconds of a Split.',
  },
  marathon_mind: {
    title: 'Marathon Mind',
    description: 'Win a game with 100 or more tiles in your grid.',
  },
  no_dumps_given: {
    title: 'No Dumps Given',
    description: 'Win a game without dumping a single tile.',
  },
  word_nerd: {
    title: 'Word Nerd',
    description: 'Play an especially rare word.',
  },
  alphabet_soup: {
    title: 'Alphabet Soup',
    description: 'Across all your games, play a word starting with every letter A–Z.',
  },
  century_club: {
    title: 'Century Club',
    description: 'Play 100 games.',
  },
  peel_machine: {
    title: 'Peel Machine',
    description: 'Peel 1,000 tiles across all your games.',
  },
  full_house: {
    title: 'Full House',
    description: 'Play a game with all 8 player slots filled.',
  },
  nail_biter: {
    title: 'Nail Biter',
    description: 'Win a game while an opponent has just one tile left to place.',
  },
  egg_hunter: {
    title: 'Egg Hunter',
    description: 'Play a hidden easter-egg word.',
    hidden: true,
    hint: 'Some words are more equal than others',
  },
  mind_and_hand: {
    title: 'Mens et Manus',
    description: 'Play MIT.',
    hidden: true,
    hint: 'Mind and hand',
  },
  practically_perfect: {
    title: 'Practically Perfect',
    description: 'Win instantly with SUPERCALIFRAGILISTICEXPIALIDOCIOUS.',
    hidden: true,
    hint: 'Practically perfect',
  },
  collector: {
    title: 'Egg Collector',
    description: 'Find every easter-egg word.',
    hidden: true,
    hint: 'Collector',
  },
  speedrun: {
    title: 'Speedrun',
    description: 'Solve the daily puzzle in under 60 seconds.',
    hidden: true,
    hint: 'Speedrun',
  },
};

/** All achievement ids in display order. */
export const ACHIEVEMENT_ORDER = Object.keys(ACHIEVEMENT_DEFS) as AchievementType[];

/** What a tile should show: a locked mystery achievement is "???" + its hint; everything else
 * (unlocked mystery included) shows its real title and description. */
export function achievementDisplay(
  type: AchievementType,
  unlocked: boolean,
): { title: string; description: string; mystery: boolean } {
  const def = ACHIEVEMENT_DEFS[type];
  if (def.hidden && !unlocked) return { title: '???', description: def.hint ?? '', mystery: true };
  return { title: def.title, description: def.description, mystery: false };
}
