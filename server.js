// JARVIS backend: zero dependencies, needs Node 18+. Keys live ONLY here.
const http = require('http'), fs = require('fs'), path = require('path');
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
const E = process.env, PORT = E.PORT || 3000;
const hits = new Map(); // simple rate limit: 30 req/min per IP
const limited = ip => { const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000); a.push(now); hits.set(ip, a); return a.length > 30; };

async function search(q) {
  if (!E.TAVILY_API_KEY) return [];
  const r = await fetch('https://api.tavily.com/search', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + E.TAVILY_API_KEY },
    body: JSON.stringify({ query: q, max_results: 4 }) });
  if (!r.ok) throw new Error('Search service error ' + r.status);
  return ((await r.json()).results || []).map(x => ({ title: x.title, url: x.url, snippet: (x.content || '').slice(0, 400) }));
}

async function askAI(system, messages) {
  if (!E.AI_API_KEY) throw Object.assign(new Error('No AI_API_KEY set on the server.'), { code: 503 });
  if ((E.AI_PROVIDER || 'openai') === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': E.AI_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: E.AI_MODEL, max_tokens: 800, system, messages }) });
    if (!r.ok) throw new Error('AI provider error ' + r.status);
    return (await r.json()).content.map(c => c.text || '').join('');
  }
  const r = await fetch((E.AI_BASE_URL || '').replace(/\/$/, '') + '/chat/completions', { method: 'POST',
    headers: { Authorization: 'Bearer ' + E.AI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: E.AI_MODEL, max_tokens: 800, messages: [{ role: 'system', content: system }, ...messages] }) });
  if (!r.ok) throw new Error('AI provider error ' + r.status);
  return (await r.json()).choices[0].message.content;
}

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }
  if (req.method === 'GET' && req.url === '/api/health') return send(res, 200, { ok: true, ai: !!E.AI_API_KEY, search: !!E.TAVILY_API_KEY, tokenRequired: !!E.APP_TOKEN });
  if (req.method === 'POST' && req.url === '/api/chat') {
    if (limited(req.socket.remoteAddress)) return send(res, 429, { error: 'Too many requests. Wait a minute.' });
    if (E.APP_TOKEN && req.headers['x-app-token'] !== E.APP_TOKEN) return send(res, 401, { error: 'Wrong or missing access token.' });
    let body = ''; for await (const c of req) { body += c; if (body.length > 50000) return send(res, 413, { error: 'Message too large.' }); }
    try {
      const { messages = [], memory = [], web = false } = JSON.parse(body);
      const msgs = messages.slice(-12).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) }));
      let sources = [], ctx = '';
      if (web && msgs.length) { sources = await search(msgs[msgs.length - 1].content).catch(() => []);
        if (sources.length) ctx = '\n\nWeb results (cite as verified, mention source titles):\n' + sources.map((s, i) => `[${i + 1}] ${s.title}: ${s.snippet}`).join('\n'); }
      const system = 'You are JARVIS, a concise, witty personal assistant on an Android phone. Reply in the language the user used (Hindi, English or Hinglish). Keep answers short and speakable; avoid heavy markdown. Say clearly when you are unsure. Never claim you performed a phone action; the app does that.' +
        (memory.length ? '\nUser preferences:\n- ' + memory.slice(0, 20).join('\n- ') : '') + ctx;
      const reply = await askAI(system, msgs);
      send(res, 200, { reply, sources, verified: sources.length > 0 });
    } catch (e) { send(res, e.code || 502, { error: e.message }); }
    return;
  }
  send(res, 404, { error: 'Not found' });
}).listen(PORT, () => console.log('JARVIS running on http://localhost:' + PORT));
