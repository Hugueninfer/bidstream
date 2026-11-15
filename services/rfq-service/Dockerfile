# Build context: repo root (the image needs proto/).
#   docker build -f services/rfq-service/Dockerfile -t bidstream-rfq-service:dev .

# ---- stubs: generate gRPC code from the shared protos ----
FROM python:3.12-slim AS stubs
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY services/rfq-service/requirements-build.txt /tmp/
RUN pip install -r /tmp/requirements-build.txt
COPY proto /proto
RUN mkdir /generated && python -m grpc_tools.protoc -I /proto \
      --python_out=/generated --grpc_python_out=/generated \
      /proto/bidstream/rfq/v1/rfq.proto /proto/bidstream/bid/v1/bid.proto

# ---- base: runtime dependencies + code ----
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app/src:/app/generated
WORKDIR /app
COPY services/rfq-service/requirements.txt .
RUN pip install -r requirements.txt
COPY --from=stubs /generated /app/generated
COPY services/rfq-service/src /app/src

# ---- test: unit tests by default; integration tests with `-m integration` ----
FROM base AS test
COPY services/rfq-service/requirements-dev.txt .
RUN pip install -r requirements-dev.txt
COPY services/rfq-service/pyproject.toml /app/
COPY services/rfq-service/tests /app/tests
COPY services/rfq-service/scripts /app/scripts
CMD ["pytest", "-m", "not integration"]

# ---- runtime (default target) ----
FROM base AS runtime
RUN useradd --system --uid 10001 app
USER app
EXPOSE 50061
STOPSIGNAL SIGTERM
CMD ["python", "-m", "rfq_service"]
