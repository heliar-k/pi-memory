import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createEmbedder, diagnoseEmbedderError } from "./embedder.js";

const ROOT = "/opt/pi/node_modules/@samfp/pi-memory";

function named(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { name }, extra);
}

describe("diagnoseEmbedderError (#30)", () => {
  it("names the missing optional AWS SDK and says where to install it", () => {
    const err = Object.assign(
      new Error("Cannot find package '@aws-sdk/client-bedrock-runtime' imported from /x/dist/index.js"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    const d = diagnoseEmbedderError(err, { type: "bedrock" }, ROOT);
    assert.match(d.reason, /AWS SDK/);
    assert.match(d.reason, /optional dependency/);
    assert.ok(d.hint.includes(ROOT), d.hint);
    assert.match(d.hint, /--include=optional/);
    assert.match(d.hint, /openai, mistral, ollama or openai-compatible/);
  });

  it("treats CommonJS MODULE_NOT_FOUND the same way", () => {
    const err = Object.assign(new Error("Cannot find module '@aws-sdk/credential-providers'"), {
      code: "MODULE_NOT_FOUND",
    });
    assert.match(diagnoseEmbedderError(err, { type: "bedrock" }, ROOT).reason, /AWS SDK/);
  });

  it("reports missing credentials with the configured (or default) profile", () => {
    const err = named(
      "CredentialsProviderError",
      "Could not resolve credentials using profile: [work] in configuration/credentials file(s).",
    );
    const d = diagnoseEmbedderError(err, { type: "bedrock", profile: "work", region: "eu-west-1" }, ROOT);
    assert.match(d.reason, /no AWS credentials/);
    assert.match(d.reason, /profile "work", region eu-west-1/);
    assert.match(d.hint, /aws sso login --profile work/);

    const dflt = diagnoseEmbedderError(err, { type: "bedrock" }, ROOT);
    assert.match(dflt.reason, /profile "default", region us-east-1/);
  });

  it("reports a failing credential_process with its own stderr, not as a missing profile", () => {
    // Message shape from @aws-sdk/credential-provider-process when the command exits non-zero.
    const err = named(
      "CredentialsProviderError",
      "Command failed: /opt/bin/vend creds\nfetching role...\nunable to authenticate; please run 'login-tool'\n",
    );
    const d = diagnoseEmbedderError(err, { type: "bedrock", profile: "work", region: "eu-west-1" }, ROOT);
    assert.match(d.reason, /credential_process for profile "work", region eu-west-1 failed/);
    assert.match(d.reason, /please run 'login-tool'/);
    assert.doesNotMatch(d.reason, /no AWS credentials|\/opt\/bin\/vend/);
    assert.doesNotMatch(d.hint, /aws sso login/);
    assert.match(d.hint, /aws sts get-caller-identity --profile work/);

    const badJson = named("CredentialsProviderError", "Profile work credential_process returned invalid JSON.");
    assert.match(
      diagnoseEmbedderError(badJson, { type: "bedrock", profile: "work" }, ROOT).reason,
      /credential_process .* failed \(Profile work credential_process returned invalid JSON\.\)/,
    );
  });

  it("reports expired credentials", () => {
    const err = named("ExpiredTokenException", "The security token included in the request is expired");
    assert.match(diagnoseEmbedderError(err, { type: "bedrock" }, ROOT).reason, /expired/);
  });

  it("reports Bedrock access denial with model and region", () => {
    const err = named("AccessDeniedException", "You don't have access to the model", {
      $metadata: { httpStatusCode: 403 },
    });
    const d = diagnoseEmbedderError(err, { type: "bedrock", region: "us-west-2" }, ROOT);
    assert.match(d.reason, /amazon\.titan-embed-text-v2:0/);
    assert.match(d.hint, /bedrock:InvokeModel/);
    assert.match(d.hint, /us-west-2/);
  });

  it("reports a missing API key with the env var to set", () => {
    const d = diagnoseEmbedderError(new Error("openai embeddings need an API key"), { type: "openai" }, ROOT);
    assert.match(d.reason, /no API key/);
    assert.match(d.hint, /OPENAI_API_KEY/);
    const m = diagnoseEmbedderError(new Error("mistral embeddings need an API key"), { type: "mistral" }, ROOT);
    assert.match(m.hint, /MISTRAL_API_KEY/);
  });

  it("maps HTTP statuses from the OpenAI-compatible and Ollama providers", () => {
    const cfg = { type: "openai" as const, apiKey: "k" };
    assert.match(diagnoseEmbedderError(new Error("Embeddings API 401: bad key"), cfg, ROOT).reason, /API key/);
    assert.match(diagnoseEmbedderError(new Error("Embeddings API 404: nope"), cfg, ROOT).hint, /baseUrl/);
    assert.match(diagnoseEmbedderError(new Error("Embeddings API 429: slow down"), cfg, ROOT).reason, /rate limit/);
    const ollama404 = diagnoseEmbedderError(new Error('Ollama 404: model "x" not found'), { type: "ollama" }, ROOT);
    assert.match(ollama404.hint, /ollama pull nomic-embed-text/);
  });

  it("points a capped-batch 400 at memory.embedding.batchSize", () => {
    const d = diagnoseEmbedderError(
      new Error("Embeddings API 400: Value error, batch size is invalid, it should not be larger than 10."),
      { type: "openai-compatible", baseUrl: "http://127.0.0.1:3425" },
      ROOT,
    );
    assert.match(d.reason, /caps how many inputs/);
    assert.match(d.hint, /memory\.embedding\.batchSize/);
    assert.match(d.hint, /10/);
  });

  it("tells the user to start Ollama when it is unreachable", () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const d = diagnoseEmbedderError(err, { type: "ollama" }, ROOT);
    assert.match(d.reason, /not reachable at http:\/\/localhost:11434/);
    assert.match(d.hint, /ollama serve/);
  });

  it("falls back to the first line of an unrecognised error", () => {
    const d = diagnoseEmbedderError(new Error("something odd\nstack-ish detail"), { type: "openai", apiKey: "k" }, ROOT);
    assert.equal(d.reason, "something odd");
    assert.match(d.hint, /memory\.embedding/);
  });
});

describe("createEmbedder", () => {
  function withEnv(name: string, value: string | undefined, fn: () => void) {
    const saved = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  }

  it("fails fast when openai/mistral have no API key", () => {
    withEnv("OPENAI_API_KEY", undefined, () => {
      assert.throws(() => createEmbedder({ type: "openai" }), /openai embeddings need an API key/);
    });
    withEnv("MISTRAL_API_KEY", undefined, () => {
      assert.throws(() => createEmbedder({ type: "mistral" }), /mistral embeddings need an API key/);
    });
  });

  it("accepts a key from settings or the environment", () => {
    withEnv("OPENAI_API_KEY", undefined, () => {
      assert.doesNotThrow(() => createEmbedder({ type: "openai", apiKey: "sk-test" }));
    });
    withEnv("OPENAI_API_KEY", "sk-env", () => {
      assert.doesNotThrow(() => createEmbedder({ type: "openai" }));
    });
  });

  it("does not require a key for openai-compatible local servers", () => {
    assert.doesNotThrow(() => createEmbedder({ type: "openai-compatible", baseUrl: "http://localhost:8080" }));
  });

  it("surfaces an all-failed Ollama batch instead of returning only nulls", async () => {
    // Port 9 (discard) on loopback: refused immediately, no network needed.
    const emb = createEmbedder({ type: "ollama", url: "http://127.0.0.1:9" });
    await assert.rejects(emb.embedBatch(["a", "b"]), /fetch failed/);
  });
});

describe("OpenAI-compatible batching", () => {
  it("splits requests by batchSize instead of failing a capped gateway", async () => {
    const sizes: number[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const input = (JSON.parse(raw) as { input: string[] }).input;
        sizes.push(input.length);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: input.map((_, index) => ({ embedding: [index], index })) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}`;

      // Default for openai-compatible is 10 inputs per request.
      const dflt = createEmbedder({ type: "openai-compatible", baseUrl });
      const texts = Array.from({ length: 11 }, (_, i) => `t${i}`);
      assert.equal((await dflt.embedBatch(texts)).length, 11);
      assert.deepEqual(sizes, [10, 1]);

      sizes.length = 0;
      const small = createEmbedder({ type: "openai-compatible", baseUrl, batchSize: 2 });
      assert.equal((await small.embedBatch(["a", "b", "c"])).length, 3);
      assert.deepEqual(sizes, [2, 1]);
    } finally {
      server.close();
    }
  });
});
