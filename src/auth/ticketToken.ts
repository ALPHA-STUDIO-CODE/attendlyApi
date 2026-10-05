import jwt from "jsonwebtoken";

export interface TicketTokenPayload {
  registrationId: string;
  eventId: string;
}

function getTicketTokenSecret(): string {
  const secret = process.env.JWT_TICKET_SECRET;
  if (!secret) {
    throw new Error("JWT_TICKET_SECRET is not set.");
  }
  return secret;
}

export function signTicketToken(payload: TicketTokenPayload): string {
  return jwt.sign(payload, getTicketTokenSecret());
}

export function verifyTicketToken(token: string): TicketTokenPayload {
  return jwt.verify(token, getTicketTokenSecret()) as TicketTokenPayload & jwt.JwtPayload;
}
