import { useMemo } from "react";
import { useHealthSnapshot } from "../api/queries";
import type { ServiceHealth } from "../api/types";
import { useLive } from "./LiveEvents";

/** Latest service health: SSE `health` events, falling back to one GET /v1/health snapshot at start-up. */
export function useServiceHealth(): Map<ServiceHealth["name"], ServiceHealth> {
  const { health } = useLive();
  const snapshot = useHealthSnapshot();
  const services = health?.services ?? snapshot.data?.services;
  return useMemo(() => new Map((services ?? []).map((s) => [s.name, s])), [services]);
}
