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
