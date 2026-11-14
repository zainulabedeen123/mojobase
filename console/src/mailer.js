// Transactional email for the console, sent through Resend's HTTP API.
import { config } from './config.js';

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

function layout({ heading, body, cta, url, footnote }) {
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f7;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#111118">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;padding:32px">
<tr><td style="font-size:20px;font-weight:700;padding-bottom:4px">mojobase</td></tr>
<tr><td style="font-size:22px;font-weight:700;padding:18px 0 8px">${escapeHtml(heading)}</td></tr>
<tr><td style="font-size:15px;line-height:1.6;color:#3d3d4a">${escapeHtml(body)}</td></tr>
<tr><td style="padding:24px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#7c3aed;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px">${escapeHtml(cta)}</a></td></tr>
<tr><td style="font-size:13px;line-height:1.6;color:#6b6b78">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(url)}</span></td></tr>
<tr><td style="font-size:13px;color:#6b6b78;padding-top:18px">${escapeHtml(footnote)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${heading}\n\n${body}\n\n${cta}: ${url}\n\n${footnote}\n`;
  return { html, text };
}

export async function sendEmail({ to, subject, ...content }) {
  const { html, text } = layout(content);
  if (!config.resendApiKey) {
    // No email provider configured (local development): log instead of sending.
    // EMAIL_DEBUG_LOG=1 (tests only) also logs the link so it can be followed.
    const debug = process.env.EMAIL_DEBUG_LOG === '1' ? { url: content.url } : {};
    console.log(
      JSON.stringify({
        level: 'warn',
        msg: 'email not sent (no RESEND_API_KEY)',
        to,
        subject,
        ...debug,
      })
    );
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.emailFrom, to: [to], subject, html, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Email provider returned ${res.status}: ${detail.slice(0, 200)}`);
  }
}

export const emails = {
  verify: (to, url) =>
    sendEmail({
      to,
      subject: 'Confirm your Mojobase email',
      heading: 'Confirm your email',
      body: 'Thanks for signing up for Mojobase. Confirm your email address to start creating projects.',
      cta: 'Confirm email',
      url,
      footnote: "This link expires in 24 hours. If you didn't sign up, you can ignore this email.",
    }),
  reset: (to, url) =>
    sendEmail({
      to,
      subject: 'Reset your Mojobase password',
      heading: 'Reset your password',
      body: 'Someone asked to reset the password for your Mojobase account. Choose a new password with the link below.',
      cta: 'Choose a new password',
      url,
      footnote:
        "This link expires in 1 hour and can be used once. If you didn't ask for this, you can ignore this email — your password won't change.",
    }),
};
