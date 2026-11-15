"""The demo SKU catalog (docs/contracts.md, "Pricing model")."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CatalogSku:
    sku: str
    unit: str
    typical_quantity: int
    anchor_price: float  # unit price at the typical quantity
    seed_rows: int  # history size generated on first start


CATALOG: tuple[CatalogSku, ...] = (
    CatalogSku("BOLT-M8", "pcs", 40_000, 0.47, 1_284),
    CatalogSku("NUT-M8", "pcs", 60_000, 0.13, 1_137),
    CatalogSku("STEEL-SHEET-2MM", "sheets", 1_200, 46.20, 963),
    CatalogSku("PALLET-WOOD", "pallets", 800, 12.10, 1_046),
    CatalogSku("CARDBOARD-BOX-L", "boxes", 15_000, 0.86, 1_219),
    CatalogSku("LUBRICANT-5L", "cans", 300, 33.80, 912),
)
