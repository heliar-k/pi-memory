import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "./store.js";

// Same Node/Bun split as store.ts — these tests inspect the index from outside.
const require = createRequire(import.meta.url);
const DatabaseSync: new (path: string) => any =
  typeof (globalThis as any).Bun !== "undefined"
    ? require("bun:sqlite").Database
    : require("node:sqlite").DatabaseSync;

/** Rows in an FTS5 shadow table, read without going through MemoryStore. */
function shadowCount(dbPath: string, table: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  } finally {
    db.close();
  }
}

/** Run a statement outside MemoryStore, e.g. to age a queue claim. */
function execRaw(dbPath: string, sql: string, ...params: unknown[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

describe("MemoryStore", () => {
  let store: MemoryStore;
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
    store = new MemoryStore(join(tmpDir, "test.db"));
  });

  after(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("semantic", () => {
    it("set and get", () => {
      store.setSemantic("pref.editor", "vim", 0.9, "user");
      const entry = store.getSemantic("pref.editor");
      assert.ok(entry);
      assert.equal(entry.value, "vim");
      assert.equal(entry.confidence, 0.9);
      assert.equal(entry.source, "user");
    });

    it("higher confidence wins", () => {
      store.setSemantic("pref.theme", "dark", 0.9, "user");
      store.setSemantic("pref.theme", "light", 0.7, "consolidation");
      assert.equal(store.getSemantic("pref.theme")!.value, "dark");
    });

    it("same or higher confidence updates", () => {
      store.setSemantic("pref.lang", "typescript", 0.8, "consolidation");
      store.setSemantic("pref.lang", "rust", 0.9, "user");
      assert.equal(store.getSemantic("pref.lang")!.value, "rust");
    });

    it("list with prefix", () => {
      store.setSemantic("project.rosie.lang", "java", 0.9, "consolidation");
      store.setSemantic("project.rosie.di", "dagger", 0.9, "consolidation");
      const results = store.listSemantic("project.rosie.");
      assert.ok(results.length >= 2);
      assert.ok(results.some(r => r.key === "project.rosie.lang"));
    });

    it("search by keyword", () => {
      store.setSemantic("tool.sed", "use for daily note insertion", 0.9, "user");
      const results = store.searchSemantic("daily note");
      assert.ok(results.length > 0);
      assert.ok(results.some(r => r.key === "tool.sed"));
    });

    it("FTS5 search: basic query", () => {
      store.setSemantic("pref.music", "jazz and classical", 0.9, "user");
      const results = store.searchSemantic("jazz");
      assert.ok(results.some(r => r.key === "pref.music"));
    });

    it("FTS5 search: multi-term OR", () => {
      store.setSemantic("pref.food", "sushi is favorite", 0.9, "user");
      store.setSemantic("pref.drink", "coffee every morning", 0.9, "user");
      const results = store.searchSemantic("sushi coffee");
      assert.ok(results.length >= 2);
      assert.ok(results.some(r => r.key === "pref.food"));
      assert.ok(results.some(r => r.key === "pref.drink"));
    });

    it("FTS5 search: no results for nonsense", () => {
      const results = store.searchSemantic("xyzzyplugh");
      assert.equal(results.length, 0);
    });

    it("FTS5 search: special characters handled safely", () => {
      // Should not throw — special chars are quoted
      const results = store.searchSemantic('hello "world" (test)');
      assert.ok(Array.isArray(results));
    });

    it("touchAccessed updates last_accessed", () => {
      store.setSemantic("pref.accessed_test", "some value", 0.9, "user");
      const before = store.getSemantic("pref.accessed_test");
      assert.ok(!before!.last_accessed); // initially null

      store.touchAccessed(["pref.accessed_test"]);
      const after = store.getSemantic("pref.accessed_test");
      assert.ok(after!.last_accessed);
    });

    it("delete", () => {
      store.setSemantic("pref.temp", "value", 0.8, "user");
      assert.ok(store.getSemantic("pref.temp"));
      assert.ok(store.deleteSemantic("pref.temp"));
      assert.equal(store.getSemantic("pref.temp"), undefined);
    });

    it("delete nonexistent returns false", () => {
      assert.equal(store.deleteSemantic("pref.nonexistent"), false);
    });
  });

  describe("lessons", () => {
    it("add and list", () => {
      const result = store.addLesson("Use sed for daily notes, not echo >>", "vault", "user", true);
      assert.ok(result.success);
      assert.ok(result.id);

      const lessons = store.listLessons("vault");
      assert.ok(lessons.some(l => l.rule.includes("sed for daily")));
    });

    it("exact dedup", () => {
      store.addLesson("Always use conventional commits", "git");
      const result = store.addLesson("always use conventional commits", "git");
      assert.equal(result.success, false);
      assert.equal(result.reason, "duplicate");
    });

    it("jaccard dedup", () => {
      store.addLesson("Never hardcode secrets in source code", "security");
      const result = store.addLesson("Never hardcode secrets in the source code files", "security");
      assert.equal(result.success, false);
      assert.equal(result.reason, "similar");
    });

    it("soft delete", () => {
      const { id } = store.addLesson("Temporary lesson to delete", "test");
      assert.ok(id);
      assert.ok(store.deleteLesson(id!));
      assert.equal(store.getLesson(id!), undefined);
    });

    it("empty rule rejected", () => {
      const result = store.addLesson("", "test");
      assert.equal(result.success, false);
      assert.equal(result.reason, "empty rule");
    });

    it("negative flag preserved", () => {
      const { id } = store.addLesson("Do not use echo >> for vault notes", "vault", "user", true);
      const lesson = store.getLesson(id!);
      assert.ok(lesson);
      assert.equal(lesson.negative, true);
    });

    it("searchLessons by keyword", () => {
      store.addLesson("Always verify exploit PoC before report submission", "bug-bounty", "user", false);
      store.addLesson("Use conventional commits for all repos", "general", "user", false);

      const results = store.searchLessons("exploit PoC", 10);
      assert.ok(results.length > 0);
      assert.ok(results.some(r => r.rule.includes("exploit")));
    });

    it("searchLessons returns empty for nonsense", () => {
      const results = store.searchLessons("xyzzy12345 qqqqq", 10);
      assert.equal(results.length, 0);
    });

    it("project field is null when not provided", () => {
      const { id } = store.addLesson("Global rule with no project", "general", "user", false);
      const lesson = store.getLesson(id!);
      assert.ok(lesson);
      assert.equal(lesson.project, null);
    });

    it("project field is stored when provided", () => {
      const { id } = store.addLesson("Always use fabricca fixtures", "testing", "consolidation", false, "rise");
      const lesson = store.getLesson(id!);
      assert.ok(lesson);
      assert.equal(lesson.project, "rise");
    });

    it("listLessons with project filter excludes other-project lessons", () => {
      store.addLesson("Use fabricca for rise fixtures", "testing", "consolidation", false, "rise");
      store.addLesson("Use pytest fixtures for myapp", "testing", "consolidation", false, "myapp");
      store.addLesson("Always write tests", "general", "user", false); // null project

      const forMyapp = store.listLessons(undefined, 50, "myapp");
      const rules = forMyapp.map(l => l.rule);
      assert.ok(rules.some(r => r.includes("pytest")), "should include myapp lesson");
      assert.ok(rules.some(r => r.includes("Always write tests")), "should include null-project lesson");
      assert.ok(!rules.some(r => r.includes("fabricca")), "should exclude rise lesson");
    });

    it("listLessons with no project filter returns all", () => {
      store.addLesson("Rise-specific rule", "testing", "consolidation", false, "rise");
      store.addLesson("Global rule", "general", "user", false);

      const all = store.listLessons(undefined, 50);
      const rules = all.map(l => l.rule);
      assert.ok(rules.some(r => r.includes("Rise-specific")));
      assert.ok(rules.some(r => r.includes("Global rule")));
    });
  });

  describe("fts index maintenance", () => {
    it("keeps search working across a reopen with an in-sync index", () => {
      const dbPath = join(tmpDir, "reopen.db");
      const first = new MemoryStore(dbPath);
      first.setSemantic("pref.reopen", "survives a reopen", 0.9, "user");
      first.close();

      // Reopening must not need a rebuild to stay searchable.
      const second = new MemoryStore(dbPath);
      try {
        assert.ok(second.searchSemantic("reopen", 5).some(h => h.key === "pref.reopen"));
      } finally {
        second.close();
      }
    });

    it("rebuilds a stale index on open", () => {
      const dbPath = join(tmpDir, "stale.db");
      const first = new MemoryStore(dbPath);
      first.setSemantic("pref.stale", "index this row", 0.9, "user");
      first.close();

      // Simulate an index that lost its documents (pre-FTS migration, dropped
      // trigger, manual tampering) while the content table kept the rows.
      const raw = new DatabaseSync(dbPath);
      raw.exec(`INSERT INTO semantic_fts(semantic_fts) VALUES('delete-all')`);
      raw.close();
      assert.equal(shadowCount(dbPath, "semantic_fts_docsize"), 0);

      const reopened = new MemoryStore(dbPath);
      try {
        assert.ok(reopened.searchSemantic("stale", 5).some(h => h.key === "pref.stale"));
      } finally {
        reopened.close();
      }
      assert.equal(shadowCount(dbPath, "semantic_fts_docsize"), 1);
    });
  });

  describe("pending consolidation queue", () => {
    const dbPath = (name: string) => join(tmpDir, `queue-${name}.db`);
    const tail = (...messages: string[]) => ({ userMessages: messages, assistantMessages: [] });

    it("a claimed job is invisible until it is deleted", (t) => {
      const q = new MemoryStore(dbPath(t.name));
      try {
        q.enqueuePending("s1", tail("a", "b", "c"), 3);
        assert.equal(q.pendingCount(), 1);

        const job = q.claimPending();
        assert.ok(job);
        assert.deepEqual(JSON.parse(job!.payload).userMessages, ["a", "b", "c"]);

        // Claimed: a concurrent drainer must not take it as well.
        assert.equal(q.claimPending(), undefined);
        assert.equal(q.pendingCount(), 1, "claimed work is never silently dropped");

        q.deletePending(job!.id);
        assert.equal(q.pendingCount(), 0);
      } finally {
        q.close();
      }
    });

    it("re-offers a job whose drainer died mid-run", (t) => {
      const q = new MemoryStore(dbPath(t.name));
      try {
        q.enqueuePending("s1", tail("x", "y", "z"), 3);
        const job = q.claimPending()!;
        assert.equal(q.claimPending(), undefined);

        // A killed drain leaves the row claimed; after the stale window it is
        // offered again rather than lost.
        execRaw(dbPath(t.name), "UPDATE pending_consolidation SET claimed_at = datetime('now', '-11 minutes') WHERE id = ?", job.id);
        assert.equal(q.claimPending()?.id, job.id);
      } finally {
        q.close();
      }
    });

    it("re-queues a re-seeded tail instead of duplicating it", (t) => {
      const q = new MemoryStore(dbPath(t.name));
      try {
        // Every resumed session re-seeds its whole history, so the same tail
        // arrives again — it must not become a second job.
        q.enqueuePending("s1", tail("a", "b", "c"), 3);
        q.enqueuePending("s1", tail("a", "b", "c"), 3);
        assert.equal(q.pendingCount(), 1);

        // A tail that grew replaces the queued one.
        q.enqueuePending("s1", tail("a", "b", "c", "d"), 4);
        assert.equal(q.pendingCount(), 1);
        assert.deepEqual(JSON.parse(q.claimPending()!.payload).userMessages, ["a", "b", "c", "d"]);
      } finally {
        q.close();
      }
    });

    it("queues a shorter tail alongside an older one", (t) => {
      const q = new MemoryStore(dbPath(t.name));
      try {
        // A drain cleared the buffer, so this tail holds only the turns after
        // it — new information, not a duplicate of the older one.
        q.enqueuePending("s1", tail("a", "b", "c", "d"), 4);
        q.enqueuePending("s1", tail("e", "f", "g"), 3);
        assert.equal(q.pendingCount(), 2);
      } finally {
        q.close();
      }
    });

    it("can requeue a job while a newer tail is waiting", (t) => {
      const q = new MemoryStore(dbPath(t.name));
      try {
        q.enqueuePending("s1", tail("a", "b", "c"), 3);
        const job = q.claimPending()!;
        q.enqueuePending("s1", tail("d", "e", "f"), 3);

        // Regression: a partial unique index on (session_id WHERE unclaimed)
        // made both of these throw "UNIQUE constraint failed", so a claim could
        // never be handed back and attempts never reached their cap.
        assert.equal(q.failPending(job.id), 1);
        q.releasePending(job.id);
        assert.equal(q.pendingCount(), 2);
      } finally {
        q.close();
      }
    });

    it("queues a new job when one is already being drained", (t) => {
      const q = new MemoryStore(dbPath(t.name));
      try {
        q.enqueuePending("s1", tail("a", "b", "c"), 3);
        const inflight = q.claimPending()!;
        q.enqueuePending("s1", tail("d", "e", "f"), 3);
        assert.equal(q.pendingCount(), 2, "in-flight work is never overwritten");
        const next = q.claimPending()!;
        assert.notEqual(next.id, inflight.id);
        assert.deepEqual(JSON.parse(next.payload).userMessages, ["d", "e", "f"]);
      } finally {
        q.close();
      }
    });

    it("counts a failed attempt and puts the job back", (t) => {
      const q = new MemoryStore(dbPath(t.name));
      try {
        q.enqueuePending("s1", tail("a", "b", "c"), 3);
        const job = q.claimPending()!;

        assert.equal(q.failPending(job.id), 1);
        // Requeued immediately, so the next idle moment retries it.
        assert.equal(q.claimPending()?.id, job.id);
        assert.equal(q.failPending(job.id), 2);
        assert.equal(q.failPending(job.id), 3);
      } finally {
        q.close();
      }
    });

    it("stays bounded when drains keep failing", (t) => {
      const q = new MemoryStore(dbPath(t.name));
      try {
        for (let i = 0; i < 25; i++) {
          q.enqueuePending(`s${i}`, tail(`m${i}`), 1);
        }
        assert.equal(q.pendingCount(), 20);
        // Oldest first, and the five oldest were dropped — not the newest.
        assert.match(q.claimPending()!.payload, /m5/);
      } finally {
        q.close();
      }
    });

    it("is reported by stats", (t) => {
      const q = new MemoryStore(dbPath(t.name));
      try {
        assert.equal(q.stats().pending, 0);
        q.enqueuePending("s1", tail("a", "b", "c"), 3);
        assert.equal(q.stats().pending, 1);
      } finally {
        q.close();
      }
    });

    it("rolls back work that throws inside a transaction", (t) => {
      const q = new MemoryStore(dbPath(t.name));
      try {
        // Writing facts and dropping their job share one transaction, so a
        // failure must leave neither.
        assert.throws(() =>
          q.transaction(() => {
            q.setSemantic("pref.rolled_back", "must not persist", 0.9, "user");
            throw new Error("boom");
          }),
        );
        assert.equal(q.getSemantic("pref.rolled_back"), undefined);
      } finally {
        q.close();
      }
    });
  });

  describe("events", () => {
    it("logs operations", () => {
      const events = store.listEvents(100);
      assert.ok(events.length > 0);
      assert.ok(events.some(e => e.event_type === "create"));
    });
  });

  describe("stats", () => {
    it("returns counts", () => {
      const stats = store.stats();
      assert.ok(stats.semantic > 0);
      assert.ok(stats.lessons > 0);
      assert.ok(stats.events > 0);
    });
  });
});
