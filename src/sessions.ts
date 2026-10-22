/**
 * Derived full-text index over pi's own session transcripts.
 *
 * pi-memory's fact store remembers what was LEARNED. This remembers what was
 * DONE — "which session did I set up the gateway in", "where did we decide to
 * drop the Effect dependency".
 *
 * The index is disposable: it is a pure function of the `.jsonl` files under
 * `~/.pi/agent/sessions`, so deleting it costs only a rebuild, and a file whose
 * (size, mtime) is unchanged is never re-read. That is the discipline dsh's
 * session-query backend applies — separate database, incremental by file,
 * reinsert-whole-file on change — and it is why the index never needs its own
 * repair path.
 *
 * `shortcut: the trigram tokenizer needs 3 characters per term, so a 2-character
 * query returns nothing. Upgrade to a segmenter table if 2-char CJK search
 * turns out to matter.`
 */
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { containsCjk } from "./store.js";

const _require = createRequire(import.meta.url);
const isBun = typeof (globalThis as any).Bun !== "undefined";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DatabaseSync: new (path: string) => any = isBun
  ? _require("bun:sqlite").Database
  : _require("node:sqlite").DatabaseSync;

export interface SessionHit {
  sessionId: string;
  role: string;
  ts: string;
  /** Matched text with the query terms marked by »…«. */
  snippet: string;
}

export interface SessionMessage {
  role: string;
  ts: string;
  text: string;
}

/** A single transcript line longer than this is truncated before indexing. */
const MAX_DOC_CHARS = 8000;

/** Bytes of transcript read per `sync` call; the rest is picked up next time. */
const DEFAULT_SYNC_BYTES = 32 * 1024 * 1024;
/**
 * Directory pi stores a cwd's sessions in.
 *
 * Mirrors pi's own encoding (`--<cwd without leading slash>--`, separators and
 * `:` replaced by `-`). Duplicated rather than imported because pi does not
 * export the helper; if the encoding ever changes, this returns a missing
 * directory and session search simply finds nothing, which is a silent but
 * harmless failure.
 */
export function sessionDirFor(sessionsRoot: string, cwd: string): string {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(sessionsRoot, safe);
}

export class SessionIndex {
  private db: InstanceType<typeof DatabaseSync>;
  private hasFTS5 = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    try {
      // Trigram, not the default tokenizer: `unicode61` treats a run
      // of CJK as one token, which makes Chinese transcripts unsearchable.
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
          text,
          session_id UNINDEXED,
          seq UNINDEXED,
          role UNINDEXED,
          ts UNINDEXED,
          tokenize = 'trigram'
        );
      `);
      this.hasFTS5 = true;
    } catch {
      // No FTS5 (or no trigram) in this SQLite build: session search is off,
      // everything else keeps working.
      this.hasFTS5 = false;
    }
  }

  /**
   * Bring the index up to date for one working directory.
   *
   * Only this cwd's transcripts are indexed — the same exact-match scoping the
   * tools use, so a session from another project can never surface here. Files
   * are visited newest-first and the byte budget is per call, so the first
   * search in a large project returns partial results instead of blocking.
   */
  sync(sessionsRoot: string, cwd: string, maxBytes: number = DEFAULT_SYNC_BYTES): { indexed: number; stale: number } {
    if (!this.hasFTS5) return { indexed: 0, stale: 0 };

    const dir = sessionDirFor(sessionsRoot, cwd);
    let names: string[];
    try {
      names = readdirSync(dir).filter(name => name.endsWith(".jsonl"));
    } catch {
      return { indexed: 0, stale: 0 };
    }

    const files = names
      .map(name => {
        const path = join(dir, name);
        try {
          const st = statSync(path);
          return { path, size: st.size, mtime: Math.floor(st.mtimeMs) };
        } catch {
          return null;
        }
      })
      .filter((f): f is { path: string; size: number; mtime: number } => f !== null)
      .sort((a, b) => b.mtime - a.mtime);

    const seen = new Set(files.map(f => f.path));
    let budget = maxBytes;
    let indexed = 0;

    for (const file of files) {
      const row = this.db.prepare("SELECT size, mtime FROM files WHERE path = ?").get(file.path) as
        | { size: number; mtime: number }
        | undefined;
      if (row && row.size === file.size && row.mtime === file.mtime) continue;
      // Always make progress: a file larger than the whole budget would
      // otherwise be skipped on every call and stay stale forever.
      if (file.size > budget && indexed > 0) continue;
      budget -= file.size;
      this.indexFile(file.path, file.size, file.mtime);
      indexed++;
    }

    // Files deleted on disk must stop answering queries.
    const known = this.db.prepare("SELECT path, session_id FROM files").all() as Array<{ path: string; session_id: string }>;
    for (const row of known) {
      if (seen.has(row.path)) continue;
      if (!row.path.startsWith(dir)) continue; // another cwd's rows are not ours to prune
      this.db.prepare("DELETE FROM files WHERE path = ?").run(row.path);
      this.db.prepare("DELETE FROM docs WHERE session_id = ?").run(row.session_id);
    }

    let stale = 0;
    for (const file of files) {
      const row = this.db.prepare("SELECT size, mtime FROM files WHERE path = ?").get(file.path) as
        | { size: number; mtime: number }
        | undefined;
      if (!row || row.size !== file.size || row.mtime !== file.mtime) stale++;
    }

    return { indexed, stale };
  }

  private indexFile(path: string, size: number, mtime: number): void {
    const base = path.split("/").pop() ?? path;
    const sessionId = base.replace(/\.jsonl$/, "").split("_").pop() ?? base;

    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return;
    }

    // Reinsert the whole file rather than diffing rows: it is the same
    // operation for an append and for a rewrite, and a rewrite is what happens
    // when a session is compacted or forked.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM docs WHERE session_id = ?").run(sessionId);
      const insert = this.db.prepare(
        "INSERT INTO docs (text, session_id, seq, role, ts) VALUES (?, ?, ?, ?, ?)"
      );

      let seq = 0;
      for (const line of raw.split("\n")) {
        if (!line) continue;
        // Cheap prefix test before JSON.parse: transcripts are mostly tool
        // output, and only message records are worth parsing.
        if (!line.startsWith('{"type":"message"')) continue;
        try {
          const record = JSON.parse(line) as { message?: { role?: string; content?: unknown }; timestamp?: string };
          const role = record.message?.role;
          if (role !== "user" && role !== "assistant") continue;
          const text = messageText(record.message?.content);
          if (!text) continue;
          insert.run(
            text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text,
            sessionId,
            seq++,
            role,
            record.timestamp ?? "",
          );
        } catch {
          // A torn line is not worth failing the whole file over.
        }
      }

      this.db.prepare(
        `INSERT INTO files (path, size, mtime, session_id, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(path) DO UPDATE SET
           size = excluded.size, mtime = excluded.mtime,
           session_id = excluded.session_id, updated_at = datetime('now')`
      ).run(path, size, mtime, sessionId);

      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already gone */ }
      throw err;
    }
  }

  /** Ranked matches. Queries shorter than 3 characters per term yield nothing. */
  search(query: string, limit: number = 10): SessionHit[] {
    if (!this.hasFTS5) return [];
    const terms = trigramTerms(query);
    if (terms.length === 0) return [];

    const ftsQuery = terms.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    try {
      return this.db.prepare(`
        SELECT session_id AS sessionId, role, ts,
               snippet(docs, 0, '»', '«', '…', 14) AS snippet
        FROM docs
        WHERE docs MATCH ?
        ORDER BY bm25(docs)
        LIMIT ?
      `).all(ftsQuery, limit) as SessionHit[];
    } catch {
      return [];
    }
  }

  /** Messages of one session, oldest first. `sessionId` may be a prefix. */
  readSession(sessionId: string, limit: number = 40): SessionMessage[] {
    if (!this.hasFTS5) return [];

    // The prefix is resolved against the ordinary `files` table first: FTS5
    // will not evaluate LIKE against an UNINDEXED column (it returns nothing
    // for a row it plainly holds — `=` works, `LIKE` does not), so filtering
    // docs by prefix is not an option. An ambiguous prefix resolves to the
    // most recently written session rather than failing.
    const file = this.db.prepare(
      "SELECT session_id FROM files WHERE session_id LIKE ? || '%' ORDER BY updated_at DESC LIMIT 1"
    ).get(sessionId) as { session_id: string } | undefined;
    if (!file) return [];

    const rows = this.db.prepare(`
      SELECT role, ts, text FROM docs
      WHERE session_id = ?
      ORDER BY seq DESC
      LIMIT ?
    `).all(file.session_id, limit) as SessionMessage[];
    return rows.reverse();
  }

  stats(): { sessions: number; docs: number } {
    const sessions = (this.db.prepare("SELECT COUNT(*) AS c FROM files").get() as { c: number }).c;
    const docs = this.hasFTS5
      ? (this.db.prepare("SELECT COUNT(*) AS c FROM docs").get() as { c: number }).c
      : 0;
    return { sessions, docs };
  }

  close(): void {
    this.db.close();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Text of a message, ignoring thinking blocks and tool payloads. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as any).type === "text") {
      const text = (block as any).text;
      if (typeof text === "string" && text.trim()) parts.push(text.trim());
    }
  }
  return parts.join("\n");
}

/**
 * Terms the trigram tokenizer can match.
 *
 * A latin word is passed through whole — FTS5 turns it into trigram phrases
 * itself, which keeps `gateway` from matching `always`. A CJK run has no word
 * boundaries to preserve, so it contributes every 3-character window. Anything
 * shorter than 3 characters is dropped rather than silently matching everything.
 */
export function trigramTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const word of query.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    const chars = Array.from(word);
    if (chars.length < 3) continue;
    if (!containsCjk(word)) {
      terms.add(word);
      continue;
    }
    for (let i = 0; i + 3 <= chars.length; i++) {
      terms.add(chars.slice(i, i + 3).join(""));
    }
  }
  return [...terms];
}
