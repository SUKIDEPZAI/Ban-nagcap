import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import { chmodSync } from 'node:fs';
const execFileAsync = promisify(execFileCb);
const LOCAL_YTDLP = path.resolve(process.env.YTDLP_LOCAL_PATH || './bin/yt-dlp');
let ytdlpPromise = null;

async function ytDlpPath() {
  const configured = process.env.YTDLP_PATH;
  if (configured) return configured;
  if (fs.existsSync(LOCAL_YTDLP)) {
    try { chmodSync(LOCAL_YTDLP, 0o755); } catch { /* host có thể cấm chmod */ }
    return LOCAL_YTDLP;
  }
  try { await execFileAsync('yt-dlp', ['--version'], { timeout: 5000 }); return 'yt-dlp'; } catch { /* thử module Python / tải binary */ }
  // Một số host không giữ quyền executable cho binary nhưng vẫn cho chạy Python module.
  for (const py of ['python3', 'python']) {
    try { await execFileAsync(py, ['-m', 'yt_dlp', '--version'], { timeout: 5000 }); return `${py} -m yt_dlp`; } catch { /* thử python tiếp */ }
  }
  if (!ytdlpPromise) ytdlpPromise = (async () => {
    const asset = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : process.arch === 'x64' ? 'yt-dlp_linux' : null;
    if (!asset) throw new Error(`Không tự cài yt-dlp cho kiến trúc ${process.arch}; đặt YTDLP_PATH trỏ tới binary yt-dlp.`);
    fs.mkdirSync(path.dirname(LOCAL_YTDLP), { recursive: true });
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
    let response;
    try { response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(45000) }); }
    catch (e) { throw new Error(`yt-dlp chưa cài và không tải được binary: ${e.message}. Hãy tải yt-dlp Linux rồi đặt tại ${LOCAL_YTDLP} hoặc cấu hình YTDLP_PATH.`); }
    if (!response.ok) throw new Error(`Tải yt-dlp thất bại (HTTP ${response.status}). Đặt binary tại ${LOCAL_YTDLP} hoặc cấu hình YTDLP_PATH.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1000000) throw new Error('File yt-dlp tải về không hợp lệ; kiểm tra quyền mạng của host.');
    fs.writeFileSync(LOCAL_YTDLP, bytes, { mode: 0o755 });
    try { fs.chmodSync(LOCAL_YTDLP, 0o755); } catch { /* xử lý lỗi spawn ở caller */ }
    console.log(`[music] yt-dlp đã sẵn sàng: ${LOCAL_YTDLP}`);
    return LOCAL_YTDLP;
  })().catch((e) => { ytdlpPromise = null; throw e; });
  return ytdlpPromise;
}

import { createAudioResource, AudioPlayerStatus, StreamType } from '@discordjs/voice';
import { cfg } from './config.js';

// cookies YouTube (tùy chọn) để tránh bị chặn IP datacenter
let cookiesPath = null;
try {
  const raw = process.env.YT_COOKIES_B64
    ? Buffer.from(process.env.YT_COOKIES_B64, 'base64').toString('utf8')
    : process.env.YT_COOKIES || '';
  if (raw.trim()) {
    cookiesPath = '/tmp/yt-cookies.txt';
    fs.writeFileSync(cookiesPath, raw);
  }
} catch (e) { console.error('[music] cookies lỗi:', e.message); }

const baseArgs = [...cfg.ytdlpArgs, ...(cookiesPath ? ['--cookies', cookiesPath] : []), '--no-warnings'];

function commandFor(bin, args) {
  const match = /^(python3|python) -m yt_dlp$/.exec(bin);
  return match ? { bin: match[1], args: ['-m', 'yt_dlp', ...args] } : { bin, args };
}

async function run(args, timeout = 30000) {
  const bin = await ytDlpPath();
  try {
    const cmd = commandFor(bin, args);
    const { stdout } = await execFileAsync(cmd.bin, cmd.args, { timeout, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const last = String(err.stderr || err.message || 'yt-dlp lỗi').split('\n').filter(Boolean).pop() || 'yt-dlp lỗi';
    throw new Error(last.slice(0, 250));
  }
}

export const fmt = (sec) => {
  sec = Math.round(Number(sec) || 0);
  if (!sec) return '?';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
};

export async function search(q, n = 5) {
  const out = await run([...baseArgs, '--flat-playlist', '--dump-json', `ytsearch${n}:${q}`]);
  return out.trim().split('\n').filter(Boolean).map((l) => {
    try {
      const j = JSON.parse(l);
      return {
        title: j.title,
        url: String(j.url || '').startsWith('http') ? j.url : `https://www.youtube.com/watch?v=${j.id}`,
        duration: j.duration,
        by: j.channel || j.uploader || '',
      };
    } catch { return null; }
  }).filter(Boolean);
}

export async function resolve(q) {
  if (/^https?:\/\//i.test(q)) {
    const out = await run([...baseArgs, '--no-playlist', '--print', '%(title)s\t%(duration)s', q]);
    const [title, dur] = out.trim().split('\n')[0].split('\t');
    return [{ title: title || q, url: q, duration: Number(dur) || 0 }];
  }
  return search(q, 1);
}

function killProc(s) {
  if (s.proc) {
    const p = s.proc;
    s.proc = null;
    try { p.kill('SIGKILL'); } catch { /* đã chết */ }
    // host có thể từ chối kill (EACCES): đóng pipe để yt-dlp/ffmpeg tự thoát (EPIPE), tránh rò rỉ RAM
    try { p.stdout?.destroy(); p.stderr?.destroy(); } catch { /* bỏ qua */ }
  }
}

export function attach(s) {
  s.musicPlayer.on('stateChange', (o, n) => {
    if (n.status === AudioPlayerStatus.Idle && o.status !== AudioPlayerStatus.Idle) onEnd(s);
  });
  s.musicPlayer.on('error', (e) => console.error('[music] player:', e.message));
}

function onEnd(s) {
  killProc(s);
  const ended = s.current;
  s.current = null;
  if (s.stopping) { s.stopping = false; return; }
  if (s.skipFlag) s.skipFlag = false;
  else if (ended) {
    if (s.loop === 'track') s.queue.unshift(ended);
    else if (s.loop === 'queue') s.queue.push(ended);
  }
  playNext(s);
}

async function playNext(s) {
  const t = s.queue.shift();
  if (!t) { s.current = null; return; }
  s.current = t;
  try {
    const bin = await ytDlpPath();
    if (s.current !== t) return;
    const args = [...baseArgs, '-f', 'bestaudio/best', '--no-playlist', '-q', '-o', '-', t.url];
    const cmd = commandFor(bin, args);
    const proc = spawn(cmd.bin, cmd.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    s.proc = proc;
    let errTxt = '';
    proc.stderr.on('data', (d) => { errTxt = (errTxt + d.toString()).slice(-2000); });
    proc.stdout.on('error', () => {});
    proc.on('error', (err) => {
      console.error('[yt-dlp spawn]', err.message);
      if (s.current === t) {
        const hint = err.code === 'EACCES'
        ? ' Host từ chối chạy binary. Đã thử chmod; nếu vẫn lỗi, cài gói Python yt-dlp trong môi trường host hoặc yêu cầu host bật quyền thực thi.'
        : ' Kiểm tra YTDLP_PATH/quyền chạy binary.';
      s.textChannel?.send(`⚠️ Không khởi chạy được yt-dlp (${err.code || 'lỗi'}): ${err.message}.${hint}`).catch(() => {});
        s.current = null;
        playNext(s);
      }
    });
    proc.on('close', (code) => {
      if (code && s.proc === proc) {
        console.error('[yt-dlp]', errTxt.slice(-400));
        const hint = /sign in|bot/i.test(errTxt) ? ' (YouTube chặn IP server — cần YT_COOKIES_B64)' : '';
        s.textChannel?.send(`⚠️ Không phát được **${t.title}**${hint}: ${errTxt.trim().split('\n').filter(Boolean).pop() || `yt-dlp exit ${code}`}`.slice(0, 1900)).catch(() => {});
      }
    });
    const res = createAudioResource(proc.stdout, { inputType: StreamType.Arbitrary, inlineVolume: true });
    res.volume.setVolume(s.volume);
    s.resource = res;
    s.musicPlayer.play(res);
    s.textChannel?.send(`🎶 Đang phát: **${t.title}** (${fmt(t.duration)}) — ${t.requester || '?'}`).catch(() => {});
  } catch (e) {
    console.error('[music]', e.message || e);
    s.textChannel?.send(`⚠️ Tính năng nhạc: ${String(e.message || e).slice(0, 350)}`).catch(() => {});
    s.current = null;
    playNext(s);
  }
}

export function enqueue(s, track) {
  s.queue.push(track);
  if (!s.current) { playNext(s); return 0; }
  return s.queue.length;
}

export function skip(s) {
  if (!s.current) return false;
  s.skipFlag = true;
  s.musicPlayer.stop(true);
  return true;
}

export function stop(s) {
  s.queue = [];
  if (s.current) {
    s.stopping = true;
    s.musicPlayer.stop(true);
  }
}

export const pause = (s) => s.musicPlayer.pause(true);
export const resume = (s) => s.musicPlayer.unpause();

export function setVolume(s, level) {
  s.volume = Math.max(0.01, Math.min(1, level / 100));
  s.resource?.volume?.setVolume(s.volume);
}

export function queueText(s) {
  if (!s.current && !s.queue.length) return 'Hàng chờ trống, chưa phát gì.';
  const lines = [];
  if (s.current) lines.push(`Đang phát: ${s.current.title} (${fmt(s.current.duration)})`);
  s.queue.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.title} (${fmt(t.duration)})`));
  if (s.queue.length > 10) lines.push(`... và ${s.queue.length - 10} bài nữa`);
  lines.push(`Lặp: ${s.loop} | Âm lượng: ${Math.round(s.volume * 100)}`);
  return lines.join('\n');
}

export function cleanup(s) {
  killProc(s);
  s.queue = [];
  s.current = null;
  try { s.musicPlayer.stop(true); } catch { /* bỏ qua */ }
}
