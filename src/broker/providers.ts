import { z } from "zod";

export const ProviderIdSchema = z.enum(["openai", "anthropic", "gemini", "xai"]);
export type BuiltinProviderId = z.infer<typeof ProviderIdSchema>;

export type ProviderDefinition = {
  id: string;
  upstream: string;
  credentialEnv: string;
  routePrefixes: string[];
  authenticate(headers: Headers, credential: string, url: URL): void;
  /** Prove that provider-managed context and billed features are bounded by the request. */
  validateBoundedInput(input: {
    body: unknown;
    endpointClass: string;
    model: string;
    costCapped: boolean;
    inputCapped: boolean;
    outputCapped: boolean;
  }): string | null;
};

const providers = new Map<string, ProviderDefinition>();

export function registerProvider(definition: ProviderDefinition) {
  const normalized = normalizeProviderDefinition(definition);
  if (providers.has(normalized.id)) throw new Error(`Provider ${normalized.id} is already registered.`);
  providers.set(normalized.id, normalized);
  return normalized;
}

export function normalizeProviderDefinition(definition: ProviderDefinition): ProviderDefinition {
  const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).parse(definition.id);
  if (typeof definition.authenticate !== "function") throw new Error(`Provider ${id} must define an authentication function.`);
  if (typeof definition.validateBoundedInput !== "function") {
    throw new Error(`Provider ${id} must define bounded-input validation.`);
  }
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(definition.credentialEnv)) {
    throw new Error(`Provider ${id} must declare a safe credential environment key.`);
  }
  if (
    !definition.routePrefixes.length
    || definition.routePrefixes.length > 64
    || definition.routePrefixes.some((prefix) => prefix.length > 512 || !prefix.startsWith("/") || prefix.includes("?") || prefix.includes("#") || prefix.includes(".."))
  ) {
    throw new Error(`Provider ${id} must declare safe absolute route prefixes.`);
  }
  const upstream = new URL(definition.upstream);
  const loopback = upstream.hostname === "127.0.0.1" || upstream.hostname === "localhost" || upstream.hostname === "[::1]";
  if (upstream.protocol !== "https:" && !(loopback && upstream.protocol === "http:")) {
    throw new Error(`Provider ${id} upstream must use HTTPS unless it is loopback HTTP.`);
  }
  if (upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error(`Provider ${id} upstream must not contain credentials, a query, or a fragment.`);
  }
  return {
    ...definition,
    id,
    credentialEnv: definition.credentialEnv,
    routePrefixes: [...new Set(definition.routePrefixes)].sort(),
    upstream: upstream.toString().replace(/\/$/, ""),
  };
}

export function unregisterProvider(id: string) {
  if (ProviderIdSchema.safeParse(id).success) throw new Error(`Built-in provider ${id} cannot be unregistered.`);
  return providers.delete(id);
}

export function getProvider(id: string) {
  return providers.get(id) ?? null;
}

export function listProviders() {
  return [...providers.values()];
}

registerProvider({
  id: "openai",
  upstream: "https://api.openai.com",
  credentialEnv: "OPENAI_API_KEY",
  routePrefixes: ["/v1/chat/completions", "/v1/responses", "/v1/embeddings", "/v1/models"],
  authenticate(headers, credential) {
    headers.set("authorization", `Bearer ${credential}`);
  },
  validateBoundedInput(input) {
    return validateOpenAiCompatibleInput(input, "openai");
  },
});

registerProvider({
  id: "anthropic",
  upstream: "https://api.anthropic.com",
  credentialEnv: "ANTHROPIC_API_KEY",
  routePrefixes: ["/v1/messages", "/v1/models"],
  authenticate(headers, credential) {
    headers.set("x-api-key", credential);
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  },
  validateBoundedInput: validateAnthropicInput,
});

registerProvider({
  id: "gemini",
  upstream: "https://generativelanguage.googleapis.com",
  credentialEnv: "GEMINI_API_KEY",
  routePrefixes: ["/v1beta/models/", "/v1/models/"],
  authenticate(headers, credential, url) {
    headers.set("x-goog-api-key", credential);
    url.searchParams.delete("key");
  },
  validateBoundedInput: validateGeminiInput,
});

registerProvider({
  id: "xai",
  upstream: "https://api.x.ai",
  credentialEnv: "XAI_API_KEY",
  routePrefixes: ["/v1/chat/completions", "/v1/responses", "/v1/models"],
  authenticate(headers, credential) {
    headers.set("authorization", `Bearer ${credential}`);
  },
  validateBoundedInput(input) {
    return validateOpenAiCompatibleInput(input, "xai");
  },
});

type BoundedProviderInput = Parameters<ProviderDefinition["validateBoundedInput"]>[0];

function validateOpenAiCompatibleInput(input: BoundedProviderInput, provider: "openai" | "xai") {
  const body = objectValue(input.body);
  if (!body) return "Provider request body cannot be bounded as inline JSON.";
  const model = validateTextGenerationModel(input.model, provider);
  if (model) return model;
  const reference = findOpaqueReference(body, new Set([
    "previous_response_id",
    "conversation",
    "prompt",
    "file_id",
    "file_ids",
    "file_url",
    "file_urls",
    "vector_store_id",
    "vector_store_ids",
    "container",
    "container_id",
    "mcp_server",
    "mcp_servers",
    "web_search_options",
    "search_options",
    "search_parameters",
  ]));
  if (reference) return `Provider-side context reference ${reference} is unavailable under an input or cost cap.`;
  const modality = nonTextModality(body.modalities);
  if (modality) return `Provider output modality ${modality} is unavailable under an input or cost cap.`;
  if (meaningful(body.audio)) return "Provider audio output is unavailable under an input or cost cap.";
  if ("service_tier" in body && body.service_tier !== "default") {
    return "Non-default provider service tiers are unavailable under an input or cost cap.";
  }
  return validateTools(body.tools, "openai");
}

function validateAnthropicInput(input: BoundedProviderInput) {
  const body = objectValue(input.body);
  if (!body) return "Provider request body cannot be bounded as inline JSON.";
  const model = validateTextGenerationModel(input.model, "anthropic");
  if (model) return model;
  const reference = findOpaqueReference(body, new Set([
    "container",
    "container_id",
    "file_id",
    "file_ids",
    "mcp_server",
    "mcp_servers",
  ]));
  if (reference) return `Provider-side context reference ${reference} is unavailable under an input or cost cap.`;
  if ("service_tier" in body && body.service_tier !== "standard_only") {
    return "Non-default provider service tiers are unavailable under an input or cost cap.";
  }
  return validateTools(body.tools, "anthropic");
}

function validateGeminiInput(input: BoundedProviderInput) {
  const body = objectValue(input.body);
  if (!body) return "Provider request body cannot be bounded as inline JSON.";
  const model = validateTextGenerationModel(input.model, "gemini");
  if (model) return model;
  const reference = findOpaqueReference(body, new Set([
    "cachedContent",
    "cached_content",
    "fileUri",
    "file_uri",
  ]));
  if (reference) return `Provider-side context reference ${reference} is unavailable under an input or cost cap.`;
  const generation = objectValue(body.generationConfig) ?? objectValue(body.generation_config);
  const modality = nonTextModality(generation?.responseModalities ?? generation?.response_modalities);
  if (modality) return `Provider output modality ${modality} is unavailable under an input or cost cap.`;
  for (const [key, serviceTier] of [["serviceTier", body.serviceTier], ["service_tier", body.service_tier]] as const) {
    if (!(key in body)) continue;
    if (typeof serviceTier !== "string" || !["default", "standard", "standard_only", "service_tier_unspecified"].includes(serviceTier.toLowerCase())) {
      return "Non-default provider service tiers are unavailable under an input or cost cap.";
    }
  }
  return validateTools(body.tools, "gemini");
}

function validateTextGenerationModel(model: string, provider: "openai" | "anthropic" | "gemini" | "xai") {
  const normalized = model.toLowerCase().replace(/^(?:openai|anthropic|google|gemini|xai)\//, "");
  if (/(search|research|image|imagine|imagen|video|veo|audio|realtime|live|speech|tts|transcrib|embed|moderation)/.test(normalized)) {
    return `Provider model ${model} has capabilities outside the bounded text-generation policy.`;
  }
  const allowed = provider === "openai"
    ? /^(gpt-|o[1-9](?:$|[-.])|codex-|chatgpt-)/.test(normalized)
    : provider === "anthropic"
      ? /^claude(?:$|[-.])/.test(normalized)
      : provider === "gemini"
        ? /^gemini(?:$|[-.])/.test(normalized)
        : /^grok(?:$|[-.])/.test(normalized);
  return allowed ? null : `Provider model ${model} is not in the bounded text-generation policy.`;
}

function nonTextModality(value: unknown) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return "unknown";
  return value.map(String).find((modality) => modality.toLowerCase() !== "text") ?? null;
}

function validateTools(value: unknown, protocol: "openai" | "anthropic" | "gemini") {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return "Provider tools must be an inline array under an input or cost cap.";
  for (const candidate of value) {
    const tool = objectValue(candidate);
    if (!tool) return "Provider tool definition is not bounded inline JSON.";
    if (protocol === "openai") {
      if (tool.type === "function" || tool.type === "custom" || tool.type === "local_shell") continue;
      return `Provider-managed tool ${String(tool.type ?? "unknown")} is unavailable under an input or cost cap.`;
    }
    if (protocol === "anthropic") {
      if (typeof tool.name === "string" && objectValue(tool.input_schema) && tool.type === undefined) continue;
      return `Provider-managed tool ${String(tool.type ?? tool.name ?? "unknown")} is unavailable under an input or cost cap.`;
    }
    const keys = Object.keys(tool);
    if (keys.length > 0 && keys.every((key) => key === "functionDeclarations" || key === "function_declarations")) continue;
    return `Provider-managed Gemini tool ${keys[0] ?? "unknown"} is unavailable under an input or cost cap.`;
  }
  return null;
}

function findOpaqueReference(root: Record<string, unknown>, forbidden: Set<string>) {
  const pending: unknown[] = [root];
  let visited = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    visited += 1;
    if (visited > 100_000) return "<input-complexity-limit>";
    if (Array.isArray(value)) {
      for (const child of value) {
        pending.push(child);
        if (pending.length > 100_000) return "<input-complexity-limit>";
      }
      continue;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "url" && remoteUrl(record.url)) return "url";
    if (record.type === "item_reference" && meaningful(record.id)) return "item_reference";
    if (meaningful(objectValue(record.audio)?.id)) return "audio.id";
    for (const [key, child] of Object.entries(record)) {
      if (forbidden.has(key) && meaningful(child)) return key;
      if (key === "image_url" && remoteUrl(child)) return key;
      pending.push(child);
    }
  }
  return null;
}

function remoteUrl(value: unknown) {
  if (typeof value === "string") return /^https?:\/\//i.test(value);
  const object = objectValue(value);
  return typeof object?.url === "string" && /^https?:\/\//i.test(object.url);
}

function meaningful(value: unknown) {
  return value !== undefined
    && value !== null
    && value !== false
    && value !== ""
    && (!Array.isArray(value) || value.length > 0);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
