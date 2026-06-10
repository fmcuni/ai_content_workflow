/**
 * The verification/reset URL is interpolated into both the `href="..."`
 * attribute and the HTML body of the email. It must be HTML-escaped so a
 * crafted link cannot break out of the attribute or inject markup.
 */
import { describe, expect, it } from "vitest";

import { resetPasswordHtml, verifyEmailHtml } from "./email";

describe("email HTML escaping", () => {
  it("escapes a URL with a double-quote + angle brackets in verifyEmailHtml", () => {
    const url = 'https://app.test/verify?code=1"><script>alert(1)</script>';
    const html = verifyEmailHtml(url);
    // The raw breakout sequence must not appear.
    expect(html).not.toContain('"><script>');
    expect(html).not.toContain("<script>");
    // The escaped forms appear instead.
    expect(html).toContain("&quot;");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes ampersands so query separators stay valid entities", () => {
    const url = "https://app.test/verify?code=abc&token=xyz";
    const html = resetPasswordHtml(url);
    expect(html).toContain("code=abc&amp;token=xyz");
  });

  it("leaves a benign URL otherwise intact in the href", () => {
    const url = "https://app.test/verify?code=abc";
    const html = verifyEmailHtml(url);
    expect(html).toContain(`href="${url}"`);
  });
});
