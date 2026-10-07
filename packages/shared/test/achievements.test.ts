import { describe, it, expect } from 'vitest';
import { ACHIEVEMENT_DEFS, ACHIEVEMENT_ORDER, achievementDisplay, type AchievementType } from '../src/index.js';

const MYSTERY: AchievementType[] = ['egg_hunter', 'mind_and_hand', 'practically_perfect', 'collector', 'speedrun'];

describe('mystery achievements', () => {
  it('all five exist, are hidden, carry a hint, and come after the standard nine', () => {
    for (const t of MYSTERY) {
      expect(ACHIEVEMENT_DEFS[t].hidden).toBe(true);
      expect(ACHIEVEMENT_DEFS[t].hint?.length ?? 0).toBeGreaterThan(0);
    }
    expect(ACHIEVEMENT_ORDER.slice(-5)).toEqual(MYSTERY);
    expect(ACHIEVEMENT_ORDER).toHaveLength(14);
  });

  it('uses the spec hints verbatim', () => {
    expect(ACHIEVEMENT_DEFS.egg_hunter.hint).toBe('Some words are more equal than others');
    expect(ACHIEVEMENT_DEFS.mind_and_hand.hint).toBe('Mind and hand');
    expect(ACHIEVEMENT_DEFS.practically_perfect.hint).toBe('Practically perfect');
    expect(ACHIEVEMENT_DEFS.collector.hint).toBe('Collector');
    expect(ACHIEVEMENT_DEFS.speedrun.hint).toBe('Speedrun');
  });

  it('a locked mystery achievement displays as ??? with its hint', () => {
    expect(achievementDisplay('mind_and_hand', false)).toEqual({
      title: '???',
      description: 'Mind and hand',
      mystery: true,
    });
  });

  it('an unlocked mystery achievement displays its real name', () => {
    const d = achievementDisplay('mind_and_hand', true);
    expect(d.mystery).toBe(false);
    expect(d.title).toBe(ACHIEVEMENT_DEFS.mind_and_hand.title);
    expect(d.title).not.toBe('???');
  });

  it('standard achievements are never masked, locked or not', () => {
    expect(achievementDisplay('speed_peeler', false)).toEqual({
      title: 'Speed Peeler',
      description: ACHIEVEMENT_DEFS.speed_peeler.description,
      mystery: false,
    });
  });
});
