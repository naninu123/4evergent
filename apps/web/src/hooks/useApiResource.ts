import { useEffect, useState, useRef, useCallback, type DependencyList } from 'react';

/**
 * Reusable hook for API resource fetching with:
 * - Initial loading state
 * - Error handling
 * - Stale request protection
 * - Safe unmounting
 * - Manual reload capability
 */
export function useApiResource<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList
): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Request sequence counter for stale request protection
  const sequenceRef = useRef(0);
  // Unmount guard
  const isMountedRef = useRef(true);

  // Internal fetch function that handles sequence and mount checks
  const fetchData = useCallback(
    async (sequence: number) => {
      try {
        const result = await fetcher();
        
        // Only update state if this is still the latest request and component is mounted
        if (isMountedRef.current && sequenceRef.current === sequence) {
          setData(result);
          setError(null);
          setLoading(false);
        }
      } catch (e: unknown) {
        // Only update state if this is still the latest request and component is mounted
        if (isMountedRef.current && sequenceRef.current === sequence) {
          const message = e instanceof Error ? e.message : String(e);
          setError(message);
          setLoading(false);
        }
      }
    },
    [fetcher]
  );

  // Manual reload function
  const reload = useCallback(async () => {
    if (!isMountedRef.current) return;
    
    sequenceRef.current += 1;
    const currentSequence = sequenceRef.current;
    
    // Set loading state synchronously before async fetch
    setLoading(true);
    setError(null);
    // Keep previous data during reload to avoid UI flicker
    
    await fetchData(currentSequence);
  }, [fetchData]);

  // Initial fetch and refetch on dependency changes
  useEffect(() => {
    isMountedRef.current = true;
    sequenceRef.current += 1;
    const currentSequence = sequenceRef.current;

    setLoading(true);
    setError(null);

    fetchData(currentSequence);

    return () => {
      isMountedRef.current = false;
    };
  }, deps); // Dependencies passed by caller

  return { data, error, loading, reload };
}
