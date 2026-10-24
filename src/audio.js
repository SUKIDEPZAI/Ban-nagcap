// Các hàm xử lý âm thanh/văn bản THUẦN (không phụ thuộc discord.js) để dễ test.

export const HALLUCINATIONS = /(ghiền mì gõ|đăng ký (cho )?kênh|subscribe|cảm ơn các bạn (đã )?(theo dõi|xem)|hẹn gặp lại các bạn|amara\.org|phụ đề)/i;

// RMS ước lượng từ PCM s16le (lấy mẫu thưa để rẻ)
export function rms(pcm) {
  let sum = 0, n = 0;
  for (let i = 0; i + 1 < pcm.length; i += 40) { const v = pcm.readInt16LE(i); sum += v * v; n++; }
  return n ? Math.sqrt(sum / n) : 0;
}

function wavHeader(samples, rate = 16000) {
  const out = Buffer.alloc(44 + samples * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + samples * 2, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(samples * 2, 40);
  return out;
}

// PCM 48kHz stereo s16le -> WAV 16kHz mono (trung bình 3 frame stereo = 6 mẫu)
export function toWav16kMono(pcm) {
  const outSamples = Math.floor(pcm.length / 12);
  const out = wavHeader(outSamples);
  for (let i = 0; i < outSamples; i++) {
    const o = i * 12;
    let sum = 0;
    for (let k = 0; k < 12; k += 2) sum += pcm.readInt16LE(o + k);
    out.writeInt16LE(Math.round(sum / 6), 44 + i * 2);
  }
  return out;
}

// WAV im lặng dùng để tự kiểm tra Whisper khi khởi động
export const silentWav = (seconds = 1) => wavHeader(16000 * seconds);

// Whisper hay in "[BLANK_AUDIO]", "(tiếng ồn)", "[Music]"... -> coi là rỗng
export function cleanTranscript(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (/^[\[(].*[\])]$/.test(t)) return '';
  return t.replace(/\[(BLANK_AUDIO|MUSIC|Music|Âm nhạc)\]/g, '').trim();
}
