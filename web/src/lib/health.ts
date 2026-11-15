import type { ServiceHealth } from "../api/types";

export const SERVICES: ServiceHealth["name"][] = ["rfq-service", "bid-service", "pricing-service"];

export function healthDotClass(s: ServiceHealth | undefined) {
  if (!s) return "bg-border-strong";
  return s.status === "healthy" ? "bg-good" : s.status === "degraded" ? "bg-warn" : "bg-bad";
}
