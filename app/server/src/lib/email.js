/* Tiny transactional-email sender via Resend's HTTP API — no SMTP, no deps, just
 * fetch (kind to the Pi). Configured by env:
 *   RESEND_API_KEY  required to actually send (if unset, send is a logged no-op so
 *                   dev/offline and the rest of the flow don't break).
 *   RESEND_FROM     verified sender, e.g. "SwissYGO <noreply@elbunkers.com>".
 */
const ENDPOINT = 'https://api.resend.com/emails';

export function emailEnabled() {
  return !!process.env.RESEND_API_KEY;
}

export async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[email] RESEND_API_KEY not set — skipping email to', to); return false; }
  const from = process.env.RESEND_FROM || 'SwissYGO <noreply@elbunkers.com>';
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[email] Resend send failed', res.status, body.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[email] Resend request error', e && e.message);
    return false;
  }
}
