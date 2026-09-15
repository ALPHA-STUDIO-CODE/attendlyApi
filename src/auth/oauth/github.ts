import type { OAuthProfile } from "./google";

interface GitHubTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUserResponse {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

interface GitHubEmailResponse {
  email: string;
  primary: boolean;
  verified: boolean;
}

function getGitHubOAuthConfig() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const redirectUri = process.env.GITHUB_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "GitHub OAuth is not configured. Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, " +
        "and GITHUB_REDIRECT_URI.",
    );
  }

  return { clientId, clientSecret, redirectUri };
}

function githubApiHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    // GitHub's API requires a User-Agent on every request or it 403s.
    "User-Agent": "attendly-app",
  };
}

/**
 * GitHub omits `email` from the main profile response whenever the user
 * has their email set to private (a common default) — it's only
 * available via this separate, more sensitive endpoint, which requires
 * the `user:email` scope to have been granted during the authorize step.
 */
async function fetchVerifiedGitHubEmail(accessToken: string): Promise<string | null> {
  const response = await fetch("https://api.github.com/user/emails", {
    headers: githubApiHeaders(accessToken),
  });
  if (!response.ok) {
    return null;
  }
  const emails = (await response.json()) as GitHubEmailResponse[];
  const primaryVerified = emails.find((e) => e.primary && e.verified);
  const anyVerified = emails.find((e) => e.verified);
  return primaryVerified?.email ?? anyVerified?.email ?? null;
}

/**
 * Exchanges a GitHub OAuth authorization code for the user's profile.
 * Sole network-calling boundary for GitHub OAuth — tests mock this whole
 * module rather than hitting GitHub's real endpoints (per spec §12).
 */
export async function exchangeGitHubAuthCode(code: string): Promise<OAuthProfile> {
  const { clientId, clientSecret, redirectUri } = getGitHubOAuthConfig();

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`GitHub token exchange failed with status ${tokenResponse.status}.`);
  }

  const tokenData = (await tokenResponse.json()) as GitHubTokenResponse;
  if (tokenData.error || !tokenData.access_token) {
    throw new Error(`GitHub token exchange returned an error: ${tokenData.error ?? "unknown"}.`);
  }

  const userResponse = await fetch("https://api.github.com/user", {
    headers: githubApiHeaders(tokenData.access_token),
  });
  if (!userResponse.ok) {
    throw new Error(`GitHub user fetch failed with status ${userResponse.status}.`);
  }
  const githubUser = (await userResponse.json()) as GitHubUserResponse;

  const email = githubUser.email ?? (await fetchVerifiedGitHubEmail(tokenData.access_token));
  if (!email) {
    throw new Error(
      "GitHub account has no accessible verified email address. The 'user:email' " +
        "scope must be granted, or the account must have a public email set.",
    );
  }

  return {
    providerId: String(githubUser.id),
    email,
    name: githubUser.name ?? githubUser.login,
  };
}
