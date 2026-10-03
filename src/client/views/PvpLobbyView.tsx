import React, { useState, useEffect } from 'react';
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
  ExternalLink,
  Sparkles,
} from 'lucide-react';
import type { PvpRoomState } from '../../shared/types.js';
import { getAuthToken } from '../utils/storage.js';
import { copyTextToClipboard } from '../utils/clipboard.js';

interface PvpLobbyViewProps {
  initialYear: number;
  playerId: string;
  nickname: string;
  onBack: () => void;
  onStartMatch: (roomState: PvpRoomState, ws: WebSocket) => void;
  initialRoomCode?: string;
}

export const PvpLobbyView: React.FC<PvpLobbyViewProps> = ({
  initialYear,
  playerId,
  nickname,
  onBack,
  onStartMatch,
  initialRoomCode,
}) => {
  const [mode, setMode] = useState<'create' | 'join'>(initialRoomCode ? 'join' : 'create');
  const [roomCodeInput, setRoomCodeInput] = useState(initialRoomCode || '');
  const [selectedYear, setSelectedYear] = useState<number>(initialYear);
  const [durationMinutes, setDurationMinutes] = useState<number>(15);
  const [years, setYears] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Active connected room state
  const [currentRoom, setCurrentRoom] = useState<PvpRoomState | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [countdownNum, setCountdownNum] = useState<number | null>(null);

  useEffect(() => {
    fetchYears();
  }, []);

  useEffect(() => {
    if (initialRoomCode) {
      setMode('join');
      setRoomCodeInput(initialRoomCode.toUpperCase().trim());
    }
  }, [initialRoomCode]);

  // Keep WebSocket alive with ping every 20 seconds
  useEffect(() => {
    if (!ws) return;
    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 20000);
    return () => clearInterval(pingTimer);
  }, [ws]);

  // Auto-reconnect when switching back to this tab/app (e.g. from WeChat)
  useEffect(() => {
    const handleReactivate = () => {
      if (document.visibilityState === 'visible' && currentRoom) {
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          console.log('[PVP] Re-establishing connection upon reactivation...');
          connectWebSocket()
            .then((newWs) => {
              setWs(newWs);
              newWs.send(
                JSON.stringify({
                  type: 'room:reconnect',
                  payload: { roomCode: currentRoom.roomCode },
                })
              );
            })
            .catch((err) => {
              console.error('Reconnect failed:', err);
            });
        }
      }
    };

    document.addEventListener('visibilitychange', handleReactivate);
    window.addEventListener('online', handleReactivate);
    return () => {
      document.removeEventListener('visibilitychange', handleReactivate);
      window.removeEventListener('online', handleReactivate);
    };
  }, [currentRoom, ws]);

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

  const connectWebSocket = (): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const token = getAuthToken();
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws?token=${token}&playerId=${playerId}`;
      const socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        resolve(socket);
      };

      socket.onerror = (err) => {
        reject(err);
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleWsMessage(msg, socket);
        } catch (err) {
          console.error('Invalid message from server:', err);
        }
      };

      socket.onclose = () => {
        console.log('WS connection closed');
      };
    });
  };

  const handleWsMessage = (msg: { type: string; payload?: any }, activeSocket: WebSocket) => {
    switch (msg.type) {
      case 'room:state':
        setCurrentRoom(msg.payload);
        setLoading(false);
        setError(null);
        if (msg.payload.status === 'IN_PROGRESS') {
          onStartMatch(msg.payload, activeSocket);
        }
        break;
      case 'room:countdown':
        setCountdownNum(msg.payload.secondsRemaining);
        break;
      case 'error':
        setError(msg.payload.message || '操作失败');
        setLoading(false);
        break;
      case 'pong':
        // Heartbeat acknowledged
        break;
    }
  };

  const handleCreateRoom = async () => {
    setError(null);
    setLoading(true);
    try {
      let socket = ws;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        socket = await connectWebSocket();
        setWs(socket);
      }
      socket.send(
        JSON.stringify({
          type: 'room:create',
          payload: {
            nickname,
            year: selectedYear,
            durationMinutes,
          },
        })
      );
    } catch {
      setError('无法连接对战服务器，请检查网络或重新登录');
      setLoading(false);
    }
  };

  const handleJoinRoom = async () => {
    const code = roomCodeInput.trim().toUpperCase();
    if (!code) {
      setError('请输入6位房间码');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      let socket = ws;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        socket = await connectWebSocket();
        setWs(socket);
      }
      socket.send(
        JSON.stringify({
          type: 'room:join',
          payload: {
            roomCode: code,
            nickname,
          },
        })
      );
    } catch {
      setError('无法连接对战服务器，请检查网络或重新登录');
      setLoading(false);
    }
  };

  const handleToggleReady = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'room:toggle_ready' }));
    }
  };

  const handleCopyLink = async () => {
    if (!currentRoom) return;
    const url = `${window.location.origin}/#/pvp/${currentRoom.roomCode}`;
    if (typeof navigator !== 'undefined' && navigator.share && /mobile|android|iphone|ipad/i.test(navigator.userAgent)) {
      try {
        await navigator.share({
          title: '考研英语翻译竞技场对战邀请',
          text: `我在考研英语（一）翻译竞技场创建了 ${currentRoom.year} 年真题房间，房间码：${currentRoom.roomCode}，来决一胜负吧！`,
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

  const handleCopyCode = async () => {
    if (!currentRoom) return;
    const success = await copyTextToClipboard(currentRoom.roomCode);
    if (success) {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2500);
    }
  };

  const handleLeaveRoom = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'room:leave' }));
      ws.close();
      setWs(null);
    }
    setCurrentRoom(null);
    setCountdownNum(null);
  };

  // --- WAITING ROOM SCREEN ---
  if (currentRoom) {
    const players = Object.values(currentRoom.players);
    const myPlayer = currentRoom.players[playerId];
    const opponent = players.find((p) => p.playerId !== playerId);
    const inviteUrl = `${window.location.origin}/#/pvp/${currentRoom.roomCode}`;

    return (
      <div className="max-w-4xl mx-auto px-3 sm:px-6 py-6 sm:py-10 space-y-6 sm:space-y-8">
        {/* Countdown overlay if active */}
        {countdownNum !== null && (
          <div className="fixed inset-0 z-50 bg-swiss-black/90 dark:bg-black/95 backdrop-blur-md flex flex-col items-center justify-center text-white">
            <div className="font-mono text-sm uppercase tracking-widest text-swiss-red mb-4">
              MATCH STARTING // 即刻开战
            </div>
            <div className="font-mono text-8xl sm:text-9xl font-black animate-ping text-white">
              {countdownNum}
            </div>
            <div className="font-mono text-xs text-zinc-400 mt-6 uppercase">
              双方请就位，作答立即开启
            </div>
          </div>
        )}

        {/* Room Header */}
        <div className="border-2 sm:border-4 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 sm:p-8 shadow-[6px_6px_0px_0px_#09090b] dark:shadow-[6px_6px_0px_0px_#000000]">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-5 sm:pb-6 border-b-2 border-swiss-black dark:border-zinc-700">
            <div>
              <div className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1">
                PVP ARENA ROOM // 对战等待室
              </div>
              <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
                <span className="text-lg sm:text-xl font-black uppercase text-swiss-black dark:text-zinc-100">房间码：</span>
                <span className="bg-zinc-100 dark:bg-zinc-800 border-2 border-swiss-black dark:border-zinc-700 px-3 sm:px-3.5 py-0.5 sm:py-1 tracking-widest font-mono text-xl sm:text-2xl font-black text-swiss-red">
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

            <div className="flex items-center gap-2.5 sm:gap-3 w-full sm:w-auto">
              <button
                onClick={handleCopyLink}
                className="flex-1 sm:flex-initial flex items-center justify-center gap-2 px-4 sm:px-5 py-2.5 border-2 border-swiss-black dark:border-zinc-700 bg-swiss-black hover:bg-swiss-red dark:bg-zinc-100 dark:text-swiss-black dark:hover:bg-swiss-red dark:hover:text-white text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors shadow-sm active:scale-[0.98]"
              >
                {copiedLink ? (
                  <>
                    <Check className="w-4 h-4 text-emerald-400 dark:text-emerald-600" />
                    <span>已复制链接</span>
                  </>
                ) : (
                  <>
                    <Share2 className="w-4 h-4 text-swiss-red" />
                    <span>分享 / 复制链接</span>
                  </>
                )}
              </button>

              <button
                onClick={handleLeaveRoom}
                className="px-3.5 sm:px-4 py-2.5 border-2 border-zinc-300 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-400 font-mono text-xs font-bold uppercase transition-colors text-zinc-600 dark:text-zinc-300 bg-white dark:bg-zinc-800"
              >
                退出房间
              </button>
            </div>
          </div>

          {/* Quick link box for manual selection / mobile fallback */}
          <div className="mt-4 p-3 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 flex flex-wrap items-center gap-2 sm:gap-3">
            <span className="text-xs font-mono font-bold text-zinc-500 dark:text-zinc-400 uppercase shrink-0">
              直达链接：
            </span>
            <input
              type="text"
              readOnly
              value={inviteUrl}
              onClick={(e) => (e.target as HTMLInputElement).select()}
              className="flex-1 min-w-[180px] bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs font-mono text-zinc-700 dark:text-zinc-200 select-all cursor-text focus:outline-none focus:border-swiss-black dark:focus:border-zinc-400"
            />
          </div>

          {/* Match Settings Info */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4 py-4 sm:py-6 border-b border-zinc-200 dark:border-zinc-800 font-mono text-xs mt-4">
            <div className="p-3 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700">
              <div className="text-zinc-500 dark:text-zinc-400 text-[10px] uppercase font-bold mb-1 flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5" /> 考研年份
              </div>
              <div className="font-black text-sm text-swiss-black dark:text-zinc-100">{currentRoom.year} 年真题</div>
            </div>
            <div className="p-3 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700">
              <div className="text-zinc-500 dark:text-zinc-400 text-[10px] uppercase font-bold mb-1 flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" /> 限时规则
              </div>
              <div className="font-black text-sm text-swiss-black dark:text-zinc-100">{currentRoom.durationMinutes} 分钟限时</div>
            </div>
            <div className="p-3 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 col-span-2 md:col-span-1">
              <div className="text-zinc-500 dark:text-zinc-400 text-[10px] uppercase font-bold mb-1 flex items-center gap-1">
                <Users className="w-3.5 h-3.5" /> 房间状态
              </div>
              <div className="font-black text-sm text-swiss-black dark:text-zinc-100">
                {players.length} / 2 位选手在场
              </div>
            </div>
          </div>

          {/* Player Cards (2 Slots) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6 my-6 sm:my-8">
            {/* Slot 1: You */}
            <div className="border-2 border-swiss-black dark:border-zinc-700 p-4 sm:p-5 bg-zinc-50 dark:bg-zinc-800/60 space-y-3 relative">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] font-bold bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black px-2 py-0.5 uppercase">
                  {myPlayer?.isHost ? '房主 (YOU)' : '挑战者 (YOU)'}
                </span>
                <span
                  className={`font-mono text-xs font-black uppercase px-2 py-0.5 border ${
                    myPlayer?.isReady
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'bg-white dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border-zinc-300 dark:border-zinc-700'
                  }`}
                >
                  {myPlayer?.isReady ? 'READY 已就绪' : 'WAITING 未准备'}
                </span>
              </div>

              <div className="font-mono text-lg sm:text-xl font-black text-swiss-black dark:text-zinc-100 truncate">
                {myPlayer?.nickname}
              </div>

              <button
                onClick={handleToggleReady}
                className={`w-full py-3 font-mono text-xs font-bold uppercase tracking-wider transition-colors border-2 active:scale-[0.99] ${
                  myPlayer?.isReady
                    ? 'bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-800 dark:text-zinc-100 border-zinc-400 dark:border-zinc-600'
                    : 'bg-swiss-red hover:bg-swiss-red-dark text-white border-swiss-red shadow-sm'
                }`}
              >
                {myPlayer?.isReady ? '取消准备' : '准备就绪 (READY)'}
              </button>
            </div>

            {/* Slot 2: Opponent */}
            <div className="border-2 border-swiss-black dark:border-zinc-700 p-4 sm:p-5 bg-zinc-50 dark:bg-zinc-800/60 space-y-3 relative">
              {opponent ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] font-bold bg-zinc-700 text-white px-2 py-0.5 uppercase">
                      {opponent.isHost ? '房主 (对手)' : '挑战者 (对手)'}
                    </span>
                    <span
                      className={`font-mono text-xs font-black uppercase px-2 py-0.5 border ${
                        opponent.isReady
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border-zinc-300 dark:border-zinc-700'
                      }`}
                    >
                      {opponent.isReady ? 'READY 已就绪' : 'WAITING 未准备'}
                    </span>
                  </div>

                  <div className="font-mono text-lg sm:text-xl font-black text-swiss-black dark:text-zinc-100 truncate">
                    {opponent.nickname}
                  </div>

                  <div className="w-full py-3 text-center font-mono text-xs font-bold uppercase text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700">
                    {opponent.isReady ? '对手已就绪，等待开局' : '等待对手准备中...'}
                  </div>
                </>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center p-5 sm:p-6 border-2 border-dashed border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 min-h-[140px]">
                  <Loader2 className="w-6 h-6 animate-spin text-swiss-red mb-2" />
                  <div className="font-mono text-xs font-bold text-swiss-black dark:text-zinc-200 uppercase">
                    等待好友加入...
                  </div>
                  <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 max-w-xs">
                    复制上方房间码或完整链接给好友，好友加入即可开赛。房间将保持常开，切屏发微信无需担心掉房。
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 text-center">
            * 双方同时点击“准备就绪”后，系统将进入 3 秒倒计时并开始作答。
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
              PVP 对战竞技大厅
            </h2>
          </div>
          <span className="font-mono text-xs font-bold uppercase text-zinc-500 dark:text-zinc-400">
            [ PLAYER: {nickname} ]
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
            创建对战房间
          </button>
          <button
            onClick={() => setMode('join')}
            className={`py-2.5 border-2 transition-all ${
              mode === 'join'
                ? 'bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black border-swiss-black dark:border-zinc-100'
                : 'bg-zinc-50 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-400'
            }`}
          >
            输入房间码加入
          </button>
        </div>

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
                  <span>生成对战房间 & 邀请好友</span>
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

            <button
              onClick={handleJoinRoom}
              disabled={loading || !roomCodeInput.trim()}
              className="w-full min-h-[48px] py-3.5 bg-swiss-black hover:bg-swiss-red dark:bg-zinc-100 dark:text-swiss-black dark:hover:bg-swiss-red dark:hover:text-white text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.99]"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>加入房间中...</span>
                </>
              ) : (
                <>
                  <span>进入对战房间</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
