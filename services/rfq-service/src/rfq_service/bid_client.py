"""gRPC client for bid-service (used to validate awards)."""

import logging
from decimal import Decimal

import grpc
from bidstream.bid.v1 import bid_pb2, bid_pb2_grpc

from .domain import BidInfo
from .errors import Unavailable

log = logging.getLogger(__name__)

GET_BID_TIMEOUT_S = 2.0
# bid-service answers these for a bid it does not have (INVALID_ARGUMENT: malformed id).
_UNKNOWN_BID_CODES = frozenset({grpc.StatusCode.NOT_FOUND, grpc.StatusCode.INVALID_ARGUMENT})


class GrpcBidClient:
    def __init__(self, channel: grpc.aio.Channel, timeout: float = GET_BID_TIMEOUT_S) -> None:
        self._stub = bid_pb2_grpc.BidServiceStub(channel)
        self._timeout = timeout

    async def get_bid(self, tenant_id: str, bid_id: str) -> BidInfo | None:
        try:
            bid = await self._stub.GetBid(
                bid_pb2.GetBidRequest(tenant_id=tenant_id, bid_id=bid_id), timeout=self._timeout
            )
        except grpc.aio.AioRpcError as exc:
            if exc.code() in _UNKNOWN_BID_CODES:
                return None
            log.warning(
                "bid-service GetBid failed",
                extra={"bid_id": bid_id, "code": exc.code().name, "details": exc.details()},
            )
            raise Unavailable(f"bid-service unavailable ({exc.code().name})") from exc
        return BidInfo(
            bid_id=bid.bid_id,
            tenant_id=bid.tenant_id,
            rfq_id=bid.rfq_id,
            supplier_id=bid.supplier_id,
            supplier_name=bid.supplier_name,
            # str() first: Decimal(0.39) would carry the binary float error.
            unit_price=Decimal(str(bid.unit_price)),
        )
