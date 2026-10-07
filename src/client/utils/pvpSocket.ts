import type { PvpRoomSummary, RoundDetail } from '../../shared/types.js';
import { getAuthToken } from './storage.js';

/**
 * Connection state of the PVP websocket, surfaced to the UI.
 */
export type PvpConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'fatal';

export interface PvpServerMessage {
  type: string;
  payload?: any;
}

export interface PvpStatusDetail {
  attempt: number;
  message?: string;
}

type MessageHandler = (msg: PvpServerMessage) => void;
type StatusHandler = (status: PvpConnectionStatus, detail: PvpStatusDetail) => void;

const HEARTBEAT_INTERVAL_MS = 20000;
const BACKOFF_MS = [500, 1000, 2000, 4000, 5000];

/**
 * Owns the PVP websocket for a whole match session (lobby -> live match -> recap).
 *
 * Why this exists: previously the socket was created by PvpLobbyView, handed to
 * PvpMatchView, and nothing ever reconnected. If the connection dropped mid-match
 * (mobile app switch, network glitch, idle proxy) the client silently kept sending
 * `segment:submit` messages into a dead socket, the server never received them, and
 * the UI stayed frozen on the current question forever.
 *
 * This class adds:
 *  - heartbeat ping for the entire session (not just the lobby)
 *  - automatic reconnect with backoff, plus instant retry on visibilitychange/online
 *  - `room:reconnect` on every (re)connect so the server re-associates the player and
 *    pushes authoritative state (current segment, submissions) back
 *  - `send()` that reports failure instead of silently discarding
 *  - explicit terminal states (expired token / room gone) so the UI can stop retrying
 */
export class PvpSocket {
  private readonly playerId: string;
  private ws: WebSocket | null = null;
  private roomCode?: string;
  private status: PvpConnectionStatus = 'idle';
  private statusMessage?: string;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private manuallyClosed = false;
  private reactivateBound = false;
  private lastSummary: PvpRoomSummary | null = null;
  private readonly roundDetails = new Map<number, RoundDetail>();
  private pendingSends: string[] = [];

  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();

  constructor(playerId: string) {
    this.playerId = playerId;
  }

  // --- Subscriptions -------------------------------------------------------

  /**
   * Register a message handler. The latest `room:summary` (and every cached
   * `round:detail`) is replayed immediately so the lobby -> match view hand-off never
   * misses an authoritative frame.
   */
  public subscribe(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    if (this.lastSummary) {
      try {
        handler({ type: 'room:summary', payload: this.lastSummary });
        for (const detail of this.roundDetails.values()) {
          handler({ type: 'round:detail', payload: detail });
        }
      } catch (err) {
        console.error('[PVP] Replay handler failed', err);
      }
    }
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  public onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    try {
      handler(this.status, { attempt: this.reconnectAttempt, message: this.statusMessage });
    } catch (err) {
      console.error('[PVP] Status handler failed', err);
    }
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  // --- Getters -------------------------------------------------------------

  public getStatus(): PvpConnectionStatus {
    return this.status;
  }

  public getStatusMessage(): string | undefined {
    return this.statusMessage;
  }

  public getRoomCode(): string | undefined {
    return this.roomCode;
  }

  public getLastSummary(): PvpRoomSummary | null {
    return this.lastSummary;
  }

  public getRoundDetail(roundIndex: number): RoundDetail | undefined {
    return this.roundDetails.get(roundIndex);
  }

  /** Asks the server for a round's detail and marks it as the round we are watching. */
  public requestRound(roundIndex: number): void {
    this.send({ type: 'round:request', payload: { roundIndex } });
  }

  public getReconnectAttempt(): number {
    return this.reconnectAttempt;
  }

  public isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  public setRoomCode(roomCode?: string): void {
    this.roomCode = roomCode ? roomCode.toUpperCase().trim() : undefined;
  }

  // --- Lifecycle -----------------------------------------------------------

  /** Start (or restart) the connection. Clears any previous terminal state. */
  public connect(roomCode?: string): void {
    if (roomCode) this.setRoomCode(roomCode);
    this.manuallyClosed = false;
    this.statusMessage = undefined;
    if (this.status === 'fatal') {
      this.status = 'idle';
    }
    this.bindReactivate();
    this.openSocket();
  }

  /** User explicitly left the match/room: stop reconnecting. */
  public close(): void {
    this.manuallyClosed = true;
    this.stopReconnectTimer();
    this.stopHeartbeat();
    this.unbindReactivate();
    const socket = this.ws;
    this.ws = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      try {
        socket.close();
      } catch {}
    }
    this.setStatus('closed');
  }

  /**
   * Returns true when the message was handed to an OPEN socket. When the socket is
   * down the message is kept and flushed as soon as the connection re-opens, and
   * `false` is returned so the caller can keep the user's text on screen instead of
   * silently losing it (the bug reported for room Q7JZPT). Server-side segment
   * submission is idempotent, so a replay after reconnect is always safe.
   */
  public send(message: object): boolean {
    if (this.manuallyClosed || this.status === 'fatal') return false;

    const data = JSON.stringify(message);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(data);
        return true;
      } catch (err) {
        console.error('[PVP] Failed to send message, queueing for retry', err);
      }
    }

    this.pendingSends.push(data);
    if (this.pendingSends.length > 20) {
      this.pendingSends.shift();
    }
    // Make sure a connection attempt is on its way so the queued message lands.
    if (this.status !== 'connecting') this.scheduleReconnect();
    return false;
  }

  // --- Internals -----------------------------------------------------------

  private openSocket(): void {
    if (this.manuallyClosed || this.status === 'fatal') return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const token = getAuthToken();
    if (!token) {
      this.statusMessage = '登录已过期，请重新登录';
      this.setStatus('fatal');
      return;
    }

    this.setStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}&playerId=${encodeURIComponent(
      this.playerId
    )}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      console.error('[PVP] Failed to create websocket', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.reconnectAttempt = 0;
      this.statusMessage = undefined;
      this.setStatus('open');
      this.startHeartbeat();
      if (this.roomCode) {
        console.log(`[PVP] (Re)connected, requesting authoritative room state for ${this.roomCode}`);
        socket.send(JSON.stringify({ type: 'room:reconnect', payload: { roomCode: this.roomCode } }));
      }
      this.flushPending();
    };

    socket.onmessage = (event: MessageEvent) => {
      let msg: PvpServerMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg?.type === 'room:summary' && msg.payload) {
        this.lastSummary = msg.payload as PvpRoomSummary;
      }
      if (msg?.type === 'round:detail' && msg.payload) {
        const detail = msg.payload as RoundDetail;
        this.roundDetails.set(detail.roundIndex, detail);
      }

      if (msg?.type === 'error' && msg.payload?.code === 'ROOM_NOT_FOUND') {
        this.statusMessage = msg.payload?.message || '对战已结束或房间已失效';
      }

      this.emit(msg);

      if (this.statusMessage && msg?.type === 'error' && msg.payload?.code === 'ROOM_NOT_FOUND') {
        this.stopReconnectTimer();
        this.setStatus('fatal');
      }
    };

    socket.onerror = () => {
      // A close event always follows; reconnect is handled there.
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.ws === socket) this.ws = null;
      this.stopHeartbeat();

      if (this.manuallyClosed) {
        this.setStatus('closed');
        return;
      }
      if (event?.code === 4001) {
        this.statusMessage = '登录已过期，请重新登录';
        this.setStatus('fatal');
        return;
      }
      if (this.status === 'fatal') return;

      console.warn(`[PVP] Socket closed (code=${event?.code}); scheduling reconnect`);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.status === 'fatal') return;
    if (this.reconnectTimer) return;

    // Background tabs get their sockets frozen by mobile OSes; wait until visible.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      this.setStatus('reconnecting', { attempt: this.reconnectAttempt, message: '页面已切到后台，返回后自动重连' });
      return;
    }

    const delay = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.setStatus('reconnecting', {
      attempt: this.reconnectAttempt,
      message: `连接已断开，正在自动重连（第 ${this.reconnectAttempt} 次）…`,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private flushPending(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const queued = this.pendingSends;
    this.pendingSends = [];
    for (const data of queued) {
      try {
        this.ws.send(data);
      } catch (err) {
        console.error('[PVP] Failed to flush queued message', err);
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        } catch {}
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleReactivate = (): void => {
    if (this.manuallyClosed || this.status === 'fatal') return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (this.isOpen()) return;
    this.stopReconnectTimer();
    this.openSocket();
  };

  private bindReactivate(): void {
    if (this.reactivateBound || typeof window === 'undefined') return;
    document.addEventListener('visibilitychange', this.handleReactivate);
    window.addEventListener('online', this.handleReactivate);
    this.reactivateBound = true;
  }

  private unbindReactivate(): void {
    if (!this.reactivateBound || typeof window === 'undefined') return;
    document.removeEventListener('visibilitychange', this.handleReactivate);
    window.removeEventListener('online', this.handleReactivate);
    this.reactivateBound = false;
  }

  private emit(msg: PvpServerMessage): void {
    for (const handler of Array.from(this.messageHandlers)) {
      try {
        handler(msg);
      } catch (err) {
        console.error('[PVP] Message handler failed', err);
      }
    }
  }

  private setStatus(status: PvpConnectionStatus, detail?: PvpStatusDetail): void {
    this.status = status;
    if (status === 'closed' || status === 'fatal') {
      this.pendingSends = [];
    }
    if (detail?.message !== undefined) {
      this.statusMessage = detail.message;
    }
    const payload: PvpStatusDetail = {
      attempt: detail?.attempt ?? this.reconnectAttempt,
      message: this.statusMessage,
    };
    for (const handler of Array.from(this.statusHandlers)) {
      try {
        handler(status, payload);
      } catch (err) {
        console.error('[PVP] Status handler failed', err);
      }
    }
  }
}
