import { ProviderBroker } from "../src/broker/server";
import { redactAndTruncate } from "../src/runtime/redaction";

type SmokeDefinition = {
  id: "openai" | "anthropic" | "gemini" | "xai";
  credential: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY" | "XAI_API_KEY";
  modelEnv: string;
  endpointClass: "responses" | "messages" | "generate" | "chat";
  path(model: string): string;
  body(model: string): unknown;
};

const definitions: SmokeDefinition[] = [
  {
    id: "openai",
    credential: "OPENAI_API_KEY",
    modelEnv: "HEADLESS_SMOKE_OPENAI_MODEL",
    endpointClass: "responses",
    path: () => "/v1/responses",
    body: (model) => ({ model, input: "Reply with OK only.", max_output_tokens: 8 }),
  },
  {
    id: "anthropic",
    credential: "ANTHROPIC_API_KEY",
    modelEnv: "HEADLESS_SMOKE_ANTHROPIC_MODEL",
    endpointClass: "messages",
    path: () => "/v1/messages",
    body: (model) => ({ model, max_tokens: 8, messages: [{ role: "user", content: "Reply with OK only." }] }),
  },
  {
    id: "gemini",
    credential: "GEMINI_API_KEY",
    modelEnv: "HEADLESS_SMOKE_GEMINI_MODEL",
    endpointClass: "generate",
    path: (model) => `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    body: () => ({ contents: [{ parts: [{ text: "Reply with OK only." }] }], generationConfig: { maxOutputTokens: 8 } }),
  },
  {
    id: "xai",
    credential: "XAI_API_KEY",
    modelEnv: "HEADLESS_SMOKE_XAI_MODEL",
    endpointClass: "chat",
    path: () => "/v1/chat/completions",
    body: (model) => ({ model, max_tokens: 8, messages: [{ role: "user", content: "Reply with OK only." }] }),
  },
];

const missing = definitions.flatMap((definition) => [
  ...(process.env[definition.credential]?.trim() ? [] : [definition.credential]),
  ...(process.env[definition.modelEnv]?.trim() ? [] : [definition.modelEnv]),
]);
if (missing.length > 0) {
  throw new Error(`Protected provider smoke is missing required environment values: ${missing.join(", ")}.`);
}

const broker = new ProviderBroker({
  credentials: Object.fromEntries(definitions.map((definition) => [definition.credential, process.env[definition.credential]])),
  maxConcurrentRequests: 1,
  maxInFlightBodyBytes: 256_000,
});
broker.start();

try {
  for (const definition of definitions) {
    const model = process.env[definition.modelEnv]!.trim();
    const lease = broker.issueLease({
      runId: `protected-smoke-${definition.id}`,
      provider: definition.id,
      models: [model],
      endpointClasses: [definition.endpointClass],
      expiresAt: Date.now() + 60_000,
      maxRequests: 1,
      maxBodyBytes: 64_000,
      maxConcurrentRequests: 1,
      maxInFlightBodyBytes: 64_000,
      maxStreamMs: 30_000,
      maxCostUsd: 0.10,
    });
    const response = await fetch(`${lease.baseUrl}${definition.path(model)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
      body: JSON.stringify(definition.body(model)),
      signal: AbortSignal.timeout(35_000),
    });
    const body = await readBounded(response, 64_000);
    if (!response.ok) {
      throw new Error(`${definition.id} smoke failed with HTTP ${response.status}: ${redactAndTruncate(body, 2_048).text}`);
    }
    const observation = broker.getLeaseObservation(lease.id);
    if (observation?.requests !== 1) throw new Error(`${definition.id} smoke did not produce exactly one broker-observed request.`);
    console.log(`${definition.id}: passed (HTTP ${response.status}, broker requests ${observation.requests})`);
    broker.revokeLease(lease.id);
  }
} finally {
  broker.stop();
}

async function readBounded(response: Response, maxBytes: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel("provider smoke response exceeded limit").catch(() => {});
        throw new Error(`Provider smoke response exceeded ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      console.warn("Provider smoke response reader lock could not be released during cleanup.");
    }
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}
