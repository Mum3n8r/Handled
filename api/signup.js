// api/signup.js - Vercel serverless proxy for signup form.
// Browser POSTs to /api/signup (same origin, no CORS/ngrok issues).
// This function forwards to the HP backend server-side.

const BACKEND = 'https://duvet-habitant-stimulate.ngrok-free.dev';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { url, email, business_name } = req.body;
    if (!url || !email) return res.status(400).json({ error: 'url and email required' });

    const r = await fetch(`${BACKEND}/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify({ url, email, business_name }),
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : 500).json(data.ok ? { ok: true } : { error: 'Backend error' });

  } catch (e) {
    // Backend unreachable — still acknowledge so customer isn't blocked.
    // Fallback: log to console, Vercel will capture it.
    console.error('[signup proxy] backend unreachable:', e.message);
    return res.status(200).json({ ok: true, fallback: true });
  }
}
