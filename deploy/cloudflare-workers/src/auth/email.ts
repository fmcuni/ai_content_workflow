import type { Env } from "../index";

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Bowtie Content Desk <noreply@bowtie.com.hk>";
// Hard cap on the Resend call so a slow/unreachable endpoint can NEVER hang the
// sign-up request (which awaits this). Without it, an unresponsive api.resend.com
// blocks the whole Worker request until the platform limit.
const SEND_TIMEOUT_MS = 8_000;

/**
 * Send a transactional email via Resend's HTTPS API (Workers can't open raw
 * SMTP sockets). Throws on non-2xx / timeout so the caller can decide what to do
 * (verification mail must never be silently dropped), but the timeout guarantees
 * it fails fast instead of hanging.
 */
export async function sendEmail(env: Env, input: SendEmailInput): Promise<void> {
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM ?? DEFAULT_FROM,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Resend send failed (${res.status}): ${detail}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Resend send timed out after ${SEND_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal branded HTML for the email-verification message. */
export function verifyEmailHtml(url: string): string {
  return emailShell(
    "Verify your account",
    "Confirm your email to start using the Bowtie Content Desk.",
    "Verify email",
    url,
  );
}

/** Minimal branded HTML for the password-reset message. */
export function resetPasswordHtml(url: string): string {
  return emailShell(
    "Reset your password",
    "Click below to choose a new Bowtie Content Desk password. Ignore this email if you didn't request it.",
    "Reset password",
    url,
  );
}

/**
 * Escape a value for safe interpolation into HTML text or a double-quoted
 * attribute. The link comes from auth config / request input, so escaping the
 * five significant characters prevents it from breaking out of the `href="..."`
 * attribute or injecting markup into the email body.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function emailShell(heading: string, body: string, cta: string, url: string): string {
  const safeUrl = escapeHtml(url);
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1a1a1a;line-height:1.5;padding:24px">
  <h2 style="margin:0 0 12px">${heading}</h2>
  <p style="margin:0 0 20px;color:#444">${body}</p>
  <p style="margin:0 0 24px"><a href="${safeUrl}" style="background:#1a1a1a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${cta}</a></p>
  <p style="margin:0;color:#888;font-size:12px">Or paste this link into your browser:<br>${safeUrl}</p>
</body></html>`;
}
