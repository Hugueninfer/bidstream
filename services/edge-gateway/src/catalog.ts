// Static SKU catalog from docs/contracts.md ("Pricing model").
export const SKUS: ReadonlyArray<{ sku: string; unit: string }> = [
  { sku: "BOLT-M8", unit: "pcs" },
  { sku: "NUT-M8", unit: "pcs" },
  { sku: "STEEL-SHEET-2MM", unit: "sheets" },
  { sku: "PALLET-WOOD", unit: "pallets" },
  { sku: "CARDBOARD-BOX-L", unit: "boxes" },
  { sku: "LUBRICANT-5L", unit: "cans" },
];
