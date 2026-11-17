import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { HistorySessionRecord, TranslationDirection } from '../shared/types.js';
import { normalizeDirection } from '../shared/direction.js';
import { describeExamId } from './examService.js';

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
  /** Canonical paper id (backfilled to `${year}-translation` for legacy rows). */
  exam_id: string | null;
  direction: TranslationDirection;
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
        last_login_at INTEGER NOT NULL,
        terms_version TEXT,
        terms_accepted_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS history_records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        year INTEGER NOT NULL,
        exam_id TEXT,
        direction TEXT NOT NULL DEFAULT 'en-zh',
        timestamp INTEGER NOT NULL,
        total_score REAL NOT NULL,
        time_spent_seconds INTEGER NOT NULL,
        submissions_json TEXT NOT NULL,
        pvp_details_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_history_user_time ON history_records (user_id, timestamp DESC);
    `);

    // Additive migration: recorded consent to the user agreement / privacy policy.
    const userColumns = this.db.prepare('PRAGMA table_info(users)').all() as Array<{
      name?: string;
    }>;
    if (!userColumns.some((column) => column.name === 'terms_version')) {
      this.db.exec('ALTER TABLE users ADD COLUMN terms_version TEXT');
      this.db.exec('ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER');
      console.log('[db] Added users.terms_version / terms_accepted_at');
    }

    // Additive migration for databases created before the direction column.
    const columns = this.db.prepare('PRAGMA table_info(history_records)').all() as Array<{
      name?: string;
    }>;
    if (!columns.some((column) => column.name === 'direction')) {
      this.db.exec(
        "ALTER TABLE history_records ADD COLUMN direction TEXT NOT NULL DEFAULT 'en-zh'"
      );
      console.log('[db] Added history_records.direction (default en-zh)');
    }

    // Additive migration for databases created before examId (`year` alone stopped
    // being unique once several banks share a year). Idempotent: the ALTER only
    // runs when the column is missing, the backfill only touches NULL/blank rows.
    if (!columns.some((column) => column.name === 'exam_id')) {
      this.db.exec('ALTER TABLE history_records ADD COLUMN exam_id TEXT');
      console.log('[db] Added history_records.exam_id');
    }
    const backfill = this.db
      .prepare(
        "UPDATE history_records SET exam_id = CAST(year AS TEXT) || '-translation' " +
          "WHERE exam_id IS NULL OR exam_id = ''"
      )
      .run();
    const backfilled = Number(backfill.changes || 0);
    if (backfilled > 0) {
      console.log(`[db] Backfilled exam_id for ${backfilled} legacy history record(s)`);
    }
  }

  // --- Users Operations ---
  public createUser(user: {
    id: string;
    username: string;
    passwordHash: string;
    passwordSalt: string;
    nickname: string;
    termsVersion?: string;
  }): UserRow {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO users (id, username, password_hash, password_salt, nickname, created_at, last_login_at, terms_version, terms_accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      user.id,
      user.username.toLowerCase().trim(),
      user.passwordHash,
      user.passwordSalt,
      user.nickname.trim(),
      now,
      now,
      user.termsVersion || null,
      user.termsVersion ? now : null
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

  /** Irreversible account deletion; history rows cascade via the foreign key. */
  public deleteUser(userId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM users WHERE id = ?');
    const result = stmt.run(userId) as { changes?: number };
    return (result.changes || 0) > 0;
  }

  /** Everything the operator holds about one account, for a data-access request. */
  public exportUser(userId: string) {
    const user = this.getUserById(userId);
    if (!user) return null;
    return {
      profile: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        createdAt: user.created_at,
        lastLoginAt: user.last_login_at,
      },
      history: this.getUserHistory(userId, 1000),
    };
  }

  // --- History Records Operations ---
  public saveHistoryRecord(userId: string, record: HistorySessionRecord): void {
    const submissionsJson = JSON.stringify(record.submissions || []);
    const pvpDetailsJson = record.pvpDetails ? JSON.stringify(record.pvpDetails) : null;
    const now = record.timestamp || Date.now();
    const direction = normalizeDirection(record.direction);
    // Records written before examId existed (or by an old client) belong to the
    // translation bank of their year.
    const examId =
      typeof record.examId === 'string' && record.examId.trim()
        ? record.examId.trim()
        : `${record.year}-translation`;

    // Defense-in-depth: Check for duplicate/prior submissions within a window (e.g. 120s)
    // or by matching record id, to update in place and prevent duplicate inserts.
    // examId (not year) identifies the paper now that a year holds several papers.
    const dupCheckStmt = this.db.prepare(`
      SELECT id FROM history_records
      WHERE user_id = ? AND type = ? AND exam_id = ? AND direction = ?
        AND (id = ? OR abs(timestamp - ?) < 120000)
      LIMIT 1
    `);
    const existing = dupCheckStmt.get(
      userId,
      record.type,
      examId,
      direction,
      record.id,
      now
    ) as { id: string } | undefined;

    const targetId = existing?.id || record.id;

    const stmt = this.db.prepare(`
      INSERT INTO history_records (
        id, user_id, type, year, exam_id, direction, timestamp, total_score, time_spent_seconds, submissions_json, pvp_details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      examId,
      direction,
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
    return rows.map((r): HistorySessionRecord => {
      const examId = r.exam_id || `${r.year}-translation`;
      // bank/partLabel are derived from the paper catalogue so old rows (and the
      // pre-examId schema) still render a readable paper label.
      const descriptor = describeExamId(examId);
      return {
        id: r.id,
        type: r.type,
        year: r.year,
        examId,
        bank: descriptor?.bank,
        partLabel: descriptor?.partLabel,
        direction: normalizeDirection(r.direction),
        timestamp: r.timestamp,
        totalScore: r.total_score,
        timeSpentSeconds: r.time_spent_seconds,
        submissions: JSON.parse(r.submissions_json || '[]'),
        pvpDetails: r.pvp_details_json ? JSON.parse(r.pvp_details_json) : undefined,
      };
    });
  }

  public clearUserHistory(userId: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM history_records WHERE user_id = ?
    `);
    stmt.run(userId);
  }
}

export const db = new AppDatabase();
