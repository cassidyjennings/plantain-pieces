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
  fetchMyMatchHistory,
  fetchMyProfile,
  type ProfileStatsRow,
  type AchievementRow,
  type MatchHistoryRow,
  type GameMode,
} from '../lib/profile.js';
import { signOut, upgradeWith, signInWith, getLinkedIdentities, consumeOAuthRedirectError } from '../lib/auth.js';
import Avatar from '../components/Avatar.js';
import DictionaryJournal from '../components/DictionaryJournal.js';
import ConfirmDeleteModal from '../components/ConfirmDeleteModal.js';
import { AccessibilitySettings } from '../components/AccessibilitySettings.js';

type Tab = 'overview' | 'stats' | 'achievements' | 'history' | 'accessibility';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'stats', label: 'Stats' },
  { id: 'achievements', label: 'Achievements' },
  { id: 'history', label: 'History' },
  { id: 'accessibility', label: 'Accessibility' },
];

type StatsFilter = 'all' | GameMode;

export default function Profile() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('overview');
  const [statsFilter, setStatsFilter] = useState<StatsFilter>('all');
  const [stats, setStats] = useState<ProfileStatsRow | null>(null);
  const [streak, setStreak] = useState<{ current: number; longest: number } | null>(null);
  const [achievements, setAchievements] = useState<AchievementRow[]>([]);
  const [history, setHistory] = useState<MatchHistoryRow[]>([]);

  useEffect(() => {
    fetchMyStats(statsFilter === 'all' ? undefined : statsFilter).then(setStats);
  }, [statsFilter]);

  useEffect(() => {
    fetchMyProfile().then((p) => {
      if (p) setStreak({ current: p.current_streak, longest: p.longest_streak });
    });
    fetchMyAchievements().then(setAchievements);
    fetchMyMatchHistory().then(setHistory);
  }, []);

  return (
    <div className="centered profile-screen">
      <div className="profile-topbar">
        <button className="btn-tertiary" onClick={() => navigate('/')}>
          ← Home
        </button>
        <h1 className="profile-title">Your Profile</h1>
        <span style={{ width: 72 }} />
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
          <StatsBoard stats={stats} streak={streak} filter={statsFilter} onFilterChange={setStatsFilter} />
        )}
        {tab === 'achievements' && <AchievementGrid achievements={achievements} />}
        {tab === 'history' && <MatchHistoryList history={history} />}
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
    const FALLBACK_GUARD_KEY = 'plantain-oauth-fallback-attempted';
    // A link attempt fails server-side whenever this Google identity is already tied to ANY
    // account — including the user's own, from a previous session/browser. Whatever the exact
    // reason, what the user wants by clicking "Sign in with Google" is to end up signed into
    // that Google-linked account, not stuck on a fresh guest — so fall back to a normal sign-in
    // rather than surfacing the link failure as an error. Guarded to run once per tab so a
    // sign-in that ALSO genuinely fails (e.g. the provider itself is misconfigured) still
    // surfaces a real message instead of looping redirects forever.
    if (!sessionStorage.getItem(FALLBACK_GUARD_KEY)) {
      sessionStorage.setItem(FALLBACK_GUARD_KEY, '1');
      signInWith('google').catch((err) => setOauthError(err instanceof Error ? err.message : 'Sign-in failed'));
      return;
    }
    setOauthError(redirectError.message);
  }, []);

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

  async function handleSignOut() {
    setBusy(true);
    await signOut();
    // Reload to reset all in-memory state to the new guest identity.
    window.location.href = '/';
  }

  async function handleUpgrade(provider: 'google') {
    setOauthError(null);
    try {
      await upgradeWith(provider);
      // On success the browser redirects to the provider; nothing more to do here.
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : 'Upgrade failed');
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
        <button className="btn-secondary" onClick={() => setEditingAvatar((v) => !v)}>
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
        <h3>Account</h3>
        {isGuest ? (
          <>
            <p className="hint">Link an account so your progress follows you across devices.</p>
            <div className="profile-oauth-row">
              <button className="btn-secondary" onClick={() => handleUpgrade('google')}>
                Sign in with Google
              </button>
            </div>
            {oauthError && <p className="error">{oauthError}</p>}
          </>
        ) : (
          <>
            <p className="hint">Your progress is saved to your linked account.</p>
            <button className="btn-tertiary" onClick={handleSignOut} disabled={busy}>
              Sign out
            </button>
          </>
        )}
      </div>

      <div className="profile-section">
        <h3>Dictionaries</h3>
        <button className="btn-secondary" onClick={() => setShowJournal(true)}>
          My Dictionaries
        </button>
      </div>

      <div className="profile-section danger-zone">
        <h3>Data &amp; danger zone</h3>
        <div className="profile-oauth-row">
          <button className="btn-secondary" onClick={handleExport}>
            Export my data
          </button>
          <button className="btn-danger" onClick={() => setShowDelete(true)}>
            Delete account
          </button>
        </div>
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
  const slots: AccessorySlot[] = ['base', 'hat', 'glasses', 'hair'];
  return (
    <div className="avatar-editor">
      {slots.map((slot) => (
        <div key={slot} className="avatar-slot">
          <span className="avatar-slot-label">{slot}</span>
          <div className="avatar-options">
            {ACCESSORY_SETS[slot].map((option) => (
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

// --- Stats ------------------------------------------------------------------

interface StatsBoardProps {
  stats: ProfileStatsRow | null;
  streak: { current: number; longest: number } | null;
  filter: StatsFilter;
  onFilterChange: (f: StatsFilter) => void;
}

function StatsBoard({ stats, streak, filter, onFilterChange }: StatsBoardProps) {
  const filterOptions: { id: StatsFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'multiplayer', label: 'Multiplayer' },
    { id: 'solo', label: 'Solo' },
  ];

  const modeSelector = (
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

// --- Match history ----------------------------------------------------------

function MatchHistoryList({ history }: { history: MatchHistoryRow[] }) {
  if (history.length === 0) {
    return (
      <div className="panel profile-panel">
        <p className="hint">No games yet. Your recent matches will show up here.</p>
      </div>
    );
  }
  return (
    <div className="panel profile-panel">
      <ul className="match-list">
        {history.map((m) => {
          const date = new Date(m.finished_at);
          const isSolo = m.mode === 'solo';
          const opponents = m.opponents.map((o) => o.displayName).join(', ') || '-';
          const dur = m.duration_ms != null ? `${Math.round(m.duration_ms / 1000)}s` : '';
          return (
            <li key={m.id} className={`match-row${m.is_winner ? ' win' : ''}`}>
              <span className={`match-result ${m.is_winner ? 'win' : 'loss'}`}>
                {isSolo ? 'Cleared' : m.is_winner ? 'Win' : 'Loss'}
              </span>
              <div className="match-detail">
                <span className="match-opponents">{isSolo ? 'Solo' : `vs ${opponents}`}</span>
                <span className="match-meta">
                  {date.toLocaleDateString()} · {isSolo ? 'solo' : `${m.player_count}p`} · {m.final_tile_count} tiles
                  {dur ? ` · ${dur}` : ''}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
