export interface OAuthProfile {
  providerId: string;
  email: string;
  name: string;
}

interface GoogleTokenResponse {
  id_token: string;
  access_token: string;
  [key: string]: unknown;
}

interface GoogleIdTokenClaims {
  sub: string;
  email?: string;
  name?: string;
  [key: string]: unknown;
}

function getGoogleOAuthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, " +
        "and GOOGLE_REDIRECT_URI.",
    );
  }

  return { clientId, clientSecret, redirectUri };
}

function decodeIdTokenClaims(idToken: string): GoogleIdTokenClaims {
  // We receive this id_token directly from Google's token endpoint over a
  // server-to-server HTTPS call in exchangeGoogleAuthCode below — not from
  // the client — so the TLS connection itself is the trust boundary here.
  // (A client-submitted id_token, by contrast, would need full signature
  // verification against Google's public keys before trusting its claims.)
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed Google id_token.");
  }
  const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
  return JSON.parse(payloadJson) as GoogleIdTokenClaims;
}

/**
 * Exchanges a Google OAuth authorization code for the user's profile.
 * This is the sole network-calling boundary for Google OAuth — tests
 * mock this whole module rather than hitting Google's real endpoints
 * (per spec §12: never hit real third-party APIs in CI).
 */
export async function exchangeGoogleAuthCode(code: string): Promise<OAuthProfile> {
  const { clientId, clientSecret, redirectUri } = getGoogleOAuthConfig();

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Google token exchange failed with status ${tokenResponse.status}.`);
  }

  const tokenData = (await tokenResponse.json()) as GoogleTokenResponse;
  const claims = decodeIdTokenClaims(tokenData.id_token);

  if (!claims.sub || !claims.email) {
    throw new Error("Google id_token is missing required claims (sub/email).");
  }

  return {
    providerId: claims.sub,
    email: claims.email,
    name: claims.name ?? claims.email,
  };
}
