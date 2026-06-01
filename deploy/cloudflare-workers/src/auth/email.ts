import type { Env } from "../index";

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Bowtie Content Desk <noreply@bowtie.com.hk>";

/**
 * Send a transactional email via Resend's HTTPS API (Workers can't open raw
 * SMTP sockets). Throws on non-2xx so better-auth surfaces the failure —
 * verification mail must never be silently dropped.
 */
export async function sendEmail(env: Env, input: SendEmailInput): Promise<void> {
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
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

function emailShell(heading: string, body: string, cta: string, url: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1a1a1a;line-height:1.5;padding:24px">
  <h2 style="margin:0 0 12px">${heading}</h2>
  <p style="margin:0 0 20px;color:#444">${body}</p>
  <p style="margin:0 0 24px"><a href="${url}" style="background:#1a1a1a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${cta}</a></p>
  <p style="margin:0;color:#888;font-size:12px">Or paste this link into your browser:<br>${url}</p>
</body></html>`;
}
