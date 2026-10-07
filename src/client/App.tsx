import React, { useState, useEffect } from 'react';
import type { AuthUser, PvpRoomState } from '../shared/types.js';
import { SwissHeader } from './components/SwissHeader.js';
import { PasswordGate } from './components/PasswordGate.js';
import { HomeView } from './views/HomeView.js';
import { SoloView } from './views/SoloView.js';
import { PvpLobbyView } from './views/PvpLobbyView.js';
import { PvpMatchView } from './views/PvpMatchView.js';
import { HistoryView } from './views/HistoryView.js';
import {
  getAuthToken,
  removeAuthToken,
  getStoredUser,
  setStoredUser,
  getPlayerNickname,
  setPlayerNickname,
  getStoredTheme,
  setStoredTheme,
  clearActivePvpRoom,
  getActivePvpRoom,
  type AppTheme,
} from './utils/storage.js';
import type { PvpSocket } from './utils/pvpSocket.js';

export const App: React.FC = () => {
  const [theme, setTheme] = useState<AppTheme>(() => getStoredTheme());
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(() => getStoredUser());
  const [currentView, setCurrentView] = useState<'home' | 'solo' | 'pvp-lobby' | 'pvp-match' | 'history'>('home');
  const [selectedYear, setSelectedYear] = useState<number>(2024);
  const [nickname, setNickname] = useState<string>(() => getPlayerNickname());

  // Player ID is tied to authenticated user ID for 100% online persistence
  const playerId = currentUser?.id || 'guest';

  // PVP Active State
  const [pvpState, setPvpState] = useState<{
    roomState: PvpRoomState;
    socket: PvpSocket;
  } | null>(null);
  const [initialRoomCode, setInitialRoomCode] = useState<string | undefined>();
  const [initialSpectate, setInitialSpectate] = useState<boolean>(false);
  const [autoJoinRoom, setAutoJoinRoom] = useState(false);

  // Check auth on mount
  useEffect(() => {
    checkAuth();
    parseHashRoute();
    window.addEventListener('hashchange', parseHashRoute);
    return () => window.removeEventListener('hashchange', parseHashRoute);
  }, []);

  // Resume a match that was interrupted by a refresh / app switch. The room code is
  // persisted when a match starts and cleared when it truly ends.
  useEffect(() => {
    if (isAuthenticated !== true || currentView !== 'home') return;
    if (window.location.hash.match(/#\/pvp\/[A-Za-z0-9]+/)) return;
    const activeRoom = getActivePvpRoom();
    if (!activeRoom) return;
    console.log(`[PVP] Resuming interrupted match in room ${activeRoom}`);
    setInitialRoomCode(activeRoom);
    setInitialSpectate(false);
    setAutoJoinRoom(true);
    setCurrentView('pvp-lobby');
    // Intentionally only reacts to auth resolution; navigation changes must not re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  const parseHashRoute = () => {
    const hash = window.location.hash;
    const match = hash.match(/#\/pvp\/([A-Za-z0-9]+)/);
    if (match && match[1]) {
      setInitialRoomCode(match[1].toUpperCase());
      setInitialSpectate(hash.includes('spectate=1') || hash.includes('spectate=true'));
      setAutoJoinRoom(false);
      setCurrentView('pvp-lobby');
    }
  };

  const checkAuth = async () => {
    const token = getAuthToken();
    if (!token) {
      setIsAuthenticated(false);
      return;
    }
    try {
      const res = await fetch('/api/auth/check', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.user) {
          setCurrentUser(data.user);
          setNickname(data.user.nickname);
          setStoredUser(data.user);
        }
        setIsAuthenticated(true);
      } else {
        removeAuthToken();
        setCurrentUser(null);
        setIsAuthenticated(false);
      }
    } catch {
      // In case server is temporarily restarting, keep session if token exists
      setIsAuthenticated(true);
    }
  };

  const handleToggleTheme = () => {
    const next: AppTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setStoredTheme(next);
  };

  const handleAuthSuccess = (user: AuthUser) => {
    setCurrentUser(user);
    setNickname(user.nickname);
    setStoredUser(user);
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    if (pvpState?.socket) {
      pvpState.socket.close();
    }
    clearActivePvpRoom();
    setPvpState(null);
    setCurrentView('home');
    removeAuthToken();
    setCurrentUser(null);
    setIsAuthenticated(false);
  };

  const handleChangeNickname = async () => {
    const next = prompt('请输入新的对战与练习昵称：', nickname);
    if (next && next.trim()) {
      const trimmed = next.trim().slice(0, 20);
      setNickname(trimmed);
      setPlayerNickname(trimmed);

      // Persist to server database
      try {
        const token = getAuthToken();
        const res = await fetch('/api/user/nickname', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ nickname: trimmed }),
        });
        if (res.ok && currentUser) {
          const updatedUser = { ...currentUser, nickname: trimmed };
          setCurrentUser(updatedUser);
          setStoredUser(updatedUser);
        }
      } catch (err) {
        console.error('Failed to update nickname online:', err);
      }
    }
  };

  const handleStartSolo = (year: number) => {
    setSelectedYear(year);
    setCurrentView('solo');
  };

  const handleEnterPvpLobby = (year: number) => {
    setSelectedYear(year);
    setInitialRoomCode(undefined);
    setInitialSpectate(false);
    setAutoJoinRoom(false);
    setCurrentView('pvp-lobby');
  };

  const handleStartMatch = (roomState: PvpRoomState, socket: PvpSocket) => {
    setPvpState({ roomState, socket });
    setCurrentView('pvp-match');
  };

  const handleExitMatch = () => {
    if (pvpState?.socket) {
      pvpState.socket.close();
    }
    clearActivePvpRoom();
    setPvpState(null);
    setCurrentView('home');
  };

  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen flex items-center justify-center font-mono text-xs text-zinc-500">
        加载凭据中...
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-swiss-paper dark:bg-swiss-paper-dark text-swiss-black dark:text-zinc-100 font-sans swiss-grid-bg transition-colors duration-150">
      {!isAuthenticated && (
        <PasswordGate onSuccess={handleAuthSuccess} />
      )}

      {currentView !== 'pvp-match' && (
        <SwissHeader
          currentView={currentView}
          onNavigate={(view) => setCurrentView(view)}
          nickname={nickname}
          username={currentUser?.username}
          onChangeNickname={handleChangeNickname}
          onLogout={handleLogout}
          theme={theme}
          onToggleTheme={handleToggleTheme}
        />
      )}

      <main className="flex-1 pb-safe">
        {currentView === 'home' && (
          <HomeView
            onStartSolo={handleStartSolo}
            onEnterPvpLobby={handleEnterPvpLobby}
            onViewHistory={() => setCurrentView('history')}
          />
        )}

        {currentView === 'solo' && (
          <SoloView year={selectedYear} onBack={() => setCurrentView('home')} />
        )}

        {currentView === 'pvp-lobby' && (
          <PvpLobbyView
            initialYear={selectedYear}
            playerId={playerId}
            nickname={nickname}
            initialRoomCode={initialRoomCode}
            initialSpectate={initialSpectate}
            autoJoin={autoJoinRoom}
            onBack={() => setCurrentView('home')}
            onStartMatch={handleStartMatch}
          />
        )}

        {currentView === 'pvp-match' && pvpState && (
          <PvpMatchView
            initialRoomState={pvpState.roomState}
            socket={pvpState.socket}
            playerId={playerId}
            onExit={handleExitMatch}
            theme={theme}
            onToggleTheme={handleToggleTheme}
          />
        )}

        {currentView === 'history' && (
          <HistoryView onBack={() => setCurrentView('home')} />
        )}
      </main>

      {/* Swiss Minimalist Footer */}
      {currentView !== 'pvp-match' && (
        <footer className="border-t-2 border-swiss-black dark:border-zinc-800 bg-white dark:bg-zinc-900 py-6 mt-16 font-mono text-xs text-zinc-500 dark:text-zinc-400">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 bg-swiss-red"></span>
              <span className="font-bold text-swiss-black dark:text-zinc-100 uppercase">
                TRANSLATION TRAINING // 2002–2026
              </span>
            </div>
            <div>
              SWISS DESIGN SYSTEM · DEEPSEEK HIGH REASONING · PVP ARENA
            </div>
          </div>
        </footer>
      )}
    </div>
  );
};
