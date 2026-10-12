import { describe, expect, it } from "vitest";
import { htmlToText, MASK, MASKED_CODE, maskSecrets } from "../src/mask.js";

describe("maskSecrets: links", () => {
  const masked: Array<[string, string]> = [
    [
      "WordPress password reset",
      "https://shop.example.com/wp-login.php?action=rp&key=FAKEkey0123456789abcd&login=ava",
    ],
    ["resetpass action alone", "https://shop.example.com/wp-login.php?action=resetpass&login=ava"],
    [
      "WooCommerce lost password",
      "https://shop.example.com/my-account/lost-password/?show-reset-form=true&key=abc&id=12",
    ],
    ["token parameter", "https://app.example.com/login?token=3f9a1c"],
    ["login token parameter", "https://app.example.com/session?login_token=zz9"],
    [
      "WordPress nonce",
      "https://shop.example.com/wp-admin/post.php?post=5&action=edit&_wpnonce=a1b2c3d4e5",
    ],
    ["plain nonce", "https://shop.example.com/?nonce=a1b2c3"],
    ["email verification code", "https://app.example.com/verify-email?code=771203"],
    ["verify parameter", "https://app.example.com/account?verify=1a2b3c"],
    [
      "FluentCRM manage link hash",
      "https://crm.example.com/?fluentcrm=1&route=manage&ce_id=9&hash=5e3c9b",
    ],
    ["magic link token in path", "https://app.example.com/magic/9f8e7d6c5b4a3f2e1d0c9b8a"],
    ["short token in a magic-login path", "https://app.example.com/magic-login/k3y9x2p7"],
    ["random value in any parameter", "https://app.example.com/go?x=AbCdEf0123456789GhIjKl"],
    ["token in the fragment", "https://app.example.com/callback#access_token=abc123"],
    ["signature", "https://cdn.example.com/file.pdf?expires=1&signature=deadbeef"],
  ];
  for (const [name, url] of masked) {
    it(`masks ${name}`, () => {
      const out = maskSecrets(`Click ${url} now`);
      expect(out).not.toContain(url);
      expect(out).toContain(MASK);
      // The host stays, so the user can still tell what the link was.
      expect(out).toContain(new URL(url).host);
    });
  }

  it("keeps trailing sentence punctuation outside the masked link", () => {
    expect(maskSecrets("Reset here: https://a.example.com/wp-login.php?action=rp&key=k1.")).toBe(
      `Reset here: https://a.example.com/wp-login.php?${MASK}.`,
    );
  });

  it("masks every link in the text", () => {
    const out = maskSecrets(
      "a https://a.example.com/?token=1 b https://b.example.com/?key=2 c https://c.example.com/blog",
    );
    expect(out).toBe(
      `a https://a.example.com/?${MASK} b https://b.example.com/?${MASK} c https://c.example.com/blog`,
    );
  });

  const kept = [
    "https://shop.example.com/blog/how-we-ship",
    "https://shop.example.com/order/1026",
    "https://shop.example.com/products?category=shoes&page=2",
    "https://shop.example.com/wp-login.php",
    "https://shop.example.com/verify-email/",
  ];
  for (const url of kept) {
    it(`keeps an ordinary link: ${url}`, () => {
      expect(maskSecrets(`See ${url}`)).toBe(`See ${url}`);
    });
  }
});

describe("maskSecrets: one-time codes", () => {
  const cases: Array<[string, string]> = [
    ["Your verification code is 482913.", `Your verification code is ${MASKED_CODE}.`],
    ["Your code: 4829-13", `Your code: ${MASKED_CODE}`],
    ["OTP 123 456", `OTP ${MASKED_CODE}`],
    ["Use one-time passcode 90210 to sign in", `Use one-time passcode ${MASKED_CODE} to sign in`],
    ["Your login code is X7K9QZ2", `Your login code is ${MASKED_CODE}`],
    ["Your PIN is 4821", `Your PIN is ${MASKED_CODE}`],
    ["2FA code 551203", `2FA code ${MASKED_CODE}`],
    ["482913 is your verification code", `${MASKED_CODE} is your verification code`],
  ];
  for (const [input, expected] of cases) {
    it(`masks "${input}"`, () => {
      expect(maskSecrets(input)).toBe(expected);
    });
  }

  const kept = [
    "Your order receipt #1026",
    "Booking confirmed for Friday",
    "We received your message",
    "Order 12345 has shipped",
    "Your verification code",
    "Welcome to the newsletter",
  ];
  for (const text of kept) {
    it(`keeps "${text}"`, () => {
      expect(maskSecrets(text)).toBe(text);
    });
  }
});

describe("htmlToText", () => {
  it("keeps link addresses so they can be masked", () => {
    const html =
      '<p>Someone asked to reset your password.</p><p><a href="https://s.example.com/wp-login.php?action=rp&amp;key=FAKEkey0123456789abcd&amp;login=ava">Reset your password</a></p>';
    const text = htmlToText(html);
    expect(text).toBe(
      "Someone asked to reset your password.\nReset your password (https://s.example.com/wp-login.php?action=rp&key=FAKEkey0123456789abcd&login=ava)",
    );
    expect(maskSecrets(text)).toBe(
      `Someone asked to reset your password.\nReset your password (https://s.example.com/wp-login.php?${MASK})`,
    );
  });

  it("drops styles, scripts and comments and decodes entities", () => {
    expect(
      htmlToText(
        "<html><head><style>p{}</style></head><body><!-- x --><p>Tom &amp; Jerry&#39;s &lt;3</p><script>alert(1)</script></body></html>",
      ),
    ).toBe("Tom & Jerry's <3");
  });

  it("turns breaks and list items into lines", () => {
    expect(htmlToText("<ul><li>One</li><li>Two</li></ul>Line<br>Next")).toBe(
      "- One\n- Two\nLine\nNext",
    );
  });

  it("does not repeat a link whose text is its address", () => {
    expect(htmlToText('<a href="https://x.example.com/">https://x.example.com/</a>')).toBe(
      "https://x.example.com/",
    );
  });
});
