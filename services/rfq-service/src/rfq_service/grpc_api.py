"""gRPC adapter: proto <-> domain, domain errors -> status codes."""

import functools
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import datetime
from decimal import Decimal
from typing import Any, TypeVar

import grpc
from bidstream.rfq.v1 import rfq_pb2, rfq_pb2_grpc

from .domain import RfqRecord, format_ts
from .errors import DomainError, FailedPrecondition, InvalidArgument, NotFound, Unavailable
from .service import RfqService

log = logging.getLogger(__name__)

_STATUS_CODES: dict[type[DomainError], grpc.StatusCode] = {
    InvalidArgument: grpc.StatusCode.INVALID_ARGUMENT,
    NotFound: grpc.StatusCode.NOT_FOUND,
    FailedPrecondition: grpc.StatusCode.FAILED_PRECONDITION,
    Unavailable: grpc.StatusCode.UNAVAILABLE,
}

Response = TypeVar("Response")
Handler = Callable[[Any, Any, grpc.aio.ServicerContext], Awaitable[Response]]


def rfq_to_proto(rfq: RfqRecord, now: datetime) -> rfq_pb2.Rfq:
    optional = {
        "best_bid_unit_price": _opt_float(rfq.best_bid_unit_price),
        "best_bid_supplier_name": rfq.best_bid_supplier_name,
        "awarded_bid_id": rfq.awarded_bid_id,
        "awarded_supplier_name": rfq.awarded_supplier_name,
        "awarded_unit_price": _opt_float(rfq.awarded_unit_price),
        "awarded_at": format_ts(rfq.awarded_at) if rfq.awarded_at else None,
    }
    return rfq_pb2.Rfq(
        rfq_id=rfq.rfq_id,
        tenant_id=rfq.tenant_id,
        title=rfq.title,
        sku=rfq.sku,
        quantity=rfq.quantity,
        unit=rfq.unit,
        deadline=format_ts(rfq.deadline),
        status=rfq.effective_status(now),
        created_at=format_ts(rfq.created_at),
        bid_count=rfq.bid_count,
        # proto3 `optional`: leave unset (not zero/empty) when there is no value.
        **{name: value for name, value in optional.items() if value is not None},
    )


def _opt_float(value: Decimal | None) -> float | None:
    return None if value is None else float(value)


def _status_code(exc: DomainError) -> grpc.StatusCode:
    for error_type, code in _STATUS_CODES.items():
        if isinstance(exc, error_type):
            return code
    return grpc.StatusCode.UNKNOWN


def _rpc(handler: Handler[Response]) -> Handler[Response]:
    """Log every call and translate domain errors into gRPC status codes."""

    @functools.wraps(handler)
    async def wrapper(self: Any, request: Any, context: grpc.aio.ServicerContext) -> Response:
        started = time.perf_counter()
        code = grpc.StatusCode.OK
        try:
            return await handler(self, request, context)
        except DomainError as exc:
            code = _status_code(exc)
            await context.abort(code, str(exc))
            raise  # unreachable: abort() raises
        except Exception:
            code = grpc.StatusCode.INTERNAL
            log.exception("unhandled error", extra={"rpc": handler.__name__})
            await context.abort(code, "internal error")
            raise
        finally:
            log.info(
                "rpc",
                extra={
                    "rpc": handler.__name__,
                    "code": code.name,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                    "tenant_id": getattr(request, "tenant_id", None),
                },
            )

    return wrapper


class RfqServicer(rfq_pb2_grpc.RfqServiceServicer):
    def __init__(self, service: RfqService) -> None:
        self._service = service

    @_rpc
    async def CreateRfq(self, request: rfq_pb2.CreateRfqRequest, context: Any) -> rfq_pb2.Rfq:
        rfq = await self._service.create(
            tenant_id=request.tenant_id,
            title=request.title,
            sku=request.sku,
            quantity=request.quantity,
            unit=request.unit,
            deadline=request.deadline,
        )
        return rfq_to_proto(rfq, self._service.now())

    @_rpc
    async def GetRfq(self, request: rfq_pb2.GetRfqRequest, context: Any) -> rfq_pb2.Rfq:
        rfq = await self._service.get(tenant_id=request.tenant_id, rfq_id=request.rfq_id)
        return rfq_to_proto(rfq, self._service.now())

    @_rpc
    async def ListRfqs(
        self, request: rfq_pb2.ListRfqsRequest, context: Any
    ) -> rfq_pb2.ListRfqsResponse:
        now = self._service.now()  # one clock reading for both the filter and the status
        rfqs = await self._service.list(tenant_id=request.tenant_id, status=request.status, now=now)
        return rfq_pb2.ListRfqsResponse(rfqs=[rfq_to_proto(rfq, now) for rfq in rfqs])

    @_rpc
    async def AwardRfq(self, request: rfq_pb2.AwardRfqRequest, context: Any) -> rfq_pb2.Rfq:
        rfq = await self._service.award(
            tenant_id=request.tenant_id, rfq_id=request.rfq_id, bid_id=request.bid_id
        )
        return rfq_to_proto(rfq, self._service.now())
