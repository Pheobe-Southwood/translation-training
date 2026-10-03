import type { AuthUser, HistorySessionRecord } from '../../shared/types.js';

const STORAGE_KEYS = {
  TOKEN: 'tt_auth_token',
  USER: 'tt_auth_user',
  NICKNAME: 'tt_player_nickname',
  HISTORY: 'tt_session_history',
  THEME: 'tt_theme',
};

export type AppTheme = 'light' | 'dark';

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
