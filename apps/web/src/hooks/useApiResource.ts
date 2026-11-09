import { useCallback, useEffect, useRef, useState } from 'react';

export interface ApiResourceState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Shared hook for asynchronous API resource fetching.
 *
 * Consolidates the fetch -> loading -> error -> data state machine:
 * - Returns `{ data: T | null, error: string | null, loading: boolean, reload: () => void }`.
 * - Uses a monotonically increasing request-sequence token to ignore stale
 *   out-of-order responses when dependencies change or `reload()` is called.
 * - Guards against setting state after component unmount.
 * - Sets `loading: true` on both initial mount/dependency changes and `reload()`.
 *
 * Remaining pages still using manual `useState`/`useEffect` fetch patterns
 * (tracked as follow-up migrations):
 * - `Agents.tsx`, `Approvals.tsx`, `ApprovalDetail.tsx`, `ExecutionDetail.tsx`,
 *   `Executions.tsx`, `ExecutionList.tsx`, `Overview.tsx`, `ScheduleList.tsx`,
 *   `ScheduleManagement.tsx`, `Submit.tsx`.
 */
export function useApiResource<T>(
  fetcher: () => Promise<T>,
  deps: unknown[]
): ApiResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const runFetch = useCallback(() => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);

    let promise: Promise<T>;
    try {
      promise = Promise.resolve(fetcherRef.current());
    } catch (err) {
      promise = Promise.reject(err);
    }

    promise.then(
      (result) => {
        if (!mountedRef.current || seq !== requestSeqRef.current) return;
        setData(result);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!mountedRef.current || seq !== requestSeqRef.current) return;
        const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
        setError(message);
        setLoading(false);
      }
    );
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    runFetch();
    return () => {
      requestSeqRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSeqRef.current++;
    };
  }, []);

  const reload = useCallback(() => {
    if (!mountedRef.current) return;
    runFetch();
  }, [runFetch]);

  return { data, error, loading, reload };
}
