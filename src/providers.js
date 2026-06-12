/**
 * Model provider presets. jsclaw agents run on the Claude Code runtime,
 * which speaks the Anthropic API natively — so any provider exposing an
 * Anthropic-compatible endpoint works by pointing ANTHROPIC_BASE_URL at
 * it. GLM (Z.ai) and Kimi (Moonshot) publish such endpoints; everything
 * else routes through a translation proxy like LiteLLM.
 *
 * Provider credentials and endpoints travel to containers via stdin
 * (ContainerInput.providerEnv), never argv — argv leaks into `ps`.
 * @module providers
 */

/**
 * @typedef {Object} ProviderPreset
 * @property {string} label - Human name shown in the onboarding wizard
 * @property {string} [baseUrl] - Anthropic-compatible endpoint (unset = api.anthropic.com)
 * @property {string} keyEnv - Env var name the API key is read from
 * @property {'apiKey'|'authToken'} [keyStyle] - Whether the key is sent as
 *   ANTHROPIC_API_KEY (default) or ANTHROPIC_AUTH_TOKEN (bearer)
 * @property {Record<string, string>} [env] - Extra fixed env (e.g. Bedrock switch)
 * @property {string[]} [models] - Suggested model ids (first = default suggestion)
 * @property {string} [heartbeatModel] - Suggested cheap model for heartbeats
 * @property {string} [notes] - Wizard hint
 */

/** @type {Record<string, ProviderPreset>} */
export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (direct)',
    keyEnv: 'ANTHROPIC_API_KEY',
    models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'],
    heartbeatModel: 'claude-haiku-4-5-20251001',
  },
  zai: {
    label: 'Z.ai — GLM',
    baseUrl: 'https://api.z.ai/api/anthropic',
    keyEnv: 'ZAI_API_KEY',
    keyStyle: 'authToken',
    models: ['glm-4.6', 'glm-4.5-air'],
    heartbeatModel: 'glm-4.5-air',
    notes: 'GLM Coding Plan endpoint; Anthropic-compatible. Verify model ids against current Z.ai docs.',
  },
  moonshot: {
    label: 'Moonshot — Kimi (pay-as-you-go API)',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    keyEnv: 'MOONSHOT_API_KEY',
    keyStyle: 'authToken',
    models: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview'],
    heartbeatModel: 'kimi-k2-turbo-preview',
    notes: 'Pay-as-you-go (metered balance) Anthropic endpoint. For a Kimi Code *subscription*, use the "kimi" preset instead. Verify model ids against current Moonshot docs.',
  },
  kimi: {
    label: 'Kimi Code — subscription (coding plan)',
    baseUrl: 'https://api.kimi.com/coding',
    keyEnv: 'KIMI_API_KEY',
    keyStyle: 'authToken',
    models: ['kimi-for-coding'],
    heartbeatModel: 'kimi-for-coding',
    notes: 'Kimi Code subscription. Use the sk-kimi-… key from the Kimi Code console → API Keys (server-side use; up to 5 keys). Anthropic-native at /v1/messages; the plan explicitly allows Claude Code-class agents. Distinct from the metered "moonshot" preset.',
  },
  bedrock: {
    label: 'AWS Bedrock (Claude models)',
    keyEnv: 'AWS_ACCESS_KEY_ID',
    env: { CLAUDE_CODE_USE_BEDROCK: '1' },
    models: ['us.anthropic.claude-sonnet-4-6-v1:0'],
    notes: 'Uses your AWS credentials (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION).',
  },
  vertex: {
    label: 'Google Vertex AI (Claude models)',
    keyEnv: 'ANTHROPIC_VERTEX_PROJECT_ID',
    env: { CLAUDE_CODE_USE_VERTEX: '1' },
    models: ['claude-sonnet-4-6'],
    notes: 'Uses gcloud application-default credentials plus CLOUD_ML_REGION / ANTHROPIC_VERTEX_PROJECT_ID.',
  },
  custom: {
    label: 'Custom Anthropic-compatible endpoint (LiteLLM, OpenRouter proxy, …)',
    keyEnv: 'ANTHROPIC_AUTH_TOKEN',
    keyStyle: 'authToken',
    notes: 'Any proxy that translates the Anthropic API: LiteLLM unlocks OpenAI, Gemini, Grok, DeepSeek, Ollama.',
  },
};

/**
 * Env var names allowed to pass from host to container as provider
 * configuration. Anything else stays on the host.
 */
export const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CLAUDE_CODE_USE_VERTEX',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
];

/**
 * Build the provider env to send to a container (via stdin, never argv).
 * Host environment supplies the whitelisted keys; explicit config
 * (providerBaseUrl / providerAuthToken) wins over the host env.
 *
 * @param {import('./types.js').JsclawConfig} config
 * @returns {Record<string, string>|undefined} undefined when empty
 */
export function resolveProviderEnv(config) {
  const env = {};
  for (const key of PROVIDER_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (config.providerBaseUrl) env.ANTHROPIC_BASE_URL = config.providerBaseUrl;
  if (config.providerAuthToken) env.ANTHROPIC_AUTH_TOKEN = config.providerAuthToken;
  return Object.keys(env).length > 0 ? env : undefined;
}
