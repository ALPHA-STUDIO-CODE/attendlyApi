import jwt from "jsonwebtoken";

const ACCESS_TOKEN_EXPIRY = "15m";

function getAccessTokenSecret(): string {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw new Error("JWT_ACCESS_SECRET is not set.");
  }
  return secret;
}

export interface AccessTokenPayload {
  sub: string; // user id
  role: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, getAccessTokenSecret(), { expiresIn: ACCESS_TOKEN_EXPIRY });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  // jwt.verify's return type is generic (string | JwtPayload); we always
  // sign structured objects above, so a successful verify here is safe to
  // narrow back to our own payload shape.
  return jwt.verify(token, getAccessTokenSecret()) as AccessTokenPayload & jwt.JwtPayload;
}
