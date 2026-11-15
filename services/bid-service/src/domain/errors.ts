/** Errors the domain layer raises on purpose; the gRPC layer maps them to status codes. */
export class DomainError extends Error {
  constructor(
    readonly kind: 'invalid_argument' | 'not_found' | 'failed_precondition',
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidArgumentError extends DomainError {
  constructor(message: string) {
    super('invalid_argument', message);
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super('not_found', message);
  }
}

export class FailedPreconditionError extends DomainError {
  constructor(message: string) {
    super('failed_precondition', message);
  }
}
