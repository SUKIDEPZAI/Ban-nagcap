import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { createSynth } from './synth.js';
import { cleanForTTS, splitSentences, fallbackFilter } from './ttstext.js';

export { cleanForTTS, splitSentences };

// Edge TTS chỉ có 2 giọng Việt gốc (HoaiMy = nữ, NamMinh = nam).
// Các giọng "bé gái / ông già / bà già..." được tạo bằng cách chỉnh cao độ (pitch) + tốc độ (rate).
export const VOICES = {
  nu:       { label: 'Nữ (mặc định)',      name: 'vi-VN-HoaiMyNeural', pitch: '+0Hz',  rate: '+0%' },
  be_gai:   { label: 'Bé gái',             name: 'vi-VN-HoaiMyNeural', pitch: '+45Hz', rate: '+12%' },
  ba_gia:   { label: 'Bà già',             name: 'vi-VN-HoaiMyNeural', pitch: '-25Hz', rate: '-18%' },
  nam:      { label: 'Chàng trai',         name: 'vi-VN-NamMinhNeural', pitch: '+0Hz',  rate: '+0%' },
  be_trai:  { label: 'Bé trai',            name: 'vi-VN-NamMinhNeural', pitch: '+55Hz', rate: '+12%' },
  nam_tram: { label: 'Nam trầm',           name: 'vi-VN-NamMinhNeural', pitch: '-25Hz', rate: '-8%' },
  ong_gia:  { label: 'Ông già',            name: 'vi-VN-NamMinhNeural', pitch: '-45Hz', rate: '-22%' },
  noi_nhanh:{ label: 'Nói nhanh như rap',  name: 'vi-VN-NamMinhNeural', pitch: '+0Hz',  rate: '+35%' },
  en_nu:    { label: 'Tiếng Anh nữ',       name: 'en-US-AriaNeural',   pitch: '+0Hz',  rate: '+0%' },
  en_nam:   { label: 'Tiếng Anh nam',      name: 'en-US-GuyNeural',    pitch: '+0Hz',  rate: '+0%' },
  en_be:    { label: 'Tiếng Anh bé (Ana)', name: 'en-US-AnaNeural',    pitch: '+0Hz',  rate: '+0%' },
  jp_nu:    { label: 'Tiếng Nhật nữ',      name: 'ja-JP-NanamiNeural', pitch: '+0Hz',  rate: '+0%' },
  kr_nu:    { label: 'Tiếng Hàn nữ',       name: 'ko-KR-SunHiNeural',  pitch: '+0Hz',  rate: '+0%' },
  cn_nu:    { label: 'Tiếng Trung nữ',     name: 'zh-CN-XiaoxiaoNeural', pitch: '+0Hz', rate: '+0%' },
};

const timeout = (ms, msg) => { let t; const p = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); }); return { p, clear: () => clearTimeout(t) }; };
async function within(promise, ms, msg) {
  const t = timeout(ms, msg);
  try { return await Promise.race([promise, t.p]); } finally { t.clear(); }
}

// 1 lần gọi Edge TTS (retry/dự phòng do synth.js lo)
async function edgeOnce(text, key) {
  const v = VOICES[key] || VOICES.nu;
  const tts = new MsEdgeTTS();
  try {
    await within(tts.setMetadata(v.name, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3), 8000, 'Kết nối Edge TTS quá thời gian 8 giây');
    const r = await within(tts.toStream(text, { pitch: v.pitch, rate: v.rate }), 10000, 'Edge TTS không trả stream sau 10 giây');
    const stream = r.audioStream || r;
    const chunks = [];
    await within((async () => { for await (const c of stream) chunks.push(c); })(), 15000, 'Edge TTS stream bị treo quá 15 giây');
    return Buffer.concat(chunks);
  } finally {
    try { tts.close?.(); } catch { /* best effort */ }
  }
}

const GOOGLE_LANG = { en_nu: 'en', en_nam: 'en', en_be: 'en', jp_nu: 'ja', kr_nu: 'ko', cn_nu: 'zh-CN' };

// Dự phòng không cần API key; vẫn cần host truy cập được Google Translate.
// Giữ lại "chất giọng" (cao độ/tốc độ) bằng bộ lọc ffmpeg do voice.js áp dụng.
async function googleOnce(text, key) {
  const lang = GOOGLE_LANG[key] || 'vi';
  const chunks = [];
  for (const part of splitSentences(String(text || ''), 160)) {
    const url = new URL('https://translate.google.com/translate_tts');
    url.search = new URLSearchParams({ ie: 'UTF-8', client: 'tw-ob', tl: lang, q: part }).toString();
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Google TTS HTTP ${response.status}`);
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length) throw new Error('Google TTS trả âm thanh rỗng');
    chunks.push(audio);
  }
  return { buf: Buffer.concat(chunks), fx: fallbackFilter(VOICES[key] || VOICES.nu) };
}

export const synthesize = createSynth({ edge: edgeOnce, google: googleOnce });
