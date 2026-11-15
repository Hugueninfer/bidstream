"""gRPC adapter: request validation and status-code mapping around the Estimator."""

from __future__ import annotations

import logging

import grpc
import psycopg
from bidstream.pricing.v1 import pricing_pb2, pricing_pb2_grpc
from opentelemetry import trace
from psycopg_pool import PoolTimeout

from .estimator import Estimator, SkuNotFound

log = logging.getLogger(__name__)

MAX_SKU_LENGTH = 64


class PricingServicer(pricing_pb2_grpc.PricingServiceServicer):
    def __init__(self, estimator: Estimator) -> None:
        self._estimator = estimator

    async def GetPriceEstimate(  # noqa: N802 (gRPC method name)
        self, request: pricing_pb2.GetPriceEstimateRequest, context: grpc.aio.ServicerContext
    ) -> pricing_pb2.GetPriceEstimateResponse:
        sku = request.sku.strip()
        if not sku:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "sku is required")
        if len(sku) > MAX_SKU_LENGTH:
            await context.abort(
                grpc.StatusCode.INVALID_ARGUMENT, f"sku is longer than {MAX_SKU_LENGTH} characters"
            )
        if request.quantity <= 0:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "quantity must be positive")

        span = trace.get_current_span()
        span.set_attributes({"pricing.sku": sku, "pricing.quantity": request.quantity})
        try:
            result = await self._estimator.estimate(sku, request.quantity)
        except SkuNotFound:
            await context.abort(grpc.StatusCode.NOT_FOUND, f"no price history for sku {sku!r}")
        except (psycopg.Error, PoolTimeout):
            log.exception("price history unavailable", extra={"sku": sku})
            await context.abort(grpc.StatusCode.UNAVAILABLE, "price history unavailable")
        span.set_attribute("pricing.cache_hit", result.cache_hit)

        estimate = result.estimate
        return pricing_pb2.GetPriceEstimateResponse(
            sku=sku,
            quantity=request.quantity,
            estimated_unit_price=estimate.estimated_unit_price,
            low=estimate.low,
            high=estimate.high,
            sample_size=estimate.sample_size,
            cache_hit=result.cache_hit,
            model_version=estimate.model_version,
        )
