export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown, code = "VALIDATION_ERROR") {
    super(400, code, message, details);
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(message: string, details?: unknown, code = "UNPROCESSABLE_ENTITY") {
    super(422, code, message, details);
  }
}

export class AuthError extends AppError {
  constructor(message: string, details?: unknown, code = "AUTH_ERROR") {
    super(401, code, message, details);
  }
}

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

export class BadGatewayError extends AppError {
  constructor(message: string, details?: unknown, code = "BAD_GATEWAY") {
    super(502, code, message, details);
  }
}
