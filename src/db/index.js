import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DATABASE_PATH
  || path.join(process.cwd(), 'data', 'periphery.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** Apply the schema. Idempotent — safe to run on every boot and on deploy. */
export function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  // Columns added after a database was first created. CREATE TABLE IF NOT EXISTS
  // silently leaves an existing table alone, so new columns need adding by hand.
  addColumn('sources', 'exclude_pattern', 'TEXT');

  // Ensure the singleton profile row exists.
  const existing = db.prepare('SELECT id FROM research_profile WHERE id = 1').get();
  if (!existing) {
    db.prepare(
      `INSERT INTO research_profile (id, display_name, statement)
       VALUES (1, ?, ?)`
    ).run('Reader', '');
  }
  return DB_PATH;
}

// Applied at module load. The schema is idempotent, and several modules prepare
// statements at import time — without this, a fresh database would crash on boot
// before server.js ever got the chance to migrate it.
migrate();

function addColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function profile() {
  return db.prepare('SELECT * FROM research_profile WHERE id = 1').get();
}

export function interests({ kind = null, activeOnly = true } = {}) {
  let sql = 'SELECT * FROM research_interests WHERE 1=1';
  const args = [];
  if (kind) { sql += ' AND kind = ?'; args.push(kind); }
  if (activeOnly) {
    sql += " AND active = 1 AND (expires_on IS NULL OR expires_on >= date('now'))";
  }
  sql += ' ORDER BY kind, weight DESC, value';
  return db.prepare(sql).all(...args);
}

export const DB_FILE = DB_PATH;
export default db;
