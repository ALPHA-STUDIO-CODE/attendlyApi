import {
  AppError,
  ValidationError,
  AuthError,
  NotFoundError,
  ConflictError,
  BadGatewayError,
} from "../../src/errors";

describe("AppError subclasses", () => {
  it("ValidationError carries status 400 and code VALIDATION_ERROR by default", () => {
    const err = new ValidationError("Invalid input", { field: "email" });
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.details).toEqual({ field: "email" });
  });

  it("AuthError carries status 401 and code AUTH_ERROR by default", () => {
    const err = new AuthError("Invalid credentials");
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe("AUTH_ERROR");
  });

  it("NotFoundError carries status 404 and code NOT_FOUND by default", () => {
    const err = new NotFoundError("Event not found");
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("ConflictError carries status 409 and code CONFLICT by default", () => {
    const err = new ConflictError("Already registered");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("CONFLICT");
  });

  it("allows overriding the default code for a more specific error identifier", () => {
    const err = new ConflictError("Email already registered", undefined, "EMAIL_TAKEN");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("EMAIL_TAKEN");
  });

  it("BadGatewayError carries status 502 and code BAD_GATEWAY by default", () => {
    const err = new BadGatewayError("Upstream failed");
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(502);
    expect(err.code).toBe("BAD_GATEWAY");
  });

  it("BadGatewayError allows a specific code such as UPLOAD_FAILED", () => {
    const err = new BadGatewayError("Upload failed", undefined, "UPLOAD_FAILED");
    expect(err.statusCode).toBe(502);
    expect(err.code).toBe("UPLOAD_FAILED");
  });
});
