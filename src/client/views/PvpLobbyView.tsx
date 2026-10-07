import React, { useState, useEffect, useRef } from 'react';
import {
  Swords,
  Copy,
  Check,
  ArrowLeft,
  Users,
  Clock,
  Calendar,
  Loader2,
  Share2,
  Eye,
  UserPlus,
  Play,
  Crown,
} from 'lucide-react';
import type { PvpRoomState } from '../../shared/types.js';
import { PvpSocket, type PvpConnectionStatus } from '../utils/pvpSocket.js';
import { clearActivePvpRoom, getAuthToken, setActivePvpRoom } from '../utils/storage.js';
import { copyTextToClipboard } from '../utils/clipboard.js';

interface PvpLobbyViewProps {
  initialYear: number;
  playerId: string;
  nickname: string;
  onBack: () => void;
  onStartMatch: (roomState: PvpRoomState, socket: PvpSocket) => void;
  initialRoomCode?: string;
  initialSpectate?: boolean;
  autoJoin?: boolean;
}

export const PvpLobbyView: React.FC<PvpLobbyViewProps> = ({
  initialYear,
  playerId,
  nickname,
  onBack,
  onStartMatch,
  initialRoomCode,
  initialSpectate = false,
  autoJoin = false,
}) => {
  const [mode, setMode] = useState<'create' | 'join'>(initialRoomCode ? 'join' : 'create');
  const [roomCodeInput, setRoomCodeInput] = useState(initialRoomCode || '');
  const [selectedYear, setSelectedYear] = useState<number>(initialYear);
  const [durationMinutes, setDurationMinutes] = useState<number>(15);
  const [maxPlayers, setMaxPlayers] = useState<number>(2);
  const [allowSpectators, setAllowSpectators] = useState<boolean>(true);
  const [years, setYears] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spectatorNotice, setSpectatorNotice] = useState<string | null>(null);

  // Active connected room state
  const [currentRoom, setCurrentRoom] = useState<PvpRoomState | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedSpectateLink, setCopiedSpectateLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [countdownNum, setCountdownNum] = useState<number | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<PvpConnectionStatus>('idle');
  const [connectionMessage, setConnectionMessage] = useState<string | undefined>(undefined);

  const socketRef = useRef<PvpSocket | null>(null);
  const handedOffRef = useRef(false);
  const onStartMatchRef = useRef(onStartMatch);

  const getSocket = (): PvpSocket => {
    if (!socketRef.current) {
      socketRef.current = new PvpSocket(playerId);
    }
    return socketRef.current;
  };

  useEffect(() => {
    onStartMatchRef.current = onStartMatch;
  }, [onStartMatch]);

  useEffect(() => {
    fetchYears();
  }, []);

  // Own the resilient websocket. It survives the hand-off to the live match view
  // (handedOffRef), and is closed when the player leaves the lobby for good.
  useEffect(() => {
    const socket = getSocket();

    const unsubscribeMessage = socket.subscribe((msg) => {
      switch (msg.type) {
        case 'room:state': {
          const room = msg.payload as PvpRoomState;
          setCurrentRoom(room);
          setLoading(false);
          setError(null);
          if (room.status === 'IN_PROGRESS' || room.status === 'FINISHED') {
            handedOffRef.current = true;
            setActivePvpRoom(room.roomCode);
            onStartMatchRef.current(room, socket);
          }
          break;
        }
        case 'room:joined_as_spectator': {
          setSpectatorNotice(msg.payload?.message || '已进入实时观战席');
          break;
        }
        case 'room:countdown':
          setCountdownNum(msg.payload?.secondsRemaining ?? null);
          break;
        case 'error':
          if (msg.payload?.code === 'ROOM_NOT_FOUND') {
            clearActivePvpRoom();
          }
          setError(msg.payload?.message || '操作失败');
          setLoading(false);
          break;
        case 'pong':
          break;
      }
    });

    const unsubscribeStatus = socket.onStatus((status, detail) => {
      setConnectionStatus(status);
      setConnectionMessage(detail.message);
    });

    return () => {
      unsubscribeMessage();
      unsubscribeStatus();
      if (!handedOffRef.current) {
        socket.close();
        socketRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerId]);

  useEffect(() => {
    if (!initialRoomCode) return;
    const code = initialRoomCode.toUpperCase().trim();
    setMode('join');
    setRoomCodeInput(code);
    if (!autoJoin && !initialSpectate) return;

    console.log(`[PVP] Auto-joining room ${code} (spectate=${initialSpectate})`);
    setLoading(true);
    const socket = getSocket();
    socket.setRoomCode(code);
    socket.connect(code);
    socket.send({
      type: 'room:join',
      payload: { roomCode: code, nickname, asSpectator: initialSpectate },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRoomCode, autoJoin, initialSpectate]);

  const fetchYears = async () => {
    try {
      const token = getAuthToken();
      const res = await fetch('/api/exams/years', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setYears(data.years || []);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreateRoom = () => {
    setError(null);
    setSpectatorNotice(null);
    setLoading(true);
    const socket = getSocket();
    socket.connect();
    socket.send({
      type: 'room:create',
      payload: {
        nickname,
        year: selectedYear,
        durationMinutes,
        maxPlayers,
        allowSpectators,
      },
    });
  };

  const handleJoinRoom = (asSpectator = false) => {
    const code = roomCodeInput.trim().toUpperCase();
    if (!code) {
      setError('请输入6位房间码');
      return;
    }
    setError(null);
    setSpectatorNotice(null);
    setLoading(true);
    const socket = getSocket();
    socket.setRoomCode(code);
    socket.connect(code);
    socket.send({
      type: 'room:join',
      payload: {
        roomCode: code,
        nickname,
        asSpectator,
      },
    });
  };

  const handleToggleReady = () => {
    getSocket().send({ type: 'room:toggle_ready' });
  };

  const handleSwitchRole = (targetRole: 'player' | 'spectator') => {
    setError(null);
    getSocket().send({
      type: 'room:switch_role',
      payload: { targetRole },
    });
  };

  const handleStartEarly = () => {
    setError(null);
    getSocket().send({ type: 'room:start_early' });
  };

  const handleHostChangeMaxPlayers = (newMax: number) => {
    setError(null);
    getSocket().send({
      type: 'room:update_settings',
      payload: { maxPlayers: newMax },
    });
  };

  const handleCopyLink = async () => {
    if (!currentRoom) return;
    const url = `${window.location.origin}/#/pvp/${currentRoom.roomCode}`;
    if (
      typeof navigator !== 'undefined' &&
      navigator.share &&
      /mobile|android|iphone|ipad/i.test(navigator.userAgent)
    ) {
      try {
        await navigator.share({
          title: '考研英语翻译竞技场对战邀请',
          text: `我在考研英语（一）翻译竞技场创建了 ${currentRoom.year} 年真题 ${currentRoom.maxPlayers} 人房间，房间码：${currentRoom.roomCode}，来决一胜负吧！`,
          url,
        });
        return;
      } catch {
        // user cancelled or share failed, fallback to copy
      }
    }
    const success = await copyTextToClipboard(url);
    if (success) {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    }
  };

  const handleCopySpectateLink = async () => {
    if (!currentRoom) return;
    const url = `${window.location.origin}/#/pvp/${currentRoom.roomCode}?spectate=1`;
    const success = await copyTextToClipboard(url);
    if (success) {
      setCopiedSpectateLink(true);
      setTimeout(() => setCopiedSpectateLink(false), 2500);
    }
  };

  const handleCopyCode = async () => {
    if (!currentRoom) return;
    const success = await copyTextToClipboard(currentRoom.roomCode);
    if (success) {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2500);
    }
  };

  const handleLeaveRoom = () => {
    const socket = socketRef.current;
    if (socket) {
      socket.send({ type: 'room:leave' });
      socket.close();
      socketRef.current = null;
    }
    clearActivePvpRoom();
    setCurrentRoom(null);
    setCountdownNum(null);
    setSpectatorNotice(null);
    setConnectionStatus('idle');
  };

  // --- WAITING ROOM SCREEN ---
  if (currentRoom) {
    const players = Object.values(currentRoom.players);
    const spectators = Object.values(currentRoom.spectators || {});
    const myPlayer = currentRoom.players[playerId];
    const mySpectator = currentRoom.spectators?.[playerId];
    const isMeSpectator = !!mySpectator && !myPlayer;
    const roomMaxPlayers = currentRoom.maxPlayers || 2;
    const inviteUrl = `${window.location.origin}/#/pvp/${currentRoom.roomCode}`;

    // Build ordered slots: put myPlayer first if I am a player, then other players, then null placeholders up to roomMaxPlayers
    const orderedPlayers = myPlayer
      ? [myPlayer, ...players.filter((p) => p.playerId !== playerId)]
      : players;
    const slots = Array.from({ length: roomMaxPlayers }, (_, idx) => orderedPlayers[idx] || null);

    const canStartEarly =
      myPlayer?.isHost &&
      players.length >= 2 &&
      players.length < roomMaxPlayers &&
      players.every((p) => p.isReady);

    const gridColsClass =
      roomMaxPlayers === 3
        ? 'grid-cols-1 md:grid-cols-3'
        : 'grid-cols-1 sm:grid-cols-2';

    return (
      <div className="max-w-5xl mx-auto px-3 sm:px-6 py-5 sm:py-8 space-y-5 sm:space-y-6">
        {/* Countdown overlay if active */}
        {countdownNum !== null && (
          <div className="fixed inset-0 z-50 bg-swiss-black/90 dark:bg-black/95 backdrop-blur-md flex flex-col items-center justify-center text-white">
            <div className="font-mono text-sm uppercase tracking-widest text-swiss-red mb-4">
              MATCH STARTING // 即刻开战 ({players.length}人同场)
            </div>
            <div className="font-mono text-8xl sm:text-9xl font-black animate-ping text-white">
              {countdownNum}
            </div>
            <div className="font-mono text-xs text-zinc-400 mt-6 uppercase">
              {isMeSpectator ? '实时观战大屏即将开启' : '全员请就位，作答立即开启'}
            </div>
          </div>
        )}

        {/* Connection status banner */}
        {connectionStatus !== 'open' && connectionStatus !== 'idle' && (
          <div className="p-3 border-2 border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 font-mono text-xs flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            <span>{connectionMessage || '正在连接对战服务器...'}</span>
          </div>
        )}

        {spectatorNotice && (
          <div className="p-3 border-2 border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-900 dark:text-blue-200 font-mono text-xs flex items-center gap-2">
            <Eye className="w-4 h-4 shrink-0 text-blue-600 dark:text-blue-400" />
            <span>{spectatorNotice}</span>
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-900 text-red-700 dark:text-red-300 text-xs font-mono">
            [ERROR] {error}
          </div>
        )}

        {/* Room Main Card */}
        <div className="border-2 sm:border-4 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 sm:p-7 shadow-[6px_6px_0px_0px_#09090b] dark:shadow-[6px_6px_0px_0px_#000000]">
          {/* Top Bar */}
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4 sm:pb-5 border-b-2 border-swiss-black dark:border-zinc-700">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                  PVP ARENA ROOM // {roomMaxPlayers}人竞技大厅
                </span>
                {isMeSpectator && (
                  <span className="bg-blue-600 text-white font-mono text-[10px] font-bold px-2 py-0.5 uppercase flex items-center gap-1">
                    <Eye className="w-3 h-3" /> 观战视角
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                <span className="text-base sm:text-xl font-black uppercase text-swiss-black dark:text-zinc-100">
                  房间码：
                </span>
                <span className="bg-zinc-100 dark:bg-zinc-800 border-2 border-swiss-black dark:border-zinc-700 px-3 py-0.5 tracking-widest font-mono text-xl sm:text-2xl font-black text-swiss-red">
                  {currentRoom.roomCode}
                </span>
                <button
                  onClick={handleCopyCode}
                  className="px-2.5 py-1.5 border border-zinc-400 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-400 bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 text-xs font-mono font-bold transition-colors flex items-center gap-1 active:scale-[0.98]"
                >
                  {copiedCode ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                      <span className="text-emerald-700 dark:text-emerald-400">已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-zinc-600 dark:text-zinc-400" />
                      <span>复制</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
              <button
                onClick={handleCopyLink}
                className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3.5 py-2.5 border-2 border-swiss-black dark:border-zinc-700 bg-swiss-black hover:bg-swiss-red dark:bg-zinc-100 dark:text-swiss-black dark:hover:bg-swiss-red dark:hover:text-white text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors shadow-sm active:scale-[0.98]"
              >
                {copiedLink ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400 dark:text-emerald-600" />
                    <span>已复制参赛链接</span>
                  </>
                ) : (
                  <>
                    <Share2 className="w-3.5 h-3.5 text-swiss-red" />
                    <span>邀请参赛</span>
                  </>
                )}
              </button>

              {currentRoom.allowSpectators !== false && (
                <button
                  onClick={handleCopySpectateLink}
                  className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3.5 py-2.5 border-2 border-blue-600 dark:border-blue-500 bg-blue-50 dark:bg-blue-950/50 hover:bg-blue-600 hover:text-white text-blue-700 dark:text-blue-300 font-mono text-xs font-bold uppercase tracking-wider transition-colors active:scale-[0.98]"
                >
                  {copiedSpectateLink ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>已复制观战链接</span>
                    </>
                  ) : (
                    <>
                      <Eye className="w-3.5 h-3.5" />
                      <span>邀请观战</span>
                    </>
                  )}
                </button>
              )}

              <button
                onClick={handleLeaveRoom}
                className="px-3.5 py-2.5 border-2 border-zinc-300 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-400 font-mono text-xs font-bold uppercase transition-colors text-zinc-600 dark:text-zinc-300 bg-white dark:bg-zinc-800"
              >
                退出房间
              </button>
            </div>
          </div>

          {/* Quick link box for manual selection */}
          <div className="mt-3 p-2.5 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-mono font-bold text-zinc-500 dark:text-zinc-400 uppercase shrink-0">
              直达链接：
            </span>
            <input
              type="text"
              readOnly
              value={inviteUrl}
              onClick={(e) => (e.target as HTMLInputElement).select()}
              className="flex-1 min-w-[160px] bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs font-mono text-zinc-700 dark:text-zinc-200 select-all cursor-text focus:outline-none"
            />
          </div>

          {/* Match Settings Info (4-grid) */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3.5 py-4 border-b border-zinc-200 dark:border-zinc-800 font-mono text-xs mt-3">
            <div className="p-3 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700">
              <div className="text-zinc-500 dark:text-zinc-400 text-[10px] uppercase font-bold mb-1 flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5" /> 考研年份
              </div>
              <div className="font-black text-sm text-swiss-black dark:text-zinc-100">
                {currentRoom.year} 年真题
              </div>
            </div>
            <div className="p-3 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700">
              <div className="text-zinc-500 dark:text-zinc-400 text-[10px] uppercase font-bold mb-1 flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" /> 限时规则
              </div>
              <div className="font-black text-sm text-swiss-black dark:text-zinc-100">
                {currentRoom.durationMinutes} 分钟限时
              </div>
            </div>
            <div className="p-3 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700">
              <div className="text-zinc-500 dark:text-zinc-400 text-[10px] uppercase font-bold mb-1 flex items-center gap-1">
                <Users className="w-3.5 h-3.5" /> 房间人数规模
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="font-black text-sm text-swiss-black dark:text-zinc-100">
                  {players.length} / {roomMaxPlayers} 选手
                </span>
                {myPlayer?.isHost && currentRoom.status === 'WAITING' && (
                  <div className="flex items-center gap-1">
                    {[2, 3, 4].map((num) => (
                      <button
                        key={num}
                        onClick={() => handleHostChangeMaxPlayers(num)}
                        disabled={num < players.length}
                        className={`px-1.5 py-0.5 text-[10px] font-bold border transition-colors ${
                          roomMaxPlayers === num
                            ? 'bg-swiss-red text-white border-swiss-red'
                            : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 border-zinc-300 dark:border-zinc-700 hover:border-swiss-black disabled:opacity-30'
                        }`}
                        title={`切换为 ${num} 人房`}
                      >
                        {num}人
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="p-3 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700">
              <div className="text-zinc-500 dark:text-zinc-400 text-[10px] uppercase font-bold mb-1 flex items-center gap-1">
                <Eye className="w-3.5 h-3.5" /> 实时观战席
              </div>
              <div className="font-black text-sm text-swiss-black dark:text-zinc-100">
                {currentRoom.allowSpectators === false
                  ? '已关闭观战'
                  : `${spectators.length} 人正在观战`}
              </div>
            </div>
          </div>

          {/* Host Early Start Banner when >=2 players ready in 3/4 player room */}
          {canStartEarly && (
            <div className="mt-4 p-3.5 border-2 border-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 flex flex-wrap items-center justify-between gap-3">
              <div className="font-mono text-xs text-emerald-900 dark:text-emerald-200">
                <span className="font-black uppercase mr-2">[房主特权]</span>
                在场的 {players.length} 位选手已全部准备就绪！无需等满 {roomMaxPlayers} 人即可直接开战。
              </div>
              <button
                onClick={handleStartEarly}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-mono text-xs font-bold uppercase flex items-center gap-1.5 shadow-sm active:scale-[0.98]"
              >
                <Play className="w-3.5 h-3.5" />
                立即提前开赛 ({players.length}人局)
              </button>
            </div>
          )}

          {/* Player Slots Grid (2, 3, or 4 Slots) */}
          <div className="my-5 sm:my-6">
            <div className="flex items-center justify-between mb-3">
              <span className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-300 flex items-center gap-1.5">
                <Swords className="w-3.5 h-3.5 text-swiss-red" />
                参赛选手席位 ({players.length} / {roomMaxPlayers})
              </span>
              {myPlayer &&
                currentRoom.allowSpectators !== false &&
                (!myPlayer.isHost || players.length > 1) && (
                  <button
                    onClick={() => handleSwitchRole('spectator')}
                    className="font-mono text-[11px] font-bold text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    让出选手位，转为观战者
                  </button>
                )}
            </div>

            <div className={`grid ${gridColsClass} gap-3.5 sm:gap-5`}>
              {slots.map((slotPlayer, idx) => {
                const isMe = slotPlayer?.playerId === playerId;
                return (
                  <div
                    key={slotPlayer ? slotPlayer.playerId : `empty-${idx}`}
                    className={`border-2 p-4 sm:p-5 transition-colors relative flex flex-col justify-between min-h-[152px] ${
                      slotPlayer
                        ? isMe
                          ? 'border-swiss-black dark:border-zinc-500 bg-zinc-50 dark:bg-zinc-800/80 shadow-[3px_3px_0px_0px_#09090b] dark:shadow-[3px_3px_0px_0px_#000000]'
                          : 'border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-800/40'
                        : 'border-dashed border-zinc-300 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-900/50'
                    }`}
                  >
                    {slotPlayer ? (
                      <>
                        <div className="space-y-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className={`font-mono text-[10px] font-bold px-2 py-0.5 uppercase flex items-center gap-1 ${
                                isMe
                                  ? 'bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black'
                                  : 'bg-zinc-700 text-white'
                              }`}
                            >
                              {slotPlayer.isHost && <Crown className="w-3 h-3 text-amber-400" />}
                              {slotPlayer.isHost ? '房主' : `选手 #${idx + 1}`}
                              {isMe ? ' (YOU)' : ''}
                            </span>

                            <span
                              className={`font-mono text-[11px] font-black uppercase px-2 py-0.5 border ${
                                slotPlayer.isReady
                                  ? 'bg-emerald-600 text-white border-emerald-600'
                                  : 'bg-white dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border-zinc-300 dark:border-zinc-700'
                              }`}
                            >
                              {slotPlayer.isReady ? 'READY 已就绪' : 'WAITING 未准备'}
                            </span>
                          </div>

                          <div className="flex items-center justify-between gap-2">
                            <div className="font-mono text-lg sm:text-xl font-black text-swiss-black dark:text-zinc-100 truncate">
                              {slotPlayer.nickname}
                            </div>
                            {slotPlayer.isOnline === false && (
                              <span className="font-mono text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 font-bold">
                                离线重连中
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="pt-3 mt-2">
                          {isMe ? (
                            <button
                              onClick={handleToggleReady}
                              className={`w-full py-2.5 font-mono text-xs font-bold uppercase tracking-wider transition-colors border-2 active:scale-[0.99] ${
                                slotPlayer.isReady
                                  ? 'bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-800 dark:text-zinc-100 border-zinc-400 dark:border-zinc-600'
                                  : 'bg-swiss-red hover:bg-swiss-red-dark text-white border-swiss-red shadow-sm'
                              }`}
                            >
                              {slotPlayer.isReady ? '取消准备' : '准备就绪 (READY)'}
                            </button>
                          ) : (
                            <div className="w-full py-2.5 text-center font-mono text-xs font-bold uppercase text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700">
                              {slotPlayer.isReady ? '选手已就绪，等待开局' : '等待选手准备中...'}
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="flex-1 flex flex-col items-center justify-center text-center p-3">
                        <Loader2 className="w-5 h-5 animate-spin text-swiss-red mb-2" />
                        <div className="font-mono text-xs font-bold text-swiss-black dark:text-zinc-200 uppercase">
                          空缺选手席位 #{idx + 1}
                        </div>
                        {isMeSpectator ? (
                          <button
                            onClick={() => handleSwitchRole('player')}
                            className="mt-2.5 px-3 py-1.5 bg-swiss-black hover:bg-swiss-red text-white dark:bg-zinc-100 dark:text-swiss-black dark:hover:bg-swiss-red dark:hover:text-white font-mono text-xs font-bold uppercase flex items-center gap-1.5 transition-colors"
                          >
                            <UserPlus className="w-3.5 h-3.5" />
                            坐下参赛 (加入选手席)
                          </button>
                        ) : (
                          <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 mt-1">
                            等待好友加入此席位...
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Spectator Lounge Section */}
          {currentRoom.allowSpectators !== false && (
            <div className="mt-6 pt-5 border-t-2 border-zinc-200 dark:border-zinc-800">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <Eye className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  <span className="font-mono text-xs font-bold uppercase tracking-wider text-swiss-black dark:text-zinc-100">
                    SPECTATOR GALLERY // 实时观战席 ({spectators.length} 人)
                  </span>
                </div>
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                  观战位可在开赛后实时查看全员作答内容、采分明细与排行榜
                </span>
              </div>

              {spectators.length === 0 ? (
                <div className="p-3.5 border border-dashed border-zinc-300 dark:border-zinc-700 bg-zinc-50/60 dark:bg-zinc-800/30 text-center font-mono text-xs text-zinc-500 dark:text-zinc-400">
                  暂无观众在场。点击上方「邀请观战」复制专属观战链接给好友，或满员后自动进入观战席。
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {spectators.map((spec) => {
                    const isMeSpec = spec.playerId === playerId;
                    return (
                      <div
                        key={spec.playerId}
                        className={`px-3 py-1.5 border font-mono text-xs flex items-center gap-2 ${
                          isMeSpec
                            ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/60 text-blue-900 dark:text-blue-200 font-bold'
                            : 'border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
                        }`}
                      >
                        <span
                          className={`w-2 h-2 rounded-full ${
                            spec.isOnline !== false ? 'bg-emerald-500' : 'bg-zinc-400'
                          }`}
                        />
                        <Eye className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                        <span>{spec.nickname}</span>
                        {isMeSpec && (
                          <span className="text-[10px] bg-blue-600 text-white px-1 py-0.2 uppercase">
                            YOU
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 text-center mt-5 pt-3 border-t border-zinc-100 dark:border-zinc-800/80">
            * 当满员（{roomMaxPlayers}人）全部点击“准备就绪”后自动进入 3 秒倒计时开赛；满 2 人就绪时房主也可手动提前开赛。
          </div>
        </div>
      </div>
    );
  }

  // --- PRE-ROOM (CREATE OR JOIN) SCREEN ---
  return (
    <div className="max-w-2xl mx-auto px-3 sm:px-4 py-6 sm:py-10 space-y-5 sm:space-y-6">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 px-3 py-1.5 border border-zinc-300 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-400 font-mono text-xs font-bold transition-colors bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        返回真题首页
      </button>

      <div className="border-2 sm:border-4 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 sm:p-8 shadow-[6px_6px_0px_0px_#09090b] dark:shadow-[6px_6px_0px_0px_#000000] space-y-5 sm:space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 sm:pb-4 border-b-2 border-swiss-black dark:border-zinc-700">
          <div className="flex items-center gap-2">
            <Swords className="w-5 h-5 text-swiss-red" />
            <h2 className="text-xl sm:text-2xl font-black uppercase text-swiss-black dark:text-zinc-100">
              PVP 多人竞技与观战大厅
            </h2>
          </div>
          <span className="font-mono text-xs font-bold uppercase text-zinc-500 dark:text-zinc-400">
            [ {nickname} ]
          </span>
        </div>

        {/* Create / Join Tabs */}
        <div className="grid grid-cols-2 gap-2 font-mono text-xs font-bold uppercase">
          <button
            onClick={() => setMode('create')}
            className={`py-2.5 border-2 transition-all ${
              mode === 'create'
                ? 'bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black border-swiss-black dark:border-zinc-100'
                : 'bg-zinc-50 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-400'
            }`}
          >
            创建对战房间 (2-4人)
          </button>
          <button
            onClick={() => setMode('join')}
            className={`py-2.5 border-2 transition-all ${
              mode === 'join'
                ? 'bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black border-swiss-black dark:border-zinc-100'
                : 'bg-zinc-50 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-400'
            }`}
          >
            输入房间码加入 / 观战
          </button>
        </div>

        {connectionStatus !== 'open' && connectionStatus !== 'idle' && (
          <div className="p-3 border-2 border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 font-mono text-xs flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            <span>{connectionMessage || '正在连接对战服务器...'}</span>
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-900 text-red-700 dark:text-red-300 text-xs font-mono">
            [ERROR] {error}
          </div>
        )}

        {mode === 'create' ? (
          /* Create Room Form */
          <div className="space-y-4 sm:space-y-5">
            <div>
              <label className="block text-xs font-mono font-bold uppercase mb-1.5 text-zinc-700 dark:text-zinc-300">
                选择对战真题年份
              </label>
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(parseInt(e.target.value, 10))}
                className="w-full border-2 border-swiss-black dark:border-zinc-700 px-3.5 py-2.5 font-mono text-sm bg-white dark:bg-zinc-800 text-swiss-black dark:text-zinc-100 focus:outline-none"
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y} 年考研英语一翻译真题
                  </option>
                ))}
              </select>
            </div>

            {/* Max Players Selector: 2 / 3 / 4 */}
            <div>
              <label className="block text-xs font-mono font-bold uppercase mb-1.5 text-zinc-700 dark:text-zinc-300">
                对战选手人数上限 (PLAYERS)
              </label>
              <div className="grid grid-cols-3 gap-2.5 sm:gap-3 font-mono text-xs font-bold">
                {[
                  { count: 2, label: '2 人对决', desc: '双人同题并列裁决' },
                  { count: 3, label: '3 人混战', desc: '三人竞速实时排名' },
                  { count: 4, label: '4 人争霸', desc: '四人同台巅峰竞技' },
                ].map((item) => (
                  <button
                    key={item.count}
                    type="button"
                    onClick={() => setMaxPlayers(item.count)}
                    className={`py-2.5 px-2 border-2 transition-all active:scale-[0.98] ${
                      maxPlayers === item.count
                        ? 'border-swiss-red bg-rose-50 dark:bg-rose-950/40 text-swiss-red dark:text-rose-400'
                        : 'border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:border-swiss-black dark:hover:border-zinc-500'
                    }`}
                  >
                    <div className="text-sm font-black">{item.label}</div>
                    <span className="block text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5 font-normal">
                      {item.desc}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Match Duration Selector */}
            <div>
              <label className="block text-xs font-mono font-bold uppercase mb-1.5 text-zinc-700 dark:text-zinc-300">
                比赛时限 (DURATION)
              </label>
              <div className="grid grid-cols-3 gap-2.5 sm:gap-3 font-mono text-xs font-bold">
                {[10, 15, 20].map((mins) => (
                  <button
                    key={mins}
                    type="button"
                    onClick={() => setDurationMinutes(mins)}
                    className={`py-2.5 border-2 transition-all active:scale-[0.98] ${
                      durationMinutes === mins
                        ? 'border-swiss-red bg-rose-50 dark:bg-rose-950/40 text-swiss-red dark:text-rose-400'
                        : 'border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:border-swiss-black dark:hover:border-zinc-500'
                    }`}
                  >
                    {mins} 分钟
                    {mins === 15 && <span className="block text-[10px] text-zinc-400">推荐</span>}
                  </button>
                ))}
              </div>
            </div>

            {/* Spectator Mode Toggle */}
            <div
              onClick={() => setAllowSpectators(!allowSpectators)}
              className="p-3.5 border-2 border-zinc-300 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-500 bg-zinc-50 dark:bg-zinc-800/60 flex items-center justify-between cursor-pointer transition-colors"
            >
              <div className="flex items-center gap-2.5">
                <Eye
                  className={`w-4 h-4 ${
                    allowSpectators ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-400'
                  }`}
                />
                <div>
                  <div className="font-mono text-xs font-bold text-swiss-black dark:text-zinc-100">
                    允许开启实时观战位 (SPECTATOR MODE)
                  </div>
                  <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                    观战者可实时查看每位选手的答题进度、所写译文与 AI 判分详情
                  </div>
                </div>
              </div>
              <div
                className={`px-2.5 py-1 font-mono text-[11px] font-black uppercase border ${
                  allowSpectators
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400 border-zinc-300 dark:border-zinc-600'
                }`}
              >
                {allowSpectators ? 'ON 开启' : 'OFF 关闭'}
              </div>
            </div>

            <button
              onClick={handleCreateRoom}
              disabled={loading}
              className="w-full min-h-[48px] py-3.5 bg-swiss-red hover:bg-swiss-red-dark text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.99]"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>创建房间中...</span>
                </>
              ) : (
                <>
                  <Swords className="w-4 h-4" />
                  <span>创建 {maxPlayers} 人对战房间 & 邀请好友</span>
                </>
              )}
            </button>
          </div>
        ) : (
          /* Join Room Form */
          <div className="space-y-4 sm:space-y-5">
            <div>
              <label className="block text-xs font-mono font-bold uppercase mb-1.5 text-zinc-700 dark:text-zinc-300">
                6 位房间码 (ROOM CODE)
              </label>
              <input
                type="text"
                maxLength={6}
                value={roomCodeInput}
                onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                placeholder="例如：E3PAKQ"
                autoFocus
                className="w-full border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-800 text-swiss-black dark:text-zinc-100 px-3.5 py-3 font-mono text-lg sm:text-xl tracking-widest uppercase focus:outline-none focus:bg-zinc-50 dark:focus:bg-zinc-700/60"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                onClick={() => handleJoinRoom(false)}
                disabled={loading || !roomCodeInput.trim()}
                className="w-full min-h-[48px] py-3.5 bg-swiss-black hover:bg-swiss-red dark:bg-zinc-100 dark:text-swiss-black dark:hover:bg-swiss-red dark:hover:text-white text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.99]"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Swords className="w-4 h-4" />
                )}
                <span>作为参赛选手加入</span>
              </button>

              <button
                onClick={() => handleJoinRoom(true)}
                disabled={loading || !roomCodeInput.trim()}
                className="w-full min-h-[48px] py-3.5 border-2 border-blue-600 dark:border-blue-500 bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-600 hover:text-white text-blue-700 dark:text-blue-300 font-mono text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.99]"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
                <span>进入观战位 (实时看题)</span>
              </button>
            </div>

            <div className="p-3 bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 font-mono text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
              * 提示：若房间选手席位已满或比赛已经开局，点击「作为参赛选手加入」也会自动为您切换至实时观战席。
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
