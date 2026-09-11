import jwt from "jsonwebtoken";
import { signAccessToken, verifyAccessToken, AccessTokenPayload } from "../../src/auth/jwt";

const TEST_SECRET = "test-only-access-token-secret";

describe("JWT access tokens", () => {
  const originalSecret = process.env.JWT_ACCESS_SECRET;

  beforeAll(() => {
    process.env.JWT_ACCESS_SECRET = TEST_SECRET;
  });

  afterAll(() => {
    process.env.JWT_ACCESS_SECRET = originalSecret;
  });

  it("signs a token and verifies it, decoding the original claims", () => {
    const payload: AccessTokenPayload = { sub: "user-123", role: "USER" };

    const token = signAccessToken(payload);
    const decoded = verifyAccessToken(token);

    expect(decoded.sub).toBe(payload.sub);
    expect(decoded.role).toBe(payload.role);
  });

  it("rejects an expired token", () => {
    // Fabricated directly with the same secret and an already-past
    // expiry, rather than waiting on a real clock — deterministic and
    // instant, and still exercises verifyAccessToken's real rejection path.
    const expiredToken = jwt.sign({ sub: "user-123", role: "USER" }, TEST_SECRET, {
      expiresIn: -10,
    });

    expect(() => verifyAccessToken(expiredToken)).toThrow(jwt.TokenExpiredError);
  });

  it("rejects a token with a tampered signature", () => {
    const token = signAccessToken({ sub: "user-123", role: "USER" });
    const [header, payload, signature] = token.split(".");
    const lastChar = signature[signature.length - 1];
    const tamperedSignature = signature.slice(0, -1) + (lastChar === "A" ? "B" : "A");
    const tamperedToken = `${header}.${payload}.${tamperedSignature}`;

    expect(() => verifyAccessToken(tamperedToken)).toThrow(jwt.JsonWebTokenError);
  });
});
