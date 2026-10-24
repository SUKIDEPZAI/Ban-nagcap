// Xử lý văn bản cho TTS (thuần, không phụ thuộc thư viện ngoài)

export function cleanForTTS(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[@#&!]*\d+>/g, ' ')
    .replace(/[*_~`>#|]/g, '')
    .replace(/\p{Extended_Pictographic}|️/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
}

// cắt cứng 1 đoạn dài theo từ để không vượt `max` (Google TTS giới hạn ~200 ký tự)
function hardSplit(s, max) {
  const out = [];
  let cur = '';
  for (const w of s.split(/\s+/)) {
    if (w.length > max) { // một "từ" dài bất thường -> cắt theo ký tự
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < w.length; i += max) out.push(w.slice(i, i + max));
      continue;
    }
    if ((cur + ' ' + w).trim().length > max && cur) { out.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out;
}

// tách câu để vừa tổng hợp vừa phát; mọi mảnh đều <= max ký tự
export function splitSentences(text, max = 180) {
  const raw = String(text || '').split(/(?<=[.!?…。])\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const piece of raw.flatMap((p) => (p.length > max ? hardSplit(p, max) : [p]))) {
    if ((cur + ' ' + piece).trim().length > max && cur) { out.push(cur.trim()); cur = piece; }
    else cur = (cur + ' ' + piece).trim();
  }
  if (cur) out.push(cur.trim());
  return out.length ? out : (text ? [String(text)] : []);
}

// Google TTS không có pitch/rate -> mô phỏng bằng bộ lọc ffmpeg (MP3 Google ~24kHz)
export function fallbackFilter({ pitch = '+0Hz', rate = '+0%' } = {}, sampleRate = 24000) {
  const hz = parseFloat(pitch) || 0;
  const pct = parseFloat(rate) || 0;
  const tempo = Math.min(2, Math.max(0.5, 1 + pct / 100));
  const ratio = Math.min(1.5, Math.max(0.6, 1 + hz / 220)); // ~220Hz ≈ cao độ nền giọng nữ
  if (Math.abs(ratio - 1) < 0.01 && Math.abs(tempo - 1) < 0.01) return '';
  const t = Math.min(2, Math.max(0.5, tempo / ratio));
  return `asetrate=${Math.round(sampleRate * ratio)},aresample=48000,atempo=${t.toFixed(3)}`;
}

// Phần nhìn thấy được của luồng AI: bỏ <think>...</think>; giữ lại phần đuôi có thể là đầu thẻ <think> chưa đủ
export function visibleText(raw) {
  let v = String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const open = v.indexOf('<think>');
  if (open !== -1) return v.slice(0, open);
  for (let k = Math.min(6, v.length); k > 0; k--) {
    if ('<think>'.startsWith(v.slice(-k))) return v.slice(0, v.length - k);
  }
  return v;
}

