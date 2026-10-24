import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rms, toWav16kMono, silentWav, cleanTranscript, HALLUCINATIONS } from '../src/audio.js';
import { cleanForTTS, splitSentences, fallbackFilter, visibleText } from '../src/ttstext.js';
import { createSynth, errorDetails } from '../src/synth.js';

const quiet = { warn() {}, log() {}, error() {} };
const buf = (n = 4) => Buffer.alloc(n, 1);

/* ---------- audio ---------- */
test('rms: im lặng ~0, tín hiệu lớn > ngưỡng', () => {
  assert.equal(rms(Buffer.alloc(4000)), 0);
  const loud = Buffer.alloc(4000);
  for (let i = 0; i + 1 < loud.length; i += 2) loud.writeInt16LE(i % 4 ? 8000 : -8000, i);
  assert.ok(rms(loud) > 1000);
});

test('toWav16kMono: 48k stereo -> 16k mono, header đúng, giữ biên độ', () => {
  const frames = 4800; // 0.1s
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) { pcm.writeInt16LE(1000, i * 4); pcm.writeInt16LE(1000, i * 4 + 2); }
  const wav = toWav16kMono(pcm);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.length, 44 + (frames / 3) * 2);
  assert.equal(wav.readInt16LE(44), 1000);
  assert.equal(silentWav(1).length, 44 + 32000);
});

test('cleanTranscript: bỏ [BLANK_AUDIO] và ghi chú trong ngoặc', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO] '), '');
  assert.equal(cleanTranscript('(tiếng ồn)'), '');
  assert.equal(cleanTranscript('bot phát nhạc đi'), 'bot phát nhạc đi');
  assert.ok(HALLUCINATIONS.test('hãy đăng ký kênh'));
});

/* ---------- text cho TTS ---------- */
test('cleanForTTS bỏ link, mention, markdown, emoji và giới hạn 700 ký tự', () => {
  assert.equal(cleanForTTS('**xin** chào https://a.b/c <@123> 😀'), 'xin chào');
  assert.equal(cleanForTTS('a'.repeat(900)).length, 700);
});

test('splitSentences: mọi mảnh <= max, kể cả câu dài không có dấu chấm', () => {
  const long = 'từ '.repeat(120).trim(); // ~360 ký tự, không dấu câu
  const parts = splitSentences(long, 180);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 180));
  assert.deepEqual(splitSentences('Xin chào. Khỏe không?'), ['Xin chào. Khỏe không?']);
  assert.deepEqual(splitSentences(''), []);
});

test('fallbackFilter: giọng gốc không cần lọc, giọng bé/ông già có asetrate+atempo', () => {
  assert.equal(fallbackFilter({ pitch: '+0Hz', rate: '+0%' }), '');
  assert.match(fallbackFilter({ pitch: '+45Hz', rate: '+12%' }), /asetrate=\d+,aresample=48000,atempo=[\d.]+/);
  const t = Number(fallbackFilter({ pitch: '-45Hz', rate: '-22%' }).match(/atempo=([\d.]+)/)[1]);
  assert.ok(t >= 0.5 && t <= 2);
});

test('visibleText: ẩn <think>, giữ phần đuôi có thể là đầu thẻ', () => {
  assert.equal(visibleText('xin <think>nghĩ</think>chào'), 'xin chào');
  assert.equal(visibleText('a <think>đang nghĩ'), 'a ');
  assert.equal(visibleText('a <thi'), 'a ');
  assert.equal(visibleText('x < y'), 'x < y');
});

/* ---------- synth: retry + fallback + circuit breaker ---------- */
function harness(over = {}) {
  let t = 1_000_000;
  const calls = { edge: 0, google: 0 };
  const synth = createSynth({
    edge: async () => { calls.edge++; if (over.edgeFail) throw new Error('ws closed'); return buf(); },
    google: async () => { calls.google++; if (over.googleFail) throw new Error('HTTP 429'); return { buf: buf(), fx: 'fx' }; },
    sleep: async () => {}, now: () => t, log: quiet, attempts: 2, cooldownMs: 60_000,
  });
  return { synth, calls, advance: (ms) => { t += ms; }, set: (o) => Object.assign(over, o) };
}

test('synth: Edge ổn -> dùng Edge, không gọi Google', async () => {
  const h = harness();
  const r = await h.synth('hi', 'nu');
  assert.equal(r.engine, 'edge');
  assert.deepEqual(h.calls, { edge: 1, google: 0 });
});

test('synth: Edge lỗi -> retry rồi dùng Google; lần sau BỎ QUA Edge (circuit breaker)', async () => {
  const h = harness({ edgeFail: true });
  const r1 = await h.synth('hi', 'nu');
  assert.equal(r1.engine, 'google');
  assert.equal(h.calls.edge, 2);
  const r2 = await h.synth('hi', 'nu');
  assert.equal(r2.engine, 'google');
  assert.equal(h.calls.edge, 2, 'không thử lại Edge trong thời gian cooldown');
});

test('synth: sau cooldown chỉ thăm dò Edge 1 lần; Edge sống lại thì quay về Edge', async () => {
  const h = harness({ edgeFail: true });
  await h.synth('a', 'nu');
  h.advance(61_000);
  await h.synth('b', 'nu');
  assert.equal(h.calls.edge, 3, 'thăm dò đúng 1 lần');
  h.advance(61_000);
  h.set({ edgeFail: false });
  const r = await h.synth('c', 'nu');
  assert.equal(r.engine, 'edge');
});

test('synth: cả hai lỗi -> ném lỗi có chi tiết cả hai và KHÔNG khóa Edge', async () => {
  const h = harness({ edgeFail: true, googleFail: true });
  await assert.rejects(h.synth('hi', 'nu'), (e) => /ws closed/.test(e.message) && /HTTP 429/.test(e.message));
  h.set({ edgeFail: false });
  assert.equal((await h.synth('hi', 'nu')).engine, 'edge');
});

test('errorDetails: gộp cause lồng nhau và có gợi ý khi lỗi trống', () => {
  const e = new Error('outer', { cause: Object.assign(new Error('inner'), { code: 'ECONNRESET' }) });
  assert.match(errorDetails(e), /outer.*inner.*ECONNRESET/);
  assert.match(errorDetails({}), /chặn WebSocket/);
});

/* ---------- cấu trúc mã (smoke) ---------- */
const src = (f) => readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');

test('STT: Whisper cục bộ là mặc định, STT_API_KEY (đám mây) chỉ là tùy chọn', async () => {
  const stt = await src('stt.js');
  assert.match(stt, /WHISPER_CLI_PATH/);
  assert.match(stt, /process\.env\.STT_API_KEY \|\| ''/);
});

test('khóa API nhận MOTAPIS_API_KEY hoặc AI_API_KEY', async () => {
  assert.match(await src('config.js'), /MOTAPIS_API_KEY\s*\|\|\s*process\.env\.AI_API_KEY/);
});

test('voice: ffmpeg -> PCM thô, dùng opusscript (không native), có epoch chống nói chen', async () => {
  const voice = await src('voice.js');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(voice, /StreamType\.Raw/);
  assert.match(voice, /FFMPEG_PATH/);
  assert.match(voice, /s\.epoch/);
  assert.equal(pkg.dependencies['@discordjs/opus'], undefined);
  assert.equal(pkg.dependencies.opusscript, '^0.0.8');
});

test('chatStream được nối vào nhánh voice của brain', async () => {
  assert.match(await src('brain.js'), /chatStream/);
});
