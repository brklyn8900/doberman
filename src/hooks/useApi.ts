import { useState, useEffect, useCallback } from "react";
import {
  fetchStatus,
  fetchPings,
  fetchOutages,
  fetchConfig,
  fetchSpeedTests,
  fetchStatsSummaryFull,
  type StatusResponse,
  type PingRecord,
  type Outage,
  type Config,
  type PingParams,
  type OutageParams,
  type SpeedTestResult,
  type StatsSummary,
} from "../api";

interface UseQueryResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

function useQuery<T>(
  port: number | null,
  fetcher: (port: number) => Promise<T>,
): UseQueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (port === null) return;
    let cancelled = false;
    setLoading(true);

    fetcher(port)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [port, fetcher, tick]);

  return { data, loading, error, refetch };
}

export function useStatus(port: number | null): UseQueryResult<StatusResponse> {
  const fetcher = useCallback((p: number) => fetchStatus(p), []);
  return useQuery(port, fetcher);
}

export function usePings(
  port: number | null,
  params?: PingParams,
): UseQueryResult<{ pings: PingRecord[]; total: number }> {
  const fetcher = useCallback(
    (p: number) => fetchPings(p, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(params)],
  );
  return useQuery(port, fetcher);
}

export function useOutages(
  port: number | null,
  params?: OutageParams,
): UseQueryResult<{ outages: Outage[] }> {
  const fetcher = useCallback(
    (p: number) => fetchOutages(p, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(params)],
  );
  return useQuery(port, fetcher);
}

export function useConfig(port: number | null): UseQueryResult<Config> {
  const fetcher = useCallback((p: number) => fetchConfig(p), []);
  return useQuery(port, fetcher);
}

export function useSpeedTests(
  port: number | null,
): UseQueryResult<{ tests: SpeedTestResult[] }> {
  const fetcher = useCallback((p: number) => fetchSpeedTests(p), []);
  return useQuery(port, fetcher);
}

export function useStatsSummary(
  port: number | null,
): UseQueryResult<StatsSummary> {
  const fetcher = useCallback((p: number) => fetchStatsSummaryFull(p), []);
  return useQuery(port, fetcher);
}
