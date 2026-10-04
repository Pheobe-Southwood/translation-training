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
    `);
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
    const now = record.timestamp || Date.now();

    // Defense-in-depth: Check for duplicate submissions within a short window (e.g. 60s)
    // to prevent duplicate inserts even if client generated a slightly different id.
    const dupCheckStmt = this.db.prepare(`
      SELECT id FROM history_records
      WHERE user_id = ? AND type = ? AND year = ? AND submissions_json = ? AND abs(timestamp - ?) < 60000
      LIMIT 1
    `);
    const existing = dupCheckStmt.get(userId, record.type, record.year, submissionsJson, now) as { id: string } | undefined;

    const targetId = existing?.id || record.id;

    const stmt = this.db.prepare(`
      INSERT INTO history_records (
        id, user_id, type, year, timestamp, total_score, time_spent_seconds, submissions_json, pvp_details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        total_score = excluded.total_score,
        submissions_json = excluded.submissions_json,
        pvp_details_json = excluded.pvp_details_json
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
      pvpDetailsJson
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
    }));
  }

  public clearUserHistory(userId: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM history_records WHERE user_id = ?
    `);
    stmt.run(userId);
  }
}

export const db = new AppDatabase();
