import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ACHIEVEMENT_DEFS,
  ACHIEVEMENT_ORDER,
  ACCESSORY_SETS,
  validateDisplayName,
  normalizeAvatarConfig,
  type AvatarConfig,
  type AccessorySlot,
} from '@plantain/shared';
import { api, ApiError } from '../lib/api.js';
import { useSessionStore } from '../store/sessionStore.js';
import {
  fetchMyStats,
  fetchMyAchievements,
  fetchMyProfile,
  guestHasProgress,
  type ProfileStatsRow,
  type AchievementRow,
  type GameMode,
} from '../lib/profile.js';
import {
  signOut,
  upgradeWith,
  signInWith,
  getLinkedIdentities,
  consumeOAuthRedirectError,
  markOAuthFallbackAttempted,
  oauthFallbackAttempted,
  clearOAuthFallbackGuard,
} from '../lib/auth.js';
import Avatar from '../components/Avatar.js';
import XtinaToggle from '../components/XtinaToggle.js';
import DictionaryJournal from '../components/DictionaryJournal.js';
import ConfirmDeleteModal from '../components/ConfirmDeleteModal.js';
import { AccessibilitySettings } from '../components/AccessibilitySettings.js';

// Stina's own pieces — one id per slot, gated to the xtina partner role in both the option
// list and the randomizer below. Kept in one place so a future Stina piece only needs adding
// here, not re-threading through both call sites.
const STINA_EXCLUSIVE: Partial<Record<AccessorySlot, string>> = {
  base: 'stina base',
  hair: 'stina hair',
  glasses: 'stina glasses',
};

function isStinaLocked(slot: AccessorySlot, option: string, xtinaRole: 'owner' | 'partner' | null): boolean {
  return STINA_EXCLUSIVE[slot] === option && xtinaRole !== 'partner';
}

type Tab = 'overview' | 'stats' | 'achievements' | 'accessibility';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'stats', label: 'Stats' },
  { id: 'achievements', label: 'Achievements' },
  { id: 'accessibility', label: 'Accessibility' },
];

type StatsFilter = 'all' | GameMode;

export default function Profile() {
  const navigate = useNavigate();
  const isGuest = useSessionStore((s) => s.isGuest);
  const [tab, setTab] = useState<Tab>('overview');
  const [statsFilter, setStatsFilter] = useState<StatsFilter>('all');
  const [stats, setStats] = useState<ProfileStatsRow | null>(null);
  const [streak, setStreak] = useState<{ current: number; longest: number } | null>(null);
  const [achievements, setAchievements] = useState<AchievementRow[]>([]);

  useEffect(() => {
    fetchMyStats(statsFilter === 'all' ? undefined : statsFilter).then(setStats);
  }, [statsFilter]);

  useEffect(() => {
    fetchMyProfile().then((p) => {
      if (p) setStreak({ current: p.current_streak, longest: p.longest_streak });
    });
    fetchMyAchievements().then(setAchievements);
  }, []);

  return (
    <div className="centered profile-screen">
      <div className="profile-topbar">
        <button className="btn-tertiary" onClick={() => navigate('/')}>
          ← Home
        </button>
        <h1 className="profile-title">Your Profile</h1>
        <span className="profile-topbar-spacer" />
      </div>

      <div className="profile-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`profile-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="profile-content">
        {tab === 'overview' && <Overview />}
        {tab === 'stats' && (
          <GuestGate locked={isGuest} what="stats">
            <StatsBoard
              stats={stats}
              streak={streak}
              filter={statsFilter}
              onFilterChange={setStatsFilter}
              locked={isGuest}
            />
          </GuestGate>
        )}
        {tab === 'achievements' && (
          <GuestGate locked={isGuest} what="achievements">
            <AchievementGrid achievements={achievements} />
          </GuestGate>
        )}
        {tab === 'accessibility' && <AccessibilitySettings />}
      </div>
    </div>
  );
}

// --- Overview ---------------------------------------------------------------

function Overview() {
  const displayName = useSessionStore((s) => s.displayName);
  const setDisplayName = useSessionStore((s) => s.setDisplayName);
  const avatarConfig = useSessionStore((s) => s.avatarConfig);
  const setAvatarConfig = useSessionStore((s) => s.setAvatarConfig);
  const isGuest = useSessionStore((s) => s.isGuest);
  const xtinaRole = useSessionStore((s) => s.xtinaRole);

  const [nameDraft, setNameDraft] = useState(displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [editingAvatar, setEditingAvatar] = useState(false);
  const [showJournal, setShowJournal] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [providers, setProviders] = useState<string[]>([]);
  const [oauthError, setOauthError] = useState<string | null>(null);

  useEffect(() => {
    getLinkedIdentities().then((ids) => setProviders(ids.map((i) => i.provider)));
  }, []);

  useEffect(() => {
    const redirectError = consumeOAuthRedirectError();
    if (!redirectError) return;
    // A link attempt fails server-side whenever this Google identity is already tied to ANY
    // account — including the user's own, from a previous session/browser. Whatever the exact
    // reason, what the user wants by clicking "Sign in with Google" is to end up signed into
    // that Google-linked account, not stuck on a fresh guest — so fall back to a normal sign-in
    // rather than surfacing the link failure as an error. Guarded so a sign-in that ALSO
    // genuinely fails (e.g. the provider itself is misconfigured) surfaces a real message
    // instead of looping redirects forever; handleUpgrade resets the guard on each deliberate
    // click, and signOut() resets it too, so the guard can only ever suppress the fallback
    // within one uninterrupted attempt.
    if (!oauthFallbackAttempted()) {
      markOAuthFallbackAttempted();
      signInWith('google').catch((err) => setOauthError(err instanceof Error ? err.message : 'Sign-in failed'));
      return;
    }
    setOauthError(redirectError.message);
  }, []);

  // Landing here signed in means the flow that set the guard completed; clear it so a later
  // sign-out → sign-in in this same tab starts from a clean slate.
  useEffect(() => {
    if (!isGuest) clearOAuthFallbackGuard();
  }, [isGuest]);

  const nameCheck = validateDisplayName(nameDraft);
  const nameError =
    !nameCheck.valid && nameDraft.trim().length > 0
      ? nameCheck.reason === 'TOO_LONG'
        ? 'Max 20 characters'
        : 'No control characters allowed'
      : null;

  async function saveName() {
    if (!nameCheck.valid) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await api.updateProfile({ displayName: nameDraft.trim() });
      setDisplayName(res.displayName);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  }

  async function saveAvatar(config: AvatarConfig) {
    setAvatarConfig(config); // optimistic
    try {
      await api.updateProfile({ avatarConfig: config });
    } catch {
      /* best-effort; local state already reflects the choice */
    }
  }

  function randomizeAvatar() {
    const pick = <T,>(options: readonly T[]): T => options[Math.floor(Math.random() * options.length)];
    const poolFor = (slot: AccessorySlot) =>
      ACCESSORY_SETS[slot].filter((o) => !isStinaLocked(slot, o, xtinaRole));
    saveAvatar({
      base: pick(poolFor('base')),
      hat: pick(poolFor('hat')),
      glasses: pick(poolFor('glasses')),
      hair: pick(poolFor('hair')),
    });
  }

  async function handleSignOut() {
    setBusy(true);
    await signOut();
    // Reload to reset all in-memory state to the new guest identity.
    window.location.href = '/';
  }

  async function handleUpgrade(provider: 'google') {
    setOauthError(null);
    setBusy(true);
    // A deliberate click is a fresh attempt — never let a guard left over from an earlier one
    // (it survives the same-tab reload sign-out performs) suppress this attempt's fallback.
    clearOAuthFallbackGuard();
    try {
      // Linking attaches Google to the CURRENT guest, preserving everything on it — but it fails
      // outright when that Google account already exists, and recovering costs a SECOND OAuth
      // round-trip (a second account-picker click). Auth is sessionStorage-scoped, so any new
      // tab is a brand-new empty guest and "already exists" is the overwhelmingly common case.
      // Only pay for the link attempt when this guest actually has something to carry over;
      // otherwise sign in directly, which lands straight in the existing account (or creates one)
      // in a single prompt and simply abandons the empty guest.
      if (await guestHasProgress()) await upgradeWith(provider);
      else await signInWith(provider);
      // On success the browser redirects to the provider; nothing more to do here.
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : 'Upgrade failed');
      setBusy(false);
    }
  }

  async function handleExport() {
    try {
      const data = await api.exportMyData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `plantain-pieces-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Export failed');
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await api.deleteAccount();
      await signOut();
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed');
      setBusy(false);
      setShowDelete(false);
    }
  }

  return (
    <div className="panel profile-panel">
      <div className="profile-identity">
        <Avatar config={avatarConfig} size={96} />
        <div className="profile-identity-text">
          <span className="profile-name-display">{displayName || 'Guest'}</span>
          <span className={`profile-status ${isGuest ? 'guest' : 'linked'}`}>
            {isGuest ? 'Guest account' : `Linked · ${providers.join(', ') || 'account'}`}
          </span>
        </div>
        {editingAvatar && (
          <button className="btn-secondary edit-avatar-btn" onClick={randomizeAvatar}>
            Randomize
          </button>
        )}
        <button className="btn-secondary edit-avatar-btn" onClick={() => setEditingAvatar((v) => !v)}>
          {editingAvatar ? 'Done' : 'Edit avatar'}
        </button>
      </div>

      {editingAvatar && <AvatarEditor config={avatarConfig} onChange={saveAvatar} />}

      <label className="field">
        Display name
        <input
          value={nameDraft}
          onChange={(e) => {
            setNameDraft(e.target.value);
            setSaved(false);
          }}
          maxLength={24}
          placeholder="Your name"
        />
      </label>
      {nameError && <p className="error">{nameError}</p>}
      <button disabled={busy || !nameCheck.valid || nameDraft.trim() === displayName.trim()} onClick={saveName}>
        {saved ? 'Saved' : 'Save name'}
      </button>

      <div className="profile-section">
        <h3>Dictionaries</h3>
        <button className="btn-secondary" onClick={() => setShowJournal(true)}>
          My Dictionaries
        </button>
      </div>

      <XtinaToggle />

      <div className="profile-section">
        <h3>Account</h3>
        {!isGuest && <p className="hint">Your progress is saved to your linked account.</p>}
        <div className="profile-oauth-row">
          {isGuest ? (
            <button className="btn-secondary account-btn-wide" onClick={() => handleUpgrade('google')}>
              Sign in with Google
            </button>
          ) : (
            <button className="btn-tertiary account-btn-wide" onClick={handleSignOut} disabled={busy}>
              Sign out
            </button>
          )}
          <div className="account-btn-narrow-row">
            <button className="btn-secondary account-btn-narrow" onClick={handleExport}>
              Export data
            </button>
            <button className="btn-danger account-btn-narrow" onClick={() => setShowDelete(true)}>
              Delete account
            </button>
          </div>
        </div>
        {oauthError && <p className="error">{oauthError}</p>}
      </div>

      {error && <p className="error">{error}</p>}

      {showJournal && <DictionaryJournal onClose={() => setShowJournal(false)} />}
      {showDelete && (
        <ConfirmDeleteModal busy={busy} onConfirm={handleDelete} onCancel={() => setShowDelete(false)} />
      )}
    </div>
  );
}

function AvatarEditor({ config, onChange }: { config: AvatarConfig; onChange: (c: AvatarConfig) => void }) {
  const current = normalizeAvatarConfig(config);
  const xtinaRole = useSessionStore((s) => s.xtinaRole);
  const slots: AccessorySlot[] = ['base', 'hat', 'glasses', 'hair'];
  // Stina's pieces are hers alone. Gated on the role rather than on xtinaEnabled deliberately:
  // they shouldn't disappear just because no game happens to be armed.
  const optionsFor = (slot: AccessorySlot): readonly string[] =>
    ACCESSORY_SETS[slot].filter((o) => !isStinaLocked(slot, o, xtinaRole));
  return (
    <div className="avatar-editor">
      {slots.map((slot) => (
        <div key={slot} className="avatar-slot">
          <span className="avatar-slot-label">{slot}</span>
          <div className="avatar-options">
            {optionsFor(slot).map((option) => (
              <button
                key={option}
                className={`avatar-option${current[slot] === option ? ' selected' : ''}`}
                onClick={() => onChange({ ...current, [slot]: option })}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// --- Guest gate -------------------------------------------------------------

/** Stats and achievements are only kept for linked accounts. A guest still accumulates them
 * server-side — so linking later reveals a filled-in history rather than an empty one — but a
 * guest can never sign back in (auth is sessionStorage-scoped, so closing the tab destroys the
 * session for good) and the 10-day sweep deletes those rows along with the guest. Showing them
 * as if they were durable would be a lie; this states the deal instead.
 *
 * The content stays rendered behind a blurred veil rather than being replaced, so the prompt
 * reads as "this is yours, claim it" rather than "there is nothing here".
 *
 * The children must contain nothing focusable. aria-hidden takes content out of the screen-reader
 * tree but does NOT remove it from the tab order, so a button behind the veil would still be
 * reachable by keyboard while invisible; `inert` would fix that but isn't reliable in React 18.
 * Callers drop their interactive bits instead (see StatsBoard's `locked` prop). */
function GuestGate({
  locked,
  what,
  children,
}: {
  locked: boolean;
  what: 'stats' | 'achievements';
  children: React.ReactNode;
}) {
  if (!locked) return <>{children}</>;
  return (
    <div className="guest-gate">
      <div className="guest-gate-behind" aria-hidden="true">
        {children}
      </div>
      <div className="guest-gate-veil">
        <LockGlyph />
        <p className="guest-gate-copy">Link your account to Google to track {what}</p>
      </div>
    </div>
  );
}

function LockGlyph() {
  return (
    <svg className="guest-gate-lock" viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
      <path
        d="M7 10V7a5 5 0 0 1 10 0v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <rect x="4" y="10" width="16" height="11" rx="2.5" fill="currentColor" />
      <circle cx="12" cy="15" r="1.6" fill="var(--color-surface)" />
    </svg>
  );
}

// --- Stats ------------------------------------------------------------------

interface StatsBoardProps {
  stats: ProfileStatsRow | null;
  streak: { current: number; longest: number } | null;
  filter: StatsFilter;
  onFilterChange: (f: StatsFilter) => void;
  /** Rendered behind a GuestGate veil: drop the mode selector so nothing focusable sits behind
   * it. See GuestGate for why that matters more than it looks. */
  locked?: boolean;
}

function StatsBoard({ stats, streak, filter, onFilterChange, locked = false }: StatsBoardProps) {
  const filterOptions: { id: StatsFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'multiplayer', label: 'Multiplayer' },
    { id: 'solo', label: 'Solo' },
  ];

  const modeSelector = locked ? null : (
    <div className="segmented">
      {filterOptions.map((o) => (
        <button
          key={o.id}
          className={`segmented-option${filter === o.id ? ' selected' : ''}`}
          onClick={() => onFilterChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  if (!stats || stats.games_played === 0) {
    return (
      <div className="panel profile-panel">
        {modeSelector}
        <p className="hint">Play a game to start building your stats!</p>
      </div>
    );
  }
  const avgLen = stats.total_words > 0 ? (stats.total_word_length / stats.total_words).toFixed(1) : '-';
  const winRate = stats.games_played > 0 ? Math.round((stats.games_won / stats.games_played) * 100) : 0;
  // Solo games always end in a win (the only way not to finish is to leave, which isn't
  // archived), so choke rate / win rate read as trivial there — the multiplayer-only stats
  // below (win rate, choke rate) are hidden when filtered to solo.
  const showCompetitiveStats = filter !== 'solo';
  const chokeRate =
    stats.games_played - stats.games_won > 0
      ? Math.round((stats.choke_count / (stats.games_played - stats.games_won)) * 100)
      : 0;
  const fastestPeel = stats.fastest_peel_ms != null ? `${(stats.fastest_peel_ms / 1000).toFixed(1)}s` : '-';

  const tiles: { label: string; value: string | number }[] = [
    { label: 'Games played', value: stats.games_played },
    ...(showCompetitiveStats ? [{ label: 'Wins', value: `${stats.games_won} (${winRate}%)` }] : []),
    ...(streak ? [{ label: 'Current streak', value: streak.current }, { label: 'Longest streak', value: streak.longest }] : []),
    { label: 'Longest word', value: stats.longest_word ?? '-' },
    { label: 'Rarest word', value: stats.rarest_word ?? '-' },
    { label: 'Avg word length', value: avgLen },
    { label: 'Fastest peel', value: fastestPeel },
    { label: 'Tiles peeled', value: stats.total_peels },
    { label: 'Tiles dumped', value: stats.total_dumps },
    { label: 'Alphabet letters', value: `${stats.first_letters.length}/26` },
    ...(showCompetitiveStats ? [{ label: 'Choke rate', value: `${chokeRate}%` }] : []),
  ];

  return (
    <div className="panel profile-panel">
      {modeSelector}
      <div className="stats-grid">
        {tiles.map((t) => (
          <div key={t.label} className="stat-tile">
            <span className="stat-value">{t.value}</span>
            <span className="stat-label">{t.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Achievements -----------------------------------------------------------

function AchievementGrid({ achievements }: { achievements: AchievementRow[] }) {
  const unlocked = useMemo(() => new Set(achievements.map((a) => a.type)), [achievements]);
  return (
    <div className="panel profile-panel">
      <div className="achievement-grid">
        {ACHIEVEMENT_ORDER.map((type) => {
          const def = ACHIEVEMENT_DEFS[type];
          const isUnlocked = unlocked.has(type);
          return (
            <div key={type} className={`achievement-tile${isUnlocked ? ' unlocked' : ' locked'}`}>
              <span className="achievement-status">{isUnlocked ? 'Unlocked' : 'Locked'}</span>
              <span className="achievement-title">{def.title}</span>
              <span className="achievement-desc">{def.description}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

