import type { ProviderId } from './types.js';
export const expandedProviders = ['nvidia', 'groq', 'mistral', 'cloudflare'] as const;
export const providerMetadata: Record<ProviderId, { name: string; keyURL: string; source: string; accountId: boolean; freeConditions: string }> = {
  openai: { name:'OpenAI', keyURL:'https://platform.openai.com/api-keys', source:'https://developers.openai.com/api/docs', accountId:false, freeConditions:'No automatic free entitlement.' },
  anthropic: { name:'Anthropic', keyURL:'https://platform.claude.com/settings/keys', source:'https://platform.claude.com/docs', accountId:false, freeConditions:'Credits are not a zero-cost entitlement.' },
  gemini: { name:'Gemini', keyURL:'https://aistudio.google.com/api-keys', source:'https://ai.google.dev/gemini-api/docs/billing', accountId:false, freeConditions:'Project Free Tier and reviewed model required.' },
  deepseek: { name:'DeepSeek', keyURL:'https://platform.deepseek.com/api_keys', source:'https://api-docs.deepseek.com', accountId:false, freeConditions:'Balance is not a zero-cost entitlement.' },
  nvidia: { name:'NVIDIA NIM', keyURL:'https://build.nvidia.com/', source:'https://docs.api.nvidia.com/nim/docs/product', accountId:false, freeConditions:'Hosted developer trial only; account/model entitlement and NVIDIA use limits apply. Not self-hosted or enterprise billing.' },
  groq: { name:'Groq', keyURL:'https://console.groq.com/keys', source:'https://console.groq.com/docs/rate-limits', accountId:false, freeConditions:'GroqCloud Free plan only; organization/model request and token limits apply. Headers are rate windows, not remaining free credit.' },
  mistral: { name:'Mistral AI', keyURL:'https://console.mistral.ai/', source:'https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key', accountId:false, freeConditions:'Studio Free/Experiment mode only; account limits and eligible model access must be checked. Paid mode is separate.' },
  cloudflare: { name:'Cloudflare Workers AI', keyURL:'https://dash.cloudflare.com/', source:'https://developers.cloudflare.com/workers-ai/platform/pricing/', accountId:true, freeConditions:'Workers Free plan: shared 10,000 Neurons/day, resets 00:00 UTC. Paid-only models excluded. Paid plans can charge beyond the allocation; no gateway credits used.' }
};
// Exact reviewed text endpoints, not a model catalog or an account entitlement.
export const reviewedFreeModels: Partial<Record<ProviderId, readonly string[]>> = {
  nvidia: ['meta/llama-3.1-8b-instruct', 'nvidia/nemotron-3.5-super-vl-120b-a12b', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia/nemotron-3-ultra-550b-a55b', 'deepseek-ai/deepseek-v4.1-flash'],
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  mistral: ['mistral-small-2603'],
  cloudflare: ['@cf/meta/llama-3.1-8b-instruct']
};
export const providerReviewAt = '2026-10-25T00:00:00Z';
