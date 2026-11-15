import { status } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { FailedPreconditionError, InvalidArgumentError, NotFoundError } from '../../src/domain/errors.js';
import { toGrpcError } from '../../src/grpc/errors.js';

describe('toGrpcError', () => {
  it.each([
    [new InvalidArgumentError('bad'), status.INVALID_ARGUMENT, 'bad'],
    [new NotFoundError('rfq not known to bid-service yet'), status.NOT_FOUND, 'rfq not known to bid-service yet'],
    [new FailedPreconditionError('rfq is awarded, not open'), status.FAILED_PRECONDITION, 'rfq is awarded, not open'],
  ])('maps %s', (err, code, details) => {
    expect(toGrpcError(err)).toMatchObject({ code, details });
  });

  it('maps connection failures to UNAVAILABLE', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const adminShutdown = Object.assign(new Error('terminating connection'), { code: '57P01' });
    const connectionClass = Object.assign(new Error('connection failure'), { code: '08006' });
    for (const err of [refused, adminShutdown, connectionClass]) {
      expect(toGrpcError(err).code).toBe(status.UNAVAILABLE);
    }
  });

  it('hides internals behind INTERNAL', () => {
    const err = Object.assign(new Error('relation "bids" does not exist'), { code: '42P01' });
    expect(toGrpcError(err)).toMatchObject({ code: status.INTERNAL, details: 'internal error' });
    expect(toGrpcError('boom')).toMatchObject({ code: status.INTERNAL });
  });
});
