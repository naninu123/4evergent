import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useApiResource } from '../useApiResource';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useApiResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { data, error, loading, reload } and transitions from loading to resolved data', async () => {
    const deferred = createDeferred<{ count: number }>();
    const fetcher = vi.fn(() => deferred.promise);

    const { result } = renderHook(() => useApiResource(fetcher, []));

    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(typeof result.current.reload).toBe('function');

    await act(async () => {
      deferred.resolve({ count: 42 });
      await deferred.promise;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({ count: 42 });
  });

  it('captures error message and clears loading when fetcher rejects', async () => {
    const fetcher = vi.fn(() => Promise.reject(new Error('Backend unavailable')));

    const { result } = renderHook(() => useApiResource(fetcher, []));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe('Backend unavailable');
    expect(result.current.data).toBeNull();
  });

  it('ignores stale responses when two fetches resolve out of order', async () => {
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(
      ({ dep }) => useApiResource(fetcher, [dep]),
      { initialProps: { dep: 'req-1' } }
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(true);

    // Trigger a second fetch before the first resolves
    rerender({ dep: 'req-2' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(true);

    // Resolve the SECOND request first
    await act(async () => {
      second.resolve('latest-data');
      await second.promise;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBe('latest-data');

    // Now resolve the stale FIRST request out of order — must be ignored
    await act(async () => {
      first.resolve('stale-data');
      await first.promise;
    });

    expect(result.current.data).toBe('latest-data');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does not set state or emit warnings when unmounted mid-flight', async () => {
    const deferred = createDeferred<string>();
    const fetcher = vi.fn(() => deferred.promise);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { result, unmount } = renderHook(() => useApiResource(fetcher, []));
      expect(result.current.loading).toBe(true);

      // Unmount while the request is still pending
      unmount();

      await act(async () => {
        deferred.resolve('post-unmount-data');
        await deferred.promise;
      });

      // State snapshot captured prior to unmount remains untouched and no React warnings fired
      expect(result.current.data).toBeNull();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('reload() re-invokes the fetcher and sets loading=true during the reload', async () => {
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useApiResource(fetcher, []));

    await act(async () => {
      first.resolve('v1');
      await first.promise;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBe('v1');

    // Trigger reload() -> loading must immediately become true while second fetch is in flight
    act(() => {
      result.current.reload();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(true);

    await act(async () => {
      second.resolve('v2');
      await second.promise;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBe('v2');
  });
});
