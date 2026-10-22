/**
 * Builds a context block from memory for injection into the system prompt.
 *
 * Two modes:
 * - Selective (prompt provided): search semantic memory for entries relevant
 *   to the user's current prompt, plus always-inject lessons.
 * - Fallback (no prompt): dump top entries by prefix (old behavior).
 */
import type { MemoryStore, SemanticEntry, LessonEntry } from "./store.js";
import os from "node:os";

const MAX_CONTEXT_CHARS = 8000;
const SEARCH_LIMIT = 15;
const LESSON_SEARCH_LIMIT = 15;

export interface ContextBlock {
  text: string;
  stats: { semantic: number; lessons: number };
}

/**
 * Injected dependencies.
 *
 * `searchFacts` exists so the caller (the extension) can supply hybrid
 * retrieval — FTS5 fused with embeddings via RRF — without the injector
 * importing an embedding provider. The default is the store's lexical search.
 */
export interface InjectorDeps {
  searchFacts?: (query: string, limit: number) => Promise<SemanticEntry[]>;
}

/** One line that competes for the context budget. */
interface BlockItem {
  section: string;
  line: string;
  /** Higher survives the budget. Only comparable within one block. */
  score: number;
  /** Collection order — rendering keeps it so relevance order is preserved. */
  idx: number;
  kind: "semantic" | "lesson";
}

/** Rendering order of the sections. Also the priority when scores tie. */
const SECTION_ORDER = [
  "User Preferences",
  "Project Context",
  "Tool Preferences",
  "Relevant Memory",
  "Learned Corrections",
  "Validated Approaches",
  "User",
];

/**
 * Configuration for lesson injection behavior.
 * - "all": inject all lessons (original behavior, default)
 * - "selective": use semantic search to pick relevant lessons + category filtering
 */
export type LessonInjectionMode = "all" | "selective";

export const CONSOLIDATION_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ConsolidationThinking = (typeof CONSOLIDATION_THINKING_LEVELS)[number];

export interface InjectorConfig {
  lessonInjection?: LessonInjectionMode;
  /**
   * Optional embedding provider for semantic search. Absent -- the default --
   * means FTS5 BM25 only and needs no configuration.
   *
   * Shape mirrors EmbedderConfig in ./embedder.ts, typed structurally here so
   * injector.ts does not need the embedder import.
   */
  embedding?: {
    type: "openai" | "bedrock" | "ollama" | "mistral" | "openai-compatible";
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    sendDimensions?: boolean;
    profile?: string;
    region?: string;
    url?: string;
    dimensions?: number;
  };
  /**
   * Per-turn retrieval switch. Default (undefined or true): each user turn
   * runs a relevance search against the current prompt, and `injectionMode`
   * decides where the block goes.
   *
   * false: no per-turn retrieval; a one-shot fallback block (all relevant
   * memory, 8KB cap) is injected as a hidden message at session_start.
   */
  perTurnInjection?: boolean;
  /**
   * Controls how per-turn memory is spliced into the LLM context.
   * Only relevant when perTurnInjection is not false.
   *
   * "context-hook" (default): memory is injected as an ephemeral custom
   *   message immediately before the latest user message, via the
   *   pi.on("context") hook. The system prompt is never modified — it
   *   caches unconditionally. A memory content change only causes a cache
   *   miss at the injection point and forward (not from the system prompt
   *   root). Injected messages are NOT persisted to session history or
   *   fed back into consolidation.
   *
   * "system-prompt" (legacy v1.4.0 behavior): memory is appended to
   *   event.systemPrompt in before_agent_start. Cache-stable when memory
   *   content is unchanged, but a topic shift causes a cache miss that
   *   cascades from the system prompt root through all downstream messages.
   */
  injectionMode?: "system-prompt" | "context-hook";
  /**
   * Model string passed to `pi --model` for session-end consolidation.
   * When omitted, the built-in default is used.  Useful for users on
   * non-Anthropic providers (OpenAI/Codex/OpenRouter/Ollama/local),
   * or for picking a cheaper/faster model for background extraction.
   *
   * Invalid model strings will cause the consolidation sub-process to
   * fail — the existing try/catch swallows that silently, so the worst
   * case is that consolidation skips this session.
   */
  consolidationModel?: string;
  /**
   * Thinking level for the consolidation subprocess (`pi --thinking`).
   *
   * Without it the child inherits the global `defaultThinkingLevel`, which is
   * often tuned for the main agent (xhigh in one real config) — an odd fit for
   * extracting JSON, and it changes the key style the model produces.
   * Absent means "inherit", which is the upstream behaviour.
   */
  consolidationThinking?: ConsolidationThinking;
}

/**
 * Build context block. When `prompt` is provided, uses selective injection
 * (search-based). Otherwise falls back to prefix-based dump.
 */
export async function buildContextBlock(store: MemoryStore, cwd?: string, prompt?: string, config?: InjectorConfig, deps?: InjectorDeps): Promise<ContextBlock> {
  if (prompt?.trim()) {
    return buildSelectiveBlock(store, prompt, cwd, config, deps);
  }
  return buildFallbackBlock(store, cwd);
}

// ─── Selective injection ─────────────────────────────────────────────

async function buildSelectiveBlock(store: MemoryStore, prompt: string, cwd?: string, config?: InjectorConfig, deps?: InjectorDeps): Promise<ContextBlock> {
  const items: BlockItem[] = [];
  const mode = config?.lessonInjection ?? "all";

  // Search semantic memory using the user's prompt. `searchFacts` is the
  // hybrid path; without it this degrades to lexical-only, which is why the
  // extension always passes one.
  const searchFacts = deps?.searchFacts ?? ((q: string, l: number) => Promise.resolve(store.searchSemantic(q, l)));
  const results = await searchFacts(prompt, SEARCH_LIMIT);

  // Also search with project slug if we have a cwd, to pull in project context
  const slug = cwd ? projectSlug(cwd) : "";
  if (slug) {
    const projectResults = await searchFacts(slug, 5);
    // Merge, dedup by key
    const seen = new Set(results.map(r => r.key));
    for (const r of projectResults) {
      if (!seen.has(r.key)) {
        results.push(r);
        seen.add(r.key);
      }
    }
  }

  // Filter out project.* facts that belong to other projects.
  // FTS can match project facts from unrelated projects when their text
  // coincidentally matches the prompt (e.g. a prompt about "prisma" pulling
  // in rise.testing.fabricca). Keep only facts whose project segment
  // matches the current slug; non-project facts (pref.*, tool.*, user.*)
  // are always kept.
  const filteredResults = slug
    ? results.filter(r => {
        if (!r.key.startsWith("project.")) return true;
        const parts = r.key.split(".");
        return parts.length >= 2 && parts[1] === slug;
      })
    : results;

  // Shared dedup set — used by FTS search and prefix expansion below.
  const seen = new Set(filteredResults.map(r => r.key));

  // ── Prefix co-expansion ──────────────────────────────────────────────────
  // When any key in a sibling group appears in FTS results, pull a bounded set
  // of siblings under the same prefix to recover useful nearby context.
  const expandedPrefixes = new Set<string>();
  for (const r of [...filteredResults]) {  // snapshot — we push into filteredResults below
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
      kind: "semantic",
    });
  });

  if (filteredResults.length > 0) {
    // Track access time for these memories — one write for the whole set, and
    // the score above reads it back, so a fact that keeps proving useful
    // survives the budget when a stale one would not.
    store.touchAccessed(filteredResults.map(r => r.key));
  }

  // Inject lessons — either all or filtered by relevance + project scope
  const lessons = mode === "selective"
    ? getRelevantLessons(store, prompt, cwd)
    : store.listLessons(undefined, 50, slug || undefined);

  lessons.forEach((lesson, rank) => {
    items.push({
      section: lesson.negative ? "Learned Corrections" : "Validated Approaches",
      line: lesson.negative
        ? `DON'T: ${lesson.rule}${lesson.category !== "general" ? ` [${lesson.category}]` : ""}`
        : `${lesson.rule}${lesson.category !== "general" ? ` [${lesson.category}]` : ""}`,
      score: lessonScore(rank),
      idx: items.length,
      kind: "lesson",
    });
  });

  const user = store.listSemantic("user.", 10);
  user.forEach((entry, rank) => {
    items.push({
      section: "User",
      line: formatSemantic(entry),
      score: factScore(entry, rank),
      idx: items.length,
      kind: "semantic",
    });
  });

  return renderBlock(items);
}

// ─── Selective lesson injection ──────────────────────────────────────

/**
 * Get lessons relevant to the current prompt + project context.
 *
 * Strategy:
 * 1. Search lessons by prompt terms (semantic/FTS match)
 * 2. If cwd implies a project, also search by project slug
 * 3. Always include "general" category lessons (broadly applicable)
 * 4. Dedup and cap at LESSON_SEARCH_LIMIT
 */
function getRelevantLessons(store: MemoryStore, prompt: string, cwd?: string): LessonEntry[] {
  const seen = new Set<string>();
  const result: LessonEntry[] = [];

  function add(lessons: LessonEntry[]) {
    for (const l of lessons) {
      if (!seen.has(l.id)) {
        seen.add(l.id);
        result.push(l);
      }
    }
  }

  // 1. Search by prompt relevance (FTS across rule text + category)
  add(store.searchLessons(prompt, LESSON_SEARCH_LIMIT));

  // 2. Search by project slug if we have a cwd
  const slug = cwd ? projectSlug(cwd) : "";
  if (slug) {
    add(store.searchLessons(slug, 5));
  }

  // 3. Always include general lessons (they're broadly applicable)
  add(store.listLessons("general", 10));

  return result.slice(0, LESSON_SEARCH_LIMIT);
}

// ─── Fallback (no prompt) ────────────────────────────────────────────

function buildFallbackBlock(store: MemoryStore, cwd?: string): ContextBlock {
  const items: BlockItem[] = [];

  const push = (section: string, entries: SemanticEntry[], kind: BlockItem["kind"] = "semantic") => {
    entries.forEach((entry, rank) => {
      items.push({
        section,
        line: formatSemantic(entry),
        score: factScore(entry, rank),
        idx: items.length,
        kind,
      });
    });
  };

  push("User Preferences", store.listSemantic("pref.", 50));

  // Filter project facts to the current project only.
  // Match by exact second key segment (project.<slug>.<rest>) rather than
  // substring — avoids "pi" matching "project.pipefittingjobs.*" and prevents
  // user-set facts (confidence 0.95) from bleeding into unrelated sessions.
  const slug = cwd ? projectSlug(cwd) : "";
  const projects = store.listSemantic("project.", 50);
  const relevant = slug
    ? projects.filter(p => {
        const parts = p.key.split(".");
        return parts.length >= 2 && parts[1] === slug;
      })
    : projects;
  push("Project Context", relevant);

  push("Tool Preferences", store.listSemantic("tool.", 20));

  store.listLessons(undefined, 50, slug || undefined).forEach((lesson, rank) => {
    items.push({
      section: lesson.negative ? "Learned Corrections" : "Validated Approaches",
      line: lesson.negative
        ? `DON'T: ${lesson.rule}${lesson.category !== "general" ? ` [${lesson.category}]` : ""}`
        : `${lesson.rule}${lesson.category !== "general" ? ` [${lesson.category}]` : ""}`,
      score: lessonScore(rank),
      idx: items.length,
      kind: "lesson",
    });
  });

  push("User", store.listSemantic("user.", 10));

  return renderBlock(items);
}

// ─── Budget ──────────────────────────────────────────────────────────

/**
 * How much a fact is worth when the block does not fit.
 *
 * Retrieval rank dominates; confidence and recency-of-use only reorder facts
 * of comparable relevance. A fact nobody has read in 90 days loses half its
 * score, which is what keeps a stale preference from crowding out a current
 * one once the store outgrows `MAX_CONTEXT_CHARS`.
 */
function factScore(entry: SemanticEntry, rank: number): number {
  const base = 1 / (1 + rank);
  const confidence = 0.6 + 0.4 * entry.confidence;
  const stale = daysSince(entry.updated_at) >= VERY_STALE_DAYS ? 0.5 : 1;
  const usedRecently = entry.last_accessed && daysSince(entry.last_accessed) <= 7 ? 1.2 : 1;
  return base * confidence * stale * usedRecently;
}

/**
 * Lessons outrank facts of the same rank: a correction is the one thing this
 * extension exists to keep, and it already survived a dedup + acceptance test.
 */
function lessonScore(rank: number): number {
  return 1.25 / (1 + rank);
}

/**
 * Render the block under a fixed budget by dropping whole lines.
 *
 * The previous implementation sliced the finished string at 8000 chars, which
 * cut mid-line and deleted whole sections in a fixed order regardless of how
 * relevant they were. Here every line carries a score, the cheapest lines are
 * dropped first, and no line is ever split.
 */
function renderBlock(items: BlockItem[]): ContextBlock {
  if (items.length === 0) return { text: "", stats: { semantic: 0, lessons: 0 } };

  const overhead =
    "<memory>\n".length +
    "\n\n".length +
    MEMORY_DRIFT_CAVEAT.length +
    "\n</memory>".length;
  let budget = MAX_CONTEXT_CHARS - overhead;

  const kept = new Set<BlockItem>();
  const sectionsStarted = new Set<string>();
  for (const item of [...items].sort((a, b) => b.score - a.score)) {
    const headerCost = sectionsStarted.has(item.section) ? 0 : item.section.length + 4; // "## " + "\n"
    const cost = item.line.length + 3; // "- " + "\n"
    // `continue`, not `break`: a short line after a long one may still fit.
    if (cost + headerCost > budget) continue;
    budget -= cost + headerCost;
    sectionsStarted.add(item.section);
    kept.add(item);
  }

  if (kept.size === 0) return { text: "", stats: { semantic: 0, lessons: 0 } };

  // Render in collection order so each section keeps its relevance order.
  const bySection = new Map<string, string[]>();
  for (const item of [...items].sort((a, b) => a.idx - b.idx)) {
    if (!kept.has(item)) continue;
    const lines = bySection.get(item.section) ?? [];
    lines.push(item.line);
    bySection.set(item.section, lines);
  }

  const rendered = SECTION_ORDER
    .filter(section => bySection.has(section))
    .map(section => formatSection(section, bySection.get(section)!));
  // A section added without a SECTION_ORDER entry still renders, at the end,
  // instead of silently disappearing from the block.
  for (const [section, lines] of bySection) {
    if (!SECTION_ORDER.includes(section)) rendered.push(formatSection(section, lines));
  }

  const text = `<memory>\n${rendered.join("\n")}\n\n${MEMORY_DRIFT_CAVEAT}\n</memory>`;
  const keptItems = items.filter(item => kept.has(item));

  return {
    text,
    stats: {
      semantic: keptItems.filter(item => item.kind === "semantic").length,
      lessons: keptItems.filter(item => item.kind === "lesson").length,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Staleness thresholds (in days) */
const STALE_WARNING_DAYS = 30;
const VERY_STALE_DAYS = 90;

function formatSection(title: string, items: string[]): string {
  return `## ${title}\n${items.map(i => `- ${i}`).join("\n")}`;
}

/**
 * Format a semantic entry with staleness indicator.
 * Memories older than 30 days get a warning; older than 90 days get a strong warning.
 * This prevents the agent from treating stale facts as current truth.
 */
function formatSemantic(entry: SemanticEntry): string {
  const key = entry.key.split(".").slice(1).join(".");
  const ageDays = daysSince(entry.updated_at);
  const staleTag = ageDays >= VERY_STALE_DAYS
    ? ` ⚠️ ${ageDays}d old — verify before acting on this`
    : ageDays >= STALE_WARNING_DAYS
      ? ` (${ageDays}d ago)`
      : "";
  return `${key}: ${entry.value}${staleTag}`;
}

/**
 * Calculate days since a date string.
 */
function daysSince(dateStr: string): number {
  try {
    const then = new Date(dateStr).getTime();
    const now = Date.now();
    return Math.floor((now - then) / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

/**
 * Memory drift caveat — appended to the memory block so the agent knows
 * to verify recalled facts against current state before acting on them.
 */
const MEMORY_DRIFT_CAVEAT = `## Before acting on memory
- Memory records can become stale. If a memory names a file, function, or flag — verify it still exists before recommending it. "The memory says X exists" is not the same as "X exists now."
- If a recalled memory conflicts with what you observe in the current code or project state, trust what you observe now.
- Memories about project state (deadlines, decisions, architecture) decay fastest — check if still relevant.`;

/**
 * Extract domain prefix for sibling expansion.
 * Only keys with 3+ segments expand: `user.health.diet` → `user.health`.
 * 2-segment keys like `pref.editor` or `user.fitness` are leaf-level.
 */
function keyDomainPrefix(key: string): string | null {
  const parts = key.split(".");
  return parts.length >= 3 ? parts.slice(0, 2).join(".") : null;
}

export function projectSlug(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  const skip = new Set(["workplace", "local", "home", "src", "scratch", os.userInfo().username]);
  for (const p of parts.reverse()) {
    if (!skip.has(p.toLowerCase()) && p.length > 1) return p.toLowerCase();
  }
  return "";
}
