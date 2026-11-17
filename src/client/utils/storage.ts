import type { AuthUser, HistorySessionRecord, TranslationDirection } from '../../shared/types.js';
import { DEFAULT_DIRECTION, normalizeDirection } from '../../shared/direction.js';

const STORAGE_KEYS = {
  TOKEN: 'tt_auth_token',
  USER: 'tt_auth_user',
  NICKNAME: 'tt_player_nickname',
  HISTORY: 'tt_session_history',
  THEME: 'tt_theme',
  ACTIVE_PVP_ROOM: 'tt_active_pvp_room',
  PVP_DRAFT: 'tt_pvp_draft',
  SPECTATOR_ID: 'tt_spec_id',
  DIRECTION: 'tt_direction',
};

export type AppTheme = 'light' | 'dark';

/**
 * Guarded storage access.
 *
 * localStorage/sessionStorage can be missing or throw (private mode, disabled
 * storage, quota), so every read/write goes through these helpers instead of
 * repeating a try/catch in each accessor.
 */
type StoreKind = 'local' | 'session';

function resolveStore(kind: StoreKind): Storage | null {
  try {
    return kind === 'local' ? localStorage : sessionStorage;
  } catch {
    return null;
  }
}

function readRaw(kind: StoreKind, key: string): string | null {
  const store = resolveStore(kind);
  if (!store) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(kind: StoreKind, key: string, value: string): void {
  const store = resolveStore(kind);
  if (!store) return;
  try {
    store.setItem(key, value);
  } catch {}
}

function removeRaw(kind: StoreKind, key: string): void {
  const store = resolveStore(kind);
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {}
}

function readJson<T>(kind: StoreKind, key: string, fallback: T): T {
  const raw = readRaw(kind, key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(kind: StoreKind, key: string, value: unknown): void {
  writeRaw(kind, key, JSON.stringify(value));
}

/**
 * Per-tab identity for read-only link spectators.
 *
 * Watching a match must work without an account, and a viewer must never share an
 * identity with a playing account (two tabs of the same account used to fight over
 * one socket and could reset the opponent's view). Living in sessionStorage keeps
 * the seat stable across a refresh of the same tab while staying unique per tab.
 */
export function getSpectatorId(): string {
  const existing = readRaw('session', STORAGE_KEYS.SPECTATOR_ID);
  if (existing && /^spec_[a-z0-9]{6,}$/.test(existing)) return existing;
  const minted = `spec_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  writeRaw('session', STORAGE_KEYS.SPECTATOR_ID, minted);
  return minted;
}

/**
 * Room code of the match the player is currently in. Persisted so a page refresh
 * or a mobile browser restore mid-match can resume instead of being stranded.
 */
export function getActivePvpRoom(): string | null {
  return readRaw('local', STORAGE_KEYS.ACTIVE_PVP_ROOM);
}

export function setActivePvpRoom(roomCode: string): void {
  writeRaw('local', STORAGE_KEYS.ACTIVE_PVP_ROOM, roomCode.toUpperCase().trim());
}

export function clearActivePvpRoom(): void {
  removeRaw('local', STORAGE_KEYS.ACTIVE_PVP_ROOM);
}

export interface PvpDraft {
  roomCode: string;
  segmentIndex: number;
  answer: string;
}

/**
 * Unsent translation for the current question. Kept in sessionStorage so that a
 * submission lost to a dropped socket, a refresh, or an app switch can be
 * restored into the textarea instead of vanishing.
 */
export function getPvpDraft(): PvpDraft | null {
  const parsed = readJson<PvpDraft | null>('session', STORAGE_KEYS.PVP_DRAFT, null);
  if (!parsed || typeof parsed.answer !== 'string') return null;
  return parsed;
}

export function setPvpDraft(draft: PvpDraft): void {
  writeJson('session', STORAGE_KEYS.PVP_DRAFT, draft);
}

export function clearPvpDraft(): void {
  removeRaw('session', STORAGE_KEYS.PVP_DRAFT);
}

export function getStoredDirection(): TranslationDirection {
  const saved = readRaw('local', STORAGE_KEYS.DIRECTION);
  return saved ? normalizeDirection(saved) : DEFAULT_DIRECTION;
}

export function setStoredDirection(direction: TranslationDirection): void {
  writeRaw('local', STORAGE_KEYS.DIRECTION, direction);
}

export function getStoredTheme(): AppTheme {
  const saved = readRaw('local', STORAGE_KEYS.THEME);
  if (saved === 'dark' || saved === 'light') {
    return saved;
  }
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function setStoredTheme(theme: AppTheme): void {
  writeRaw('local', STORAGE_KEYS.THEME, theme);
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }
}

export function getAuthToken(): string | null {
  return readRaw('local', STORAGE_KEYS.TOKEN);
}

export function setAuthToken(token: string): void {
  writeRaw('local', STORAGE_KEYS.TOKEN, token);
}

export function removeAuthToken(): void {
  removeRaw('local', STORAGE_KEYS.TOKEN);
  removeRaw('local', STORAGE_KEYS.USER);
}

export function getStoredUser(): AuthUser | null {
  return readJson<AuthUser | null>('local', STORAGE_KEYS.USER, null);
}

export function setStoredUser(user: AuthUser): void {
  writeJson('local', STORAGE_KEYS.USER, user);
  if (user.nickname) {
    setPlayerNickname(user.nickname);
  }
}

export function getPlayerNickname(): string {
  const user = getStoredUser();
  if (user?.nickname) return user.nickname;
  return readRaw('local', STORAGE_KEYS.NICKNAME) || `研友${Math.floor(1000 + Math.random() * 9000)}`;
}

export function setPlayerNickname(nickname: string): void {
  writeRaw('local', STORAGE_KEYS.NICKNAME, nickname.trim());
}

// Local cache fallback for history
export function getLocalHistory(): HistorySessionRecord[] {
  return readJson<HistorySessionRecord[]>('local', STORAGE_KEYS.HISTORY, []);
}

export function setLocalHistory(records: HistorySessionRecord[]): void {
  writeJson('local', STORAGE_KEYS.HISTORY, records.slice(0, 50));
}

export function saveHistoryRecord(record: HistorySessionRecord): void {
  const list = getLocalHistory();
  const existingIdx = list.findIndex((r) => r.id === record.id);
  if (existingIdx >= 0) {
    list[existingIdx] = record;
  } else {
    list.unshift(record);
  }
  setLocalHistory(list);
}

/** Save locally and mirror the record to the account history endpoint. */
export function persistHistoryRecord(record: HistorySessionRecord): void {
  saveHistoryRecord(record);
  const token = getAuthToken();
  if (!token) return;
  fetch('/api/history', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ record }),
  }).catch((err) => console.error('Failed to post history to server:', err));
}

export function clearHistory(): void {
  removeRaw('local', STORAGE_KEYS.HISTORY);
}
