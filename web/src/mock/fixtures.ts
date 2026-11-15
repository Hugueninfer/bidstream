// Demo data matching the design (BidStream.pdf). Times are relative to page load so countdowns look right.

export const SKUS = [
  { sku: "BOLT-M8", unit: "pcs", typical: 40_000, anchor: 0.47, samples: 1284 },
  { sku: "NUT-M8", unit: "pcs", typical: 60_000, anchor: 0.13, samples: 1166 },
  { sku: "STEEL-SHEET-2MM", unit: "sheets", typical: 1_200, anchor: 46.2, samples: 1043 },
  { sku: "PALLET-WOOD", unit: "pallets", typical: 800, anchor: 12.1, samples: 1211 },
  { sku: "CARDBOARD-BOX-L", unit: "boxes", typical: 15_000, anchor: 0.86, samples: 1297 },
  { sku: "LUBRICANT-5L", unit: "cans", typical: 300, anchor: 33.8, samples: 204 },
];

export const SUPPLIERS = [
  "Kestrel Fastening Co.",
  "Northgate Fasteners",
  "Halvard Metalworks",
  "Ironbark Supply",
  "Pelham & Roe Industrial",
  "Brackwater Components",
  "Ostrander Supply Works",
];

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

export type FixtureBid = { id: string; supplier: string; price: number; lead: number; ago: number };
export type FixtureRfq = {
  id: string;
  title: string;
  sku: string;
  quantity: number;
  createdAgo: number;
  deadlineIn: number; // negative = in the past
  status: "open" | "awarded" | "expired";
  bids: FixtureBid[];
  winner?: string; // bid id
  /** bid-service hasn't consumed rfq.created yet for this long after page load (demo of 409 rfq_syncing). */
  syncingFor?: number;
};

export const RFQS: FixtureRfq[] = [
  {
    id: "rfq_7f3a91c2b0de",
    title: "M8 hex bolts, A2 stainless — Q1 restock",
    sku: "BOLT-M8",
    quantity: 40_000,
    createdAgo: 2 * D + 4 * H + 48 * M,
    deadlineIn: 2 * D + 2 * H + 57 * M,
    status: "open",
    bids: [
      { id: "bid_9c41e2a7b5d0", supplier: "Kestrel Fastening Co.", price: 0.39, lead: 21, ago: 19 * S },
      { id: "bid_8e20f4c19a63", supplier: "Northgate Fasteners", price: 0.58, lead: 10, ago: 43 * S },
      { id: "bid_71d5a0b3e8c2", supplier: "Halvard Metalworks", price: 0.51, lead: 6, ago: 11 * M },
      { id: "bid_63aa9d27f104", supplier: "Ironbark Supply", price: 0.47, lead: 9, ago: 42 * M },
      { id: "bid_5f02c86e1b97", supplier: "Pelham & Roe Industrial", price: 0.44, lead: 12, ago: 75 * M },
    ],
  },
  {
    id: "rfq_5b19e04a7c31",
    title: "Wood pallets 1200×800 — warehouse B",
    sku: "PALLET-WOOD",
    quantity: 800,
    createdAgo: 1 * D + 3 * H,
    deadlineIn: 17 * H + 57 * M,
    status: "open",
    bids: [
      { id: "bid_4c7e1a90d2b5", supplier: "Ironbark Supply", price: 11.4, lead: 5, ago: 4 * M },
      { id: "bid_2d9b6f03a8e1", supplier: "Kestrel Fastening Co.", price: 11.8, lead: 8, ago: 2 * H },
      { id: "bid_0a5c3e7f91b4", supplier: "Brackwater Components", price: 11.95, lead: 6, ago: 3 * H },
      { id: "bid_e1f08b4c62d7", supplier: "Halvard Metalworks", price: 12.3, lead: 4, ago: 5 * H },
      { id: "bid_b7a2d95e0c13", supplier: "Pelham & Roe Industrial", price: 12.6, lead: 7, ago: 8 * H },
      { id: "bid_93c6e1f7a40b", supplier: "Northgate Fasteners", price: 12.85, lead: 3, ago: 11 * H },
      { id: "bid_6f14b8d2c9e5", supplier: "Ostrander Supply Works", price: 13.1, lead: 9, ago: 20 * H },
    ],
  },
  {
    id: "rfq_91c2d7e85a10",
    title: "M8 nuts for assembly line 3",
    sku: "NUT-M8",
    quantity: 60_000,
    createdAgo: 1 * D + 6 * H,
    deadlineIn: 2 * D + 21 * H + 57 * M,
    status: "open",
    bids: [
      { id: "bid_c3e9a1b7d064", supplier: "Kestrel Fastening Co.", price: 0.12, lead: 14, ago: 18 * M },
      { id: "bid_7b0d4f2e9a18", supplier: "Northgate Fasteners", price: 0.13, lead: 9, ago: 3 * H },
      { id: "bid_1e8f6c3a5b92", supplier: "Ironbark Supply", price: 0.14, lead: 7, ago: 9 * H },
    ],
  },
  {
    id: "rfq_c04e6b2f9d87",
    title: "Cold-rolled steel sheet, 2 mm",
    sku: "STEEL-SHEET-2MM",
    quantity: 1_200,
    createdAgo: 20 * H,
    deadlineIn: 5 * D + 2 * H + 57 * M,
    status: "open",
    bids: [
      { id: "bid_f2a7c0e4b815", supplier: "Brackwater Components", price: 52.6, lead: 18, ago: 13 * M },
      { id: "bid_8d3b1e6f0a72", supplier: "Halvard Metalworks", price: 54.1, lead: 12, ago: 6 * H },
    ],
  },
  {
    id: "rfq_e7d03a9c1f42",
    title: "Shipping boxes, large — December peak",
    sku: "CARDBOARD-BOX-L",
    quantity: 15_000,
    createdAgo: 40 * S,
    deadlineIn: 6 * D + 2 * H + 57 * M,
    status: "open",
    bids: [],
    syncingFor: 15 * S,
  },
  {
    id: "rfq_2a6f81d4c0b9",
    title: "Machine lubricant 5 L — maintenance stock",
    sku: "LUBRICANT-5L",
    quantity: 240,
    createdAgo: 6 * D,
    deadlineIn: -(1 * D + 21 * H),
    status: "awarded",
    winner: "bid_5e81a3c0f9d2",
    bids: [
      { id: "bid_5e81a3c0f9d2", supplier: "Pelham & Roe Industrial", price: 31.5, lead: 4, ago: 3 * D },
      { id: "bid_a90c7e2b4f16", supplier: "Northgate Fasteners", price: 32.75, lead: 6, ago: 4 * D },
      { id: "bid_3b6d0f8a1e24", supplier: "Ironbark Supply", price: 33.2, lead: 3, ago: 4 * D + 5 * H },
      { id: "bid_d4f2b9e7c053", supplier: "Brackwater Components", price: 34.9, lead: 5, ago: 5 * D },
    ],
  },
  {
    id: "rfq_b83d5e2a9f06",
    title: "M8 hex bolts — pilot run",
    sku: "BOLT-M8",
    quantity: 2_000,
    createdAgo: 14 * D,
    deadlineIn: -(8 * D + 21 * H),
    status: "expired",
    bids: [],
  },
];

/** Live bids the fake stream submits shortly after load, so the new-row flash can be seen. */
export const SCRIPTED_BIDS = [
  { after: 6 * S, rfq: "rfq_7f3a91c2b0de", id: "bid_a3f7d1c8e902", supplier: "Brackwater Components", price: 0.45, lead: 15 },
  { after: 13 * S, rfq: "rfq_7f3a91c2b0de", id: "bid_b118e6a4c2f9", supplier: "Ostrander Supply Works", price: 0.41, lead: 11 },
];
