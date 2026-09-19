import { Context } from 'hono';
import models from '../data/models.json';
import providers from '../data/providers.json';
import {
  getLlmRuntimeConfig,
  getRuntimeModels,
} from '../runtimeConfig';

/**
 * Handles the models request. Returns a list of models supported by the Ai gateway.
 * Allows filters in query params for the provider
 * @param c - The Hono context
 * @returns - The response
 */
export async function modelsHandler(c: Context): Promise<Response> {
  const runtimeModels = getRuntimeModels(getLlmRuntimeConfig());
  // Discovery lists deployable routes; the reference endpoint remains the
  // full Portkey catalog for clients that use it as documentation.
  if (c.req.path === '/v1/models' && runtimeModels.length) {
    return c.json({object: 'list', data: runtimeModels, count: runtimeModels.length});
  }
  // Keep Portkey's built-in catalogue for backwards compatibility and put
  // deployment-specific aliases (for example lite, flash, and pro) first.
  const allModels = [
    ...runtimeModels,
    ...models.data.filter(
      (model: any) => !runtimeModels.some((runtimeModel) => runtimeModel.id === model.id)
    ),
  ];
  // If the request does not contain a provider query param, return all models. Add a count as well.
  const provider = c.req.query('provider');
  if (!provider) {
    return c.json({
      ...models,
      data: allModels,
      count: allModels.length,
    });
  } else {
    // Filter the models by the provider
    const filteredModels = allModels.filter(
      (model: any) =>
        model.provider?.id === provider || model.providers?.includes(provider)
    );
    return c.json({
      ...models,
      data: filteredModels,
      count: filteredModels.length,
    });
  }
}

export async function providersHandler(c: Context): Promise<Response> {
  return c.json({
    ...providers,
    count: providers.data.length,
  });
}
