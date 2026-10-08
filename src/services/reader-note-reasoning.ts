import {
  ANTHROPIC,
  BEDROCK,
  COHERE,
  DASHSCOPE,
  DEEPSEEK,
  GOOGLE,
  GOOGLE_VERTEX_AI,
  OLLAMA,
  OPEN_AI,
  ZHIPU,
} from '../globals';
import { Options, Params } from '../types/requestBody';

type LegacyReasoningParams = Omit<Params, 'thinking'> & {
  thinking?: {
    type?: string;
    budget_tokens?: number;
    clear_thinking?: boolean;
  };
  extra_body?: Record<string, any>;
  enable_thinking?: boolean;
  thinking_budget?: number;
  preserve_thinking?: boolean;
  clear_thinking?: boolean;
};

const effortBudgets: Record<string, number> = {
  minimal: 1024,
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768,
  max: 32768,
};

/** Accept old ReaderNote clients while keeping the upstream thinking contract. */
export function normalizeReaderNoteReasoning(
  params: Params,
  providerOptions: Options
): Params {
  const input: LegacyReasoningParams = { ...params };
  if (input.extra_body && typeof input.extra_body === 'object') {
    for (const key of [
      'thinking',
      'reasoning_effort',
      'enable_thinking',
      'thinking_budget',
      'preserve_thinking',
      'clear_thinking',
    ]) {
      if (!(key in input) && key in input.extra_body) {
        (input as any)[key] = input.extra_body[key];
      }
    }
  }

  let thinking = input.thinking;
  if (!thinking && input.enable_thinking !== undefined) {
    thinking = { type: input.enable_thinking ? 'enabled' : 'disabled' };
  } else if (!thinking && input.reasoning_effort !== undefined) {
    thinking = {
      type: input.reasoning_effort === 'none' ? 'disabled' : 'enabled',
    };
  }

  if (thinking && (!thinking.type || ['enabled', 'disabled'].includes(thinking.type))) {
    const budget = thinking.budget_tokens ?? input.thinking_budget;
    const clearThinking = thinking.clear_thinking ?? input.clear_thinking ??
      (input.preserve_thinking === undefined ? undefined : !input.preserve_thinking);
    input.thinking = {
      ...thinking,
      type: thinking.type || 'enabled',
      budget_tokens: Number.isFinite(budget) && Number(budget) >= 0
        ? Number(budget)
        : thinking.type === 'disabled'
          ? 0
          : effortBudgets[input.reasoning_effort || 'medium'] ?? 4096,
      ...(clearThinking !== undefined ? { clear_thinking: clearThinking } : {}),
    };
    if (input.reasoning_effort === undefined) {
      input.reasoning_effort = thinking.type === 'disabled' ? 'none'
        : input.thinking.budget_tokens! <= 1024 ? 'low'
          : input.thinking.budget_tokens! <= 4096 ? 'medium' : 'high';
    }
  }
  // These providers already implement thinking in their upstream adapters.
  if (thinking && [ANTHROPIC, BEDROCK, COHERE, GOOGLE, GOOGLE_VERTEX_AI, OLLAMA]
    .includes(providerOptions.provider)) {
    delete input.reasoning_effort;
  }

  delete input.extra_body;
  delete input.enable_thinking;
  delete input.thinking_budget;
  delete input.preserve_thinking;
  delete input.clear_thinking;
  return input as Params;
}

/** Add vendor dialects only at the ReaderNote host boundary, after upstream mapping. */
export function adaptReaderNoteProviderRequest(
  request: Record<string, any>,
  params: Params,
  providerOptions: Options
): Record<string, any> {
  if (!params.thinking) return request;
  const model = String(params.model || '').toLowerCase();
  const provider = providerOptions.provider;
  const compatibleHost = provider === OPEN_AI && Boolean(providerOptions.customHost);
  const dashscope = provider === DASHSCOPE ||
    (compatibleHost && /dashscope|aliyuncs\.com|qwen\.ai/.test(providerOptions.customHost || ''));
  const qwen = compatibleHost && /qwen|qwq/.test(model);
  const deepseek = provider === DEEPSEEK || (compatibleHost && /deepseek/.test(model));
  const glm = provider === ZHIPU || (compatibleHost && /glm/.test(model));
  const mapped = { ...request };
  const enabled = params.thinking.type !== 'disabled';

  if (provider === BEDROCK && mapped.additionalModelRequestFields) {
    mapped.additionalModelRequestFields = { ...mapped.additionalModelRequestFields };
  }
  const anthropicFields = provider === ANTHROPIC ? mapped
    : provider === BEDROCK ? mapped.additionalModelRequestFields : undefined;
  if (anthropicFields?.thinking) {
    const maxTokens = Number(provider === ANTHROPIC ? mapped.max_tokens : mapped.inferenceConfig?.maxTokens);
    const beta = providerOptions.anthropicBeta ||
      (provider === BEDROCK ? anthropicFields.anthropic_beta : params.anthropic_beta);
    const interleaved = beta?.includes('interleaved-thinking-2025-05-14');
    if (params.thinking.type === 'disabled') {
      anthropicFields.thinking = { type: 'disabled' };
    } else if (params.thinking.type === 'enabled') {
      // Manual thinking needs at least 1024 tokens and room for the answer.
      const budget = Math.max(1024, params.thinking.budget_tokens);
      const available = !interleaved && Number.isFinite(maxTokens) ? maxTokens - 1 : budget;
      anthropicFields.thinking = available < 1024 ? { type: 'disabled' }
        : { type: 'enabled', budget_tokens: Math.min(budget, available) };
    }
    return mapped;
  }

  if (dashscope || qwen) {
    delete mapped.reasoning_effort;
    if (/instruct|qwen2/.test(model)) return mapped;
    const alwaysThinking = /thinking|qwq|qwen3\.8-2\.4t|deepseek-r1/.test(model);
    if (!alwaysThinking) mapped.enable_thinking = enabled;
    if (enabled || alwaysThinking) mapped.thinking_budget = params.thinking.budget_tokens;
  } else if (deepseek || glm) {
    delete mapped.reasoning_effort;
    if (deepseek && /deepseek-r1/.test(model)) return mapped;
    const thinking = params.thinking as NonNullable<LegacyReasoningParams['thinking']>;
    mapped.thinking = {
      type: thinking.type,
      ...(glm && enabled ? { clear_thinking: thinking.clear_thinking ?? false } : {}),
    };
    if (enabled && (deepseek ? /deepseek-v4/.test(model) : /glm-5\.[23]/.test(model))) {
      const effort = params.reasoning_effort || 'high';
      mapped.reasoning_effort = thinking.budget_tokens! >= 32768 ? 'max'
        : effort === 'medium' ? 'high' : effort === 'xhigh' ? 'max' : effort;
    }
  } else if (provider === OPEN_AI && enabled &&
    params.thinking.budget_tokens >= 32768 && /^gpt-(?:5\.[2-9]|6)/.test(model)) {
    mapped.reasoning_effort = 'xhigh';
  }
  return mapped;
}
