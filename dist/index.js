// src/index.ts
import { Type } from "typebox";
import { join as join2, resolve, dirname as dirname3 } from "node:path";
import { homedir } from "node:os";
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { fileURLToPath } from "node:url";

// src/store.ts
import { createRequire } from "node:module";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// src/vector.ts
function cosine(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
function fromBlob(b) {
  if (!b || b.byteLength === 0 || b.byteLength % 4 !== 0) return null;
  if (b.byteOffset % 4 === 0) {
    return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  }
  const copy = Uint8Array.prototype.slice.call(b);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

// src/store.ts
var _require = createRequire(import.meta.url);
var isBun = typeof globalThis.Bun !== "undefined";
var DatabaseSync = isBun ? _require("bun:sqlite").Database : _require("node:sqlite").DatabaseSync;
var MemoryStore = class {
  db;
  writeLock = Promise.resolve();
  hasFTS5 = false;
  // Non-zero while a transaction is open, so nested calls join it instead of
  // starting a second BEGIN (which SQLite rejects).
  txDepth = 0;
  constructor(dbPath) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA wal_autocheckpoint = 128");
    this.db.exec("PRAGMA journal_size_limit = 1048576");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        source TEXT NOT NULL DEFAULT 'consolidation',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY,
        rule TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        source TEXT NOT NULL DEFAULT 'consolidation',
        negative INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Durable outbox for session-end consolidation. The session path only
      -- appends here (one commit); the LLM call happens later, off the
      -- interaction path.
      CREATE TABLE IF NOT EXISTS pending_consolidation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        user_count INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        claimed_at TEXT
      );
    `);
    for (const column of [
      "session_id TEXT",
      "user_count INTEGER NOT NULL DEFAULT 0",
      "attempts INTEGER NOT NULL DEFAULT 0"
    ]) {
      try {
        this.db.exec(`ALTER TABLE pending_consolidation ADD COLUMN ${column}`);
      } catch {
      }
    }
    this.db.exec(`DROP INDEX IF EXISTS pending_session`);
    try {
      this.db.exec(`ALTER TABLE semantic ADD COLUMN last_accessed TEXT`);
    } catch {
    }
    try {
      this.db.exec(`ALTER TABLE semantic ADD COLUMN session_id TEXT`);
    } catch {
    }
    try {
      this.db.exec(`ALTER TABLE lessons ADD COLUMN project TEXT`);
    } catch {
    }
    try {
      this.db.exec(`ALTER TABLE semantic ADD COLUMN embedding BLOB`);
    } catch {
    }
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(key, value, content='semantic', content_rowid='rowid');

        CREATE TRIGGER IF NOT EXISTS semantic_ai AFTER INSERT ON semantic BEGIN
          INSERT INTO semantic_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
        END;
        CREATE TRIGGER IF NOT EXISTS semantic_ad AFTER DELETE ON semantic BEGIN
          INSERT INTO semantic_fts(semantic_fts, rowid, key, value) VALUES('delete', old.rowid, old.key, old.value);
        END;
        CREATE TRIGGER IF NOT EXISTS semantic_au AFTER UPDATE ON semantic BEGIN
          INSERT INTO semantic_fts(semantic_fts, rowid, key, value) VALUES('delete', old.rowid, old.key, old.value);
          INSERT INTO semantic_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
        END;
      `);
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(rule, category, content='lessons', content_rowid='rowid');

        CREATE TRIGGER IF NOT EXISTS lessons_fts_ai AFTER INSERT ON lessons BEGIN
          INSERT INTO lessons_fts(rowid, rule, category) VALUES (new.rowid, new.rule, new.category);
        END;
        CREATE TRIGGER IF NOT EXISTS lessons_fts_ad AFTER DELETE ON lessons BEGIN
          INSERT INTO lessons_fts(lessons_fts, rowid, rule, category) VALUES('delete', old.rowid, old.rule, old.category);
        END;
        CREATE TRIGGER IF NOT EXISTS lessons_fts_au AFTER UPDATE ON lessons BEGIN
          INSERT INTO lessons_fts(lessons_fts, rowid, rule, category) VALUES('delete', old.rowid, old.rule, old.category);
          INSERT INTO lessons_fts(rowid, rule, category) VALUES (new.rowid, new.rule, new.category);
        END;
      `);
      let ftsInSync = false;
      try {
        const guard = this.db.prepare(
          `SELECT (SELECT COUNT(*) FROM semantic) = (SELECT COUNT(*) FROM semantic_fts_docsize)
                AND (SELECT COUNT(*) FROM lessons) = (SELECT COUNT(*) FROM lessons_fts_docsize) AS ok`
        ).get();
        ftsInSync = !!guard && guard.ok === 1;
      } catch {
        ftsInSync = false;
      }
      if (!ftsInSync) {
        this.db.exec("BEGIN");
        try {
          this.db.exec(`INSERT INTO semantic_fts(semantic_fts) VALUES('rebuild')`);
          this.db.exec(`INSERT INTO lessons_fts(lessons_fts) VALUES('rebuild')`);
          this.db.exec("COMMIT");
        } catch (err) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
          }
          throw err;
        }
      }
      this.hasFTS5 = true;
    } catch {
      this.hasFTS5 = false;
    }
  }
  /**
   * Serialize async callers so concurrent read-modify-write cycles
   * (e.g. two consolidation calls) don't clobber each other.
   *
   * Re-entrant: a `transaction()` block may call methods that take the lock
   * themselves, which is how writing facts and dropping their queue job stay
   * atomic without every caller knowing about the outer transaction.
   */
  withLock(fn) {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }
  /** Run several operations atomically (e.g. write facts and drop their job). */
  transaction(fn) {
    return this.withLock(fn);
  }
  // ─── Semantic ────────────────────────────────────────────────────
  getSemantic(key) {
    const normalized = key.toLowerCase();
    return this.db.prepare("SELECT * FROM semantic WHERE key = ?").get(normalized);
  }
  setSemantic(key, value, confidence = 0.8, source = "consolidation", sessionId) {
    const normalized = key.toLowerCase();
    this.withLock(() => {
      const existing = this.db.prepare("SELECT * FROM semantic WHERE key = ?").get(normalized);
      if (existing && existing.confidence > confidence) return;
      this.db.prepare(`
        INSERT INTO semantic (key, value, confidence, source, session_id, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          confidence = excluded.confidence,
          source = excluded.source,
          session_id = COALESCE(excluded.session_id, semantic.session_id),
          -- A changed value invalidates its vector: an embedding of the old
          -- text would keep ranking this fact for queries it no longer
          -- answers. NULL makes the backfill re-embed it.
          embedding = CASE WHEN excluded.value = semantic.value THEN semantic.embedding ELSE NULL END,
          updated_at = datetime('now')
      `).run(normalized, value, confidence, source, sessionId ?? null);
      this.logEvent(existing ? "update" : "create", "semantic", normalized);
    });
  }
  deleteSemantic(key) {
    const normalized = key.toLowerCase();
    return this.withLock(() => {
      const result = this.db.prepare("DELETE FROM semantic WHERE key = ?").run(normalized);
      if (result.changes > 0) this.logEvent("delete", "semantic", normalized);
      return result.changes > 0;
    });
  }
  /**
   * Store a pre-computed embedding for a key.
   * Converts Float32Array → Buffer for SQLite BLOB storage.
   */
  setEmbedding(key, embedding) {
    const normalized = key.toLowerCase();
    const blob = Buffer.from(new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength));
    this.db.prepare("UPDATE semantic SET embedding = ? WHERE key = ?").run(blob, normalized);
  }
  /**
   * Return all semantic keys with their raw embedding BLOBs.
   * Used for in-memory cosine similarity at query time.
   * Entries without an embedding have embedding = null.
   */
  getAllEmbeddings() {
    return this.db.prepare("SELECT key, embedding FROM semantic ORDER BY updated_at DESC").all();
  }
  /**
   * Rank stored entries by cosine similarity against a query vector.
   *
   * Entries without an embedding are skipped rather than scored 0, so a
   * partially-embedded store -- the normal case, since embeddings are written
   * lazily as facts arrive -- does not drag un-embedded entries below lexical
   * results they would have won on merit.
   *
   * `minScore` drops weak matches, so RRF is not handed noise to reward for
   * being "found by two paths".
   *
   * The default is calibrated against amazon.titan-embed-text-v2:0 at 512
   * dimensions, measured rather than assumed:
   *
   *   paraphrases of a stored fact   0.219 - 0.248
   *   loosely related text           0.235
   *   unrelated text                -0.025 - 0.082
   *
   * Titan's usable range is much narrower than raw cosine suggests, so 0.15
   * sits mid-gap with roughly equal margin on both sides. A higher-contrast
   * model may want a higher floor; pass `minScore` explicitly if you change
   * providers.
   */
  searchSemanticByVector(queryVector, limit = 10, minScore = 0.15) {
    const scored = [];
    for (const row of this.getAllEmbeddings()) {
      const vec = fromBlob(row.embedding);
      if (!vec) continue;
      const score = cosine(queryVector, vec);
      if (score >= minScore) scored.push({ key: row.key, score });
    }
    if (scored.length === 0) return [];
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    const placeholders = top.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM semantic WHERE key IN (${placeholders})`).all(...top.map((t) => t.key));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return top.map((t) => byKey.get(t.key)).filter((r) => r !== void 0);
  }
  /** How much of the store is embedded. Surfaced by memory_stats. */
  embeddingCoverage() {
    const rows = this.getAllEmbeddings();
    return {
      embedded: rows.filter((r) => fromBlob(r.embedding) !== null).length,
      total: rows.length
    };
  }
  /**
   * Entries needing an embedding: absent, unreadable, or -- when `dimensions`
   * is given -- the wrong width.
   *
   * The width check matters for stores written before #31: that backend used
   * 384-dim MiniLM vectors, while a Bedrock Titan config produces 512. Since
   * cosine() returns 0 for mismatched lengths, a stale-width vector is not
   * merely useless, it is invisible -- and without this check it would never be
   * replaced, because the column is non-null.
   */
  entriesNeedingEmbedding(dimensions, limit = 500) {
    const stale = [];
    for (const row of this.getAllEmbeddings()) {
      const vec = fromBlob(row.embedding);
      if (vec === null || dimensions !== void 0 && vec.length !== dimensions) {
        stale.push(row.key);
        if (stale.length >= limit) break;
      }
    }
    if (stale.length === 0) return [];
    const placeholders = stale.map(() => "?").join(",");
    return this.db.prepare(`SELECT key, value FROM semantic WHERE key IN (${placeholders})`).all(...stale);
  }
  listSemantic(prefix, limit = 100) {
    if (prefix) {
      return this.db.prepare("SELECT * FROM semantic WHERE key LIKE ? ORDER BY updated_at DESC LIMIT ?").all(`${prefix}%`, limit);
    }
    return this.db.prepare("SELECT * FROM semantic ORDER BY updated_at DESC LIMIT ?").all(limit);
  }
  /**
   * Search facts by relevance to a query.
   *
   * Two paths, chosen by the query's script:
   *
   * - Latin queries use FTS5 BM25.
   * - Queries containing CJK use substring scoring over the fact table. FTS5
   *   ships no CJK segmenter, so a run of Chinese characters is indexed as ONE
   *   token: `术语` matches 0 rows in a store whose value contains it, and no
   *   phrase query recovers an interior substring. Substring scoring is the
   *   only option that needs no segmentation dependency, and the table is
   *   small enough (thousands of rows at most) that a scan is cheaper than
   *   the workarounds.
   */
  searchSemantic(query, limit = 10) {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    if (terms.some(containsCjk)) return this._searchSemanticSubstring(terms, limit);
    if (!this.hasFTS5) return this._searchSemanticSubstring(terms, limit);
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    try {
      const rows = this.db.prepare(`
        SELECT s.key, s.value, s.confidence, s.source, s.session_id, s.created_at, s.updated_at, s.last_accessed
        FROM semantic s
        JOIN semantic_fts fts ON s.rowid = fts.rowid
        WHERE semantic_fts MATCH ?
        ORDER BY bm25(semantic_fts)
        LIMIT ?
      `).all(ftsQuery, limit);
      if (rows.length > 0) return rows;
      return this._searchSemanticSubstring(terms, limit);
    } catch {
      return this._searchSemanticSubstring(terms, limit);
    }
  }
  _searchSemanticSubstring(terms, limit) {
    const all = this.db.prepare("SELECT * FROM semantic").all();
    const scored = [];
    for (const entry of all) {
      const text = `${entry.key} ${entry.value}`.toLowerCase();
      let matched = 0;
      let hits = 0;
      for (const term of terms) {
        const n = countOccurrences(text, term);
        if (n > 0) {
          matched++;
          hits += n;
        }
      }
      if (matched === 0) continue;
      scored.push({ entry, score: matched / terms.length, hits });
    }
    scored.sort((a, b) => b.score - a.score || b.hits - a.hits);
    return scored.slice(0, limit).map((s) => s.entry);
  }
  /**
   * Record that these facts were injected. One statement for the whole set:
   * the previous per-key loop issued a write per fact per turn, and this runs
   * on every turn.
   */
  touchAccessed(keys) {
    if (keys.length === 0) return;
    const placeholders = keys.map(() => "?").join(",");
    this.db.prepare(
      `UPDATE semantic SET last_accessed = datetime('now') WHERE key IN (${placeholders})`
    ).run(...keys.map((k) => k.toLowerCase()));
  }
  // ─── Lessons ─────────────────────────────────────────────────────
  addLesson(rule, category = "general", source = "consolidation", negative = false, project) {
    const trimmed = rule.trim();
    if (!trimmed) return { success: false, reason: "empty rule" };
    const normalizedCategory = category.trim().toLowerCase() || "general";
    return this.withLock(() => {
      const existing = this.db.prepare(
        "SELECT id FROM lessons WHERE LOWER(TRIM(rule)) = LOWER(?) AND is_deleted = 0"
      ).get(trimmed.toLowerCase());
      if (existing) return { success: false, reason: "duplicate", id: existing.id };
      const allRules = this.db.prepare("SELECT id, rule FROM lessons WHERE is_deleted = 0").all();
      for (const r of allRules) {
        if (jaccard(trimmed, r.rule) >= 0.7) {
          return { success: false, reason: "similar", id: r.id };
        }
      }
      const id = crypto.randomUUID();
      this.db.prepare(
        "INSERT INTO lessons (id, rule, category, source, negative, project) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, trimmed, normalizedCategory, source, negative ? 1 : 0, project ?? null);
      this.logEvent("create", "lesson", id, trimmed.slice(0, 100));
      return { success: true, id };
    });
  }
  getLesson(id) {
    const row = this.db.prepare("SELECT * FROM lessons WHERE id = ? AND is_deleted = 0").get(id);
    if (!row) return void 0;
    return { ...row, negative: !!row.negative };
  }
  /**
   * List lessons, optionally filtered by category and/or project.
   *
   * Project filtering:
   * - If `project` is provided, returns lessons where `project = slug` OR `project IS NULL`
   *   (NULL = user-authored or pre-migration lessons, treated as global).
   * - If `project` is not provided, returns all lessons (no project filter).
   */
  listLessons(category, limit = 50, project) {
    let rows;
    if (category && project) {
      const normalizedCategory = category.trim().toLowerCase();
      rows = this.db.prepare(
        "SELECT * FROM lessons WHERE category = ? AND (project = ? OR project IS NULL) AND is_deleted = 0 ORDER BY created_at DESC LIMIT ?"
      ).all(normalizedCategory, project, limit);
    } else if (category) {
      const normalizedCategory = category.trim().toLowerCase();
      rows = this.db.prepare("SELECT * FROM lessons WHERE category = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT ?").all(normalizedCategory, limit);
    } else if (project) {
      rows = this.db.prepare(
        "SELECT * FROM lessons WHERE (project = ? OR project IS NULL) AND is_deleted = 0 ORDER BY created_at DESC LIMIT ?"
      ).all(project, limit);
    } else {
      rows = this.db.prepare("SELECT * FROM lessons WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT ?").all(limit);
    }
    return rows.map((r) => ({ ...r, negative: !!r.negative, project: r.project ?? null }));
  }
  /**
   * Search lessons by relevance to a query. Same script-based split as
   * searchSemantic: FTS5 cannot match an interior CJK substring.
   */
  searchLessons(query, limit = 20) {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    if (terms.some(containsCjk)) return this._searchLessonsSubstring(terms, limit);
    if (!this.hasFTS5) return this._searchLessonsSubstring(terms, limit);
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    try {
      const rows = this.db.prepare(`
        SELECT l.id, l.rule, l.category, l.source, l.negative, l.created_at, l.project
        FROM lessons l
        JOIN lessons_fts fts ON l.rowid = fts.rowid
        WHERE lessons_fts MATCH ? AND l.is_deleted = 0
        ORDER BY bm25(lessons_fts)
        LIMIT ?
      `).all(ftsQuery, limit);
      const mapped = rows.map((r) => ({ ...r, negative: !!r.negative, project: r.project ?? null }));
      if (mapped.length > 0) return mapped;
      return this._searchLessonsSubstring(terms, limit);
    } catch {
      return this._searchLessonsSubstring(terms, limit);
    }
  }
  _searchLessonsSubstring(terms, limit) {
    const all = this.db.prepare("SELECT * FROM lessons WHERE is_deleted = 0").all();
    const scored = [];
    for (const entry of all) {
      const text = `${entry.rule} ${entry.category}`.toLowerCase();
      let matched = 0;
      let hits = 0;
      for (const term of terms) {
        const n = countOccurrences(text, term);
        if (n > 0) {
          matched++;
          hits += n;
        }
      }
      if (matched === 0) continue;
      scored.push({
        entry: { ...entry, negative: !!entry.negative, project: entry.project ?? null },
        score: matched / terms.length,
        hits
      });
    }
    scored.sort((a, b) => b.score - a.score || b.hits - a.hits);
    return scored.slice(0, limit).map((s) => s.entry);
  }
  deleteLesson(id) {
    return this.withLock(() => {
      let result = this.db.prepare("UPDATE lessons SET is_deleted = 1 WHERE id = ? AND is_deleted = 0").run(id);
      if (result.changes === 0 && id.length < 36) {
        const matches = this.db.prepare("SELECT id FROM lessons WHERE id LIKE ? AND is_deleted = 0").all(`${id}%`);
        if (matches.length === 1) {
          result = this.db.prepare("UPDATE lessons SET is_deleted = 1 WHERE id = ? AND is_deleted = 0").run(matches[0].id);
          if (result.changes > 0) this.logEvent("delete", "lesson", matches[0].id);
          return true;
        }
      }
      if (result.changes > 0) this.logEvent("delete", "lesson", id);
      return result.changes > 0;
    });
  }
  // ─── Events ──────────────────────────────────────────────────────
  logEvent(eventType, memoryType, key, details = "") {
    this.db.prepare(
      "INSERT INTO events (event_type, memory_type, memory_key, details) VALUES (?, ?, ?, ?)"
    ).run(eventType, memoryType, key, details);
  }
  listEvents(limit = 50) {
    return this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
  }
  // ─── Pending consolidation (outbox) ───────────────────────────────
  /**
   * Queue a session tail for later consolidation.
   *
   * One commit: ~13 ms at synchronous=NORMAL, against the several seconds a
   * consolidation run costs. That is the whole point — the expensive part
   * must not run while the user is waiting to quit or switch sessions.
   *
   * Tails supersede each other instead of conflicting: a resumed session
   * re-seeds its whole history, so a new tail that carries at least as many
   * messages replaces the older unclaimed ones (the queue cannot grow one
   * duplicate job per run). A *smaller* tail is new information — it only
   * exists after a drain cleared the buffer — so it is queued alongside; two
   * surviving rows are two genuinely unconsumed tails, not a duplicate. A
   * claimed row is mid-flight and is never touched.
   */
  enqueuePending(sessionId, payload, userCount) {
    const json = JSON.stringify(payload);
    const key = sessionId ?? null;
    this.withLock(() => {
      this.db.prepare(
        `DELETE FROM pending_consolidation
           WHERE session_id IS ? AND claimed_at IS NULL AND user_count <= ?`
      ).run(key, userCount);
      this.db.prepare("INSERT INTO pending_consolidation (session_id, user_count, payload) VALUES (?, ?, ?)").run(key, userCount, json);
      this.db.prepare(
        `DELETE FROM pending_consolidation WHERE id NOT IN
           (SELECT id FROM pending_consolidation ORDER BY id DESC LIMIT 20)`
      ).run();
    });
  }
  /**
   * Take the oldest queued job, marking it claimed so a concurrent drainer
   * skips it. A job whose claim is older than `staleAfterMinutes` is offered
   * again: a drainer that was killed mid-run must not lose the work.
   */
  claimPending(staleAfterMinutes = 10) {
    return this.withLock(() => {
      const row = this.db.prepare(
        `SELECT id, payload FROM pending_consolidation
           WHERE claimed_at IS NULL OR claimed_at < datetime('now', ?)
           ORDER BY id LIMIT 1`
      ).get(`-${staleAfterMinutes} minutes`);
      if (!row) return void 0;
      this.db.prepare("UPDATE pending_consolidation SET claimed_at = datetime('now') WHERE id = ?").run(row.id);
      return row;
    });
  }
  /** Drop a job after its facts were written — at-least-once, never silent loss. */
  deletePending(id) {
    this.withLock(() => {
      this.db.prepare("DELETE FROM pending_consolidation WHERE id = ?").run(id);
    });
  }
  /**
   * Hand a claimed job back to the queue. Used when a drain is interrupted by
   * shutdown: without it the job would sit claimed until the stale window
   * expires, so a user who quits mid-consolidation would see a dead queue.
   */
  releasePending(id) {
    this.withLock(() => {
      this.db.prepare("UPDATE pending_consolidation SET claimed_at = NULL WHERE id = ?").run(id);
    });
  }
  /**
   * Record a failed attempt and requeue the job. Returns the new attempt count,
   * so the caller can decide when to stop retrying a prompt that keeps failing.
   */
  failPending(id) {
    return this.withLock(() => {
      this.db.prepare("UPDATE pending_consolidation SET attempts = attempts + 1, claimed_at = NULL WHERE id = ?").run(id);
      const row = this.db.prepare("SELECT attempts FROM pending_consolidation WHERE id = ?").get(id);
      return row?.attempts ?? 0;
    });
  }
  /**
   * Run `fn` with a short busy timeout.
   *
   * node:sqlite is synchronous, so `BEGIN IMMEDIATE` against a lock held by
   * another process blocks *this* process's event loop for up to busy_timeout —
   * i.e. a background write can freeze the TUI for seconds. Background work
   * should yield instead and let the queue retry it.
   */
  withBusyTimeout(ms, fn) {
    const previous = this.db.prepare("PRAGMA busy_timeout").get().timeout;
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(ms))}`);
    try {
      return fn();
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${previous}`);
    }
  }
  pendingCount() {
    return this.db.prepare("SELECT COUNT(*) AS c FROM pending_consolidation").get().c;
  }
  // ─── Stats ───────────────────────────────────────────────────────
  stats() {
    const semantic = this.db.prepare("SELECT COUNT(*) as c FROM semantic").get().c;
    const lessons = this.db.prepare("SELECT COUNT(*) as c FROM lessons WHERE is_deleted = 0").get().c;
    const events = this.db.prepare("SELECT COUNT(*) as c FROM events").get().c;
    return { semantic, lessons, events, pending: this.pendingCount() };
  }
  close() {
    this.db.close();
  }
};
var CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
function containsCjk(s) {
  return CJK_RE.test(s);
}
function queryTerms(query) {
  const terms = /* @__PURE__ */ new Set();
  for (const word of query.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (!word) continue;
    if (!containsCjk(word)) {
      terms.add(word);
      continue;
    }
    const chars = Array.from(word);
    if (chars.length === 1) {
      terms.add(chars[0]);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i++) terms.add(chars[i] + chars[i + 1]);
  }
  return [...terms].filter((t) => t.length > 1 || containsCjk(t));
}
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}
function jaccard(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = /* @__PURE__ */ new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

// src/injector.ts
import os from "node:os";
var MAX_CONTEXT_CHARS = 8e3;
var SEARCH_LIMIT = 15;
var LESSON_SEARCH_LIMIT = 15;
var SECTION_ORDER = [
  "User Preferences",
  "Project Context",
  "Tool Preferences",
  "Relevant Memory",
  "Learned Corrections",
  "Validated Approaches",
  "User"
];
var CONSOLIDATION_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
async function buildContextBlock(store, cwd, prompt, config, deps) {
  if (prompt?.trim()) {
    return buildSelectiveBlock(store, prompt, cwd, config, deps);
  }
  return buildFallbackBlock(store, cwd);
}
async function buildSelectiveBlock(store, prompt, cwd, config, deps) {
  const items = [];
  const mode = config?.lessonInjection ?? "all";
  const searchFacts = deps?.searchFacts ?? ((q, l) => Promise.resolve(store.searchSemantic(q, l)));
  const results = await searchFacts(prompt, SEARCH_LIMIT);
  const slug = cwd ? projectSlug(cwd) : "";
  if (slug) {
    const projectResults = await searchFacts(slug, 5);
    const seen2 = new Set(results.map((r) => r.key));
    for (const r of projectResults) {
      if (!seen2.has(r.key)) {
        results.push(r);
        seen2.add(r.key);
      }
    }
  }
  const filteredResults = slug ? results.filter((r) => {
    if (!r.key.startsWith("project.")) return true;
    const parts = r.key.split(".");
    return parts.length >= 2 && parts[1] === slug;
  }) : results;
  const seen = new Set(filteredResults.map((r) => r.key));
  const expandedPrefixes = /* @__PURE__ */ new Set();
  for (const r of [...filteredResults]) {
    const prefix = keyDomainPrefix(r.key);
    if (!prefix || expandedPrefixes.has(prefix)) continue;
    expandedPrefixes.add(prefix);
    for (const sibling of store.listSemantic(prefix, 5)) {
      if (!seen.has(sibling.key)) {
        filteredResults.push(sibling);
        seen.add(sibling.key);
      }
    }
  }
  filteredResults.forEach((entry, rank) => {
    items.push({
      section: "Relevant Memory",
      line: formatSemantic(entry),
      score: factScore(entry, rank),
      idx: items.length,
      kind: "semantic"
    });
  });
  if (filteredResults.length > 0) {
    store.touchAccessed(filteredResults.map((r) => r.key));
  }
  const lessons = mode === "selective" ? getRelevantLessons(store, prompt, cwd) : store.listLessons(void 0, 50, slug || void 0);
  lessons.forEach((lesson, rank) => {
    items.push({
      section: lesson.negative ? "Learned Corrections" : "Validated Approaches",
      line: lesson.negative ? `DON'T: ${lesson.rule}${lesson.category !== "general" ? ` [${lesson.category}]` : ""}` : `${lesson.rule}${lesson.category !== "general" ? ` [${lesson.category}]` : ""}`,
      score: lessonScore(rank),
      idx: items.length,
      kind: "lesson"
    });
  });
  const user = store.listSemantic("user.", 10);
  user.forEach((entry, rank) => {
    items.push({
      section: "User",
      line: formatSemantic(entry),
      score: factScore(entry, rank),
      idx: items.length,
      kind: "semantic"
    });
  });
  return renderBlock(items);
}
function getRelevantLessons(store, prompt, cwd) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  function add(lessons) {
    for (const l of lessons) {
      if (!seen.has(l.id)) {
        seen.add(l.id);
        result.push(l);
      }
    }
  }
  add(store.searchLessons(prompt, LESSON_SEARCH_LIMIT));
  const slug = cwd ? projectSlug(cwd) : "";
  if (slug) {
    add(store.searchLessons(slug, 5));
  }
  add(store.listLessons("general", 10));
  return result.slice(0, LESSON_SEARCH_LIMIT);
}
function buildFallbackBlock(store, cwd) {
  const items = [];
  const push = (section, entries, kind = "semantic") => {
    entries.forEach((entry, rank) => {
      items.push({
        section,
        line: formatSemantic(entry),
        score: factScore(entry, rank),
        idx: items.length,
        kind
      });
    });
  };
  push("User Preferences", store.listSemantic("pref.", 50));
  const slug = cwd ? projectSlug(cwd) : "";
  const projects = store.listSemantic("project.", 50);
  const relevant = slug ? projects.filter((p) => {
    const parts = p.key.split(".");
    return parts.length >= 2 && parts[1] === slug;
  }) : projects;
  push("Project Context", relevant);
  push("Tool Preferences", store.listSemantic("tool.", 20));
  store.listLessons(void 0, 50, slug || void 0).forEach((lesson, rank) => {
    items.push({
      section: lesson.negative ? "Learned Corrections" : "Validated Approaches",
      line: lesson.negative ? `DON'T: ${lesson.rule}${lesson.category !== "general" ? ` [${lesson.category}]` : ""}` : `${lesson.rule}${lesson.category !== "general" ? ` [${lesson.category}]` : ""}`,
      score: lessonScore(rank),
      idx: items.length,
      kind: "lesson"
    });
  });
  push("User", store.listSemantic("user.", 10));
  return renderBlock(items);
}
function factScore(entry, rank) {
  const base = 1 / (1 + rank);
  const confidence = 0.6 + 0.4 * entry.confidence;
  const stale = daysSince(entry.updated_at) >= VERY_STALE_DAYS ? 0.5 : 1;
  const usedRecently = entry.last_accessed && daysSince(entry.last_accessed) <= 7 ? 1.2 : 1;
  return base * confidence * stale * usedRecently;
}
function lessonScore(rank) {
  return 1.25 / (1 + rank);
}
function renderBlock(items) {
  if (items.length === 0) return { text: "", stats: { semantic: 0, lessons: 0 } };
  const overhead = "<memory>\n".length + "\n\n".length + MEMORY_DRIFT_CAVEAT.length + "\n</memory>".length;
  let budget = MAX_CONTEXT_CHARS - overhead;
  const kept = /* @__PURE__ */ new Set();
  const sectionsStarted = /* @__PURE__ */ new Set();
  for (const item of [...items].sort((a, b) => b.score - a.score)) {
    const headerCost = sectionsStarted.has(item.section) ? 0 : item.section.length + 4;
    const cost = item.line.length + 3;
    if (cost + headerCost > budget) continue;
    budget -= cost + headerCost;
    sectionsStarted.add(item.section);
    kept.add(item);
  }
  if (kept.size === 0) return { text: "", stats: { semantic: 0, lessons: 0 } };
  const bySection = /* @__PURE__ */ new Map();
  for (const item of [...items].sort((a, b) => a.idx - b.idx)) {
    if (!kept.has(item)) continue;
    const lines = bySection.get(item.section) ?? [];
    lines.push(item.line);
    bySection.set(item.section, lines);
  }
  const rendered = SECTION_ORDER.filter((section) => bySection.has(section)).map((section) => formatSection(section, bySection.get(section)));
  for (const [section, lines] of bySection) {
    if (!SECTION_ORDER.includes(section)) rendered.push(formatSection(section, lines));
  }
  const text = `<memory>
${rendered.join("\n")}

${MEMORY_DRIFT_CAVEAT}
</memory>`;
  const keptItems = items.filter((item) => kept.has(item));
  return {
    text,
    stats: {
      semantic: keptItems.filter((item) => item.kind === "semantic").length,
      lessons: keptItems.filter((item) => item.kind === "lesson").length
    }
  };
}
var STALE_WARNING_DAYS = 30;
var VERY_STALE_DAYS = 90;
function formatSection(title, items) {
  return `## ${title}
${items.map((i) => `- ${i}`).join("\n")}`;
}
function formatSemantic(entry) {
  const key = entry.key.split(".").slice(1).join(".");
  const ageDays = daysSince(entry.updated_at);
  const staleTag = ageDays >= VERY_STALE_DAYS ? ` \u26A0\uFE0F ${ageDays}d old \u2014 verify before acting on this` : ageDays >= STALE_WARNING_DAYS ? ` (${ageDays}d ago)` : "";
  return `${key}: ${entry.value}${staleTag}`;
}
function daysSince(dateStr) {
  try {
    const then = new Date(dateStr).getTime();
    const now = Date.now();
    return Math.floor((now - then) / (1e3 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}
var MEMORY_DRIFT_CAVEAT = `## Before acting on memory
- Memory records can become stale. If a memory names a file, function, or flag \u2014 verify it still exists before recommending it. "The memory says X exists" is not the same as "X exists now."
- If a recalled memory conflicts with what you observe in the current code or project state, trust what you observe now.
- Memories about project state (deadlines, decisions, architecture) decay fastest \u2014 check if still relevant.`;
function keyDomainPrefix(key) {
  const parts = key.split(".");
  return parts.length >= 3 ? parts.slice(0, 2).join(".") : null;
}
function projectSlug(cwd) {
  const parts = cwd.split("/").filter(Boolean);
  const skip = /* @__PURE__ */ new Set(["workplace", "local", "home", "src", "scratch", os.userInfo().username]);
  for (const p of parts.reverse()) {
    if (!skip.has(p.toLowerCase()) && p.length > 1) return p.toLowerCase();
  }
  return "";
}

// src/sessions.ts
import { createRequire as createRequire2 } from "node:module";
import { mkdirSync as mkdirSync2, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname as dirname2, join } from "node:path";
var _require2 = createRequire2(import.meta.url);
var isBun2 = typeof globalThis.Bun !== "undefined";
var DatabaseSync2 = isBun2 ? _require2("bun:sqlite").Database : _require2("node:sqlite").DatabaseSync;
var MAX_DOC_CHARS = 8e3;
var DEFAULT_SYNC_BYTES = 32 * 1024 * 1024;
function sessionDirFor(sessionsRoot, cwd) {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(sessionsRoot, safe);
}
var SessionIndex = class {
  db;
  hasFTS5 = false;
  constructor(dbPath) {
    mkdirSync2(dirname2(dbPath), { recursive: true });
    this.db = new DatabaseSync2(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }
  migrate() {
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
  sync(sessionsRoot, cwd, maxBytes = DEFAULT_SYNC_BYTES) {
    if (!this.hasFTS5) return { indexed: 0, stale: 0 };
    const dir = sessionDirFor(sessionsRoot, cwd);
    let names;
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      return { indexed: 0, stale: 0 };
    }
    const files = names.map((name) => {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        return { path, size: st.size, mtime: Math.floor(st.mtimeMs) };
      } catch {
        return null;
      }
    }).filter((f) => f !== null).sort((a, b) => b.mtime - a.mtime);
    const seen = new Set(files.map((f) => f.path));
    let budget = maxBytes;
    let indexed = 0;
    for (const file of files) {
      const row = this.db.prepare("SELECT size, mtime FROM files WHERE path = ?").get(file.path);
      if (row && row.size === file.size && row.mtime === file.mtime) continue;
      if (file.size > budget && indexed > 0) continue;
      budget -= file.size;
      this.indexFile(file.path, file.size, file.mtime);
      indexed++;
    }
    const known = this.db.prepare("SELECT path, session_id FROM files").all();
    for (const row of known) {
      if (seen.has(row.path)) continue;
      if (!row.path.startsWith(dir)) continue;
      this.db.prepare("DELETE FROM files WHERE path = ?").run(row.path);
      this.db.prepare("DELETE FROM docs WHERE session_id = ?").run(row.session_id);
    }
    let stale = 0;
    for (const file of files) {
      const row = this.db.prepare("SELECT size, mtime FROM files WHERE path = ?").get(file.path);
      if (!row || row.size !== file.size || row.mtime !== file.mtime) stale++;
    }
    return { indexed, stale };
  }
  indexFile(path, size, mtime) {
    const base = path.split("/").pop() ?? path;
    const sessionId = base.replace(/\.jsonl$/, "").split("_").pop() ?? base;
    let raw;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM docs WHERE session_id = ?").run(sessionId);
      const insert = this.db.prepare(
        "INSERT INTO docs (text, session_id, seq, role, ts) VALUES (?, ?, ?, ?, ?)"
      );
      let seq = 0;
      for (const line of raw.split("\n")) {
        if (!line) continue;
        if (!line.startsWith('{"type":"message"')) continue;
        try {
          const record = JSON.parse(line);
          const role = record.message?.role;
          if (role !== "user" && role !== "assistant") continue;
          const text = messageText(record.message?.content);
          if (!text) continue;
          insert.run(
            text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text,
            sessionId,
            seq++,
            role,
            record.timestamp ?? ""
          );
        } catch {
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
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      throw err;
    }
  }
  /** Ranked matches. Queries shorter than 3 characters per term yield nothing. */
  search(query, limit = 10) {
    if (!this.hasFTS5) return [];
    const terms = trigramTerms(query);
    if (terms.length === 0) return [];
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    try {
      return this.db.prepare(`
        SELECT session_id AS sessionId, role, ts,
               snippet(docs, 0, '\xBB', '\xAB', '\u2026', 14) AS snippet
        FROM docs
        WHERE docs MATCH ?
        ORDER BY bm25(docs)
        LIMIT ?
      `).all(ftsQuery, limit);
    } catch {
      return [];
    }
  }
  /** Messages of one session, oldest first. `sessionId` may be a prefix. */
  readSession(sessionId, limit = 40) {
    if (!this.hasFTS5) return [];
    const file = this.db.prepare(
      "SELECT session_id FROM files WHERE session_id LIKE ? || '%' ORDER BY updated_at DESC LIMIT 1"
    ).get(sessionId);
    if (!file) return [];
    const rows = this.db.prepare(`
      SELECT role, ts, text FROM docs
      WHERE session_id = ?
      ORDER BY seq DESC
      LIMIT ?
    `).all(file.session_id, limit);
    return rows.reverse();
  }
  stats() {
    const sessions = this.db.prepare("SELECT COUNT(*) AS c FROM files").get().c;
    const docs = this.hasFTS5 ? this.db.prepare("SELECT COUNT(*) AS c FROM docs").get().c : 0;
    return { sessions, docs };
  }
  close() {
    this.db.close();
  }
};
function messageText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text") {
      const text = block.text;
      if (typeof text === "string" && text.trim()) parts.push(text.trim());
    }
  }
  return parts.join("\n");
}
function trigramTerms(query) {
  const terms = /* @__PURE__ */ new Set();
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

// src/embedder.ts
var DEFAULTS = {
  openai: { model: "text-embedding-3-small", dimensions: 512, baseUrl: "https://api.openai.com", sendDimensions: true, batchSize: 100 },
  bedrock: {
    model: "amazon.titan-embed-text-v2:0",
    region: "us-east-1",
    profile: "default",
    dimensions: 512
  },
  ollama: { model: "nomic-embed-text", url: "http://localhost:11434" },
  mistral: { model: "mistral-embed", dimensions: 1024, baseUrl: "https://api.mistral.ai", sendDimensions: false, batchSize: 100 },
  // Gateways behind an OpenAI-compatible endpoint often limit inputs per
  // request (10 is common), so a smaller default trades round-trips for working.
  "openai-compatible": { model: "text-embedding-3-small", dimensions: 512, sendDimensions: false, batchSize: 10 }
};
var API_KEY_ENV = {
  openai: "OPENAI_API_KEY",
  mistral: "MISTRAL_API_KEY"
};
function requireApiKey(type, configured) {
  const envVar = API_KEY_ENV[type];
  const key = configured || process.env[envVar] || "";
  if (!key) throw new Error(`${type} embeddings need an API key`);
  return key;
}
function createEmbedder(config) {
  const defaults = DEFAULTS[config.type] ?? {};
  const merged = { ...defaults, ...config };
  switch (merged.type) {
    case "openai":
      return new OpenAICompatibleEmbedder(
        requireApiKey("openai", merged.apiKey),
        merged.model,
        merged.dimensions,
        merged.baseUrl || "https://api.openai.com",
        merged.sendDimensions ?? true,
        merged.batchSize ?? 100
      );
    case "mistral":
      return new OpenAICompatibleEmbedder(
        requireApiKey("mistral", merged.apiKey),
        merged.model,
        merged.dimensions,
        merged.baseUrl || "https://api.mistral.ai",
        merged.sendDimensions ?? false,
        merged.batchSize ?? 100
      );
    case "openai-compatible": {
      if (!merged.baseUrl) throw new Error("openai-compatible requires baseUrl");
      return new OpenAICompatibleEmbedder(
        merged.apiKey || "",
        merged.model,
        merged.dimensions,
        merged.baseUrl,
        merged.sendDimensions ?? false,
        merged.batchSize ?? 100
      );
    }
    case "bedrock":
      return new BedrockEmbedder(
        merged.profile,
        merged.region,
        merged.model,
        merged.dimensions
      );
    case "ollama":
      return new OllamaEmbedder(merged.url, merged.model);
    default:
      throw new Error(`Unknown embedder type: ${merged.type}`);
  }
}
function diagnoseEmbedderError(err, config, packageRoot) {
  const cfg = { ...DEFAULTS[config.type], ...config };
  const e = err ?? {};
  const message = String(e.message ?? err);
  const firstLine = message.split("\n")[0].slice(0, 200);
  const code = e.code ?? e.cause?.code;
  const settings = "the memory.embedding block in settings.json";
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || /Cannot find (package|module)/.test(message)) {
    if (message.includes("@aws-sdk/")) {
      return {
        reason: "the AWS SDK that the bedrock provider needs is not installed (it is an optional dependency, so it was omitted or its install failed)",
        hint: `Run \`npm install --omit=dev --include=optional\` in ${packageRoot}, or switch memory.embedding.type to openai, mistral, ollama or openai-compatible, which need no SDK.`
      };
    }
    return {
      reason: `a module it needs is missing (${firstLine})`,
      hint: "Reinstall the package: `pi install npm:@samfp/pi-memory`."
    };
  }
  const needsKey = /^(\w+) embeddings need an API key$/.exec(message);
  if (needsKey) {
    const envVar = API_KEY_ENV[config.type] ?? "the provider's API key variable";
    return {
      reason: `no API key is configured for ${needsKey[1]} embeddings`,
      hint: `Set memory.embedding.apiKey, or export ${envVar} before starting pi.`
    };
  }
  if (config.type === "bedrock") {
    const where = `profile "${cfg.profile}", region ${cfg.region}`;
    if (e.name === "CredentialsProviderError" && /^Command failed:|credential_process (returned|did not return)/.test(message)) {
      const stderr = message.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
      const detail = message.startsWith("Command failed:") ? stderr.at(-1) ?? "no error output" : firstLine;
      return {
        reason: `the credential_process for ${where} failed (${detail.slice(0, 300)})`,
        hint: `Run \`aws sts get-caller-identity --profile ${cfg.profile}\` to see the full error. If the process relies on a login session, renew it, then run /reload or start a new session.`
      };
    }
    if (e.name === "CredentialsProviderError" || /could not (resolve|load) credentials/i.test(message)) {
      return {
        reason: `no AWS credentials were found for ${where}`,
        hint: `Configure that profile (for SSO: \`aws sso login --profile ${cfg.profile}\`), or set memory.embedding.profile to one that exists.`
      };
    }
    if (/expired/i.test(`${e.name} ${message}`)) {
      return {
        reason: `the AWS credentials for ${where} have expired`,
        hint: "Refresh them, then run /reload or start a new session."
      };
    }
    if (e.name === "AccessDeniedException" || e.name === "UnrecognizedClientException" || e.$metadata?.httpStatusCode === 403) {
      return {
        reason: `Bedrock refused ${cfg.model} for ${where} (${e.name ?? "403"})`,
        hint: `Check that the profile may call bedrock:InvokeModel and that access to ${cfg.model} is enabled in ${cfg.region}.`
      };
    }
    if (e.name === "ValidationException" || e.name === "ResourceNotFoundException") {
      return {
        reason: `Bedrock rejected the request for ${cfg.model} in ${cfg.region}: ${firstLine}`,
        hint: "Check memory.embedding.model, region and dimensions (Titan v2 accepts 256, 512 or 1024)."
      };
    }
  }
  const http = /^(?:Embeddings API|Ollama) (\d{3})\b/.exec(message);
  if (http) {
    const status = Number(http[1]);
    if (status === 400 && /batch size/i.test(message)) {
      return {
        reason: `the provider caps how many inputs one request may carry (${firstLine})`,
        hint: `Lower memory.embedding.batchSize (currently ${cfg.batchSize}); some gateways allow at most 10.`
      };
    }
    if (status === 401 || status === 403) {
      return {
        reason: `the embeddings API rejected the API key (HTTP ${status})`,
        hint: "Check memory.embedding.apiKey (or the provider's API key environment variable)."
      };
    }
    if (status === 404) {
      return config.type === "ollama" ? {
        reason: `Ollama has no model named ${cfg.model}`,
        hint: `Run \`ollama pull ${cfg.model}\`.`
      } : {
        reason: `the embeddings endpoint or model was not found (HTTP 404, model ${cfg.model})`,
        hint: "Check memory.embedding.baseUrl and memory.embedding.model."
      };
    }
    if (status === 429) {
      return {
        reason: "the embeddings API is rate limiting requests (HTTP 429)",
        hint: "This is usually transient; semantic results return once the limit resets."
      };
    }
  }
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || /fetch failed/i.test(message)) {
    const target = config.type === "ollama" ? cfg.url : cfg.baseUrl;
    return config.type === "ollama" ? {
      reason: `Ollama is not reachable at ${target}`,
      hint: `Start it (\`ollama serve\`) and pull the model (\`ollama pull ${cfg.model}\`), or fix memory.embedding.url.`
    } : {
      reason: `the embeddings endpoint ${target ?? ""} is not reachable (${code ?? firstLine})`,
      hint: "Check memory.embedding.baseUrl and your network connection."
    };
  }
  return { reason: firstLine, hint: `Check ${settings}.` };
}
function truncate(text, maxChars = 12e3) {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
async function parallelMap(items, fn, concurrency, signal) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw new Error("Aborted");
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}
var OpenAICompatibleEmbedder = class {
  constructor(apiKey, model, dimensions, baseUrl, sendDimensions, batchSize) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    this.sendDimensions = sendDimensions;
    this.batchSize = batchSize;
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/v1/embeddings`;
  }
  apiKey;
  model;
  dimensions;
  sendDimensions;
  batchSize;
  endpoint;
  async embed(text, signal) {
    const [result] = await this.embedBatch([text], signal);
    if (!result) throw new Error("Embedding failed");
    return result;
  }
  async embedBatch(texts, signal) {
    const BATCH = Math.max(1, Math.floor(this.batchSize));
    const results = new Array(texts.length).fill(null);
    for (let i = 0; i < texts.length; i += BATCH) {
      if (signal?.aborted) throw new Error("Aborted");
      const batch = texts.slice(i, i + BATCH).map((t) => truncate(t));
      const body = {
        input: batch,
        model: this.model
      };
      if (this.dimensions && this.sendDimensions) {
        body.dimensions = this.dimensions;
      }
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Embeddings API ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const json = await res.json();
      for (let k = 0; k < json.data.length; k++) {
        const item = json.data[k];
        results[i + (item.index ?? k)] = item.embedding;
      }
    }
    return results;
  }
};
var BedrockEmbedder = class {
  constructor(profile, region, model, dimensions) {
    this.profile = profile;
    this.region = region;
    this.model = model;
    this.dimensions = dimensions;
  }
  profile;
  region;
  model;
  dimensions;
  client = null;
  /**
   * Loaded on first use, not in the constructor. An eager import that fails
   * (optional AWS SDK absent) while nothing awaits it is an unhandled
   * rejection, and that crashes pi. The rejection is cached so later calls fail fast.
   */
  getClient() {
    this.client ??= (async () => {
      const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
      const { fromIni } = await import("@aws-sdk/credential-providers");
      return new BedrockRuntimeClient({
        region: this.region,
        credentials: fromIni({ profile: this.profile })
      });
    })();
    return this.client;
  }
  async embed(text, signal) {
    const [result] = await this.embedBatch([text], signal);
    if (!result) throw new Error("Embedding failed");
    return result;
  }
  async embedBatch(texts, signal) {
    const client = await this.getClient();
    return parallelMap(
      texts,
      async (text) => {
        const { InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
        const body = JSON.stringify({
          inputText: truncate(text),
          dimensions: this.dimensions,
          normalize: true
        });
        const cmd = new InvokeModelCommand({
          modelId: this.model,
          contentType: "application/json",
          accept: "application/json",
          body: new TextEncoder().encode(body)
        });
        const res = await client.send(cmd);
        const parsed = JSON.parse(new TextDecoder().decode(res.body));
        if (!parsed.embedding) throw new Error("No embedding in response");
        return parsed.embedding;
      },
      10,
      signal
    );
  }
};
var OllamaEmbedder = class {
  constructor(url, model) {
    this.url = url;
    this.model = model;
    this.url = url.replace(/\/$/, "");
  }
  url;
  model;
  async embed(text, signal) {
    const res = await fetch(`${this.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: truncate(text) }),
      signal
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return json.embeddings[0];
  }
  async embedBatch(texts, signal) {
    let firstError;
    const results = await parallelMap(
      texts,
      async (text) => {
        try {
          return await this.embed(text, signal);
        } catch (err) {
          firstError ??= err;
          return null;
        }
      },
      4,
      signal
    );
    if (texts.length > 0 && results.every((r) => r === null)) throw firstError;
    return results;
  }
};

// src/hybrid.ts
var RRF_K = 60;
function reciprocalRankFusion(lexical, semantic, identity, k = RRF_K) {
  const merged = /* @__PURE__ */ new Map();
  const contribute = (list, source) => {
    const seen = /* @__PURE__ */ new Set();
    list.forEach((item, rank) => {
      const id = identity(item);
      if (seen.has(id)) return;
      seen.add(id);
      const weight = 1 / (k + rank);
      const existing = merged.get(id);
      if (existing) {
        existing.score += weight;
        existing.sources.add(source);
      } else {
        merged.set(id, { item, score: weight, sources: /* @__PURE__ */ new Set([source]) });
      }
    });
  };
  contribute(lexical, "lexical");
  contribute(semantic, "semantic");
  return [...merged.values()].map(({ item, score, sources }) => ({
    item,
    score,
    // Stable order so assertions and output do not depend on Set iteration.
    sources: ["lexical", "semantic"].filter((s) => sources.has(s))
  })).sort((a, b) => b.score - a.score);
}

// src/consolidator.ts
var CONSOLIDATION_PROMPT = `You are a memory extraction system. Analyze this conversation and extract structured knowledge.

Extract ONLY concrete, reusable facts \u2014 not summaries of what happened. Focus on:

1. **User preferences** (key prefix: pref.) \u2014 coding style, tool preferences, workflow habits
   Example: { "key": "pref.commit_style", "value": "conventional commits", "confidence": 0.9 }

2. **Project patterns** (key prefix: project.<name>.) \u2014 languages, frameworks, architecture decisions
   Example: { "key": "project.rosie.di", "value": "Dagger dependency injection", "confidence": 0.95 }

3. **Tool preferences** (key prefix: tool.) \u2014 which tools to prefer/avoid, how to use them
   Example: { "key": "tool.sed", "value": "use for daily note insertion, not echo >>", "confidence": 0.9 }

4. **Corrections/lessons** \u2014 things the user corrected, mistakes to avoid
   Example: { "rule": "Use sed to insert after ## Notes heading, not echo >> which appends after Tags", "category": "vault", "negative": true }

5. **Validated approaches** \u2014 things the user explicitly confirmed worked well (positive signal)
   Example: { "rule": "When deploying wiki changes, draft first and let user preview before publishing", "category": "wiki-edit", "negative": false }

## What NOT to extract \u2014 these are derivable or ephemeral, and pollute memory:

- **Code patterns, architecture, file paths, project structure** \u2014 these can be derived by reading the current project state (grep, git, file reads)
- **Git history, recent changes, who-changed-what** \u2014 git log/blame are authoritative
- **Debugging solutions or fix recipes** \u2014 the fix is in the code; the commit message has context
- **Anything already documented in AGENTS.md, CLAUDE.md, or project config files**
- **Ephemeral task details** \u2014 in-progress work, temporary state, current conversation context
- **Activity summaries** \u2014 "today we worked on X" is not a lasting fact. Instead ask: what was *surprising* or *non-obvious* about it?
- **File contents or code snippets** \u2014 the file itself is the source of truth
- **Exact commands that worked once** \u2014 unless they encode a non-obvious pattern that the agent consistently gets wrong

These exclusions apply even if the user asks to save such things. If asked, extract what was *surprising* or *non-obvious* \u2014 that is the part worth keeping.

Rules:
- Only extract if confidence >= 0.8 (you're reasonably sure this is a lasting preference, not a one-off)
- Key format: lowercase, dots as separators, no spaces
- **One claim per fact.** If a value needs "and" or "\uFF0C" to join two separate claims, split it into two keys. A fact that carries two claims cannot be updated, contradicted, or ranked independently of the other half.
- Keep values under 120 chars \u2014 a short value is the whole point of a key. If you need a paragraph, the paragraph belongs in AGENTS.md, not here.
- For corrections, set negative=true if it's something to AVOID
- For validated approaches (user confirmed something works), set negative=false

Respond with ONLY valid JSON matching this schema:
{
  "semantic": [{ "key": "string", "value": "string", "confidence": number }],
  "lessons": [{ "rule": "string", "category": "string", "negative": boolean }]
}

If nothing worth extracting, return: { "semantic": [], "lessons": [] }`;
function resolveTurns(input) {
  if (input.turns && input.turns.length > 0) return input.turns;
  const out = [];
  for (let i = 0; i < input.userMessages.length; i++) {
    out.push({ user: input.userMessages[i] ?? "", assistant: input.assistantMessages[i] });
  }
  return out;
}
function buildConsolidationPrompt(input, currentFacts, currentLessons) {
  const messages = [];
  let memorySection = "";
  if (currentFacts && currentFacts.length > 0 || currentLessons && currentLessons.length > 0) {
    const parts = ["## Current Memory State"];
    if (currentFacts && currentFacts.length > 0) {
      parts.push("The user already has these facts stored (avoid duplicating, update if changed):");
      let chars = 0;
      for (const f of currentFacts) {
        const line = `- ${f.key}: ${f.value.length > 120 ? f.value.slice(0, 120) + "\u2026" : f.value}`;
        if (chars + line.length > 1500) {
          parts.push("- ... (truncated)");
          break;
        }
        parts.push(line);
        chars += line.length;
      }
    }
    if (currentLessons && currentLessons.length > 0) {
      parts.push("\nAnd these lessons (avoid duplicating):");
      let chars = 0;
      for (const l of currentLessons) {
        const line = `- [${l.category}] ${l.rule.length > 120 ? l.rule.slice(0, 120) + "\u2026" : l.rule}`;
        if (chars + line.length > 500) {
          parts.push("- ... (truncated)");
          break;
        }
        parts.push(line);
        chars += line.length;
      }
    }
    memorySection = parts.join("\n") + "\n\n";
  }
  const maxTurns = 30;
  for (const turn of resolveTurns(input).slice(-maxTurns)) {
    if (turn.user) messages.push(`User: ${truncate2(turn.user, 1e3)}`);
    if (turn.assistant) messages.push(`Assistant: ${truncate2(turn.assistant, 500)}`);
  }
  return `${CONSOLIDATION_PROMPT}

${memorySection}${input.cwd ? `Working directory: ${input.cwd}
` : ""}
## Conversation

${messages.join("\n\n")}`;
}
function parseConsolidationResponse(text) {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) return { semantic: [], lessons: [] };
  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    const result = { semantic: [], lessons: [] };
    if (Array.isArray(parsed.semantic)) {
      for (const s of parsed.semantic) {
        if (typeof s.key === "string" && typeof s.value === "string" && typeof s.confidence === "number") {
          if (s.confidence >= 0.8 && isValidKey(s.key) && s.value.length <= 200) {
            result.semantic.push({ key: s.key, value: s.value, confidence: s.confidence });
          }
        }
      }
    }
    if (Array.isArray(parsed.lessons)) {
      for (const l of parsed.lessons) {
        if (typeof l.rule === "string" && l.rule.trim().length > 0) {
          result.lessons.push({
            rule: l.rule.trim(),
            category: typeof l.category === "string" ? l.category : "general",
            negative: !!l.negative
          });
        }
      }
    }
    return result;
  } catch {
    return { semantic: [], lessons: [] };
  }
}
function applyExtracted(store, extracted, source = "consolidation", project, sessionId) {
  let semanticCount = 0;
  let lessonCount = 0;
  for (const s of extracted.semantic) {
    if (isDerivableOrEphemeral(s.key, s.value)) continue;
    store.setSemantic(s.key, s.value, s.confidence, "consolidation", sessionId);
    semanticCount++;
  }
  for (const l of extracted.lessons) {
    if (isDerivableLesson(l.rule)) continue;
    const lessonProject = source === "user" ? void 0 : project;
    const result = store.addLesson(l.rule, l.category, source, l.negative, lessonProject);
    if (result.success) lessonCount++;
  }
  return { semantic: semanticCount, lessons: lessonCount };
}
var VALID_KEY_RE = /^[a-z][a-z0-9._-]*$/;
function isValidKey(key) {
  return VALID_KEY_RE.test(key) && key.length <= 100 && key.length >= 2;
}
function isDerivableOrEphemeral(key, value) {
  const kl = key.toLowerCase();
  const vl = value.toLowerCase();
  if (kl.includes("filepath") || kl.includes("file_path") || kl.includes("directory")) return true;
  if (/^project\.\w+\.(path|dir|location|structure|layout|architecture)$/.test(kl)) return true;
  if (kl.includes("commit") || kl.includes("git.history") || kl.includes("git.recent")) return true;
  if (vl.startsWith("today ") || vl.startsWith("we worked on") || vl.startsWith("this session")) return true;
  if (vl.includes("```") && vl.length > 300) return true;
  if (kl.includes("current_task") || kl.includes("in_progress") || kl.includes("investigating")) return true;
  return false;
}
function isDerivableLesson(rule) {
  const rl = rule.toLowerCase();
  if (/file .+ is (at|in|located) /.test(rl)) return true;
  if (/^the (project|codebase|repo) (uses|is written in) /.test(rl)) return true;
  if (/^(we|i|the agent) (fixed|deployed|updated|changed|modified|ran|executed) /.test(rl)) return true;
  if (/^when (encountering|bash fails|edit fails|.*error)/.test(rl) && /\b(run:|fix with:)/.test(rl)) return true;
  if (/^run: /.test(rl)) return true;
  if (rl.includes("command exited with code") && rl.length < 100) return true;
  return false;
}
function truncate2(text, max) {
  return text.length > max ? text.slice(0, max) + "\u2026" : text;
}

// src/index.ts
function ok(text) {
  return { content: [{ type: "text", text }], details: {} };
}
function stripQuotes(v) {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if (first === '"' && last === '"' || first === "'" && last === "'") {
      try {
        if (first === '"') return JSON.parse(s);
      } catch {
      }
      return s.slice(1, -1);
    }
  }
  return v;
}
var PACKAGE_ROOT = (() => {
  try {
    return resolve(fileURLToPath(new URL("..", import.meta.url)));
  } catch {
    return "the pi-memory package directory";
  }
})();
var DEFAULT_MEMORY_DIR = join2(homedir(), ".pi", "memory");
var DEFAULT_DB_PATH = join2(DEFAULT_MEMORY_DIR, "memory.db");
var GLOBAL_SETTINGS_PATH = join2(homedir(), ".pi", "agent", "settings.json");
var SESSIONS_ROOT = join2(dirname3(GLOBAL_SETTINGS_PATH), "sessions");
var DEFAULT_CONSOLIDATION_MODEL = "claude-sonnet-4-20250514";
function isBusyError(err) {
  const code = err?.errcode ?? 0;
  const message = String(err?.message ?? err);
  return code === 5 || code === 6 || /database (table )?is locked|SQLITE_BUSY/i.test(message);
}
var MAX_CONSOLIDATION_ATTEMPTS = 3;
var DB_YIELD_MS = 250;
function warnUnknownKeys(block, blockName, knownKeys) {
  if (!block || typeof block !== "object") return;
  const unknown = Object.keys(block).filter((k) => !knownKeys.includes(k));
  if (unknown.length === 0) return;
  console.error(
    `pi-memory: ignoring unknown key(s) in settings.json "${blockName}" block: ${unknown.join(", ")} (expected: ${knownKeys.join(", ")})`
  );
}
var PI_MEMORY_KNOWN_KEYS = ["localPath", "lessonInjection", "consolidationModel", "consolidationThinking", "perTurnInjection", "injectionMode", "embedding"];
var PI_TOTAL_RECALL_KNOWN_KEYS = ["localPath"];
function resolveDbPath(cwd) {
  try {
    const localSettingsPath = join2(cwd, ".pi", "settings.json");
    const raw = readFileSync2(localSettingsPath, "utf-8");
    const settings = JSON.parse(raw);
    const piMemory = settings?.["pi-memory"];
    warnUnknownKeys(piMemory, "pi-memory", PI_MEMORY_KNOWN_KEYS);
    if (piMemory && typeof piMemory === "object" && typeof piMemory.localPath === "string" && piMemory.localPath) {
      return resolve(cwd, piMemory.localPath, "memory.db");
    }
    const piTotalRecall = settings?.["pi-total-recall"];
    warnUnknownKeys(piTotalRecall, "pi-total-recall", PI_TOTAL_RECALL_KNOWN_KEYS);
    if (piTotalRecall && typeof piTotalRecall === "object" && typeof piTotalRecall.localPath === "string" && piTotalRecall.localPath) {
      return resolve(cwd, piTotalRecall.localPath, "memory", "memory.db");
    }
  } catch {
  }
  return DEFAULT_DB_PATH;
}
function mergeMemorySettings(config, memorySettings) {
  if (!memorySettings || typeof memorySettings !== "object") return;
  const m = memorySettings;
  if (m.lessonInjection === "all" || m.lessonInjection === "selective") {
    config.lessonInjection = m.lessonInjection;
  }
  if (typeof m.perTurnInjection === "boolean") {
    config.perTurnInjection = m.perTurnInjection;
  }
  if (m.injectionMode === "system-prompt" || m.injectionMode === "context-hook") {
    config.injectionMode = m.injectionMode;
  }
  if (typeof m.consolidationModel === "string" && m.consolidationModel.trim()) {
    config.consolidationModel = m.consolidationModel.trim();
  }
  if (typeof m.consolidationThinking === "string" && CONSOLIDATION_THINKING_LEVELS.includes(m.consolidationThinking)) {
    config.consolidationThinking = m.consolidationThinking;
  }
  config.embedding = parseEmbeddingSettings(m.embedding) ?? config.embedding;
}
var EMBEDDER_TYPES = ["openai", "bedrock", "ollama", "mistral", "openai-compatible"];
var EMBEDDING_KNOWN_KEYS = [
  "type",
  "apiKey",
  "model",
  "baseUrl",
  "sendDimensions",
  "batchSize",
  "profile",
  "region",
  "url",
  "dimensions"
];
function parseEmbeddingSettings(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const e = raw;
  warnUnknownKeys(e, "pi-memory.embedding", EMBEDDING_KNOWN_KEYS);
  const type = typeof e.type === "string" ? e.type.trim() : "";
  if (!EMBEDDER_TYPES.includes(type)) {
    console.error(
      `pi-memory: ignoring embedding block, "type" must be one of ${EMBEDDER_TYPES.join(", ")} (got ${JSON.stringify(e.type)})`
    );
    return void 0;
  }
  const out = { type };
  for (const k of ["apiKey", "model", "baseUrl", "profile", "region", "url"]) {
    const v = e[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  if (typeof e.dimensions === "number" && Number.isFinite(e.dimensions) && e.dimensions > 0) {
    out.dimensions = e.dimensions;
  }
  if (typeof e.batchSize === "number" && Number.isFinite(e.batchSize) && e.batchSize >= 1) {
    out.batchSize = Math.floor(e.batchSize);
  }
  if (typeof e.sendDimensions === "boolean") out.sendDimensions = e.sendDimensions;
  return out;
}
function readSettingsConfig(cwd) {
  const config = {};
  try {
    const raw = readFileSync2(GLOBAL_SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(raw);
    mergeMemorySettings(config, settings?.memory);
  } catch {
  }
  if (cwd) {
    try {
      const raw = readFileSync2(join2(cwd, ".pi", "settings.json"), "utf-8");
      const settings = JSON.parse(raw);
      mergeMemorySettings(config, settings?.memory ?? settings?.["pi-memory"]);
    } catch {
    }
  }
  return config;
}
function index_default(pi) {
  let store = null;
  let pendingTurns = [];
  let sessionCwd = "";
  let sessionId;
  let cachedCtx = null;
  let resolvedDbPath = DEFAULT_DB_PATH;
  let injectorConfig = readSettingsConfig();
  let draining = false;
  let currentJobId = null;
  let embedder = null;
  let embedFailure = null;
  let notifiedReasons = /* @__PURE__ */ new Set();
  function reportEmbedFailure(err, ctx = cachedCtx) {
    const cfg = injectorConfig.embedding;
    if (!cfg) return;
    embedFailure = diagnoseEmbedderError(err, cfg, PACKAGE_ROOT);
    if (notifiedReasons.has(embedFailure.reason)) return;
    notifiedReasons.add(embedFailure.reason);
    const text = `pi-memory: semantic search unavailable: ${embedFailure.reason}. ${embedFailure.hint} Keyword search still works.`;
    try {
      if (ctx?.hasUI) {
        ctx.ui.notify(text, "warning");
        return;
      }
    } catch {
    }
    console.error(text);
  }
  function getEmbedder() {
    if (embedder !== null) return embedder || null;
    const cfg = injectorConfig.embedding;
    if (!cfg) {
      embedder = false;
      return null;
    }
    try {
      embedder = createEmbedder(cfg);
      return embedder;
    } catch (err) {
      reportEmbedFailure(err);
      embedder = false;
      return null;
    }
  }
  function embedEntry(key, value, ctx) {
    const emb = getEmbedder();
    if (!emb || !store) return;
    const text = `${key.split(".").slice(1).join(" ")} ${value}`.trim();
    emb.embed(text).then((vec) => {
      embedFailure = null;
      if (vec && vec.length > 0 && store) store.setEmbedding(key.toLowerCase(), Float32Array.from(vec));
    }).catch((err) => reportEmbedFailure(err, ctx));
  }
  const DEFAULT_EMBED_DIMENSIONS = 512;
  async function backfillEmbeddings(ctx, max = 64, batch = 16) {
    const emb = getEmbedder();
    if (!emb || !store) return;
    const dims = injectorConfig.embedding?.dimensions ?? DEFAULT_EMBED_DIMENSIONS;
    const todo = store.entriesNeedingEmbedding(dims, max);
    if (todo.length === 0) return;
    for (let i = 0; i < todo.length; i += batch) {
      const slice = todo.slice(i, i + batch);
      const texts = slice.map((e) => `${e.key.split(".").slice(1).join(" ")} ${e.value}`.trim());
      try {
        const vectors = await emb.embedBatch(texts);
        embedFailure = null;
        vectors.forEach((vec, j) => {
          const entry = slice[j];
          if (vec && vec.length > 0 && entry && store) {
            store.setEmbedding(entry.key.toLowerCase(), Float32Array.from(vec));
          }
        });
      } catch (err) {
        reportEmbedFailure(err, ctx);
        return;
      }
    }
  }
  const EMBED_TIMEOUT_MS = 1500;
  async function searchMemory(query, limit, ctx) {
    if (!store) return [];
    const pool = Math.max(limit * 2, 20);
    const lexical = store.searchSemantic(query, pool);
    const emb = getEmbedder();
    if (!emb) return lexical.slice(0, limit);
    let semantic = [];
    try {
      const vec = await emb.embed(query, AbortSignal.timeout(EMBED_TIMEOUT_MS));
      embedFailure = null;
      if (vec && vec.length > 0) {
        semantic = store.searchSemanticByVector(Float32Array.from(vec), pool);
      }
    } catch (err) {
      const name = err?.name;
      if (name === "TimeoutError" || name === "AbortError") return lexical.slice(0, limit);
      reportEmbedFailure(err, ctx);
      return lexical.slice(0, limit);
    }
    if (semantic.length === 0) return lexical.slice(0, limit);
    return reciprocalRankFusion(lexical, semantic, (e) => e.key).slice(0, limit).map((r) => r.item);
  }
  let pendingContextBlock = null;
  let sessionIndex = null;
  function getSessionIndex() {
    if (sessionIndex) return sessionIndex;
    try {
      sessionIndex = new SessionIndex(join2(dirname3(resolvedDbPath), "sessions.db"));
      return sessionIndex;
    } catch (err) {
      try {
        cachedCtx?.ui?.notify?.(`pi-memory: session index unavailable: ${err.message}`, "warning");
      } catch {
      }
      return null;
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    try {
      sessionCwd = ctx.cwd;
      cachedCtx = ctx;
      sessionId = ctx.sessionManager?.getSessionId?.() ?? ctx.sessionId ?? ctx.session?.id;
      resolvedDbPath = resolveDbPath(sessionCwd);
      injectorConfig = readSettingsConfig(sessionCwd);
      store = new MemoryStore(resolvedDbPath);
      embedder = null;
      embedFailure = null;
      notifiedReasons = /* @__PURE__ */ new Set();
      getEmbedder();
      if (ctx.mode === "tui" || ctx.mode === "rpc") void backfillEmbeddings(ctx);
      pendingTurns = [];
      try {
        const branch = ctx.sessionManager.getBranch();
        for (const entry of branch) {
          if (entry.type !== "message") continue;
          const msg = entry.message;
          if (!msg) continue;
          recordTurn(msg.role, extractText(msg.content));
        }
      } catch {
      }
      const stats = store.stats();
      if (stats.semantic + stats.lessons > 0) {
        ctx.ui.setStatus("pi-memory", `Memory: ${stats.semantic} facts, ${stats.lessons} lessons`);
        setTimeout(() => {
          try {
            ctx.ui.setStatus("pi-memory", "");
          } catch {
          }
        }, 5e3);
      }
      if (injectorConfig.perTurnInjection === false) {
        try {
          const alreadyInjected = ctx.sessionManager.getEntries().some(
            (e) => e.type === "custom_message" && e.customType === "pi-memory-context"
          );
          if (!alreadyInjected) {
            const { text, stats: injStats } = await buildContextBlock(
              store,
              sessionCwd,
              void 0,
              // no prompt → fallback: dump all relevant memory
              injectorConfig
            );
            if (text) {
              pi.sendMessage({
                customType: "pi-memory-context",
                content: text,
                display: false,
                details: injStats
              });
            }
          }
        } catch {
        }
      }
    } catch (err) {
      ctx.ui.notify(`pi-memory: failed to open store: ${err.message}`, "warning");
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!store) return;
    if (injectorConfig.perTurnInjection === false) return;
    const { text } = await buildContextBlock(store, ctx.cwd, event.prompt, injectorConfig, {
      searchFacts: (query, limit) => searchMemory(query, limit, ctx)
    });
    const mode = injectorConfig.injectionMode ?? "context-hook";
    if (mode === "system-prompt") {
      pendingContextBlock = null;
      if (!text) return;
      return { systemPrompt: `${event.systemPrompt}

${text}` };
    }
    pendingContextBlock = text || null;
    return;
  });
  pi.on("context", async (event, _ctx) => {
    if (!store) return;
    if (injectorConfig.perTurnInjection === false) return;
    if ((injectorConfig.injectionMode ?? "context-hook") !== "context-hook") return;
    if (!pendingContextBlock) return;
    const msgs = event.messages;
    if (!msgs || msgs.length === 0) return;
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;
    const recallMessage = {
      role: "user",
      content: pendingContextBlock,
      timestamp: Date.now()
    };
    return { messages: [...msgs.slice(0, idx), recallMessage, ...msgs.slice(idx)] };
  });
  pi.on("agent_end", async (event, _ctx) => {
    for (const msg of event.messages) {
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      recordTurn(msg.role, "content" in msg ? extractText(msg.content) : "");
    }
  });
  pi.on("session_before_switch", () => {
    enqueuePendingTail();
  });
  pi.on("session_shutdown", async () => {
    if (sessionIndex) {
      try {
        sessionIndex.close();
      } catch {
      }
      sessionIndex = null;
    }
    if (!store) return;
    try {
      enqueuePendingTail();
      if (currentJobId !== null) store.releasePending(currentJobId);
    } catch {
    } finally {
      store.close();
      store = null;
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    enqueuePendingTail();
    if (ctx.mode === "tui" || ctx.mode === "rpc") void drainPending(ctx);
  });
  function enqueuePendingTail() {
    if (!store || pendingTurns.length < 3) return;
    try {
      store.enqueuePending(
        `${sessionId ?? "unknown"}:${resolvedDbPath}:${sessionCwd}`,
        consolidationInput(),
        pendingTurns.length
      );
      pendingTurns = [];
    } catch {
    }
  }
  function consolidationInput() {
    return {
      turns: pendingTurns,
      userMessages: pendingTurns.map((t) => t.user),
      assistantMessages: pendingTurns.map((t) => t.assistant).filter((t) => !!t),
      cwd: sessionCwd,
      sessionId
    };
  }
  function failOrDrop(s, jobId, reason) {
    try {
      const attempts = s.withBusyTimeout(DB_YIELD_MS, () => s.failPending(jobId));
      if (attempts < MAX_CONSOLIDATION_ATTEMPTS) {
        console.error(`pi-memory: ${reason} (attempt ${attempts}/${MAX_CONSOLIDATION_ATTEMPTS}); queued for a later idle moment`);
        return "retry";
      }
      s.withBusyTimeout(DB_YIELD_MS, () => s.deletePending(jobId));
      console.error(`pi-memory: dropping the queued tail after ${attempts} attempts (${reason})`);
      return "dropped";
    } catch {
      return "retry";
    }
  }
  function recordTurn(role, text) {
    if (!text) return;
    if (role === "user") {
      pendingTurns.push({ user: text });
      if (pendingTurns.length > 60) pendingTurns.shift();
    } else if (role === "assistant") {
      const last = pendingTurns[pendingTurns.length - 1];
      if (last) last.assistant = text;
    }
  }
  async function drainPending(ctx) {
    if (draining) return;
    draining = true;
    let showedStatus = false;
    try {
      for (; ; ) {
        const s = store;
        if (!s) return;
        let job;
        try {
          job = s.withBusyTimeout(DB_YIELD_MS, () => s.claimPending());
        } catch {
          return;
        }
        if (!job) return;
        currentJobId = job.id;
        if (!showedStatus) {
          showedStatus = true;
          try {
            ctx?.ui?.setStatus("pi-memory", "\u{1F9E0} Consolidating memory...");
          } catch {
          }
        }
        let input;
        try {
          input = JSON.parse(job.payload);
        } catch {
          try {
            s.withBusyTimeout(DB_YIELD_MS, () => s.deletePending(job.id));
          } catch {
          }
          currentJobId = null;
          continue;
        }
        const extracted = await extractFrom(input);
        if (store !== s) {
          try {
            s.withBusyTimeout(DB_YIELD_MS, () => s.releasePending(job.id));
          } catch {
          }
          currentJobId = null;
          return;
        }
        if (!extracted) {
          const outcome = failOrDrop(s, job.id, "consolidation model call failed");
          currentJobId = null;
          if (outcome === "retry") return;
          continue;
        }
        try {
          s.withBusyTimeout(DB_YIELD_MS, () => applyExtraction(s, input, extracted, job.id));
          currentJobId = null;
        } catch (err) {
          if (isBusyError(err)) {
            try {
              s.withBusyTimeout(DB_YIELD_MS, () => s.releasePending(job.id));
            } catch {
            }
          } else {
            failOrDrop(s, job.id, "writing the extraction failed");
          }
          currentJobId = null;
          return;
        }
      }
    } finally {
      if (showedStatus) {
        try {
          ctx?.ui?.setStatus("pi-memory", "");
        } catch {
        }
      }
      draining = false;
    }
  }
  async function extractFrom(input) {
    if (!store) return null;
    const currentFacts = store.listSemantic(void 0, 200).map((f) => ({ key: f.key, value: f.value }));
    const currentLessons = store.listLessons(void 0, 100).map((l) => ({ rule: l.rule, category: l.category }));
    const prompt = buildConsolidationPrompt(input, currentFacts, currentLessons);
    const EXEC_TIMEOUT_MS = 45e3;
    const HARD_TIMEOUT_MS = 6e4;
    let backstopHandle;
    try {
      const execPromise = pi.exec("pi", [
        "-p",
        prompt,
        "--print",
        "--no-extensions",
        "--no-tools",
        "--no-session",
        "--model",
        injectorConfig.consolidationModel ?? DEFAULT_CONSOLIDATION_MODEL,
        // Left unset, the child inherits the global defaultThinkingLevel; see
        // InjectorConfig.consolidationThinking.
        ...injectorConfig.consolidationThinking ? ["--thinking", injectorConfig.consolidationThinking] : []
      ], {
        timeout: EXEC_TIMEOUT_MS,
        cwd: input.cwd ?? sessionCwd
      });
      const result = await Promise.race([
        execPromise,
        new Promise((_, reject) => {
          backstopHandle = setTimeout(
            () => reject(new Error("consolidation backstop timeout")),
            HARD_TIMEOUT_MS
          );
        })
      ]);
      if (result.code !== 0 || !result.stdout) return null;
      return parseConsolidationResponse(result.stdout);
    } catch {
      return null;
    } finally {
      if (backstopHandle) clearTimeout(backstopHandle);
    }
  }
  function applyExtraction(s, input, extracted, jobId) {
    const slug = input.cwd ? projectSlug(input.cwd) : void 0;
    s.transaction(() => {
      const applied = applyExtracted(s, extracted, `session:${input.sessionId ?? "unknown"}`, slug || void 0, input.sessionId);
      if (jobId !== null) s.deletePending(jobId);
      if (applied.semantic + applied.lessons > 0) {
        console.error(`pi-memory: consolidated ${applied.semantic} facts, ${applied.lessons} lessons`);
      }
    });
  }
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search persistent memory for facts, preferences, and project patterns the user has established across sessions.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)" }))
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!store) return ok("Memory store not initialized");
      const searchParams = params;
      const results = await searchMemory(searchParams.query, searchParams.limit ?? 10, ctx);
      if (results.length === 0) {
        return ok("No matching memories found.");
      }
      const text = results.map(
        (r) => `${r.key}: ${r.value} (confidence: ${r.confidence}, source: ${r.source})`
      ).join("\n");
      return ok(text);
    }
  });
  pi.registerTool({
    name: "memory_remember",
    label: "Memory Remember",
    description: "Store a fact, preference, or lesson in persistent memory. Use dotted keys like pref.editor, project.rosie.lang, tool.sed.usage. For corrections, use type='lesson'.",
    parameters: Type.Object({
      type: Type.String({ description: "'fact' for key-value, 'lesson' for a correction" }),
      key: Type.Optional(Type.String({ description: "Dotted key for facts (e.g. pref.commit_style)" })),
      value: Type.Optional(Type.String({ description: "Value for facts" })),
      rule: Type.Optional(Type.String({ description: "Rule text for lessons" })),
      category: Type.Optional(Type.String({ description: "Category for lessons (default: general)" })),
      negative: Type.Optional(Type.Boolean({ description: "True if this is something to AVOID" }))
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!store) return ok("Memory store not initialized");
      const input = params;
      const rememberParams = {
        ...input,
        type: stripQuotes(input.type),
        key: stripQuotes(input.key),
        value: stripQuotes(input.value),
        rule: stripQuotes(input.rule),
        category: stripQuotes(input.category)
      };
      if (rememberParams.type !== "fact" && rememberParams.type !== "lesson") {
        return ok(`Invalid type: ${rememberParams.type}. Must be 'fact' or 'lesson'.`);
      }
      if (rememberParams.type === "fact") {
        if (!rememberParams.key || !rememberParams.value) {
          return ok("Both key and value required for facts");
        }
        store.setSemantic(rememberParams.key, rememberParams.value, 0.95, "user");
        embedEntry(rememberParams.key, rememberParams.value, ctx);
        return ok(`Remembered: ${rememberParams.key} = ${rememberParams.value}`);
      }
      if (rememberParams.type === "lesson") {
        if (!rememberParams.rule) {
          return ok("Rule text required for lessons");
        }
        const result = store.addLesson(rememberParams.rule, rememberParams.category ?? "general", "user", rememberParams.negative ?? false);
        if (result.success) {
          return ok(`Lesson learned: ${rememberParams.rule}`);
        }
        return ok(`Already known (${result.reason}): ${rememberParams.rule}`);
      }
      return ok("Unknown type");
    }
  });
  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "Remove a fact or lesson from persistent memory.",
    parameters: Type.Object({
      type: Type.String(),
      key: Type.Optional(Type.String({ description: "Key for facts" })),
      id: Type.Optional(Type.String({ description: "ID for lessons" }))
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");
      const input = params;
      const forgetParams = {
        ...input,
        type: stripQuotes(input.type),
        key: stripQuotes(input.key),
        id: stripQuotes(input.id)
      };
      if (forgetParams.type !== "fact" && forgetParams.type !== "lesson") {
        return ok(`Invalid type: ${forgetParams.type}. Must be 'fact' or 'lesson'.`);
      }
      if (forgetParams.type === "fact" && forgetParams.key) {
        const deleted = store.deleteSemantic(forgetParams.key);
        return ok(deleted ? `Forgot: ${forgetParams.key}` : `Not found: ${forgetParams.key}`);
      }
      if (forgetParams.type === "lesson" && forgetParams.id) {
        const deleted = store.deleteLesson(forgetParams.id);
        return ok(deleted ? `Forgot lesson ${forgetParams.id}` : `Not found: ${forgetParams.id}`);
      }
      return ok("Provide key (for facts) or id (for lessons)");
    }
  });
  pi.registerTool({
    name: "memory_lessons",
    label: "Memory Lessons",
    description: "List learned corrections and lessons from past sessions.",
    parameters: Type.Object({
      category: Type.Optional(Type.String({ description: "Filter by category" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 50)" }))
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");
      const lessonsParams = params;
      const lessons = store.listLessons(lessonsParams.category, lessonsParams.limit ?? 50);
      if (lessons.length === 0) {
        return ok("No lessons learned yet.");
      }
      const text = lessons.map(
        (l) => `${l.negative ? "\u274C" : "\u2705"} [${l.category}] ${l.rule} (id: ${l.id.slice(0, 8)})`
      ).join("\n");
      return ok(text);
    }
  });
  pi.registerTool({
    name: "memory_stats",
    label: "Memory Stats",
    description: "Show memory statistics \u2014 how many facts, lessons, and events are stored.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, _ctx) {
      if (!store) return ok("Memory store not initialized");
      const stats = store.stats();
      const lines = [
        `Memory: ${stats.semantic} semantic facts, ${stats.lessons} active lessons, ${stats.events} events logged`,
        `DB: ${resolvedDbPath}`
      ];
      if (stats.pending > 0) {
        lines.push(`Queued: ${stats.pending} unconsolidated session tail(s), processed when the session goes idle`);
      }
      const cfg = injectorConfig.embedding;
      if (cfg) {
        const cov = store.embeddingCoverage();
        lines.push(
          `Search: hybrid (FTS5 + ${cfg.type}${cfg.model ? `/${cfg.model}` : ""}), ${cov.embedded}/${cov.total} embedded`
        );
        if (embedFailure) {
          lines.push(
            `Semantic search is failing: ${embedFailure.reason}. ${embedFailure.hint} Results come from keyword search until this is fixed.`
          );
        }
      } else {
        lines.push("Search: FTS5 keyword only (set memory.embedding to enable semantic search)");
      }
      const sessionsDb = join2(dirname3(resolvedDbPath), "sessions.db");
      if (existsSync2(sessionsDb)) {
        try {
          const s = getSessionIndex()?.stats();
          if (s) lines.push(`Sessions: ${s.sessions} transcript(s), ${s.docs} message(s) indexed for this project`);
        } catch {
        }
      }
      return ok(lines.join("\n"));
    }
  });
  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description: "Search your own past pi sessions in this working directory, or read one. Use it to recall what was DONE \u2014 commands that worked, where a file lives, what was decided \u2014 when memory_search (distilled facts) has nothing. Query words need 3+ characters; Chinese is supported.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Words to search transcripts for (3+ characters each)" })),
      session: Type.Optional(Type.String({ description: "Session id (or unique prefix) to read instead of searching" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10 for search, 40 messages for a read)" }))
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      const index = getSessionIndex();
      if (!index) return ok("Session index unavailable.");
      const input = params;
      const sessionArg = stripQuotes(input.session);
      if (sessionArg) {
        const messages = index.readSession(sessionArg, input.limit ?? 40);
        if (messages.length === 0) return ok(`No indexed messages for session ${sessionArg}.`);
        return ok(messages.map((m) => `[${m.ts}] ${m.role}: ${m.text}`).join("\n\n"));
      }
      const query = stripQuotes(input.query);
      if (!query || !query.trim()) {
        return ok("Pass `query` to search, or `session` to read one session.");
      }
      const cwd = sessionCwd ?? process.cwd();
      const { indexed, stale } = index.sync(SESSIONS_ROOT, cwd);
      const hits = index.search(query, input.limit ?? 10);
      const progress = stale > 0 ? `

${stale} session file(s) from this project are still indexing \u2014 call again to include them.` : "";
      if (hits.length === 0) {
        const why = indexed > 0 ? ` (${indexed} file(s) just indexed)` : "";
        return ok(`No session text matches "${query}".${why}${progress}`);
      }
      const lines = hits.map((h) => `${h.sessionId.slice(0, 8)}  ${h.ts}  ${h.role}: ${h.snippet}`);
      return ok(`${lines.join("\n")}

Read the surrounding turn with session_search({ session: "<id>" }).${progress}`);
    }
  });
  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger memory consolidation for the current session",
    async handler(_args, ctx) {
      if (!store) {
        ctx.ui.notify("Memory store not initialized", "warning");
        return;
      }
      if (pendingTurns.length < 2) {
        ctx.ui.notify("Not enough conversation to consolidate (need at least 2 user messages)", "warning");
        return;
      }
      ctx.ui.notify("Consolidating session memory...", "info");
      try {
        store.enqueuePending(
          `${sessionId ?? "unknown"}:${resolvedDbPath}:${sessionCwd}`,
          consolidationInput(),
          pendingTurns.length
        );
        pendingTurns = [];
        if (draining) {
          ctx.ui.notify("Consolidation already running \u2014 this tail is queued behind it", "info");
          return;
        }
        await drainPending(ctx);
        const stats = store.stats();
        const queued = stats.pending > 0 ? ` (${stats.pending} still queued)` : "";
        ctx.ui.notify(`Memory updated: ${stats.semantic} facts, ${stats.lessons} lessons${queued}`, "info");
      } catch (err) {
        ctx.ui.notify(`Consolidation failed: ${err.message}`, "error");
      }
    }
  });
}
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
  }
  return "";
}
export {
  DEFAULT_CONSOLIDATION_MODEL,
  MemoryStore,
  buildContextBlock,
  index_default as default,
  projectSlug,
  readSettingsConfig,
  resolveDbPath
};
//# sourceMappingURL=index.js.map
