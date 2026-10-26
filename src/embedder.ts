/**
 * Embedding provider for semantic memory search.
 *
 * Ported from pi-session-search so both packages share one provider surface;
 * kept in-package rather than as a dependency to avoid coupling their release
 * cycles. Bedrock is the default because it needs no API key beyond the AWS
 * credential chain already present on a corporate machine, and because
 * amazon.titan-embed-text-v2:0 supports matryoshka dimension reduction.
 *
 * Replaces the @xenova/transformers backend removed in #31: no native modules,
 * no ONNX runtime, no model download. Entirely optional -- when unconfigured or
 * failing, search falls back to FTS5 BM25 exactly as it does today.
 */

export interface Embedder {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  embedBatch(
    texts: string[],
    signal?: AbortSignal
  ): Promise<(number[] | null)[]>;
}

export interface EmbedderConfig {
  type: "openai" | "bedrock" | "ollama" | "mistral" | "openai-compatible";
  // OpenAI / Mistral / OpenAI-compatible
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /**
   * Opt in to sending the OpenAI `dimensions` request parameter.
   *
   * Only some embedding models support matryoshka dimension reduction. OpenAI's
   * text-embedding-3 models do; most OpenAI-compatible providers do not.
   */
  sendDimensions?: boolean;
  /**
   * How many inputs one embeddings request may carry. Gateways commonly cap
   * this (some at 10) and answer 400 above it, which fails the whole batch.
   */
  batchSize?: number;
  // Bedrock
  profile?: string;
  region?: string;
  // Ollama
  url?: string;
  // Shared
  dimensions?: number;
}

const DEFAULTS: Record<string, Partial<EmbedderConfig>> = {
  openai: { model: "text-embedding-3-small", dimensions: 512, baseUrl: "https://api.openai.com", sendDimensions: true, batchSize: 100 },
  bedrock: {
    model: "amazon.titan-embed-text-v2:0",
    region: "us-east-1",
    profile: "default",
    dimensions: 512,
  },
  ollama: { model: "nomic-embed-text", url: "http://localhost:11434" },
  mistral: { model: "mistral-embed", dimensions: 1024, baseUrl: "https://api.mistral.ai", sendDimensions: false, batchSize: 100 },
  // Gateways behind an OpenAI-compatible endpoint often limit inputs per
  // request (10 is common), so a smaller default trades round-trips for working.
  "openai-compatible": { model: "text-embedding-3-small", dimensions: 512, sendDimensions: false, batchSize: 10 },
};

/** Env var consulted when `apiKey` is unset, for providers that require a key. */
const API_KEY_ENV: Partial<Record<EmbedderConfig["type"], string>> = {
  openai: "OPENAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

function requireApiKey(type: EmbedderConfig["type"], configured?: string): string {
  const envVar = API_KEY_ENV[type]!;
  const key = configured || process.env[envVar] || "";
  // Fail at construction: an empty key only 401s later, once per query.
  if (!key) throw new Error(`${type} embeddings need an API key`);
  return key;
}

export function createEmbedder(config: EmbedderConfig): Embedder {
  const defaults = DEFAULTS[config.type] ?? {};
  const merged = { ...defaults, ...config };

  switch (merged.type) {
    case "openai":
      return new OpenAICompatibleEmbedder(
        requireApiKey("openai", merged.apiKey),
        merged.model!,
        merged.dimensions!,
        merged.baseUrl || "https://api.openai.com",
        merged.sendDimensions ?? true,
        merged.batchSize ?? 100
      );
    case "mistral":
      return new OpenAICompatibleEmbedder(
        requireApiKey("mistral", merged.apiKey),
        merged.model!,
        merged.dimensions!,
        merged.baseUrl || "https://api.mistral.ai",
        merged.sendDimensions ?? false,
        merged.batchSize ?? 100
      );
    case "openai-compatible": {
      if (!merged.baseUrl) throw new Error("openai-compatible requires baseUrl");
      return new OpenAICompatibleEmbedder(
        merged.apiKey || "",
        merged.model!,
        merged.dimensions!,
        merged.baseUrl,
        merged.sendDimensions ?? false,
        merged.batchSize ?? 100
      );
    }
    case "bedrock":
      return new BedrockEmbedder(
        merged.profile!,
        merged.region!,
        merged.model!,
        merged.dimensions!
      );
    case "ollama":
      return new OllamaEmbedder(merged.url!, merged.model!);
    default:
      throw new Error(`Unknown embedder type: ${merged.type}`);
  }
}

// ─── Failure diagnosis ───────────────────────────────────────────────

/** Why embedding failed, in user terms, and what to do about it. */
export interface EmbedderDiagnosis {
  reason: string;
  hint: string;
}

/**
 * Turn an embedding failure into an actionable message (#30).
 *
 * Pure: `packageRoot` is where a missing optional dependency must be
 * installed, passed in so this stays testable.
 */
export function diagnoseEmbedderError(
  err: unknown,
  config: EmbedderConfig,
  packageRoot: string
): EmbedderDiagnosis {
  const cfg = { ...DEFAULTS[config.type], ...config };
  const e = (err ?? {}) as {
    name?: string;
    code?: string;
    message?: string;
    cause?: { code?: string };
    $metadata?: { httpStatusCode?: number };
  };
  const message = String(e.message ?? err);
  const firstLine = message.split("\n")[0]!.slice(0, 200);
  const code = e.code ?? e.cause?.code;
  const settings = "the memory.embedding block in settings.json";

  if (
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    /Cannot find (package|module)/.test(message)
  ) {
    if (message.includes("@aws-sdk/")) {
      return {
        reason:
          "the AWS SDK that the bedrock provider needs is not installed (it is an optional dependency, so it was omitted or its install failed)",
        hint:
          `Run \`npm install --omit=dev --include=optional\` in ${packageRoot}, ` +
          "or switch memory.embedding.type to openai, mistral, ollama or openai-compatible, which need no SDK.",
      };
    }
    return {
      reason: `a module it needs is missing (${firstLine})`,
      hint: "Reinstall the package: `pi install npm:@samfp/pi-memory`.",
    };
  }

  const needsKey = /^(\w+) embeddings need an API key$/.exec(message);
  if (needsKey) {
    const envVar = API_KEY_ENV[config.type] ?? "the provider's API key variable";
    return {
      reason: `no API key is configured for ${needsKey[1]} embeddings`,
      hint: `Set memory.embedding.apiKey, or export ${envVar} before starting pi.`,
    };
  }

  if (config.type === "bedrock") {
    const where = `profile "${cfg.profile}", region ${cfg.region}`;
    // The profile exists but its command failed, e.g. an expired login session behind it.
    // "Command failed: <cmd>\n<stderr>": show the last stderr line, where the tool's own advice usually is.
    if (e.name === "CredentialsProviderError" && /^Command failed:|credential_process (returned|did not return)/.test(message)) {
      const stderr = message.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
      const detail = message.startsWith("Command failed:") ? (stderr.at(-1) ?? "no error output") : firstLine;
      return {
        reason: `the credential_process for ${where} failed (${detail.slice(0, 300)})`,
        hint:
          `Run \`aws sts get-caller-identity --profile ${cfg.profile}\` to see the full error. ` +
          "If the process relies on a login session, renew it, then run /reload or start a new session.",
      };
    }
    if (e.name === "CredentialsProviderError" || /could not (resolve|load) credentials/i.test(message)) {
      return {
        reason: `no AWS credentials were found for ${where}`,
        hint: `Configure that profile (for SSO: \`aws sso login --profile ${cfg.profile}\`), or set memory.embedding.profile to one that exists.`,
      };
    }
    if (/expired/i.test(`${e.name} ${message}`)) {
      return {
        reason: `the AWS credentials for ${where} have expired`,
        hint: "Refresh them, then run /reload or start a new session.",
      };
    }
    if (
      e.name === "AccessDeniedException" ||
      e.name === "UnrecognizedClientException" ||
      e.$metadata?.httpStatusCode === 403
    ) {
      return {
        reason: `Bedrock refused ${cfg.model} for ${where} (${e.name ?? "403"})`,
        hint: `Check that the profile may call bedrock:InvokeModel and that access to ${cfg.model} is enabled in ${cfg.region}.`,
      };
    }
    if (e.name === "ValidationException" || e.name === "ResourceNotFoundException") {
      return {
        reason: `Bedrock rejected the request for ${cfg.model} in ${cfg.region}: ${firstLine}`,
        hint: "Check memory.embedding.model, region and dimensions (Titan v2 accepts 256, 512 or 1024).",
      };
    }
  }

  const http = /^(?:Embeddings API|Ollama) (\d{3})\b/.exec(message);
  if (http) {
    const status = Number(http[1]);
    if (status === 400 && /batch size/i.test(message)) {
      return {
        reason: `the provider caps how many inputs one request may carry (${firstLine})`,
        hint: `Lower memory.embedding.batchSize (currently ${cfg.batchSize}); some gateways allow at most 10.`,
      };
    }
    if (status === 401 || status === 403) {
      return {
        reason: `the embeddings API rejected the API key (HTTP ${status})`,
        hint: "Check memory.embedding.apiKey (or the provider's API key environment variable).",
      };
    }
    if (status === 404) {
      return config.type === "ollama"
        ? {
            reason: `Ollama has no model named ${cfg.model}`,
            hint: `Run \`ollama pull ${cfg.model}\`.`,
          }
        : {
            reason: `the embeddings endpoint or model was not found (HTTP 404, model ${cfg.model})`,
            hint: "Check memory.embedding.baseUrl and memory.embedding.model.",
          };
    }
    if (status === 429) {
      return {
        reason: "the embeddings API is rate limiting requests (HTTP 429)",
        hint: "This is usually transient; semantic results return once the limit resets.",
      };
    }
  }

  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || /fetch failed/i.test(message)) {
    const target = config.type === "ollama" ? cfg.url : cfg.baseUrl;
    return config.type === "ollama"
      ? {
          reason: `Ollama is not reachable at ${target}`,
          hint: `Start it (\`ollama serve\`) and pull the model (\`ollama pull ${cfg.model}\`), or fix memory.embedding.url.`,
        }
      : {
          reason: `the embeddings endpoint ${target ?? ""} is not reachable (${code ?? firstLine})`,
          hint: "Check memory.embedding.baseUrl and your network connection.",
        };
  }

  return { reason: firstLine, hint: `Check ${settings}.` };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function truncate(text: string, maxChars = 12000): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

async function parallelMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = new Array(items.length);
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

// ─── OpenAI-Compatible (OpenAI, Mistral, Together, Fireworks, etc.) ──

class OpenAICompatibleEmbedder implements Embedder {
  private endpoint: string;

  constructor(
    private apiKey: string,
    private model: string,
    private dimensions: number,
    baseUrl: string,
    private sendDimensions: boolean,
    private batchSize: number
  ) {
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/v1/embeddings`;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const [result] = await this.embedBatch([text], signal);
    if (!result) throw new Error("Embedding failed");
    return result;
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal
  ): Promise<(number[] | null)[]> {
    const BATCH = Math.max(1, Math.floor(this.batchSize));
    const results: (number[] | null)[] = new Array(texts.length).fill(null);

    for (let i = 0; i < texts.length; i += BATCH) {
      if (signal?.aborted) throw new Error("Aborted");
      const batch = texts.slice(i, i + BATCH).map((t) => truncate(t));

      const body: Record<string, unknown> = {
        input: batch,
        model: this.model,
      };
      if (this.dimensions && this.sendDimensions) {
        body.dimensions = this.dimensions;
      }

      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Embeddings API ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const json = (await res.json()) as {
        data: { embedding: number[]; index?: number }[];
      };
      for (let k = 0; k < json.data.length; k++) {
        const item = json.data[k];
        // Some providers (e.g. Gemini) omit `index` when it is 0
        // (protobuf default-value omission). Fall back to loop position.
        results[i + (item.index ?? k)] = item.embedding;
      }
    }
    return results;
  }
}

// ─── Bedrock ─────────────────────────────────────────────────────────

class BedrockEmbedder implements Embedder {
  private client: Promise<any> | null = null;

  constructor(
    private profile: string,
    private region: string,
    private model: string,
    private dimensions: number
  ) {}

  /**
   * Loaded on first use, not in the constructor. An eager import that fails
   * (optional AWS SDK absent) while nothing awaits it is an unhandled
   * rejection, and that crashes pi. The rejection is cached so later calls fail fast.
   */
  private getClient(): Promise<any> {
    this.client ??= (async () => {
      const { BedrockRuntimeClient } = await import(
        "@aws-sdk/client-bedrock-runtime"
      );
      const { fromIni } = await import("@aws-sdk/credential-providers");
      return new BedrockRuntimeClient({
        region: this.region,
        credentials: fromIni({ profile: this.profile }),
      });
    })();
    return this.client;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const [result] = await this.embedBatch([text], signal);
    if (!result) throw new Error("Embedding failed");
    return result;
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal
  ): Promise<(number[] | null)[]> {
    const client = await this.getClient();
    return parallelMap(
      texts,
      async (text) => {
        const { InvokeModelCommand } = await import(
          "@aws-sdk/client-bedrock-runtime"
        );
        const body = JSON.stringify({
          inputText: truncate(text),
          dimensions: this.dimensions,
          normalize: true,
        });
        const cmd = new InvokeModelCommand({
          modelId: this.model,
          contentType: "application/json",
          accept: "application/json",
          body: new TextEncoder().encode(body),
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
}

// ─── Ollama ──────────────────────────────────────────────────────────

class OllamaEmbedder implements Embedder {
  constructor(
    private url: string,
    private model: string
  ) {
    this.url = url.replace(/\/$/, "");
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const res = await fetch(`${this.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: truncate(text) }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { embeddings: number[][] };
    return json.embeddings[0];
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal
  ): Promise<(number[] | null)[]> {
    let firstError: unknown;
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
    // Per-item nulls tolerate one bad input; all-null means Ollama itself is
    // down or missing the model, which the caller should hear about.
    if (texts.length > 0 && results.every((r) => r === null)) throw firstError;
    return results;
  }
}
