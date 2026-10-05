import jwt from "jsonwebtoken";
import { signTicketToken, verifyTicketToken } from "../../src/auth/ticketToken";

describe("ticket tokens", () => {
  const OLD_ENV = process.env.JWT_TICKET_SECRET;

  beforeAll(() => {
    process.env.JWT_TICKET_SECRET = "test-ticket-secret";
  });

  afterAll(() => {
    process.env.JWT_TICKET_SECRET = OLD_ENV;
  });

  it("signs a token and verifies it, decoding the original payload", () => {
    const token = signTicketToken({ registrationId: "reg-1", eventId: "evt-1" });
    const decoded = verifyTicketToken(token);
    expect(decoded.registrationId).toBe("reg-1");
    expect(decoded.eventId).toBe("evt-1");
  });

  it("rejects a token tampered after signing", () => {
    const token = signTicketToken({ registrationId: "reg-1", eventId: "evt-1" });
    const tampered = token.slice(0, -2) + (token.slice(-2) === "aa" ? "bb" : "aa");
    expect(() => verifyTicketToken(tampered)).toThrow();
  });

  it("rejects a token signed with a different secret (e.g. the access-token secret)", () => {
    const foreignToken = jwt.sign(
      { registrationId: "reg-1", eventId: "evt-1" },
      "some-other-secret",
    );
    expect(() => verifyTicketToken(foreignToken)).toThrow();
  });

  it("does not carry an expiry claim (tickets must outlive short-lived access tokens)", () => {
    const token = signTicketToken({ registrationId: "reg-1", eventId: "evt-1" });
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect(decoded.exp).toBeUndefined();
  });

  it("throws a clear error if JWT_TICKET_SECRET is not set", () => {
    delete process.env.JWT_TICKET_SECRET;
    expect(() => signTicketToken({ registrationId: "reg-1", eventId: "evt-1" })).toThrow(
      /JWT_TICKET_SECRET/,
    );
    process.env.JWT_TICKET_SECRET = "test-ticket-secret";
  });
});
