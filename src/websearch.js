import { cfg } from './config.js';

const strip = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

async function tavily(q) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: cfg.tavilyKey, query: q, max_results: 5, include_answer: true }),
  });
  if (!r.ok) throw new Error('Tavily lỗi ' + r.status);
  const j = await r.json();
  const lines = (j.results || []).map((x, i) => `${i + 1}. ${x.title} — ${String(x.content || '').slice(0, 250)} (${x.url})`);
  return (j.answer ? `Tóm tắt: ${j.answer}\n` : '') + lines.join('\n');
}

async function ddg(q) {
  const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept-Language': 'vi,en;q=0.8' },
  });
  const html = await r.text();
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 5) {
    let url = m[1];
    const u = url.match(/uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    out.push(`${out.length + 1}. ${strip(m[2])} — ${strip(m[3]).slice(0, 250)} (${url})`);
  }
  return out.join('\n');
}

export async function webSearch(q) {
  try {
    const res = cfg.tavilyKey ? await tavily(q) : await ddg(q);
    return res || 'Không tìm thấy kết quả (có thể bị chặn). Thử thêm TAVILY_API_KEY.';
  } catch (e) {
    return 'Tìm kiếm lỗi: ' + e.message;
  }
}
