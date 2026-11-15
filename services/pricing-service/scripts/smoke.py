"""Calls a running pricing-service: health, then each catalog SKU twice (miss, then hit).

python scripts/smoke.py [host:port]
"""

import asyncio
import sys
import time

import grpc
from bidstream.pricing.v1 import pricing_pb2, pricing_pb2_grpc
from grpc_health.v1 import health_pb2, health_pb2_grpc

from pricing_service.catalog import CATALOG


async def main(addr: str) -> None:
    async with grpc.aio.insecure_channel(addr) as channel:
        health = await health_pb2_grpc.HealthStub(channel).Check(
            health_pb2.HealthCheckRequest(service="bidstream.pricing.v1.PricingService"),
            timeout=2,
        )
        print(f"health: {health_pb2.HealthCheckResponse.ServingStatus.Name(health.status)}")
        stub = pricing_pb2_grpc.PricingServiceStub(channel)
        for item in CATALOG:
            for _ in range(2):
                started = time.perf_counter()
                r = await stub.GetPriceEstimate(
                    pricing_pb2.GetPriceEstimateRequest(
                        sku=item.sku, quantity=item.typical_quantity
                    ),
                    timeout=2,
                )
                ms = (time.perf_counter() - started) * 1000
                print(
                    f"{r.sku:<16} qty={r.quantity:>6}  est={r.estimated_unit_price:<8} "
                    f"band=[{r.low}, {r.high}]  n={r.sample_size}  cache_hit={r.cache_hit}  "
                    f"model={r.model_version}  {ms:.1f} ms"
                )
        try:
            await stub.GetPriceEstimate(pricing_pb2.GetPriceEstimateRequest(sku="NOPE", quantity=1))
        except grpc.aio.AioRpcError as exc:
            print(f"unknown sku -> {exc.code().name}: {exc.details()}")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "localhost:50063"))
