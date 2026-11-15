export type BidFieldErrors = Partial<Record<"name" | "price" | "lead", string>>;

/** Client-side checks for the supplier bid form (the server validates again). */
export function validateBid(name: string, price: string, lead: string): BidFieldErrors {
  const e: BidFieldErrors = {};
  if (!name.trim()) e.name = "Enter the name buyers will see on your bid.";
  const p = Number(price);
  if (!price.trim() || !Number.isFinite(p) || p <= 0) e.price = "Enter a price greater than $0.";
  else if (!/^\d*(\.\d{0,4})?$/.test(price.trim())) e.price = "Use at most 4 decimal places.";
  const l = Number(lead);
  if (!/^\d+$/.test(lead.trim()) || l < 1 || l > 365) e.lead = "Whole days between 1 and 365.";
  return e;
}
