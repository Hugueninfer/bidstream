# Build context: repository root (the image needs proto/).
#   docker build -f services/pricing-service/Dockerfile -t bidstream-pricing-service:dev .

FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app/src:/app/gen
WORKDIR /app
COPY services/pricing-service/requirements.txt .
RUN pip install -r requirements.txt

# gRPC stubs are generated here and never committed.
FROM base AS stubs
RUN pip install grpcio-tools==1.71.0
COPY proto /proto
RUN mkdir gen && python -m grpc_tools.protoc -I /proto \
      --python_out=gen --pyi_out=gen --grpc_python_out=gen \
      /proto/bidstream/pricing/v1/pricing.proto

FROM base AS test
COPY services/pricing-service/requirements-dev.txt .
RUN pip install -r requirements-dev.txt
COPY --from=stubs /app/gen gen
COPY services/pricing-service/pyproject.toml .
COPY services/pricing-service/src src
COPY services/pricing-service/tests tests
CMD ["pytest", "-m", "not integration"]

# Last stage = default target (what docker compose builds).
FROM base AS runtime
RUN useradd --system --uid 10001 pricing
COPY --from=stubs /app/gen gen
COPY services/pricing-service/src src
USER pricing
EXPOSE 50063
CMD ["python", "-m", "pricing_service"]
