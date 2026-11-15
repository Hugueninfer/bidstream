"""gRPC smoke test against a running rfq-service.

    RFQ_ADDR=rfq-service:50061 python scripts/smoke.py

Creates an RFQ under a throwaway tenant, reads it back, and tries to award it a
bid that does not exist: NOT_FOUND when bid-service is up, UNAVAILABLE when not.
"""

import asyncio
import os
import sys
import uuid
from datetime import UTC, datetime, timedelta

import grpc
from bidstream.rfq.v1 import rfq_pb2, rfq_pb2_grpc
from grpc_health.v1 import health_pb2, health_pb2_grpc


def check(ok: bool, label: str) -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {label}")
    if not ok:
        sys.exit(1)


async def main() -> None:
    addr = os.environ.get("RFQ_ADDR", "localhost:50061")
    tenant = f"smoke_{uuid.uuid4().hex[:8]}"
    deadline = (datetime.now(UTC) + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"rfq-service smoke against {addr} (tenant {tenant})")

    async with grpc.aio.insecure_channel(addr) as channel:
        health = await health_pb2_grpc.HealthStub(channel).Check(
            health_pb2.HealthCheckRequest(service="bidstream.rfq.v1.RfqService"), timeout=5
        )
        check(health.status == health_pb2.HealthCheckResponse.SERVING, "health SERVING")

        stub = rfq_pb2_grpc.RfqServiceStub(channel)
        rfq = await stub.CreateRfq(
            rfq_pb2.CreateRfqRequest(
                tenant_id=tenant,
                title="Smoke test M8 bolts",
                sku="BOLT-M8",
                quantity=40_000,
                unit="pcs",
                deadline=deadline,
            ),
            timeout=5,
        )
        check(rfq.rfq_id.startswith("rfq_") and rfq.status == "open", f"CreateRfq -> {rfq.rfq_id}")

        fetched = await stub.GetRfq(rfq_pb2.GetRfqRequest(tenant_id=tenant, rfq_id=rfq.rfq_id))
        check(fetched == rfq, "GetRfq returns the same RFQ")

        listed = await stub.ListRfqs(rfq_pb2.ListRfqsRequest(tenant_id=tenant, status="open"))
        check([r.rfq_id for r in listed.rfqs] == [rfq.rfq_id], "ListRfqs(status=open)")

        try:
            await stub.CreateRfq(rfq_pb2.CreateRfqRequest(tenant_id=tenant, title="x"))
            check(False, "invalid CreateRfq rejected")
        except grpc.aio.AioRpcError as exc:
            check(
                exc.code() == grpc.StatusCode.INVALID_ARGUMENT,
                f"invalid CreateRfq -> {exc.code().name}: {exc.details()}",
            )

        try:
            await stub.AwardRfq(
                rfq_pb2.AwardRfqRequest(
                    tenant_id=tenant, rfq_id=rfq.rfq_id, bid_id="bid_000000000000"
                ),
                timeout=5,
            )
            check(False, "award of an unknown bid rejected")
        except grpc.aio.AioRpcError as exc:
            expected = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.NOT_FOUND}
            check(
                exc.code() in expected,
                f"AwardRfq unknown bid -> {exc.code().name}: {exc.details()}",
            )

    print(f"done; look for {rfq.rfq_id} on rfq.events")


if __name__ == "__main__":
    asyncio.run(main())
