/**
 * Runtime configuration supplied by the ReaderNote server.
 *
 * The gateway is also used as a standalone Portkey-compatible application,
 * so this module deliberately keeps the configuration optional.  When the
 * ReaderNote server starts it calls `setLlmRuntimeConfig`; standalone users
 * can use the `LLM_MODEL_ROUTES` environment variable instead.
 */

export interface RuntimeModelTarget {
  provider?: string;
  apiKey?: string;
  customHost?: string;
  model?: string;
  weight?: number;
  [key: string]: any;
}

export interface RuntimeModelRoute {
  id: string;
  label?: string;
  strategy?: { mode?: string; onStatusCodes?: number[]; [key: string]: any };
  targets: RuntimeModelTarget[];
  [key: string]: any;
}

let runtimeConfig: Record<string, any> = {};

function environmentValue(key: string) {
  // `process` is not available in Cloudflare/workerd builds.
  if (typeof process === 'undefined') return undefined;
  return process.env?.[key];
}

export function setLlmRuntimeConfig(config: Record<string, any> = {}) {
  runtimeConfig = config || {};
}

export function getLlmRuntimeConfig() {
  return runtimeConfig;
}

function parseJson(value: any): any {
  if (!value || typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function csv(value: any): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim());
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberOr(value: any, fallback = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normaliseTarget(target: any, defaults: Record<string, any> = {}) {
  const value = target || {};
  const override = value.overrideParams || value.override_params || {};
  return {
    ...value,
    provider: value.provider || defaults.provider || 'openai',
    apiKey: value.apiKey || value.api_key || defaults.apiKey,
    customHost:
      value.customHost || value.custom_host || value.baseUrl || value.base_url || defaults.customHost,
    model: value.model || override.model || defaults.model,
    weight: numberOr(value.weight, numberOr(defaults.weight, 1)),
    overrideParams: {
      ...override,
      ...(value.model || defaults.model ? { model: value.model || override.model || defaults.model } : {}),
    },
  };
}

function routeFromValue(id: string, value: any, defaults: Record<string, any> = {}): RuntimeModelRoute | undefined {
  if (Array.isArray(value)) {
    const targets = value.map((target) => normaliseTarget(target, defaults));
    return targets.length ? { id, targets } : undefined;
  }

  if (!value || typeof value !== 'object') return undefined;
  const targetValues = value.targets || value.providers || value.backends;
  const targets = Array.isArray(targetValues)
    ? targetValues.map((target: any) => normaliseTarget(target, { ...defaults, ...value }))
    : [normaliseTarget(value, { ...defaults, ...value })];

  if (!targets.length) return undefined;
  const rawStrategy = typeof value.strategy === 'string'
    ? { mode: value.strategy }
    : value.strategy || { mode: targets.length > 1 ? 'loadbalance' : 'single' };
  const strategy = {
    ...rawStrategy,
    mode: String(rawStrategy.mode || 'loadbalance').toLowerCase(),
    ...(String(rawStrategy.mode || '').toLowerCase() === 'fallback' &&
    rawStrategy.allowExceptionFallback === undefined
      ? { allowExceptionFallback: true }
      : {}),
  };
  return {
    ...value,
    id,
    label: value.label || value.name || ({lite: 'Lite', flash: 'Flash', pro: 'Pro'} as Record<string, string>)[id] || id,
    strategy,
    targets,
  };
}

/**
 * Read model routes from either a JSON configuration or the explicit
 * LLM_<MODEL>_* environment-style fields.  The latter keeps deployment
 * configuration easy to express in a .env file while the JSON form supports
 * arbitrary numbers of providers and fallback strategies.
 */
export function getConfiguredModelRoutes(config: Record<string, any> = runtimeConfig): RuntimeModelRoute[] {
  const source = config || {};
  const raw = parseJson(
    source.LLM_MODEL_ROUTES ||
      source.LLM_MODELS_CONFIG ||
      source.LLM_MODEL_CONFIG ||
      source.LLM_MODELS ||
      environmentValue('LLM_MODEL_ROUTES') ||
      environmentValue('LLM_MODELS_CONFIG')
  );
  const routes: RuntimeModelRoute[] = [];

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.entries(raw).forEach(([id, value]) => {
      const route = routeFromValue(id, value);
      if (route) routes.push(route);
    });
  } else if (Array.isArray(raw)) {
    raw.forEach((value: any, index: number) => {
      const id = value?.id || value?.name || `model-${index + 1}`;
      const route = routeFromValue(id, value);
      if (route) routes.push(route);
    });
  }

  // Convenience fields for the three first-class ReaderNote models.  Explicit
  // JSON routes always win over these values.
  ['lite', 'flash', 'pro'].forEach((id) => {
    if (routes.some((route) => normaliseId(route.id) === normaliseId(id))) return;
    const prefix = id.toUpperCase().replace('-', '_');
    const model = source[`LLM_${prefix}_MODEL`] || environmentValue(`LLM_${prefix}_MODEL`);
    const provider = source[`LLM_${prefix}_PROVIDER`] || environmentValue(`LLM_${prefix}_PROVIDER`);
    const apiKey = source[`LLM_${prefix}_API_KEY`] || environmentValue(`LLM_${prefix}_API_KEY`);
    const baseUrl = source[`LLM_${prefix}_BASE_URL`] || environmentValue(`LLM_${prefix}_BASE_URL`);
    if (model || provider || apiKey || baseUrl) {
      const route = routeFromValue(id, {
        model,
        provider,
        apiKey,
        customHost: baseUrl,
        weight: source[`LLM_${prefix}_WEIGHT`] || environmentValue(`LLM_${prefix}_WEIGHT`),
        strategy: {
          mode: source[`LLM_${prefix}_STRATEGY`] || environmentValue(`LLM_${prefix}_STRATEGY`) || 'loadbalance',
        },
      });
      if (route) routes.push(route);
    }
  });

  // Keep the three ReaderNote aliases discoverable for an existing deployment
  // that only has the legacy comma-separated LLM_* settings.  They share the
  // legacy provider pool until an explicit LLM_MODEL_ROUTES entry overrides
  // them, so upgrading the gateway does not make `/v1/models` suddenly empty.
  const hasLegacyConfig = [
    source.LLM_API_KEY,
    source.LLM_BASE_URL,
    source.LLM_PROVIDER,
    source.LLM_MODEL,
  ].some(Boolean);
  if (hasLegacyConfig) {
    const keys = csv(source.LLM_API_KEY || environmentValue('LLM_API_KEY'));
    const hosts = csv(source.LLM_BASE_URL || environmentValue('LLM_BASE_URL'));
    const providers = csv(source.LLM_PROVIDER || environmentValue('LLM_PROVIDER'));
    const models = csv(source.LLM_MODEL || environmentValue('LLM_MODEL'));
    const weights = csv(source.LLM_WEIGHT || environmentValue('LLM_WEIGHT')).map(numberOr);
    const legacyTargets = (keys.length || hosts.length || providers.length || models.length
      ? Array.from({ length: Math.max(keys.length, hosts.length, providers.length, models.length, 1) })
      : []
    ).map((_, index) => normaliseTarget({
      apiKey: keys[index] || keys[0],
      customHost: hosts[index] || hosts[0],
      provider: providers[index] || providers[0] || 'openai',
      model: models[index] || models[0] || 'deepseek-chat',
      weight: weights[index] ?? 1,
    }));

    ['lite', 'flash', 'pro'].forEach((id) => {
      if (!routes.some((route) => normaliseId(route.id) === id)) {
        routes.push({
          id,
          label: id === 'lite' ? 'Lite' : id === 'flash' ? 'Flash' : 'Pro',
          strategy: { mode: legacyTargets.length > 1 ? 'loadbalance' : 'single' },
          targets: legacyTargets,
        });
      }
    });
  }

  return routes;
}

export function normaliseId(value: any) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[ _]+/g, '-');
}

export function findModelRoute(model: string | undefined, config = runtimeConfig): RuntimeModelRoute | undefined {
  if (!model) return undefined;
  const targetId = normaliseId(model);
  const routes = getConfiguredModelRoutes(config);
  const matched = routes.find((route) => {
    if (normaliseId(route.id) === targetId || normaliseId(route.label) === targetId) return true;
    return route.targets.some((target) => normaliseId(target.model) === targetId);
  });
  if (matched) return matched;

  // `reader-note` was the model id emitted by older desktop clients. Keep it
  // as an alias for the first-class Lite route.
  if (targetId === 'reader-note') {
    return routes.find((route) => normaliseId(route.id) === 'lite') || routes[0];
  }
  return undefined;
}

/** Convert a route into the config shape consumed by tryTargetsRecursively. */
export function applyModelRoute(config: any, model: string | undefined) {
  const route = findModelRoute(model);
  if (!route) return config;

  const inheritedMax = Number(
    config?.overrideParams?.maxCompletionTokens ??
      config?.overrideParams?.max_completion_tokens ??
      config?.override_params?.max_completion_tokens
  );

  const targets = route.targets.map((target) => {
    const { model: targetModel, overrideParams, ...rest } = target;
    const routeMax = Number(
      overrideParams?.maxCompletionTokens ?? overrideParams?.max_completion_tokens
    );
    const maxCompletionTokens = Number.isFinite(inheritedMax)
      ? Number.isFinite(routeMax)
        ? Math.min(inheritedMax, routeMax)
        : inheritedMax
      : undefined;
    const safeOverrideParams = { ...(overrideParams || {}) };
    delete safeOverrideParams.maxCompletionTokens;
    delete safeOverrideParams.max_completion_tokens;
    return {
      ...rest,
      provider: target.provider,
      overrideParams: {
        ...safeOverrideParams,
        ...(targetModel ? { model: targetModel } : {}),
        ...(Number.isFinite(maxCompletionTokens)
          ? { max_completion_tokens: maxCompletionTokens }
          : {}),
      },
    };
  });

  const strategy = route.strategy || { mode: targets.length > 1 ? 'loadbalance' : 'single' };
  return {
    ...config,
    strategy,
    targets,
  };
}

function modelRecord(id: string, route?: RuntimeModelRoute) {
  const providers = route?.targets
    .map((target) => target.provider)
    .filter(Boolean)
    .filter((provider, index, list) => list.indexOf(provider) === index);
  return {
    id,
    object: 'model',
    name: route?.label || id,
    owned_by: 'reader-note',
    ...(providers?.length ? { provider: { id: providers[0] } } : {}),
    ...(providers?.length ? { providers } : {}),
  };
}

/** Build an OpenAI-compatible response while retaining the gateway's static catalogue. */
export function getRuntimeModels(config = runtimeConfig) {
  const routes = getConfiguredModelRoutes(config);
  const dynamic = routes.map((route) => modelRecord(route.id, route));
  const legacyModels = csv(config.LLM_MODEL || environmentValue('LLM_MODEL')).map((id) => modelRecord(id));
  const unique = new Map<string, any>();
  [...dynamic, ...legacyModels].forEach((model) => unique.set(model.id, model));
  return Array.from(unique.values());
}
