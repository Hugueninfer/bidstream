import { Metadata, status, type ServiceError } from '@grpc/grpc-js';
import { DomainError } from '../domain/errors.js';

const DOMAIN_STATUS: Record<DomainError['kind'], status> = {
  invalid_argument: status.INVALID_ARGUMENT,
  not_found: status.NOT_FOUND,
  failed_precondition: status.FAILED_PRECONDITION,
};

// Connection-level failures (refused, reset, Postgres class 08 / admin shutdown)
// are transient: callers may retry, and the gateway reports upstream_unavailable.
const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', '57P01', '57P03']);

function isTransient(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && (TRANSIENT_CODES.has(code) || code.startsWith('08'))) return true;
  return err instanceof Error && /timeout exceeded when trying to connect|Connection terminated/i.test(err.message);
}

export function toGrpcError(err: unknown): Partial<ServiceError> & { code: status; details: string } {
  let code: status;
  let details: string;
  if (err instanceof DomainError) {
    code = DOMAIN_STATUS[err.kind];
    details = err.message;
  } else if (isTransient(err)) {
    code = status.UNAVAILABLE;
    details = 'database unavailable';
  } else {
    // Never leak internals (SQL, stack traces) to callers; they are logged instead.
    code = status.INTERNAL;
    details = 'internal error';
  }
  return { code, details, message: details, metadata: new Metadata() };
}
