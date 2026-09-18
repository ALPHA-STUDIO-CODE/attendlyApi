// Base class for all errors that should be turned into a structured
// { error: { code, message, details } } response by errorMiddleware,
// rather than a generic 500. Anything NOT extending AppError is treated
// as unexpected and gets a generic message with no details leaked.
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    // Required for `instanceof` to work correctly when extending built-ins
    // like Error under some TS/target combinations.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown, code = "VALIDATION_ERROR") {
    super(400, code, message, details);
  }
}

export class AuthError extends AppError {
  constructor(message: string, details?: unknown, code = "AUTH_ERROR") {
    super(401, code, message, details);
  }
}

// Distinct from AuthError (401 — "we don't know who you are" / bad or
// missing credentials): this is "we know who you are, but you're not
// allowed to do this" — wrong role, or not the resource's owner.
export class ForbiddenError extends AppError {
  constructor(message: string, details?: unknown, code = "FORBIDDEN") {
    super(403, code, message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown, code = "NOT_FOUND") {
    super(404, code, message, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown, code = "CONFLICT") {
    super(409, code, message, details);
  }
}
