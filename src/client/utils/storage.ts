import type { AuthUser, HistorySessionRecord } from '../../shared/types.js';

const STORAGE_KEYS = {
  TOKEN: 'tt_auth_token',
  USER: 'tt_auth_user',
  NICKNAME: 'tt_player_nickname',
  HISTORY: 'tt_session_history',
  THEME: 'tt_theme',
  ACTIVE_PVP_ROOM: 'tt_active_pvp_room',
  PVP_DRAFT: 'tt_pvp_draft',
};

export type AppTheme = 'light' | 'dark';

/**
 * Room code of the match the player is currently in. Persisted so a page refresh
 * or a mobile browser restore mid-match can resume instead of being stranded.
 */
export function getActivePvpRoom(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.ACTIVE_PVP_ROOM);
  } catch {
    return null;
  }
}

export function setActivePvpRoom(roomCode: string): void {
  try {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PVP_ROOM, roomCode.toUpperCase().trim());
  } catch {}
}

export function clearActivePvpRoom(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_PVP_ROOM);
  } catch {}
}

export interface PvpDraft {
  roomCode: string;
  /** Round the draft belongs to. Round-scoped, or round 2 would overwrite round 1. */
  roundIndex: number;
  segmentIndex: number;
  answer: string;
  updatedAt: number;
}

/**
 * Unsent translation for the current question. Kept in sessionStorage so that a
 * submission lost to a dropped socket, a refresh, or an app switch can be
 * restored into the textarea instead of vanishing.
 */
export function getPvpDraft(): PvpDraft | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.PVP_DRAFT);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PvpDraft;
    if (!parsed || typeof parsed.answer !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setPvpDraft(draft: PvpDraft): void {
  try {
    sessionStorage.setItem(STORAGE_KEYS.PVP_DRAFT, JSON.stringify(draft));
  } catch {}
}

export function clearPvpDraft(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEYS.PVP_DRAFT);
  } catch {}
}

export function getStoredTheme(): AppTheme {
  const saved = localStorage.getItem(STORAGE_KEYS.THEME);
  if (saved === 'dark' || saved === 'light') {
    return saved;
  }
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

export function setStoredTheme(theme: AppTheme): void {
  localStorage.setItem(STORAGE_KEYS.THEME, theme);
  if (typeof document !== 'undefined') {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }
}


export function getAuthToken(): string | null {
  return localStorage.getItem(STORAGE_KEYS.TOKEN);
}

export function setAuthToken(token: string): void {
  localStorage.setItem(STORAGE_KEYS.TOKEN, token);
}

export function removeAuthToken(): void {
  localStorage.removeItem(STORAGE_KEYS.TOKEN);
  localStorage.removeItem(STORAGE_KEYS.USER);
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.USER);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setStoredUser(user: AuthUser): void {
  localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
  if (user.nickname) {
    setPlayerNickname(user.nickname);
  }
}

export function getPlayerNickname(): string {
  const user = getStoredUser();
  if (user?.nickname) return user.nickname;
  return localStorage.getItem(STORAGE_KEYS.NICKNAME) || `研友${Math.floor(1000 + Math.random() * 9000)}`;
}

export function setPlayerNickname(nickname: string): void {
  localStorage.setItem(STORAGE_KEYS.NICKNAME, nickname.trim());
}

// Local cache fallback for history
export function getLocalHistory(): HistorySessionRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.HISTORY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function setLocalHistory(records: HistorySessionRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(records.slice(0, 50)));
  } catch {}
}

export function getHistory(): HistorySessionRecord[] {
  return getLocalHistory();
}

export function saveHistoryRecord(record: HistorySessionRecord): void {
  try {
    const list = getLocalHistory();
    const existingIdx = list.findIndex((r) => r.id === record.id);
    if (existingIdx >= 0) {
      list[existingIdx] = record;
    } else {
      list.unshift(record);
    }
    setLocalHistory(list);
  } catch (err) {
    console.error('Failed to save local history record:', err);
  }
}

export function clearHistory(): void {
  localStorage.removeItem(STORAGE_KEYS.HISTORY);
}
