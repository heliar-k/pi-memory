/**
 * Drives the extension through its registered hooks and tools with a stub
 * ExtensionAPI, so behaviour is checked end-to-end rather than per helper.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// pi-memory reads ~/.pi/agent/settings.json; point HOME at an empty dir so a
// developer's real config (e.g. a live embedding provider) cannot leak in.
// node --test runs each file in its own process, so this stays local.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-home-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
const { default: piMemory } = await import("./index.js");
const { MemoryStore } = await import("./store.js");

type Api = Parameters<typeof piMemory>[0];
type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> };

function createHarness(memorySettings: Record<string, unknown>) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-hooks-"));
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".pi", "settings.json"),
    JSON.stringify({ "pi-memory": { localPath: path.join(project, "memory") }, memory: memorySettings }),
  );

  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const notifications: { text: string; level?: string }[] = [];
  const sent: { customType?: string; content?: string }[] = [];
  const execCalls: unknown[][] = [];
  const exec = { code: 0 };
  const pi = {
    on: (name: string, h: Handler) => void handlers.set(name, h),
    registerTool: (t: Tool & { name: string }) => void tools.set(t.name, t),
    registerCommand() {},
    sendMessage: (m: { customType?: string; content?: string }) => void sent.push(m),
    exec: async (...args: unknown[]) => {
      execCalls.push(args);
      if (exec.code !== 0) return { code: exec.code, stdout: "" };
      return { code: 0, stdout: '{"semantic":[],"lessons":[]}' };
    },
  };
  piMemory(pi as unknown as Api);

  const ctx = {
    cwd: project,
    // tui is the mode where idle-time drains are allowed to run.
    mode: "tui",
    hasUI: true,
    ui: {
      notify: (text: string, level?: string) => void notifications.push({ text, level }),
    },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
  };

  const call = async (tool: string, params: Record<string, unknown>) =>
    (await tools.get(tool)!.execute("id", params, undefined, undefined, ctx)).content[0]!.text;

  return {
    ctx,
    project,
    handlers,
    notifications,
    sent,
    execCalls,
    /** Force the consolidation subprocess to fail, or restore it. */
    setExecCode: (code: number) => { exec.code = code; },
    call,
    async cleanup() {
      await handlers.get("session_shutdown")?.({}, ctx);
      fs.rmSync(project, { recursive: true, force: true });
    },
  };
}

async function withoutEnv<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env[name];
  delete process.env[name];
  try {
    return await fn();
  } finally {
    if (saved !== undefined) process.env[name] = saved;
  }
}

describe("embedding failures are surfaced, not silent (#30)", () => {
  it("notifies once with cause and fix, and keyword search keeps working", async () => {
    await withoutEnv("OPENAI_API_KEY", async () => {
      const h = createHarness({ embedding: { type: "openai" } });
      try {
        await h.handlers.get("session_start")!({}, h.ctx);

        assert.equal(h.notifications.length, 1);
        const [note] = h.notifications;
        assert.equal(note!.level, "warning");
        assert.match(note!.text, /semantic search unavailable: no API key is configured for openai embeddings/);
        assert.match(note!.text, /OPENAI_API_KEY/);
        assert.match(note!.text, /Keyword search still works/);

        await h.call("memory_remember", { type: "fact", key: "pref.editor", value: "nvim with lazy.nvim" });
        assert.match(await h.call("memory_search", { query: "editor" }), /pref\.editor: nvim with lazy\.nvim/);
        assert.match(await h.call("memory_stats", {}), /Semantic search is failing: no API key/);
        assert.equal(h.notifications.length, 1, "same cause must not be re-notified");
      } finally {
        await h.cleanup();
      }
    });
  });

  it("reports a provider that fails at query time and still returns lexical hits", async () => {
    // Loopback port 9 refuses connections immediately; no network needed.
    const h = createHarness({ embedding: { type: "ollama", url: "http://127.0.0.1:9" } });
    try {
      await h.handlers.get("session_start")!({}, h.ctx);
      assert.equal(h.notifications.length, 0, "nothing to embed yet, nothing to report");

      await h.call("memory_remember", { type: "fact", key: "tool.jq.usage", value: "prefer jq over python for JSON" });
      assert.match(await h.call("memory_search", { query: "jq" }), /tool\.jq\.usage/);

      assert.equal(h.notifications.length, 1);
      assert.match(h.notifications[0]!.text, /Ollama is not reachable at http:\/\/127\.0\.0\.1:9/);
      assert.match(h.notifications[0]!.text, /ollama serve/);
    } finally {
      await h.cleanup();
    }
  });
});

describe("per-turn injection through the hooks", () => {
  const conversation = [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
    { role: "user", content: "which editor do I use?" },
    { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "file" }] },
  ];

  async function seeded(memorySettings: Record<string, unknown>) {
    const h = createHarness(memorySettings);
    await h.handlers.get("session_start")!({}, h.ctx);
    await h.call("memory_remember", { type: "fact", key: "pref.editor", value: "neovim editor with lazy.nvim" });
    return h;
  }

  it("context-hook (default): leaves the system prompt alone and splices memory before the latest user turn", async () => {
    const h = await seeded({});
    try {
      const start = await h.handlers.get("before_agent_start")!(
        { prompt: "which editor do I use?", systemPrompt: "SYS" },
        h.ctx,
      );
      assert.equal(start, undefined, "system prompt must not be modified");

      const messages = conversation.map((m) => ({ ...m }));
      // Called on every LLM call in the turn, including tool-call continuations.
      for (let call = 0; call < 2; call++) {
        const out = (await h.handlers.get("context")!({ messages }, h.ctx)) as { messages: any[] };
        assert.equal(out.messages.length, conversation.length + 1);
        assert.equal(out.messages[2].role, "user");
        assert.match(out.messages[2].content, /^<memory>/);
        assert.match(out.messages[2].content, /editor: neovim editor with lazy\.nvim/);
        assert.equal(out.messages[3].content, "which editor do I use?", "user question stays the last user turn");
        assert.equal(out.messages.at(-1).role, "toolResult");
      }
      assert.equal(messages.length, conversation.length, "event.messages is not mutated");
    } finally {
      await h.cleanup();
    }
  });

  it("context-hook: injects nothing when no memory matches", async () => {
    const h = createHarness({});
    try {
      await h.handlers.get("session_start")!({}, h.ctx);
      await h.handlers.get("before_agent_start")!({ prompt: "unrelated", systemPrompt: "SYS" }, h.ctx);
      assert.equal(await h.handlers.get("context")!({ messages: conversation }, h.ctx), undefined);
    } finally {
      await h.cleanup();
    }
  });

  it("system-prompt mode appends to the system prompt and skips the context hook", async () => {
    const h = await seeded({ injectionMode: "system-prompt" });
    try {
      const start = (await h.handlers.get("before_agent_start")!(
        { prompt: "which editor do I use?", systemPrompt: "SYS" },
        h.ctx,
      )) as { systemPrompt: string };
      assert.match(start.systemPrompt, /^SYS\n\n<memory>/);
      assert.match(start.systemPrompt, /editor: neovim editor with lazy\.nvim/);
      assert.equal(await h.handlers.get("context")!({ messages: conversation }, h.ctx), undefined);
    } finally {
      await h.cleanup();
    }
  });

  it("perTurnInjection: false injects once at session_start instead", async (t) => {
    // session_start with a non-empty store arms a 5s status-clear timer.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = createHarness({ perTurnInjection: false });
    try {
      await h.handlers.get("session_start")!({}, h.ctx);
      await h.call("memory_remember", { type: "fact", key: "pref.editor", value: "neovim editor" });
      // A later session over the same store gets the one-shot dump.
      await h.handlers.get("session_start")!({}, h.ctx);
      assert.equal(h.sent.filter((m) => m.customType === "pi-memory-context").length, 1);
      assert.equal(
        await h.handlers.get("before_agent_start")!({ prompt: "editor", systemPrompt: "SYS" }, h.ctx),
        undefined,
      );
      assert.equal(await h.handlers.get("context")!({ messages: conversation }, h.ctx), undefined);
    } finally {
      await h.cleanup();
    }
  });
});

describe("consolidation off the interaction path", () => {
  /** Poll the public stats tool until the background drain emptied the queue. */
  async function waitForDrain(
    h: ReturnType<typeof createHarness>,
  ): Promise<string> {
    for (let i = 0; i < 200; i++) {
      const text = await h.call("memory_stats", {});
      if (!text.includes("Queued:")) return text;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("background drain did not finish");
  }

  it("passes the configured thinking level to the consolidation subprocess", async () => {
    const h = createHarness({ consolidationModel: "test/model", consolidationThinking: "low" });
    try {
      await h.handlers.get("session_start")!({}, h.ctx);
      await h.handlers.get("agent_end")!(
        {
          messages: ["one", "two", "three"].flatMap((n) => [
            { role: "user", content: `remember preference ${n}` },
            { role: "assistant", content: "ok" },
          ]),
        },
        h.ctx,
      );
      await h.handlers.get("session_before_switch")!({}, h.ctx);
      await h.handlers.get("agent_settled")!({}, h.ctx);
      await waitForDrain(h);

      const args = h.execCalls[0]![1] as string[];
      assert.equal(args[args.indexOf("--thinking") + 1], "low");
    } finally {
      await h.cleanup();
    }
  });

  it("retries a failed consolidation, then drops it", async () => {
    const h = createHarness({ consolidationModel: "test/model" });
    const dbPath = path.join(h.project, "memory", "memory.db");
    const pending = () => {
      const store = new MemoryStore(dbPath);
      try {
        return store.pendingCount();
      } finally {
        store.close();
      }
    };
    const waitFor = async (predicate: () => boolean, label: string) => {
      for (let i = 0; i < 300; i++) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for ${label}`);
    };

    try {
      h.setExecCode(1); // provider or model failure
      await h.handlers.get("session_start")!({}, h.ctx);
      await h.handlers.get("agent_end")!(
        {
          messages: ["one", "two", "three"].flatMap((n) => [
            { role: "user", content: `remember preference ${n}` },
            { role: "assistant", content: "ok" },
          ]),
        },
        h.ctx,
      );

      for (const attempt of [1, 2, 3]) {
        await h.handlers.get("agent_settled")!({}, h.ctx);
        await waitFor(() => h.execCalls.length === attempt, `attempt ${attempt}`);
        await waitFor(() => pending() === (attempt < 3 ? 1 : 0), `queue after attempt ${attempt}`);
        assert.equal(pending(), attempt < 3 ? 1 : 0, `queue after attempt ${attempt}`);
      }
    } finally {
      await h.cleanup();
    }
  });

  it("a session switch queues the tail; the next idle moment drains it", async () => {
    const h = createHarness({ consolidationModel: "test/model" });
    try {
      await h.handlers.get("session_start")!({}, h.ctx);
      await h.handlers.get("agent_end")!(
        {
          messages: ["one", "two", "three"].flatMap((n) => [
            { role: "user", content: `remember preference ${n}` },
            { role: "assistant", content: "ok" },
          ]),
        },
        h.ctx,
      );

      // Switching must not wait for the model — only the queue write happens.
      await h.handlers.get("session_before_switch")!({}, h.ctx);
      assert.equal(h.execCalls.length, 0, "switch must not run the model");
      assert.match(await h.call("memory_stats", {}), /Queued: 1 /);

      // The idle moment drains it in the background.
      await h.handlers.get("agent_settled")!({}, h.ctx);
      const stats = await waitForDrain(h);
      assert.equal(h.execCalls.length, 1);
      assert.ok((h.execCalls[0]![1] as string[]).includes("test/model"));
      assert.doesNotMatch(stats, /Queued:/);
    } finally {
      await h.cleanup();
    }
  });
});
