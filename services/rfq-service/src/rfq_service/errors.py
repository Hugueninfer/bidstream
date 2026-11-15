"""Domain errors. The gRPC layer maps each one to a status code."""


class DomainError(Exception):
    pass


class InvalidArgument(DomainError):
    pass


class NotFound(DomainError):
    pass


class FailedPrecondition(DomainError):
    pass


class Unavailable(DomainError):
    """A dependency (bid-service) could not answer."""
