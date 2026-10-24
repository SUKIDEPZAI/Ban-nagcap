import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, access, stat, chmod } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanTranscript, silentWav } from './audio.js';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const cliPath = path.resolve(root, process.env.WHISPER_CLI_PATH || './bin/whisper-cli');
const modelPath = path.resolve(root, process.env.WHISPER_MODEL_PATH || './models/ggml-tiny.bin');
const language = process.env.WHISPER_LANGUAGE || process.env.STT_LANG || 'vi';
const threads = Math.max(1, Math.min(8, Number(process.env.WHISPER_THREADS) || 1));
const timeout = Math.max(5000, Math.min(120000, Number(process.env.WHISPER_TIMEOUT_MS) || 45000));
// ví dụ: WHISPER_EXTRA_ARGS="-ng -nfa" (tắt GPU/flash-attn khi host không hỗ trợ)
// Mặc định dùng giải mã tham lam (-bs 1 -bo 1 -nf): nhanh hơn nhiều so với beam 5 trên CPU yếu
const extraArgs = String(process.env.WHISPER_EXTRA_ARGS ?? '-bs 1 -bo 1 -nf').split(/\s+/).filter(Boolean);

// STT đám mây (tùy chọn, rất khuyến nghị cho host yếu): đặt STT_API_KEY (vd Groq, miễn phí)
const cloud = {
  key: process.env.STT_API_KEY || '',
  base: (process.env.STT_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
  model: process.env.STT_MODEL || 'whisper-large-v3-turbo',
  timeoutMs: Math.max(3000, Number(process.env.STT_TIMEOUT_MS) || 15000),
};
let cloudDownUntil = 0;
let stuck = null; // tiến trình whisper cũ còn sống sau timeout (host không cho kill)

const localReady = () => existsSync(cliPath) && existsSync(modelPath);
export function sttEnabled() {
  return Boolean(cloud.key) || localReady();
}

async function cloudTranscribe(wav) {
  const fd = new FormData();
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  fd.append('model', cloud.model);
  fd.append('language', language);
  fd.append('response_format', 'json');
  fd.append('temperature', '0');
  const res = await fetch(`${cloud.base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cloud.key}` },
    body: fd,
    signal: AbortSignal.timeout(cloud.timeoutMs),
  });
  if (!res.ok) throw new Error(`STT đám mây HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return cleanTranscript(j.text);
}

// Dòng log khởi tạo của whisper (không phải lỗi) -> lọc để lộ ra dòng lỗi thật
const NOISE = /^(whisper_(init|model|backend|print|full)|ggml_|system_info|main:|whisper_init_state|load_backend|register_backend)/i;

// Dịch nguyên nhân hay gặp (tín hiệu hệ điều hành) sang gợi ý dễ hiểu
export function explainFailure(error, { timedOut = false } = {}) {
  const sig = error?.signal;
  const code = error?.code;
  if (timedOut) return `Whisper chạy quá ${timeout} ms nên bị dừng: CPU của host quá chậm/bị giới hạn (lỗi 'EACCES' ở đây là do HOST KHÔNG CHO KILL tiến trình, không phải thiếu quyền chạy). Cách xử lý tốt nhất: đặt STT_API_KEY để dùng STT đám mây (vd Groq, miễn phí).`;
  if (sig === 'SIGKILL') return 'Tiến trình bị hệ điều hành kill (thường là HẾT RAM/vượt giới hạn bộ nhớ của gói host). Thử model nhỏ hơn, WHISPER_THREADS=1, hoặc nâng RAM.';
  if (sig === 'SIGILL') return 'CPU host không hỗ trợ tập lệnh mà binary được build (AVX/AVX2...). Build lại whisper-cli với GGML_NATIVE=OFF.';
  if (sig === 'SIGSEGV' || sig === 'SIGBUS') return 'Whisper bị crash bộ nhớ (SIGSEGV/SIGBUS): binary không khớp host hoặc model hỏng. Tải lại model, build lại binary.';
  if (code === 'EACCES') return `Không có quyền thực thi ${cliPath}. chmod 755 không giúp được thì host có thể gắn noexec.`;
  if (code === 'ENOEXEC') return 'Binary sai kiến trúc/định dạng (Exec format error): cần binary Linux cùng kiến trúc CPU (x86_64/arm64) với host.';
  if (code === 'ENOENT') return 'Không tìm thấy binary hoặc thiếu thư viện động (ldd bin/whisper-cli để xem). Nên build tĩnh.';
  if (error?.killed || code === 'ETIMEDOUT') return `Whisper vượt quá ${timeout} ms; giảm độ dài câu nói hoặc dùng model nhỏ hơn.`;
  return '';
}

async function preflight() {
  if (!existsSync(cliPath)) throw new Error(`Thiếu Whisper CLI: ${cliPath}. Upload binary vào bin/whisper-cli.`);
  if (!existsSync(modelPath)) throw new Error(`Thiếu model Whisper: ${modelPath}. Upload ggml-tiny.bin vào models/ggml-tiny.bin.`);
  // ZIP/file manager có thể làm mất bit executable; thử sửa quyền trước khi spawn.
  await access(cliPath, constants.X_OK).catch(async () => {
    try { await chmod(cliPath, 0o755); } catch (e) { throw new Error(`Không thể cấp quyền chạy Whisper (${e.code || e.message}). Kiểm tra quyền file/host.`); }
    await access(cliPath, constants.X_OK).catch((e) => { throw new Error(`Whisper vẫn không có quyền thực thi (${e.code || e.message}).`); });
  });
  const [cliInfo, modelInfo] = await Promise.all([stat(cliPath), stat(modelPath)]);
  if (!cliInfo.isFile() || cliInfo.size < 256 * 1024) throw new Error('bin/whisper-cli không giống binary Linux hợp lệ.');
  if (!modelInfo.isFile() || modelInfo.size < 10 * 1024 * 1024) throw new Error('Model Whisper quá nhỏ hoặc tải chưa hoàn tất.');
}

// Chạy whisper, trả về transcript (có thể rỗng nếu chỉ là im lặng/tiếng ồn)
async function runLocal(wav) {
  if (stuck) {
    if (stuck.exitCode === null && stuck.signalCode === null) throw new Error('Whisper lần trước vẫn đang chạy ngầm (host không cho kill) nên bỏ qua để tránh hết RAM. Dùng STT_API_KEY (STT đám mây) hoặc restart bot.');
    stuck = null;
  }
  await preflight();

  const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-whisper-'));
  const wavPath = path.join(dir, 'speech.wav');
  const outPrefix = path.join(dir, 'transcript');
  try {
    await writeFile(wavPath, wav);
    let result;
    const t0 = Date.now();
    const proc = execFileAsync(cliPath, [
        '-m', modelPath, '-f', wavPath, '-l', language, '-t', String(threads),
        '-nt', '-otxt', '-of', outPrefix, ...extraArgs,
      ], { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const child = proc.child;
    try {
      result = await proc;
    } catch (error) {
      const timedOut = Boolean(error.killed) || error.syscall === 'kill' || error.code === 'ETIMEDOUT' || (!error.signal && Date.now() - t0 >= timeout - 1500);
      if (timedOut) {
        try { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* bỏ qua */ }
        if (child.exitCode === null && child.signalCode === null) stuck = child;
      }
      const raw = String(error.stderr || '').trim() || String(error.stdout || '').trim() || String(error.message || error);
      const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
      const real = lines.filter((l) => !NOISE.test(l));
      // Log ĐẦY ĐỦ ra console để chẩn đoán; tin nhắn Discord chỉ lấy phần có ích
      console.error(`[stt] whisper-cli lỗi code=${error.code ?? '?'} signal=${error.signal ?? '-'}\n${lines.slice(-40).join('\n')}`);
      const detail = (real.length ? real : []).slice(-6).join(' | ').slice(-500)
        || 'whisper in log khởi tạo xong rồi dừng, không có dòng lỗi nào (tiến trình chết đột ngột)';
      const why = explainFailure(error, { timedOut });
      throw new Error(`Whisper CLI thất bại (${timedOut ? 'quá thời gian' : `code=${error.code ?? 'unknown'}`}${error.signal ? `, signal=${error.signal}` : ''}): ${detail}.${why ? ` → ${why}` : ''}`);
    }
    try {
      return cleanTranscript(await readFile(`${outPrefix}.txt`, 'utf8'));
    } catch (error) {
      const detail = String(result?.stderr || result?.stdout || '').trim().split('\n').filter((l) => l && !NOISE.test(l.trim())).slice(-6).join(' | ').slice(-500);
      throw new Error(`Whisper chạy xong nhưng không tạo transcript.txt (${error.code || error.message}). Kiểm tra WAV/model/binary. ${detail}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Trả '' khi không có lời nói (không phải lỗi, để voice.js không spam cảnh báo).
// Ưu tiên STT đám mây nếu có key; lỗi thì tự rơi về Whisper cục bộ.
export async function transcribe(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 48) throw new Error('WAV đầu vào rỗng hoặc không hợp lệ.');
  if (cloud.key && Date.now() >= cloudDownUntil) {
    try {
      return await cloudTranscribe(wav);
    } catch (e) {
      cloudDownUntil = Date.now() + 60_000;
      console.error(`[stt] STT đám mây lỗi, ${localReady() ? 'dùng Whisper cục bộ 60s' : 'không có Whisper cục bộ dự phòng'}:`, e.message);
      if (!localReady()) throw e;
    }
  }
  if (!localReady()) throw new Error(`Thiếu ${path.basename(cliPath)}/model và STT đám mây đang tạm lỗi.`);
  return runLocal(wav);
}

// Tự kiểm tra lúc khởi động: chạy trên 1 giây im lặng
export async function sttSelfTest() {
  if (!sttEnabled()) return { ok: false, message: 'Chưa có STT_API_KEY và cũng chưa có whisper-cli/model -> voice sẽ không nghe được.' };
  const t0 = Date.now();
  const engine = cloud.key ? `đám mây (${cloud.model})` : `cục bộ (threads=${threads}, lang=${language})`;
  try {
    await transcribe(silentWav(1));
    const ms = Date.now() - t0;
    const slow = !cloud.key && ms > 8000 ? ` ⚠️ RẤT CHẬM: mỗi câu nói sẽ mất ≥ ${Math.round(ms / 1000)}s. Hãy đặt STT_API_KEY để dùng STT đám mây.` : '';
    return { ok: !slow, message: `STT ${engine} chạy được (${ms} ms cho 1s im lặng).${slow}` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
