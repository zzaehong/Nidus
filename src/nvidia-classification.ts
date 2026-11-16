import type { Classification, ModelKind } from './classification.js';

const source = 'https://docs.api.nvidia.com/nim/reference/llm-apis';
const checkedAt = '2026-10-25T00:00:00Z';
// Purpose metadata only. Never generates catalog entries, grades, prices or free approvals.
const textModels = new Set([
  'deepseek-ai/deepseek-v4-flash', 'deepseek-ai/deepseek-v4-flash-0731', 'deepseek-ai/deepseek-v4-pro',
  'google/codegemma-7b', 'google/gemma-7b', 'meta/llama2-70b',
  'meta/llama-3.1-8b-instruct', 'meta/llama-3.1-70b-instruct', 'meta/llama-3.2-1b-instruct',
  'meta/llama-3.2-3b-instruct', 'meta/llama-3.3-70b-instruct',
  'microsoft/phi-4-mini-instruct', 'microsoft/phi-4-mini-flash-reasoning',
  'minimaxai/minimax-m2.5', 'minimaxai/minimax-m2.7',
  'mistralai/mistral-nemotron', 'mistralai/mixtral-8x7b-instruct', 'mistralai/mixtral-8x22b-instruct',
  'moonshotai/kimi-k2-instruct', 'moonshotai/kimi-k2-thinking', 'moonshotai/kimi-k3',
  'nvidia/llama-3.3-nemotron-super-49b-v1', 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  'nvidia/llama-3.1-nemotron-ultra-253b-v1', 'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia/nemotron-3.5-bolt-e4b',
  'nvidia/nemotron-3-nano-30b-a3b', 'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nvidia-nemotron-nano-9b-v2', 'nvidia/riva-translate-4b-instruct-v2', 'nvidia/usdcode',
  'openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen2.5-coder-32b-instruct',
  'qwen/qwen3-next-80b-a3b-instruct', 'qwen/qwen3-next-80b-a3b-thinking', 'qwen/qwq-32b',
  'sarvamai/sarvam-m', 'stepfun-ai/step-3.5-flash', 'stockmark/stockmark-2-100b-instruct',
  'upstage/solar-10.7b-instruct', 'z-ai/glm4.7', 'z-ai/glm5.1', 'z-ai/glm-5.2', 'z-ai/glm-5.3', 'z-ai/glm-5.3-flash'
]);
const specialized: Record<string, { kind: ModelKind; source: string }> = {
  'nvidia/nvclip': {kind:'embedding', source:'https://docs.api.nvidia.com/nim/reference/nvidia-nvclip'},
  'nvidia/nemotron-parse': {kind:'document', source:'https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-parse'},
  'nvidia/nemotron-parse-2.0': {kind:'document', source:'https://docs.api.nvidia.com/nim/re/reference/nvidia-nemotron-parse-2_0'},
  'nvidia/nemotron-3.5-parse': {kind:'document', source:'https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-parse'}
};
export function nvidiaPurpose(id: string): Classification | null {
  const result = (kind: ModelKind, verified: boolean, evidence = source): Classification => ({
    kind, confidence: verified ? 'metadata' : 'inferred', source: evidence, checkedAt,
    reason: verified ? 'NVIDIA 공식 모델 문서의 용도 분류. 계정 접근 권한·무료 사용·Tier를 보장하지 않습니다.' : 'NVIDIA 카탈로그의 모델 계열/이름 기반 추정. 개별 엔드포인트 호환성은 미검증입니다.',
    // Keep opt-in even for documented text: purpose alone does not verify this account's endpoint.
    textProbe: kind === 'text' ? 'opt_in' : 'unsupported'
  });
  const exact = specialized[id];
  if (exact) return result(exact.kind, true, exact.source);
  // Specialized heads must win over language-model backbone names and broad media hints.
  const name = id.split('/')[1] ?? '';
  for (const [kind, pattern] of [
    ['reranking', /(?:^|-)(?:rerank|rerankqa)(?:-|$)/],
    ['embedding', /(?:^|-)(?:embed|embedqa|embedding)(?:-|$)/],
    ['moderation', /(?:guard|content-safety|topic-control|jailbreak)/],
    ['reward', /(?:^|-)reward(?:-|$)/],
    ['detection', /(?:^|-)(?:detector|detect)(?:-|$)/],
    ['document', /(?:^|-)(?:parse|ocr|deplot)(?:[-.]|$)/]
  ] as [ModelKind, RegExp][]) if (pattern.test(name)) return result(kind, false);
  if (textModels.has(id)) return result('text', true);
  // Do not infer future omni/audio/image/video or specialized scientific models as chat.
  if (/(?:^|-)(?:omni|audio|speech|tts|image|video|diffusion|ising|cosmos)(?:[-\d]|$)/.test(name)) return null;
  const families: Record<string, RegExp> = {
    '01-ai': /^yi-/, ai21labs: /^jamba-/, aisingapore: /^sea-lion-/, bigcode: /^starcoder/, databricks: /^dbrx-/,
    'deepseek-ai': /^deepseek-/, google: /^(?:codegemma|gemma|recurrentgemma)(?:-|$)/,
    ibm: /^granite-/, meta: /^(?:llama[-\d]|codellama-)/, microsoft: /^phi-/,
    minimaxai: /^minimax-m\d/, mistralai: /^(?:mistral|mixtral|codestral)(?:-|$)/,
    'nv-mistralai': /^mistral-/, moonshotai: /^kimi-/, nvidia: /^(?:llama[-\d]|nemotron[-\d]|mistral-nemo-|riva-translate-)/,
    openai: /^gpt-oss-/, qwen: /^(?:qwen|qwq)[-\d]/, writer: /^palmyra-/, 'z-ai': /^glm[-\d]/,
    zyphra: /^zamba\d/, poolside: /^laguna-/, 'stepfun-ai': /^step-\d/
  };
  if (families[id.split('/')[0]!]?.test(name)) return result('text', false);
  // Documented visual-language families produce text; vision input is not image generation.
  if (['adept/fuyu-8b','microsoft/kosmos-2','nvidia/neva-22b','nvidia/vila'].includes(id))
    return result('text', false, 'https://github.com/NVIDIA-AI-IOT/live-vlm-webui/blob/main/docs/usage/list-of-vlms.md');
  return null;
}
