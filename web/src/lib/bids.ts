import type { Bid } from "../api/types";

export type BidSortKey = "supplier" | "unit_price" | "delta" | "total" | "lead_time" | "submitted";
export type SortDir = "asc" | "desc";

/** Sort bids by a column. Δ, total and unit price all order by unit price (quantity and estimate are constant per RFQ). */
export function sortBids(bids: Bid[], key: BidSortKey, dir: SortDir): Bid[] {
  const sign = dir === "asc" ? 1 : -1;
  const value = (b: Bid): number | string => {
    switch (key) {
      case "supplier":
        return b.supplier_name.toLocaleLowerCase();
      case "unit_price":
      case "delta":
      case "total":
        return b.unit_price;
      case "lead_time":
        return b.lead_time_days;
      case "submitted":
        return Date.parse(b.submitted_at) || 0;
    }
  };
  return [...bids].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const c = typeof va === "string" ? va.localeCompare(vb as string) : va - (vb as number);
    // tie-break: newest first, then id for stability
    return c !== 0 ? c * sign : Date.parse(b.submitted_at) - Date.parse(a.submitted_at) || a.bid_id.localeCompare(b.bid_id);
  });
}

/** Lowest unit price; earliest submission wins ties. */
export function lowestBid(bids: Bid[]): Bid | null {
  let best: Bid | null = null;
  for (const b of bids) {
    if (
      !best ||
      b.unit_price < best.unit_price ||
      (b.unit_price === best.unit_price && Date.parse(b.submitted_at) < Date.parse(best.submitted_at))
    )
      best = b;
  }
  return best;
}
