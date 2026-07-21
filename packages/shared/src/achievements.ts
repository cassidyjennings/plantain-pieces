/** Achievement catalog — the single source of truth for DISPLAY (the locked/unlocked grid)
 * and for the `AchievementType` union shared by client + Worker. The unlock *evaluation*
 * lives in SQL (archive_game / submit_game_summary), where the game data is; this file only
 * describes them. Keep the string ids stable — they're persisted in achievements.type. */

export type AchievementType =
  | 'speed_peeler'
  | 'marathon_mind'
  | 'no_dumps_given'
  | 'word_nerd'
  | 'alphabet_soup'
  | 'century_club'
  | 'peel_machine'
  | 'full_house'
  | 'nail_biter';

export interface AchievementDef {
  title: string;
  description: string;
}

/** Ordered for display (roughly easiest → rarest). */
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
    description: 'Win a game within 5 seconds of an opponent finishing.',
  },
};

/** All achievement ids in display order. */
export const ACHIEVEMENT_ORDER = Object.keys(ACHIEVEMENT_DEFS) as AchievementType[];
