// Per-provider endpoint, authentication and wire format.
import { AnthropicAdapter, CloudflareAdapter, CompatibleAdapter, DeepSeekAdapter, GeminiAdapter, OpenAIAdapter } from '../adapters/index.js';
import { NidusError } from '../errors.js';
import { bounded, HttpClient, keyValue } from '../http.js';
import type { Model, ProviderId, RequestOptions } from '../types.js';
import { validateRequest, type ModelRequest, type ModelResponse } from './contract.js';
import { anthropicWire } from './wire/anthropic.js';
import { completionsWire } from './wire/completions.js';
import { geminiWire } from './wire/gemini.js';
import { responsesWire } from './wire/responses.js';
import type { Wire } from './wire/shared.js';

export const ANTHROPIC_VERSION = '2026-10-21';
const DEFAULT_TIMEOUT_MS = 120_000;

export const defaultEndpoints: Record<ProviderId, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  cloudflare: 'https://api.cloudflare.com/client/v4',
};

const wires: Record<ProviderId, Wire> = {
  openai: responsesWire,
  anthropic: anthropicWire,
  gemini: geminiWire,
  deepseek: completionsWire,
  nvidia: completionsWire,
  groq: completionsWire,
  mistral: completionsWire,
  cloudflare: completionsWire,
};

const anthropicHeaders = (key: string) => ({ 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION });

/** Model discovery reuses the existing adapter; only the authentication header differs. */
class AnthropicModels extends AnthropicAdapter {
  protected override headers(key: string) {
    return anthropicHeaders(key);
  }
}

/** Cloudflare credentials are stored as a packed { token, accountId } JSON string. */
function cloudflareTarget(endpoint: string, key: string): { endpoint: string; headers: Record<string, string> } {
  try {
    const packed = JSON.parse(key) as { token?: unknown; accountId?: unknown };
    if (typeof packed.token !== 'string' || typeof packed.accountId !== 'string' || !/^[a-fA-F0-9]{32}$/.test(packed.accountId)) throw new Error();
    return { endpoint: `${endpoint}/accounts/${packed.accountId}/ai/v1`, headers: { authorization: `Bearer ${keyValue(packed.token)}` } };
  } catch {
    throw new NidusError('invalid_request', 'Reconnect Cloudflare with an API token and Account ID.');
  }
}

function target(provider: ProviderId, endpoint: string, key: string): { endpoint: string; headers: Record<string, string> } {
  switch (provider) {
    case 'anthropic': return { endpoint, headers: anthropicHeaders(key) };
    case 'gemini': return { endpoint, headers: { 'x-goog-api-key': key } };
    case 'cloudflare': return cloudflareTarget(endpoint, key);
    default: return { endpoint, headers: { authorization: `Bearer ${key}` } };
  }
}

export interface ProviderOptions {
  http?: HttpClient;
  endpoints?: Partial<Record<ProviderId, string>>;
}

export class ProviderClient {
  private readonly http: HttpClient;
  private readonly endpoints: Record<ProviderId, string>;
  private readonly discovery: Record<ProviderId, { listModels(key: string, options?: RequestOptions): Promise<Model[]> }>;

  constructor(options: ProviderOptions = {}) {
    this.http = options.http ?? new HttpClient();
    this.endpoints = { ...defaultEndpoints, ...options.endpoints };
    this.discovery = discoveryFor(this.endpoints, this.http);
  }

  listModels(provider: ProviderId, key: string, options: RequestOptions = {}): Promise<Model[]> {
    return this.discovery[provider].listModels(key, options);
  }

  async send(provider: ProviderId, key: string, request: ModelRequest, options: RequestOptions = {}): Promise<ModelResponse> {
    validateRequest(request);
    const wire = wires[provider];
    const { path, body } = wire.build(request, provider);
    const { endpoint, headers } = target(provider, this.endpoints[provider], keyValue(key));
    return bounded({ timeoutMs: DEFAULT_TIMEOUT_MS, ...options }, async signal =>
      wire.parse(await this.http.json(`${endpoint}${path}`, headers, signal, body, options.onHeaders), request, provider));
  }
}

function discoveryFor(endpoints: Record<ProviderId, string>, http: HttpClient) {
  return {
    openai: new OpenAIAdapter(endpoints.openai, http),
    anthropic: new AnthropicModels(endpoints.anthropic, http),
    gemini: new GeminiAdapter(endpoints.gemini, http),
    deepseek: new DeepSeekAdapter(endpoints.deepseek, http),
    nvidia: new CompatibleAdapter('nvidia', endpoints.nvidia, http),
    groq: new CompatibleAdapter('groq', endpoints.groq, http),
    mistral: new CompatibleAdapter('mistral', endpoints.mistral, http),
    cloudflare: new CloudflareAdapter(endpoints.cloudflare, http),
  };
}
