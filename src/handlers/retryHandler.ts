import retry from 'async-retry';
import { MAX_RETRY_LIMIT_MS, POSSIBLE_RETRY_STATUS_HEADERS } from '../globals';

function createAbortResponse(timeout?: number): Response {
  const isTimeout = timeout !== undefined;
  return new Response(
    JSON.stringify({
      error: {
        message: isTimeout
          ? `Request exceeded the timeout sent in the request: ${timeout}ms`
          : 'Request Aborted by user',
        type: isTimeout ? 'timeout_error' : 'cancel_error',
        param: null,
        code: null,
      },
    }),
    {
      headers: { 'content-type': 'application/json' },
      status: isTimeout ? 408 : 499,
    }
  );
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number,
  requestHandler?: () => Promise<Response>
): Promise<Response> {
  // A timeout belongs to this attempt; it must not abort later retries.
  const controller = new AbortController();
  const callerSignal = options.signal;
  const abortUpstream = (): void => controller.abort();
  if (callerSignal?.aborted) {
    abortUpstream();
  } else {
    callerSignal?.addEventListener('abort', abortUpstream, {
      once: true,
    });
  }
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const timeoutRequestOptions = {
    ...options,
    signal: controller.signal,
  };

  let response;

  try {
    if (requestHandler) {
      response = await requestHandler();
    } else {
      response = await fetch(url, timeoutRequestOptions);
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      response = createAbortResponse(
        callerSignal?.aborted ? undefined : timeout
      );
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timeoutId);
    // Successful streams still need to receive the caller's cancellation.
    if (!response?.ok) {
      callerSignal?.removeEventListener('abort', abortUpstream);
    }
  }

  return response;
}

/**
 * Tries making a fetch request a specified number of times until it succeeds.
 * If the response's status code is included in the statusCodesToRetry array,
 * the request is retried.
 *
 * @param {string} url - The URL to which the request is made.
 * @param {RequestInit} options - The options for the request, such as method, headers, and body.
 * @param {number} retryCount - The maximum number of times to retry the request.
 * @param {number[]} statusCodesToRetry - The HTTP status codes that should trigger a retry.
 * @returns {Promise<[Response, number | undefined]>} - The response from the request and the number of attempts it took to get a successful response.
 *                                                     If all attempts fail, the error message and status code are returned as a Response object, and the number of attempts is undefined.
 * @throws Will throw an error if the request fails after all retry attempts, with the error message and status code in the thrown error.
 */
export const retryRequest = async (
  url: string,
  options: RequestInit,
  retryCount: number,
  statusCodesToRetry: number[],
  timeout: number | null,
  requestHandler?: () => Promise<Response>,
  followProviderRetry?: boolean
): Promise<{
  response: Response;
  attempt: number | undefined;
  createdAt: Date;
  skip: boolean;
}> => {
  let lastResponse: Response | undefined;
  let lastAttempt: number | undefined;
  const signal = options.signal;
  const start = new Date();
  let retrySkipped = false;

  let remainingRetryTimeout = MAX_RETRY_LIMIT_MS;

  try {
    await retry(
      async (bail: any, attempt: number, rateLimiter: any) => {
        try {
          if (signal?.aborted) {
            throw new DOMException('Request Aborted by user', 'AbortError');
          }
          let response: Response;

          if (timeout) {
            response = await fetchWithTimeout(
              url,
              options,
              timeout,
              requestHandler
            );
          } else if (requestHandler) {
            response = await requestHandler();
          } else {
            try {
              response = await fetch(url, options);
            } catch (e: any) {
              if (e.name === 'AbortError') {
                response = createAbortResponse();
              } else {
                throw e;
              }
            }
          }
          if (signal?.aborted && response.status === 499) {
            retrySkipped = true;
          }
          if (statusCodesToRetry.includes(response.status)) {
            const errorObj: any = new Error(await response.text());
            errorObj.status = response.status;
            errorObj.headers = Object.fromEntries(response.headers);

            if (response.status === 429 && followProviderRetry) {
              // get retry header.
              const retryHeader = POSSIBLE_RETRY_STATUS_HEADERS.find(
                (header) => {
                  return response.headers.get(header);
                }
              );
              const retryAfterValue = response.headers.get(retryHeader ?? '');
              // continue, if no retry header is found.
              if (!retryAfterValue) {
                throw errorObj;
              }
              let retryAfter: number | undefined;
              // if the header is `retry-after` convert it to milliseconds.
              if (retryHeader === 'retry-after') {
                retryAfter = Number.parseInt(retryAfterValue.trim()) * 1000;
              } else {
                retryAfter = Number.parseInt(retryAfterValue.trim());
              }

              if (retryAfter && !Number.isNaN(retryAfter)) {
                // break the loop if the retryAfter is greater than the max retry limit
                if (
                  retryAfter >= MAX_RETRY_LIMIT_MS ||
                  retryAfter > remainingRetryTimeout
                ) {
                  retrySkipped = true;
                  rateLimiter._timeouts = [];
                  throw errorObj;
                }
                remainingRetryTimeout -= retryAfter;
                // will reset the current backoff timeout(s) to `0`.
                rateLimiter._timeouts = Array.from({
                  length: retryCount - attempt + 1,
                }).map(() => 0);

                throw await new Promise((resolve) => {
                  const abortWait = (): void => {
                    clearTimeout(retryTimeoutId);
                    resolve(errorObj);
                  };
                  const retryTimeoutId = setTimeout(() => {
                    signal?.removeEventListener('abort', abortWait);
                    resolve(errorObj);
                  }, retryAfter);
                  if (signal?.aborted) {
                    abortWait();
                  } else {
                    signal?.addEventListener('abort', abortWait, {
                      once: true,
                    });
                  }
                });
              } else {
                throw errorObj;
              }
            }

            throw errorObj;
          } else if (response.status >= 200 && response.status <= 204) {
            // do nothing
          } else {
            // All error codes that aren't retried need to be propogated up
            const errorObj: any = new Error(await response.clone().text());
            errorObj.status = response.status;
            errorObj.headers = Object.fromEntries(response.headers);
            bail(errorObj);
            return;
          }
          lastResponse = response;
        } catch (error: any) {
          if (signal?.aborted) {
            retrySkipped = true;
            const abortResponse = createAbortResponse();
            const abortError: any = new Error(await abortResponse.text());
            abortError.status = abortResponse.status;
            abortError.headers = Object.fromEntries(abortResponse.headers);
            bail(abortError);
            return;
          }
          if (attempt >= retryCount + 1) {
            bail(error);
            return;
          }
          throw error;
        }
      },
      {
        retries: retryCount,
        onRetry: (error: Error, attempt: number) => {
          lastAttempt = attempt;
        },
        randomize: false,
      }
    );
  } catch (error: any) {
    if (
      error instanceof TypeError &&
      error.cause instanceof Error &&
      error.cause?.name === 'ConnectTimeoutError'
    ) {
      console.error(
        'retryRequest ConnectTimeoutError error:',
        error.cause,
        error.message
      );
      // This error comes in case the host address is unreachable. Empty status code used to get returned
      // from here hence no retry logic used to get called.
      lastResponse = new Response(error.message, {
        status: 503,
      });
    } else if (!error.status || error instanceof TypeError) {
      console.error('retryRequest error:', error.cause, error.message);
      // The retry handler will always attach status code to the error object
      lastResponse = new Response(
        `Message: ${error.message} Cause: ${error.cause ?? 'NA'} Name: ${error.name}`,
        {
          status: 500,
        }
      );
    } else {
      lastResponse = new Response(error.message, {
        status: error.status,
        headers: error.headers,
      });
    }
  }
  return {
    response: lastResponse as Response,
    attempt: lastAttempt,
    createdAt: start,
    skip: retrySkipped,
  };
};
