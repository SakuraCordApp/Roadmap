export class RoadmapError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "RoadmapError";
  }
}

export class ValidationError extends RoadmapError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, 422, details);
  }
}

export class ConflictError extends RoadmapError {
  constructor(message: string, details?: unknown) {
    super("REVISION_CONFLICT", message, 409, details);
  }
}

export class NotFoundError extends RoadmapError {
  constructor(resource: string) {
    super("NOT_FOUND", `${resource} was not found.`, 404);
  }
}

export class AuthorizationError extends RoadmapError {
  constructor(message = "Maintainer authentication is required.") {
    super("FORBIDDEN", message, 403);
  }
}
