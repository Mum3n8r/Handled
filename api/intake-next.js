// /api/intake-next — serverless brain for the smart intake form.
// Takes the conversation so far, extracts structured fields, returns the next question.
// Tries the free OpenRouter model first, falls back to the paid variant (fractions of a cent),
// and if both fail returns { fallback: true } so the client walks its static question list.
// Never throws a visible error at the customer.

// paid model first (fractions of a cent per question, fast via Groq/Cerebras);
// free variant as backup if credits ever run out. Static questions if both fail.
const MODELS = [
  { model: 'openai/gpt-oss-120b', timeoutMs: 7000, provider: { order: ['groq', 'cerebras'], allow_fallbacks: true } },
  { model: 'openai/gpt-oss-120b:free', timeoutMs: 2500 },
];
const FIELD_KEYS = ['business_type', 'biggest_pain', 'tools_used', 'name', 'email'];

const SYSTEM_PROMPT = `You generate the next single question for the intake form of Handled, a done-for-you AI automation service for local businesses. The UI shows ONE question at a time on a clean card — it is a form, not a chat. The customer has already chosen a plan and is on the way to checkout, so keep momentum: short, warm, plain language. No emoji, no exclamation points, no filler like "Great!".

You must silently collect exactly these fields:
- business_type: what kind of business they run
- biggest_pain: their biggest time drain, CONCRETE enough to build an automation from (what task, roughly how it happens today). If their answer is vague (e.g. "admin stuff"), ask ONE clarifying follow-up. Never probe the same field twice — after one follow-up, accept whatever they give.
- tools_used: software/tools they run the business on ("nothing yet" is a valid answer)
- name: their first or full name
- email: their email address

Rules:
- Read the transcript, update every field you can infer, and ask for the FIRST missing field (in the order above).
- NEVER ask about a field that is already filled in known_fields or inferable from the transcript.
- Questions are max 2 short sentences. You may briefly acknowledge their previous answer in the question itself (e.g. "Chasing quotes by text is exactly the kind of thing we automate. What tools do you run things on today, if any?").
- If plan is "custom", when probing biggest_pain also try to learn scope (multiple locations? existing systems to integrate?).
- You may combine name and email into one question ("Last thing — your name and best email for setup?").
- When every field is filled, set done to true and next_question to null.

Respond with ONLY a JSON object, no markdown fences, in exactly this shape:
{"fields":{"business_type":string|null,"biggest_pain":string|null,"tools_used":string|null,"name":string|null,"email":string|null},"next_question":string|null,"hint":string|null,"done":boolean}
hint is optional short example text shown under the input (like a placeholder), or null.`;

async function callModel(cfg, key, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://justhandled.net',
        'X-Title': 'Handled Intake',
      },
      body: JSON.stringify({
        model: cfg.model,
        ...(cfg.provider ? { provider: cfg.provider } : {}),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        temperature: 0.4,
        max_tokens: 500,
      }),
      signal: controller.signal,
    });
    if (!r.ok) return null;
    const d = await r.json();
    return (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseReply(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1));
    if (!o || typeof o !== 'object' || !o.fields) return null;
    const fields = {};
    for (const k of FIELD_KEYS) {
      const v = o.fields[k];
      fields[k] = (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 500) : null;
    }
    const done = !!o.done || FIELD_KEYS.every(k => fields[k]);
    const next_question = (typeof o.next_question === 'string' && o.next_question.trim())
      ? o.next_question.trim().slice(0, 300) : null;
    if (!done && !next_question) return null;
    const hint = (typeof o.hint === 'string' && o.hint.trim()) ? o.hint.trim().slice(0, 120) : null;
    return { fields, next_question, hint, done };
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://justhandled.net');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(200).json({ fallback: true });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const plan = ['starter', 'full', 'custom'].includes(body && body.plan) ? body.plan : 'full';
  const transcript = Array.isArray(body && body.transcript) ? body.transcript.slice(-16).map(t => ({
    q: String((t && t.q) || '').slice(0, 300),
    a: String((t && t.a) || '').slice(0, 1000),
  })) : [];
  const known = {};
  for (const k of FIELD_KEYS) {
    const v = body && body.fields ? body.fields[k] : null;
    known[k] = (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 500) : null;
  }

  const payload = { plan, known_fields: known, transcript };

  let parsed = null;
  for (const cfg of MODELS) {
    const reply = await callModel(cfg, key, payload);
    parsed = parseReply(reply);
    if (parsed) break;
  }
  if (!parsed) return res.status(200).json({ fallback: true });

  // never let the model erase something we already knew
  for (const k of FIELD_KEYS) {
    if (!parsed.fields[k] && known[k]) parsed.fields[k] = known[k];
  }
  parsed.done = parsed.done || FIELD_KEYS.every(k => parsed.fields[k]);

  return res.status(200).json(parsed);
};
