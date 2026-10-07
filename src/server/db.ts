import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { HistorySessionRecord } from '../shared/types.js';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  password_salt: string;
  nickname: string;
  created_at: number;
  last_login_at: number;
}

export interface HistoryRow {
  id: string;
  user_id: string;
  type: 'solo' | 'pvp';
  year: number;
  timestamp: number;
  total_score: number;
  time_spent_seconds: number;
  submissions_json: string;
  pvp_details_json: string | null;
  round_count: number | null;
  match_points: number | null;
  went_overtime: number | null;
  rounds_json: string | null;
}

export interface MatchSnapshotRow {
  room_code: string;
  payload_json: string;
  updated_at: number;
}

class AppDatabase {
  private db: DatabaseSync;

  constructor() {
    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = path.join(dataDir, 'app.db');
    this.db = new DatabaseSync(dbPath);

    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        nickname TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS history_records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        year INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        total_score REAL NOT NULL,
        time_spent_seconds INTEGER NOT NULL,
        submissions_json TEXT NOT NULL,
        pvp_details_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_history_user_time ON history_records (user_id, timestamp DESC);

      CREATE TABLE IF NOT EXISTS match_snapshots (
        room_code TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.migrateSchema();
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` never adds columns to an existing database, so every
   * schema addition has to be applied by hand. Each step is idempotent.
   */
  private migrateSchema() {
    const columns = this.db.prepare(`PRAGMA table_info(history_records)`).all() as unknown as Array<{
      name: string;
    }>;
    const existing = new Set(columns.map((c) => c.name));

    const additions: Array<[string, string]> = [
      ['round_count', 'INTEGER NOT NULL DEFAULT 1'],
      ['match_points', 'REAL NOT NULL DEFAULT 0'],
      ['went_overtime', 'INTEGER NOT NULL DEFAULT 0'],
      ['rounds_json', 'TEXT'],
    ];

    for (const [name, ddl] of additions) {
      if (existing.has(name)) continue;
      this.db.exec(`ALTER TABLE history_records ADD COLUMN ${name} ${ddl}`);
      console.log(`[DB] Migrated history_records: added column ${name}`);
    }
  }

  // --- Users Operations ---
  public createUser(user: {
    id: string;
    username: string;
    passwordHash: string;
    passwordSalt: string;
    nickname: string;
  }): UserRow {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO users (id, username, password_hash, password_salt, nickname, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      user.id,
      user.username.toLowerCase().trim(),
      user.passwordHash,
      user.passwordSalt,
      user.nickname.trim(),
      now,
      now
    );

    return {
      id: user.id,
      username: user.username.toLowerCase().trim(),
      password_hash: user.passwordHash,
      password_salt: user.passwordSalt,
      nickname: user.nickname.trim(),
      created_at: now,
      last_login_at: now,
    };
  }

  public getUserByUsername(username: string): UserRow | null {
    const stmt = this.db.prepare(`
      SELECT * FROM users WHERE username = ?
    `);
    const row = stmt.get(username.toLowerCase().trim()) as unknown as UserRow | undefined;
    return row || null;
  }

  public getUserById(id: string): UserRow | null {
    const stmt = this.db.prepare(`
      SELECT * FROM users WHERE id = ?
    `);
    const row = stmt.get(id) as unknown as UserRow | undefined;
    return row || null;
  }

  public updateLastLogin(userId: string) {
    const stmt = this.db.prepare(`
      UPDATE users SET last_login_at = ? WHERE id = ?
    `);
    stmt.run(Date.now(), userId);
  }

  public updateNickname(userId: string, nickname: string) {
    const stmt = this.db.prepare(`
      UPDATE users SET nickname = ? WHERE id = ?
    `);
    stmt.run(nickname.trim(), userId);
  }

  // --- History Records Operations ---
  public saveHistoryRecord(userId: string, record: HistorySessionRecord): void {
    const submissionsJson = JSON.stringify(record.submissions || []);
    const pvpDetailsJson = record.pvpDetails ? JSON.stringify(record.pvpDetails) : null;
    const roundsJson = record.rounds ? JSON.stringify(record.rounds) : null;
    const roundCount = record.roundCount ?? 1;
    const matchPoints = record.matchPoints ?? 0;
    const wentOvertime = record.wentOvertime ? 1 : 0;
    const now = record.timestamp || Date.now();

    // The record id is deterministic on BOTH sides (client and server derive the same
    // `pvp-<room>-<startedAt>-<playerId>`), so a plain id lookup is the correct
    // idempotency key. The old ±120s window merged genuinely distinct sessions.
    const dupCheckStmt = this.db.prepare(`
      SELECT id FROM history_records WHERE user_id = ? AND id = ? LIMIT 1
    `);
    const existing = dupCheckStmt.get(userId, record.id) as { id: string } | undefined;
    const targetId = existing?.id || record.id;

    const stmt = this.db.prepare(`
      INSERT INTO history_records (
        id, user_id, type, year, timestamp, total_score, time_spent_seconds,
        submissions_json, pvp_details_json, round_count, match_points, went_overtime, rounds_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        total_score = excluded.total_score,
        submissions_json = excluded.submissions_json,
        pvp_details_json = excluded.pvp_details_json,
        round_count = excluded.round_count,
        match_points = excluded.match_points,
        went_overtime = excluded.went_overtime,
        rounds_json = excluded.rounds_json
    `);

    stmt.run(
      targetId,
      userId,
      record.type,
      record.year,
      now,
      record.totalScore,
      record.timeSpentSeconds || 0,
      submissionsJson,
      pvpDetailsJson,
      roundCount,
      matchPoints,
      wentOvertime,
      roundsJson
    );
  }

  public getUserHistory(userId: string, limit = 50): HistorySessionRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM history_records
      WHERE user_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const rows = stmt.all(userId, limit) as unknown as HistoryRow[];
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      year: r.year,
      timestamp: r.timestamp,
      totalScore: r.total_score,
      timeSpentSeconds: r.time_spent_seconds,
      submissions: JSON.parse(r.submissions_json || '[]'),
      pvpDetails: r.pvp_details_json ? JSON.parse(r.pvp_details_json) : undefined,
      roundCount: r.round_count ?? 1,
      matchPoints: r.match_points ?? 0,
      wentOvertime: r.went_overtime === 1,
      rounds: r.rounds_json ? JSON.parse(r.rounds_json) : undefined,
    }));
  }

  /**
   * Every exam year each user has already played, unioned across solo, PVP and every
   * round of a multi-round series. Used only for the overtime paper draw.
   */
  public getPlayedYears(userIds: string[]): Map<string, Set<number>> {
    const result = new Map<string, Set<number>>();
    for (const id of userIds) result.set(id, new Set<number>());
    if (userIds.length === 0) return result;

    const placeholders = userIds.map(() => '?').join(',');
    const stmt = this.db.prepare(
      `SELECT user_id, year, rounds_json FROM history_records WHERE user_id IN (${placeholders})`
    );
    const rows = stmt.all(...userIds) as unknown as Array<{
      user_id: string;
      year: number;
      rounds_json: string | null;
    }>;

    for (const row of rows) {
      const set = result.get(row.user_id);
      if (!set) continue;
      if (typeof row.year === 'number') set.add(row.year);
      if (row.rounds_json) {
        try {
          const rounds = JSON.parse(row.rounds_json) as Array<{ year?: number }>;
          for (const r of rounds) {
            if (typeof r?.year === 'number') set.add(r.year);
          }
        } catch {
          /* ignore malformed round payloads */
        }
      }
    }
    return result;
  }

  // --- Long-match snapshots (only written for series longer than 90 minutes) ---

  public saveMatchSnapshot(roomCode: string, payloadJson: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO match_snapshots (room_code, payload_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(room_code) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(roomCode, payloadJson, Date.now());
  }

  public loadMatchSnapshots(): MatchSnapshotRow[] {
    const stmt = this.db.prepare(`SELECT * FROM match_snapshots`);
    return stmt.all() as unknown as MatchSnapshotRow[];
  }

  public deleteMatchSnapshot(roomCode: string): void {
    const stmt = this.db.prepare(`DELETE FROM match_snapshots WHERE room_code = ?`);
    stmt.run(roomCode);
  }

  public clearUserHistory(userId: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM history_records WHERE user_id = ?
    `);
    stmt.run(userId);
  }
}

export const db = new AppDatabase();
