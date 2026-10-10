// Runs before every integration test file (jest `setupFiles`).
//
// Tests must never send real email, even when the developer's .env has a real
// Resend key for manual testing: with no key, the Resend wrapper only logs
// the email. APP_BASE_URL is pinned so link assertions don't depend on .env.
delete process.env.RESEND_API_KEY;
process.env.APP_BASE_URL = "https://attendly.example.test";
