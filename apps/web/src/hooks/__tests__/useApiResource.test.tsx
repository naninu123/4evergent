import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useApiResource } from '../useApiResource';

describe('useApiResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts with loading=true during initial fetch', () => {
    const fetcher = vi.fn(() => new Promise(() => {})); // Never resolves
    const { result } = renderHook(() => useApiResource(fetcher, []));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBe(null);
    expect(result.current.error).toBe(null);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stores successful response in data and sets loading=false', async () => {
    const mockData = { id: '123', name: 'test' };
    const fetcher = vi.fn(() => Promise.resolve(mockData));
    const { result } = renderHook(() => useApiResource(fetcher, []));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toEqual(mockData);
    expect(result.current.error).toBe(null);
    expect(result.current.loading).toBe(false);
  });

  it('stores empty array as data when successfully returned', async () => {
    const fetcher = vi.fn(() => Promise.resolve([]));
    const { result } = renderHook(() => useApiResource<unknown[]>(fetcher, []));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toEqual([]);
    expect(result.current.error).toBe(null);
    expect(result.current.loading).toBe(false);
  });

  it('exposes error message and sets loading=false on fetch failure', async () => {
    const errorMessage = 'Network request failed';
    const fetcher = vi.fn(() => Promise.reject(new Error(errorMessage)));
    const { result } = renderHook(() => useApiResource(fetcher, []));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toBe(null);
    expect(result.current.error).toBe(errorMessage);
    expect(result.current.loading).toBe(false);
  });

  it('handles non-Error thrown values safely', async () => {
    const fetcher = vi.fn(() => Promise.reject('string error'));
    const { result } = renderHook(() => useApiResource(fetcher, []));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('string error');
  });

  it('protects against stale requests - newer response wins', async () => {
    // Create deferred promises for deterministic control
    type Deferred<T> = {
      promise: Promise<T>;
      resolve: (value: T) => void;
      reject: (reason?: unknown) => void;
    };

    function createDeferred<T>(): Deferred<T> {
      let resolve!: (value: T) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const request1 = createDeferred<string>();
    const request2 = createDeferred<string>();

    let callCount = 0;
    const fetcher = vi.fn(() => {
      callCount++;
      return callCount === 1 ? request1.promise : request2.promise;
    });

    const { result, rerender } = renderHook(
      ({ dep }) => useApiResource(() => fetcher(), [dep]),
      { initialProps: { dep: 1 } }
    );

    // Initial request started
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Change dependency to trigger second request before first completes
    rerender({ dep: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Resolve request 2 first
    request2.resolve('response-2');
    await waitFor(() => expect(result.current.data).toBe('response-2'));

    // Now resolve the stale request 1 - it should not update state
    request1.resolve('response-1');
    
    // Wait a bit to ensure no state update occurs
    await new Promise(resolve => setTimeout(resolve, 50));
    
    expect(result.current.data).toBe('response-2'); // Still response-2, not overwritten
    expect(result.current.error).toBe(null);
  });

  it('prevents state updates after component unmounts', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    type Deferred<T> = {
      promise: Promise<T>;
      resolve: (value: T) => void;
    };

    function createDeferred<T>(): Deferred<T> {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    const request = createDeferred<string>();
    const fetcher = vi.fn(() => request.promise);

    const { result, unmount } = renderHook(() => useApiResource(fetcher, []));

    expect(result.current.loading).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Unmount before the request resolves
    unmount();

    // Resolve the request after unmount
    request.resolve('data-after-unmount');

    // Wait to ensure no state update occurs
    await new Promise(resolve => setTimeout(resolve, 50));

    // No React warnings about state updates on unmounted component
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining("Can't perform a React state update on an unmounted component")
    );

    consoleError.mockRestore();
  });

  it('calls reload() to refetch data with loading state', async () => {
    type Deferred<T> = {
      promise: Promise<T>;
      resolve: (value: T) => void;
    };

    function createDeferred<T>(): Deferred<T> {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    const initialRequest = createDeferred<string>();
    const reloadRequest = createDeferred<string>();

    let callCount = 0;
    const fetcher = vi.fn(() => {
      callCount++;
      return callCount === 1 ? initialRequest.promise : reloadRequest.promise;
    });

    const { result } = renderHook(() => useApiResource(fetcher, []));

    // Resolve initial fetch
    initialRequest.resolve('initial-data');
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe('initial-data');
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Call reload (don't resolve immediately)
    const reloadPromise = result.current.reload();
    
    // Wait for loading to become true
    await waitFor(() => expect(result.current.loading).toBe(true));
    
    // Resolve reload request
    reloadRequest.resolve('reloaded-data');
    await reloadPromise;
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toBe('reloaded-data');
    expect(result.current.error).toBe(null);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('clears previous error when reload() is called', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('initial error'))
      .mockResolvedValueOnce('success-data');

    const { result } = renderHook(() => useApiResource(fetcher, []));

    // Wait for initial fetch to fail
    await waitFor(() => expect(result.current.error).toBe('initial error'));
    expect(result.current.loading).toBe(false);

    // Call reload
    await result.current.reload();
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toBe('success-data');
    expect(result.current.error).toBe(null);
  });

  it('refetches when dependencies change', async () => {
    const fetcher1 = vi.fn(() => Promise.resolve('data-1'));
    const fetcher2 = vi.fn(() => Promise.resolve('data-2'));

    const { result, rerender } = renderHook(
      ({ dep, fn }) => useApiResource(fn, [dep]),
      { initialProps: { dep: 'a', fn: fetcher1 } }
    );

    await waitFor(() => expect(result.current.data).toBe('data-1'));
    expect(fetcher1).toHaveBeenCalledTimes(1);

    // Change dependency
    rerender({ dep: 'b', fn: fetcher2 });

    await waitFor(() => expect(result.current.data).toBe('data-2'));
    expect(fetcher2).toHaveBeenCalledTimes(1);
  });

  it('keeps previous data during reload to avoid UI flicker', async () => {
    type Deferred<T> = {
      promise: Promise<T>;
      resolve: (value: T) => void;
    };

    function createDeferred<T>(): Deferred<T> {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    const initialRequest = createDeferred<string>();
    const reloadRequest = createDeferred<string>();

    let callCount = 0;
    const fetcher = vi.fn(() => {
      callCount++;
      return callCount === 1 ? initialRequest.promise : reloadRequest.promise;
    });

    const { result } = renderHook(() => useApiResource(fetcher, []));

    // Resolve initial request
    initialRequest.resolve('initial-data');
    await waitFor(() => expect(result.current.data).toBe('initial-data'));

    // Start reload (don't wait)
    const reloadPromise = result.current.reload();
    
    // Wait for loading to become true
    await waitFor(() => expect(result.current.loading).toBe(true));
    
    // Data should still be available during reload
    expect(result.current.data).toBe('initial-data');

    // Complete reload
    reloadRequest.resolve('new-data');
    await reloadPromise;
    await waitFor(() => expect(result.current.data).toBe('new-data'));
  });
});
