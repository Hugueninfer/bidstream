import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type { RfqStatus } from "./types";

export const qk = {
  skus: ["skus"] as const,
  rfqs: (status?: RfqStatus) => (status ? (["rfqs", status] as const) : (["rfqs"] as const)),
  rfqsAll: ["rfqs"] as const,
  rfq: (id: string) => ["rfq", id] as const,
  bids: (id: string) => ["bids", id] as const,
  estimate: (sku: string, qty: number) => ["estimate", sku, qty] as const,
  health: ["health"] as const,
};

export const useSkus = () =>
  useQuery({ queryKey: qk.skus, queryFn: ({ signal }) => api.skus(signal), staleTime: Infinity });

export const useRfqs = (status?: RfqStatus) =>
  useQuery({
    queryKey: qk.rfqs(status),
    queryFn: ({ signal }) => api.listRfqs(status, signal),
    placeholderData: keepPreviousData,
  });

/** Auto-retry every 30 s while the estimate is missing (pricing degraded). */
export const PRICING_RETRY_MS = 30_000;

export const useRfq = (id: string) =>
  useQuery({
    queryKey: qk.rfq(id),
    queryFn: ({ signal }) => api.getRfq(id, signal),
    refetchInterval: (q) => (q.state.data && q.state.data.estimate === null ? PRICING_RETRY_MS : false),
  });

export const useBids = (id: string) =>
  useQuery({ queryKey: qk.bids(id), queryFn: ({ signal }) => api.listBids(id, signal) });

export const useEstimate = (sku: string, qty: number | null) =>
  useQuery({
    queryKey: qk.estimate(sku, qty ?? 0),
    queryFn: ({ signal }) => api.estimate(sku, qty!, signal),
    enabled: !!sku && qty !== null && qty > 0,
    staleTime: 60_000,
    retry: false,
  });

export const useHealthSnapshot = () =>
  useQuery({ queryKey: qk.health, queryFn: ({ signal }) => api.health(signal), staleTime: Infinity, retry: false });
