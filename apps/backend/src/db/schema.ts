import type Database from "better-sqlite3";

export function migrate(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL DEFAULT 'file',
      file_key TEXT NOT NULL,
      line_no INTEGER NOT NULL,
      ts_ms INTEGER NOT NULL,
      raw_text TEXT NOT NULL,
      level TEXT,
      thread TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_lines_file_line ON raw_lines(file_key, line_no);
    CREATE INDEX IF NOT EXISTS idx_raw_lines_ts ON raw_lines(ts_ms);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT,
      target TEXT,
      summary TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'normal',
      confidence TEXT NOT NULL DEFAULT 'confirmed',
      raw_line_id INTEGER NOT NULL REFERENCES raw_lines(id),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts_ms);
    CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(event_type, ts_ms);
    CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor);

    CREATE TABLE IF NOT EXISTS ingest_checkpoints (
      file_key TEXT PRIMARY KEY,
      inode TEXT,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      line_no INTEGER NOT NULL DEFAULT 0,
      last_ts_ms INTEGER,
      completed INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS raw_lines_fts USING fts5(
      raw_text,
      content='raw_lines',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS raw_lines_ai AFTER INSERT ON raw_lines BEGIN
      INSERT INTO raw_lines_fts(rowid, raw_text) VALUES (new.id, new.raw_text);
    END;
  `);
}
