// Loads one or more API reads for a screen; a new `deps` value or `reload()` loads again, and a
// screen that goes away aborts its requests.
import { useCallback, useEffect, useState } from 'preact/hooks';

import { ApiError } from './client.js';

export type Loaded<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly error: ApiError }
  | { readonly state: 'ok'; readonly data: T; readonly at: Date };

export function useApi<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): { readonly result: Loaded<T>; readonly reload: () => void } {
  const [result, setResult] = useState<Loaded<T>>({ state: 'loading' });
  const [round, setRound] = useState(0);
  const reload = useCallback(() => setRound((r) => r + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setResult({ state: 'loading' });
    load(controller.signal).then(
      (data) => setResult({ state: 'ok', data, at: new Date() }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setResult({
          state: 'error',
          error: error instanceof ApiError ? error : new ApiError(0, 'unexpected'),
        });
      },
    );
    return () => controller.abort();
  }, [...deps, round]);
  return { result, reload };
}
