import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, queryTerms } from "./store.js";

/**
 * Retrieval over CJK text.
 *
 * Regression guard for the bug this suite was written for: FTS5 has no CJK
 * segmenter, so a run of Chinese characters is indexed as ONE token. Before
 * the fix, `术语` matched 0 rows in a store whose value contained it, and every
 * Chinese prompt therefore injected nothing.
 */
describe("CJK retrieval", () => {
  let store: MemoryStore;
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-cjk-test-"));
    store = new MemoryStore(join(tmpDir, "test.db"));
  });

  after(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("splits CJK runs into bigrams and keeps latin words whole", () => {
    assert.deepEqual(queryTerms("网关 key 配置"), ["网关", "key", "配置"]);
    // A single CJK character is a word; a single latin character is noise.
    assert.deepEqual(queryTerms("看 a 图"), ["看", "图"]);
  });

  it("matches an interior Chinese substring", () => {
    store.setSemantic("pref.context_sync", "前端能力有变更后要同步补记 CONTEXT.md 的术语/能力词条", 0.85, "user");
    const hits = store.searchSemantic("术语");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.key, "pref.context_sync");
  });

  it("matches a whole Chinese sentence, not just a keyword", () => {
    assert.equal(store.searchSemantic("把术语补到 CONTEXT 里").length, 1);
  });

  it("returns nothing for unrelated Chinese", () => {
    assert.deepEqual(store.searchSemantic("量子力学"), []);
  });

  it("ranks the fact that covers more of the query first", () => {
    store.setSemantic("project.demo.deploy", "部署走网关", 0.9, "consolidation");
    store.setSemantic("project.demo.other", "部署脚本在 scripts/ 下", 0.9, "consolidation");

    const hits = store.searchSemantic("部署 网关");
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]!.key, "project.demo.deploy", "covering both terms must outrank covering one");
  });

  it("searches lessons the same way", () => {
    store.addLesson("不要用 echo >> 追加日记，用 sed 插入", "vault", "user", true);
    const hits = store.searchLessons("日记");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.category, "vault");
  });

  it("still ranks latin queries through FTS", () => {
    store.setSemantic("pref.a_ordering_strong", "orderingprobe orderingprobe orderingprobe", 0.9, "user");
    store.setSemantic("pref.z_ordering_weak", "orderingprobe", 0.9, "user");
    const keys = store.searchSemantic("orderingprobe").map(e => e.key);
    assert.equal(keys[0], "pref.a_ordering_strong");
  });
});

describe("embedding staleness", () => {
  let store: MemoryStore;
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-memory-embed-test-"));
    store = new MemoryStore(join(tmpDir, "test.db"));
  });

  after(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const vectorFor = (key: string) => store.getAllEmbeddings().find(r => r.key === key)?.embedding ?? null;

  it("drops the vector when the value changes", () => {
    store.setSemantic("tool.sed", "old text", 0.9, "user");
    store.setEmbedding("tool.sed", new Float32Array([1, 0, 0]));
    assert.ok(vectorFor("tool.sed"), "vector should be stored");

    store.setSemantic("tool.sed", "new text", 0.9, "user");
    assert.equal(vectorFor("tool.sed"), null, "an embedding of the old text must not keep ranking the fact");
  });

  it("keeps the vector when the value is unchanged", () => {
    store.setSemantic("tool.awk", "same text", 0.9, "user");
    store.setEmbedding("tool.awk", new Float32Array([0, 1, 0]));

    store.setSemantic("tool.awk", "same text", 0.9, "user");
    assert.ok(vectorFor("tool.awk"), "a no-op write should not force a re-embed");
  });

  it("records the session a fact came from", () => {
    store.setSemantic("pref.from_session", "value", 0.9, "consolidation", "session-abc");
    assert.equal(store.getSemantic("pref.from_session")?.session_id, "session-abc");
  });
});
