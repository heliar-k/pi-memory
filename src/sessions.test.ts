import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionIndex, sessionDirFor, trigramTerms } from "./sessions.js";

const CWD = "/tmp/proj";
const SESSION = "2026-01-02T03-04-05-000Z_01a11459-4d53-7265-9559-9b9d706ebd59";
/** The id the index stores: the file name without its timestamp prefix. */
const SESSION_ID = SESSION.split("_").pop()!;

let root: string;
let sessionFile: string;

function message(role: string, content: unknown, ts = "2026-01-02T03:05:00.000Z"): string {
  return JSON.stringify({ type: "message", timestamp: ts, message: { role, content } });
}

describe("SessionIndex", () => {
  let index: SessionIndex;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "pi-memory-sessions-test-"));
    const dir = sessionDirFor(root, CWD);
    mkdirSync(dir, { recursive: true });
    sessionFile = join(dir, `${SESSION}.jsonl`);

    const lines = [
      JSON.stringify({ type: "session", version: 3, id: SESSION, cwd: CWD }),
      message("user", "帮我配置 magpie 网关的 key", "2026-01-02T03:05:00.000Z"),
      message("assistant", [{ type: "text", text: "Base URL 只填到 /v1，key 必须是完整真值" }], "2026-01-02T03:05:01.000Z"),
      // Not indexed: tool payloads and thinking dominate a transcript by size.
      JSON.stringify({ type: "message", timestamp: "2026-01-02T03:05:02.000Z", message: { role: "toolResult", content: "SHOULD_NOT_APPEAR" } }),
      message("assistant", [{ type: "thinking", thinking: "SHOULD_NOT_APPEAR" }, { type: "text", text: "改用 sed 插入日记" }]),
    ];
    writeFileSync(sessionFile, lines.join("\n") + "\n", "utf-8");

    index = new SessionIndex(join(root, "index.db"));
  });

  after(() => {
    index.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("derives the session directory the way pi encodes it", () => {
    assert.equal(sessionDirFor("/sessions", "/Users/guankai"), "/sessions/--Users-guankai--");
    assert.equal(sessionDirFor("/sessions", "/Users/guankai/code/x"), "/sessions/--Users-guankai-code-x--");
  });

  it("keeps latin words whole and windows CJK runs at 3 characters", () => {
    assert.deepEqual(trigramTerms("gateway"), ["gateway"]);
    assert.deepEqual(trigramTerms("ab"), [], "terms shorter than a trigram cannot match");
    assert.deepEqual(trigramTerms("网关配置"), ["网关配", "关配置"]);
  });

  it("indexes message text only", () => {
    const { indexed } = index.sync(root, CWD);
    assert.equal(indexed, 1);
    assert.equal(index.search("SHOULD_NOT_APPEAR").length, 0);
  });

  it("finds Chinese text of 3+ characters", () => {
    const hits = index.search("网关的 key");
    assert.ok(hits.length > 0);
    assert.equal(hits[0]!.sessionId, SESSION_ID);
    // Documented limit: trigram windows are 3 characters wide.
    assert.equal(index.search("网关").length, 0);
  });

  it("finds latin text and marks the match", () => {
    const hits = index.search("base URL");
    assert.ok(hits.length > 0);
    assert.ok(hits[0]!.snippet.includes("»"), "the snippet should mark the matched text");
  });

  it("re-reads nothing when the files are unchanged", () => {
    const second = index.sync(root, CWD);
    assert.equal(second.indexed, 0);
    assert.equal(second.stale, 0);
  });

  it("re-indexes an appended file", () => {
    appendFileSync(sessionFile, message("user", "追加：还想记住 tempfile 这个用法") + "\n", "utf-8");
    const { indexed } = index.sync(root, CWD);
    assert.equal(indexed, 1);
    assert.ok(index.search("tempfile").length > 0);
  });

  it("reads a session oldest-first", () => {
    const messages = index.readSession(SESSION_ID.slice(0, 8));
    assert.ok(messages.length >= 4);
    assert.equal(messages[0]!.role, "user");
    assert.ok(messages[0]!.text.includes("magpie"));
    assert.ok(messages[messages.length - 1]!.text.includes("tempfile"), "last message should be the newest");
  });

  it("scopes to one cwd: another project's sessions are not visible", () => {
    const otherDir = sessionDirFor(root, "/tmp/other-proj");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(
      join(otherDir, "2026-01-03T00-00-00-000Z_01a99999-0000-0000-0000-000000000000.jsonl"),
      message("user", "OTHER_PROJECT_MARKER") + "\n",
      "utf-8",
    );

    index.sync(root, CWD);
    assert.equal(index.search("OTHER_PROJECT_MARKER").length, 0);
  });

  it("prunes a session file deleted from disk", () => {
    const dir = sessionDirFor(root, CWD);
    const gone = join(dir, "2026-01-04T00-00-00-000Z_01a88888-0000-0000-0000-000000000000.jsonl");
    writeFileSync(gone, message("user", "DELETED_MARKER") + "\n", "utf-8");
    index.sync(root, CWD);
    assert.ok(index.search("DELETED_MARKER").length > 0);

    rmSync(gone);
    index.sync(root, CWD);
    assert.equal(index.search("DELETED_MARKER").length, 0);
  });
});
