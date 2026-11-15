"""The gRPC adapter end to end, in process: real server and client, fake store."""

from datetime import timedelta

import grpc
import pytest
from bidstream.rfq.v1 import rfq_pb2, rfq_pb2_grpc

from rfq_service.grpc_api import RfqServicer, rfq_to_proto
from rfq_service.service import RfqService
from tests.fakes import NOW, FakeBids, FakeStore, FixedClock, make_bid, make_rfq


@pytest.fixture
async def rpc():
    rfq = make_rfq()
    expired = make_rfq(
        rfq_id="rfq_eeeeeeeeeeee",
        deadline=NOW - timedelta(hours=1),
        created_at=NOW - timedelta(days=2),
    )
    store = FakeStore(rfq, expired)
    bids = FakeBids(make_bid(rfq))
    server = grpc.aio.server()
    rfq_pb2_grpc.add_RfqServiceServicer_to_server(
        RfqServicer(RfqService(store, bids, clock=FixedClock())), server
    )
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
        yield rfq_pb2_grpc.RfqServiceStub(channel), bids
    await server.stop(None)


def test_rfq_to_proto_leaves_absent_optionals_unset():
    message = rfq_to_proto(make_rfq(), NOW)
    assert message.status == "open"
    assert message.deadline == "2026-11-17T12:00:00Z"
    for field in ("best_bid_unit_price", "awarded_bid_id", "awarded_at"):
        assert not message.HasField(field)


async def test_create_and_get(rpc):
    stub, _ = rpc
    created = await stub.CreateRfq(
        rfq_pb2.CreateRfqRequest(
            tenant_id="tenant_test",
            title="Pallets",
            sku="PALLET-WOOD",
            quantity=800,
            unit="pallets",
            deadline="2026-11-20T09:00:00Z",
        )
    )
    assert created.rfq_id.startswith("rfq_") and created.status == "open"
    fetched = await stub.GetRfq(
        rfq_pb2.GetRfqRequest(tenant_id="tenant_test", rfq_id=created.rfq_id)
    )
    assert fetched == created


async def test_invalid_create_is_invalid_argument(rpc):
    stub, _ = rpc
    with pytest.raises(grpc.aio.AioRpcError) as exc:
        await stub.CreateRfq(rfq_pb2.CreateRfqRequest(tenant_id="tenant_test", title="x"))
    assert exc.value.code() == grpc.StatusCode.INVALID_ARGUMENT
    assert "title must be 3-200 characters" in exc.value.details()


async def test_list_filters_on_computed_status(rpc):
    stub, _ = rpc
    all_rfqs = await stub.ListRfqs(rfq_pb2.ListRfqsRequest(tenant_id="tenant_test"))
    assert [r.status for r in all_rfqs.rfqs] == ["open", "expired"]  # newest first
    expired = await stub.ListRfqs(
        rfq_pb2.ListRfqsRequest(tenant_id="tenant_test", status="expired")
    )
    assert [r.rfq_id for r in expired.rfqs] == ["rfq_eeeeeeeeeeee"]


async def test_award_maps_errors_to_status_codes(rpc):
    stub, bids = rpc
    request = rfq_pb2.AwardRfqRequest(tenant_id="tenant_test", rfq_id="rfq_0123456789ab")

    with pytest.raises(grpc.aio.AioRpcError) as exc:
        await stub.AwardRfq(
            rfq_pb2.AwardRfqRequest(tenant_id="tenant_test", rfq_id="rfq_nope", bid_id="b")
        )
    assert exc.value.code() == grpc.StatusCode.NOT_FOUND

    bids.unavailable = True
    with pytest.raises(grpc.aio.AioRpcError) as exc:
        request.bid_id = "bid_aaaaaaaaaaaa"
        await stub.AwardRfq(request)
    assert exc.value.code() == grpc.StatusCode.UNAVAILABLE

    bids.unavailable = False
    awarded = await stub.AwardRfq(request)
    assert awarded.status == "awarded"
    assert awarded.awarded_unit_price == pytest.approx(0.39)
    assert awarded.awarded_at == "2026-11-14T12:00:00Z"

    with pytest.raises(grpc.aio.AioRpcError) as exc:
        request.bid_id = "bid_bbbbbbbbbbbb"
        await stub.AwardRfq(request)
    assert exc.value.code() == grpc.StatusCode.FAILED_PRECONDITION
