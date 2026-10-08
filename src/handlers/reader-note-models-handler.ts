import { Context, Next } from 'hono';
import { env } from 'hono/adapter';
import { HEADER_KEYS } from '../globals';
import { getRuntimeModels } from '../runtimeConfig';

/** Expose ReaderNote aliases without replacing upstream model discovery. */
export async function readerNoteModelsHandler(
  context: Context,
  next: Next
): Promise<Response | void> {
  if (context.get('readerNoteRequest') !== true || env(context).ALBUS_BASEPATH ||
    context.req.header(HEADER_KEYS.PROVIDER) || context.req.header(HEADER_KEYS.VIRTUAL_KEY)) {
    return next();
  }
  const models = getRuntimeModels();
  if (!models.length) return next();
  const provider = context.req.query('provider');
  const data = provider
    ? models.filter((model) => model.provider?.id === provider || model.providers?.includes(provider))
    : models;
  return context.json({ object: 'list', data, count: data.length });
}
