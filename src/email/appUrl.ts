const DEV_DEFAULT_BASE_URL = "http://localhost:5173";

export function buildAppUrl(path: string): string {
  const configured = process.env.APP_BASE_URL?.trim();
  const base =
    configured || (process.env.NODE_ENV === "production" ? undefined : DEV_DEFAULT_BASE_URL);
  if (!base) {
    throw new Error("APP_BASE_URL is not set; it is required in production to build email links.");
  }
  return `${base.replace(/\/+$/, "")}${path}`;
}
