import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import piMemory from "./index.js";
import { MemoryStore } from "./store.js";

type PiMemoryApi = Parameters<typeof piMemory>[0];
type TestSessionContext = ReturnType<typeof createSessionContext>["ctx"];
type Handler = (event: unknown, ctx: TestSessionContext) => Promise<void> | void;

function createHarness() {
  const handlers = new Map<string, Handler>();
  const execCalls: unknown[] = [];
  const pi = {
    on(eventName: string, handler: Handler) {
      handlers.set(eventName, handler);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
    async exec(...args: unknown[]) {
      execCalls.push(args);
      return { code: 0, stdout: '{"semantic":[],"lessons":[]}' };
    },
  };

  piMemory(pi as unknown as PiMemoryApi);

  return { handlers, execCalls };
}

function createSessionContext(tmpProject: string) {
  const statuses: string[] = [];
  const ctx = {
    cwd: tmpProject,
    ui: {
      setStatus(_key: string, value: string) {
        statuses.push(value);
      },
      notify() {},
    },
    sessionManager: {
      getBranch() {
        return [];
      },
      getEntries() {
        return [];
      },
    },
  };

  return { ctx, statuses };
}

function createTempProject() {
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-shutdown-"));
  fs.mkdirSync(path.join(tmpProject, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpProject, ".pi", "settings.json"),
    JSON.stringify({
      "pi-memory": { localPath: path.join(tmpProject, "memory") },
      memory: { consolidationModel: "test/model" },
    }),
    "utf-8",
  );
  return tmpProject;
}

/** Conversations the extension considers worth consolidating. */
const threeTurns = {
  messages: ["one", "two", "three"].flatMap((n) => [
    { role: "user", content: `remember preference ${n}` },
    { role: "assistant", content: "ok" },
  ]),
};

function pendingJobs(tmpProject: string): number {
  const store = new MemoryStore(path.join(tmpProject, "memory", "memory.db"));
  try {
    return store.pendingCount();
  } finally {
    store.close();
  }
}

describe("session_shutdown", () => {
  it("queues the tail instead of waiting on the consolidation model", async () => {
    const tmpProject = createTempProject();
    try {
      const { handlers, execCalls } = createHarness();
      const { ctx, statuses } = createSessionContext(tmpProject);

      await handlers.get("session_start")?.({}, ctx);
      await handlers.get("agent_end")?.(threeTurns, ctx);
      await handlers.get("session_shutdown")?.({}, ctx);

      // The whole point: quitting never spawns the consolidation subprocess.
      assert.equal(execCalls.length, 0);
      assert.ok(!statuses.includes("🧠 Consolidating memory..."));

      // …and nothing is lost: the tail is durable and a later drain picks it up.
      assert.equal(pendingJobs(tmpProject), 1);
    } finally {
      fs.rmSync(tmpProject, { recursive: true, force: true });
    }
  });

  it("queues nothing when there is no conversation to consolidate", async () => {
    const tmpProject = createTempProject();
    try {
      const { handlers, execCalls } = createHarness();
      const { ctx, statuses } = createSessionContext(tmpProject);

      await handlers.get("session_start")?.({}, ctx);
      await handlers.get("session_shutdown")?.({}, ctx);

      assert.equal(execCalls.length, 0);
      assert.ok(!statuses.includes("🧠 Consolidating memory..."));
      assert.equal(pendingJobs(tmpProject), 0);
    } finally {
      fs.rmSync(tmpProject, { recursive: true, force: true });
    }
  });
});
