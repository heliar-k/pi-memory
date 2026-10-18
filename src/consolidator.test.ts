import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildConsolidationPrompt,
  parseConsolidationResponse,
} from "./consolidator.js";

describe("buildConsolidationPrompt", () => {
  it("includes conversation messages", () => {
    const prompt = buildConsolidationPrompt({
      userMessages: ["Fix the daily note insertion"],
      assistantMessages: ["I'll use sed instead of echo >>"],
      cwd: "/workplace/samfp/Rosie",
    });
    assert.ok(prompt.includes("Fix the daily note insertion"));
    assert.ok(prompt.includes("sed instead of echo"));
    assert.ok(prompt.includes("/workplace/samfp/Rosie"));
  });

  it("truncates long messages", () => {
    const longMsg = "x".repeat(2000);
    const prompt = buildConsolidationPrompt({
      userMessages: [longMsg],
      assistantMessages: [],
    });
    assert.ok(prompt.length < longMsg.length + 5000);
  });

  it("caps at 30 message pairs", () => {
    const prompt = buildConsolidationPrompt({
      userMessages: Array(50).fill("msg"),
      assistantMessages: Array(50).fill("reply"),
    });
    const userCount = (prompt.match(/User: msg/g) || []).length;
    assert.ok(userCount <= 30);
  });

  it("pairs each user message with its own turn's answer", () => {
    // The legacy arrays drift: assistant messages include every tool step, so
    // index pairing puts turn 0's chatter next to turn 2's question.
    const prompt = buildConsolidationPrompt({
      userMessages: ["first question", "second question"],
      assistantMessages: ["tool preamble one", "tool preamble two", "final answer two"],
      turns: [
        { user: "first question", assistant: "final answer one" },
        { user: "second question", assistant: "final answer two" },
      ],
    });
    assert.match(prompt, /User: first question\n\nAssistant: final answer one/);
    assert.match(prompt, /User: second question\n\nAssistant: final answer two/);
    assert.ok(!prompt.includes("tool preamble"));
  });

  it("keeps the newest turns when there are more than 30", () => {
    const turns = Array.from({ length: 40 }, (_, i) => ({ user: `q${i}`, assistant: `a${i}` }));
    const prompt = buildConsolidationPrompt({ userMessages: [], assistantMessages: [], turns });
    assert.ok(!prompt.includes("User: q9"), "oldest turns must be dropped");
    assert.ok(prompt.includes("User: q10"));
    assert.ok(prompt.includes("User: q39"));
    assert.equal((prompt.match(/User: q/g) || []).length, 30);
  });

  it("falls back to index pairing for payloads queued before turns existed", () => {
    const prompt = buildConsolidationPrompt({
      userMessages: ["old question"],
      assistantMessages: ["old answer"],
    });
    assert.match(prompt, /User: old question\n\nAssistant: old answer/);
  });

  it("includes current facts in prompt", () => {
    const prompt = buildConsolidationPrompt(
      { userMessages: ["hello"], assistantMessages: ["hi"] },
      [{ key: "pref.editor", value: "vim" }, { key: "wife", value: "Eryn" }],
      []
    );
    assert.ok(prompt.includes("Current Memory State"));
    assert.ok(prompt.includes("pref.editor: vim"));
    assert.ok(prompt.includes("wife: Eryn"));
  });

  it("includes current lessons in prompt", () => {
    const prompt = buildConsolidationPrompt(
      { userMessages: ["hello"], assistantMessages: ["hi"] },
      [],
      [{ rule: "Never hardcode secrets", category: "security" }]
    );
    assert.ok(prompt.includes("And these lessons"));
    assert.ok(prompt.includes("[security] Never hardcode secrets"));
  });

  it("truncates long values in memory state", () => {
    const longValue = "x".repeat(300);
    const prompt = buildConsolidationPrompt(
      { userMessages: ["hello"], assistantMessages: ["hi"] },
      [{ key: "test.long", value: longValue }],
      []
    );
    assert.ok(prompt.includes("\u2026")); // truncation indicator
    assert.ok(!prompt.includes(longValue)); // full value not present
  });
});

describe("parseConsolidationResponse", () => {
  it("parses valid JSON", () => {
    const result = parseConsolidationResponse(JSON.stringify({
      semantic: [{ key: "pref.editor", value: "vim", confidence: 0.9 }],
      lessons: [{ rule: "Use sed for daily notes", category: "vault", negative: true }],
    }));
    assert.equal(result.semantic.length, 1);
    assert.equal(result.semantic[0].key, "pref.editor");
    assert.equal(result.lessons.length, 1);
    assert.equal(result.lessons[0].negative, true);
  });

  it("parses JSON in markdown code block", () => {
    const result = parseConsolidationResponse(`Here's what I found:
\`\`\`json
{
  "semantic": [{ "key": "pref.style", "value": "functional", "confidence": 0.85 }],
  "lessons": []
}
\`\`\`
`);
    assert.equal(result.semantic.length, 1);
    assert.equal(result.semantic[0].key, "pref.style");
  });

  it("rejects low confidence", () => {
    const result = parseConsolidationResponse(JSON.stringify({
      semantic: [{ key: "pref.maybe", value: "unsure", confidence: 0.5 }],
      lessons: [],
    }));
    assert.equal(result.semantic.length, 0);
  });

  it("rejects invalid key format", () => {
    const result = parseConsolidationResponse(JSON.stringify({
      semantic: [{ key: "INVALID KEY!", value: "bad", confidence: 0.9 }],
      lessons: [],
    }));
    assert.equal(result.semantic.length, 0);
  });

  it("accepts flexible key prefixes like family, health, config", () => {
    const result = parseConsolidationResponse(JSON.stringify({
      semantic: [
        { key: "family.brother", value: "Joe", confidence: 0.95 },
        { key: "health.allergy", value: "penicillin", confidence: 0.9 },
        { key: "config.theme", value: "dark", confidence: 0.9 },
        { key: "wife", value: "Eryn", confidence: 0.95 },
      ],
      lessons: [],
    }));
    assert.equal(result.semantic.length, 4);
  });

  it("rejects single-char keys", () => {
    const result = parseConsolidationResponse(JSON.stringify({
      semantic: [{ key: "x", value: "too short", confidence: 0.9 }],
      lessons: [],
    }));
    assert.equal(result.semantic.length, 0);
  });

  it("returns empty for garbage input", () => {
    const result = parseConsolidationResponse("not json at all");
    assert.equal(result.semantic.length, 0);
    assert.equal(result.lessons.length, 0);
  });

  it("returns empty for empty response", () => {
    const result = parseConsolidationResponse("");
    assert.equal(result.semantic.length, 0);
    assert.equal(result.lessons.length, 0);
  });

  it("handles missing fields gracefully", () => {
    const result = parseConsolidationResponse(JSON.stringify({
      semantic: [{ key: "pref.x" }], // missing value and confidence
      lessons: [{}], // missing rule
    }));
    assert.equal(result.semantic.length, 0);
    assert.equal(result.lessons.length, 0);
  });
});
