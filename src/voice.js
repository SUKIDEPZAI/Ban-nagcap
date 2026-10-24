import { spawn } from 'node:child_process';
import {
  joinVoiceChannel, entersState, VoiceConnectionStatus, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, EndBehaviorType, NoSubscriberBehavior, StreamType,
} from '@discordjs/voice';
import prism from 'prism-media';
import { cfg } from './config.js';
import { getGuild } from './store.js';
import { norm } from './util.js';
import { synthesize, cleanForTTS, splitSentences } from './tts.js';
import { HALLUCINATIONS, rms, toWav16kMono } from './audio.js';
import { transcribe, sttEnabled } from './stt.js';
import * as music from './music.js';

const sessions = new Map();
let handler = null;
let clientRef = null;

export const setVoiceHandler = (fn, client) => { handler = fn; clientRef = client; };
export const getSession = (guildId) => sessions.get(guildId);

const GREETINGS = [
  'Vào rồi nè, nói gì thì nói đi.',
  'Tao tới rồi, đứa nào gọi tao đó?',
  'Có mặt. Nói nhanh nhanh còn đi ngủ.',
];

export async function joinVoice(channel, textChannel) {
  const guild = channel.guild;
  const guildSettings = getGuild(guild.id);
  if (guildSettings.voiceChannelId && guildSettings.voiceChannelId !== channel.id) {
    throw new Error(`Kênh voice đã khóa: chỉ được vào <#${guildSettings.voiceChannelId}>. Gỡ khóa bằng set_voice_channel channel=none.`);
  }
  const old = sessions.get(guild.id);
  if (old && old.voiceChannel.id === channel.id) {
    if (textChannel) old.textChannel = textChannel;
    return old;
  }
  if (old) destroySession(guild.id);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // phải nghe được người nói
    selfMute: false,
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch {
    try { connection.destroy(); } catch { /* bỏ qua */ }
    throw new Error('Không vào được voice (kiểm tra quyền Connect/Speak, hoặc host chặn UDP).');
  }

  const musicPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  const ttsPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  connection.subscribe(musicPlayer);

  const s = {
    guild, connection, voiceChannel: channel, textChannel,
    musicPlayer, ttsPlayer,
    queue: [], current: null, loop: 'off', volume: 0.5, proc: null, resource: null,
    listening: new Set(), speaking: false, speakCount: 0, epoch: 0, turnActive: false, abort: null,
    bargeTimers: new Map(), lastWarn: 0, pending: 0,
    chain: Promise.resolve(), speakChain: Promise.resolve(),
    addressed: new Map(), aloneTimer: null,
  };
  music.attach(s);
  attachListener(s);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroySession(guild.id);
    }
  });

  sessions.set(guild.id, s);
  if (sttEnabled()) {
    speak(s, GREETINGS[Math.floor(Math.random() * GREETINGS.length)]).catch(() => {});
  }
  return s;
}

export function destroySession(guildId) {
  const s = sessions.get(guildId);
  if (!s) return;
  sessions.delete(guildId);
  clearTimeout(s.aloneTimer);
  music.cleanup(s);
  s.epoch++;
  try { s.abort?.abort(); } catch { /* bỏ qua */ }
  for (const b of s.bargeTimers.values()) clearTimeout(b.timer);
  try { s.ttsPlayer.stop(true); } catch { /* bỏ qua */ }
  try { if (s.connection.state.status !== VoiceConnectionStatus.Destroyed) s.connection.destroy(); } catch { /* bỏ qua */ }
}

/* ---------------- NÓI (TTS) ---------------- */

// giới hạn tần suất cảnh báo lên kênh text (tránh spam khi TTS/STT hỏng)
function warn(s, msg) {
  const now = Date.now();
  if (now - (s.lastWarn || 0) < 30_000) return;
  s.lastWarn = now;
  s.textChannel?.send(`⚠️ ${String(msg).slice(0, 250)}`).catch(() => {});
}

// Phát 1 buffer âm thanh (MP3...) qua ffmpeg -> PCM -> ttsPlayer. `fx` là bộ lọc -af tùy chọn.
function playBuf(s, buf, fx) {
  return new Promise((resolve, reject) => {
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0'];
    if (fx) args.push('-af', fx);
    args.push('-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');
    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const startEpoch = s.epoch;
    let stderr = '';
    let settled = false;
    let finished = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.ttsPlayer.off('stateChange', onState);
      s.ttsPlayer.off('error', onPlayerError);
      proc.off('error', onProcError);
      proc.off('close', onClose);
      try { proc.kill('SIGKILL'); } catch { /* đã thoát */ }
      if (error) reject(error); else resolve();
    };
    const onState = (_old, next) => {
      if (next.status !== AudioPlayerStatus.Idle) return;
      // Idle khi ffmpeg đã xong, HOẶC khi bị ngắt (nói chen) -> không chờ ffmpeg nữa (tránh treo 30s)
      if (finished || s.epoch !== startEpoch) finish();
    };
    const onPlayerError = (error) => finish(error);
    const onProcError = (error) => finish(new Error(`Không chạy được FFmpeg (${ffmpeg}): ${error.message}`));
    const onClose = (code) => {
      finished = true;
      if (s.epoch !== startEpoch) return finish();
      if (code !== 0) finish(new Error(`FFmpeg chuyển giọng đọc thất bại: ${stderr.trim().slice(-250) || `exit ${code}`}`));
      else if (s.ttsPlayer.state.status === AudioPlayerStatus.Idle) finish();
    };
    const timer = setTimeout(() => finish(new Error('Phát giọng đọc quá thời gian 30 giây.')), 30000);
    proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-1000); });
    proc.stdin.on('error', () => { /* EPIPE khi ffmpeg thoát sớm: lỗi thật đã được báo qua 'close' */ });
    s.ttsPlayer.on('stateChange', onState);
    s.ttsPlayer.once('error', onPlayerError);
    proc.once('error', onProcError);
    proc.once('close', onClose);
    try {
      const resource = createAudioResource(proc.stdout, { inputType: StreamType.Raw });
      s.connection.subscribe(s.ttsPlayer);
      s.ttsPlayer.play(resource);
      proc.stdin.end(buf);
    } catch (error) {
      finish(error);
    }
  });
}

async function doSpeak(s, text, voiceKey, epoch) {
  if (s.epoch !== epoch) return; // lượt này đã bị nói chen hủy
  const key = voiceKey || getGuild(s.guild.id).voice;
  const parts = splitSentences(cleanForTTS(text));
  if (!parts.length) return;
  const synth = (t) => synthesize(t, key).catch((e) => {
    console.error('[tts]', e?.stack || e);
    warn(s, `TTS lỗi: ${e?.message || e || 'lỗi không rõ'}`);
    return null;
  });
  // tổng hợp câu kế tiếp trong khi đang phát câu này
  let next = synth(parts[0]);
  for (let i = 0; i < parts.length; i++) {
    const r = await next;
    if (i + 1 < parts.length) next = synth(parts[i + 1]);
    if (s.epoch !== epoch) break;
    if (!r) continue;
    await playBuf(s, r.buf, r.fx);
    if (s.epoch !== epoch) break;
  }
}

// `epoch`: chỉ nói nếu chưa có ai nói chen kể từ lúc đó (mặc định: epoch hiện tại)
export function speak(s, text, voiceKey, epoch = s.epoch) {
  s.speakCount++;
  s.speaking = true;
  s.speakChain = s.speakChain
    .then(() => doSpeak(s, text, voiceKey, epoch))
    .catch((e) => {
      console.error('[speak]', e.message);
      warn(s, `Không phát được giọng đọc: ${e.message || e}`);
    })
    .finally(() => {
      // chỉ trả lại player nhạc khi hàng đợi nói đã rỗng (không nhả nhạc giữa các câu)
      if (--s.speakCount <= 0) {
        s.speakCount = 0;
        s.speaking = false;
        try { s.connection.subscribe(s.musicPlayer); } catch { /* connection đã hủy */ }
      }
    });
  return s.speakChain;
}

// Ngắt lượt hiện tại: hủy các câu chưa nói, dừng player, hủy luôn yêu cầu AI đang chạy
export function interrupt(s) {
  s.epoch++;
  try { s.abort?.abort(); } catch { /* bỏ qua */ }
  if (s.speaking) { try { s.ttsPlayer.stop(true); } catch { /* bỏ qua */ } }
}

/* ---------------- NGHE (STT) ---------------- */

function passWake(s, member, text, g) {
  if (!g.voiceWake) return true;
  const n = norm(text);
  const hit = cfg.botNames.some((b) => n.includes(norm(b)));
  const last = s.addressed.get(member.id) || 0;
  if (hit || Date.now() - last < 25000) {
    s.addressed.set(member.id, Date.now());
    return true;
  }
  return false;
}

function attachListener(s) {
  const receiver = s.connection.receiver;

  // Nói chen: chỉ ngắt khi người đó nói LIÊN TỤC >= bargeMs (bỏ qua tiếng ho/tiếng ồn ngắn)
  receiver.speaking.on('start', (userId) => {
    const user = clientRef?.users.cache.get(userId);
    if (user?.bot) return;
    if (s.speaking && !s.bargeTimers.has(userId)) {
      s.bargeTimers.set(userId, {
        at: Date.now(),
        timer: setTimeout(() => {
          s.bargeTimers.delete(userId);
          if (s.speaking) interrupt(s); // chỉ ngắt khi bot đang phát tiếng; AI đang nghĩ thì để nó trả lời xong
        }, cfg.bargeMs),
      });
    }
    if (s.listening.has(userId)) return;
    s.listening.add(userId);

    const opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: cfg.silenceMs } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks = [];
    let bytes = 0;
    const MAX_BYTES = 48000 * 4 * cfg.maxUtterSecs; // giới hạn độ dài 1 câu (mặc định 20s)

    decoder.on('data', (c) => {
      bytes += c.length;
      if (bytes <= MAX_BYTES) chunks.push(c);
    });
    const finish = () => {
      if (!s.listening.has(userId)) return;
      s.listening.delete(userId);
      handleUtterance(s, userId, Buffer.concat(chunks));
    };
    decoder.on('end', finish);
    decoder.on('error', () => { try { opusStream.destroy(); } catch { /* bỏ qua */ } finish(); });
    opusStream.on('error', () => finish());
    opusStream.pipe(decoder);
  });

  // tiếng động rất ngắn (<200ms) -> hủy hẹn giờ ngắt
  receiver.speaking.on('end', (userId) => {
    const b = s.bargeTimers.get(userId);
    if (b && Date.now() - b.at < 200) { clearTimeout(b.timer); s.bargeTimers.delete(userId); }
  });
}

function handleUtterance(s, userId, pcm) {
  const secs = pcm.length / (48000 * 4);
  if (secs < cfg.minSecs || rms(pcm) < cfg.minRms) return; // quá ngắn / chỉ là tiếng ồn
  if (s.pending >= 2) { console.warn('[voice] hàng đợi đầy, bỏ 1 câu nói'); return; }
  s.pending++;
  const queuedAt = Date.now();
  s.chain = s.chain.then(async () => {
    const ac = new AbortController();
    try {
      if (Date.now() - queuedAt > 30_000) { console.warn('[voice] bỏ câu nói quá cũ (xử lý chậm)'); return; }
      const lock = () => { const l = getGuild(s.guild.id).voiceChannelId; return !l || s.voiceChannel.id === l; };
      if (!lock()) return;
      const text = (await transcribe(toWav16kMono(pcm))).trim(); // rỗng = im lặng/tiếng ồn, không phải lỗi
      if (text.length < 2 || HALLUCINATIONS.test(text)) return;
      const member = s.guild.members.cache.get(userId) || await s.guild.members.fetch(userId).catch(() => null);
      if (!member) return;
      if (!passWake(s, member, text, getGuild(s.guild.id))) return;
      console.log(`[voice] ${member.displayName}: ${text}`);
      if (!handler) return;

      const epoch = s.epoch;
      let streamed = 0;
      s.turnActive = true;
      s.abort = ac;
      let reply;
      try {
        // bot nói từng câu ngay khi AI viết xong (không chờ cả đoạn)
        reply = await handler(s, member, text, {
          signal: ac.signal,
          onSentence: (sentence) => {
            if (s.epoch !== epoch) return;
            if (!lock()) return;
            streamed++;
            console.log(`[voice] bot → ${sentence}`);
            speak(s, sentence, undefined, epoch);
          },
        });
      } finally {
        s.turnActive = false;
        if (s.abort === ac) s.abort = null;
      }
      if (s.epoch !== epoch) { console.warn('[voice] lượt trả lời bị hủy vì có người nói chen khi bot đang nói.'); return; }
      if (!streamed) {
        if (!lock()) { console.warn('[voice] không nói vì kênh voice đang bị khóa sang kênh khác.'); return; }
        if (reply) { console.log(`[voice] bot → ${reply}`); await speak(s, reply, undefined, epoch); }
        else {
          // AI không trả chữ nào (vd model suy nghĩ hết ngân sách token): vẫn phải có tiếng để người dùng biết bot đã nghe
          console.warn('[voice] AI trả về rỗng cho lượt này.');
          await speak(s, 'Tao nghe rồi nhưng não đơ, nói lại đi.', undefined, epoch);
        }
      } else {
        await s.speakChain; // giữ đúng thứ tự: nói xong mới xử lý câu kế
      }
    } catch (e) {
      if (ac.signal.aborted) return; // bị nói chen hủy giữa chừng
      console.error('[voice]', e.stack || e.message);
      warn(s, `Voice gặp lỗi: ${e.message || e}`);
      if (/AI|API|Connection|timeout|fetch|\b[45]\d\d\b/i.test(String(e.message))) speak(s, 'Não tao đơ rồi, lát thử lại đi.').catch(() => {});
    } finally {
      s.pending--;
    }
  });
}

/* ---------------- SỰ KIỆN VOICE ---------------- */

export function onVoiceState(oldState, newState) {
  const guild = newState.guild || oldState.guild;
  const s = sessions.get(guild.id);
  if (!s) return;

  // bot bị kéo sang kênh khác / bị đá khỏi voice
  if (newState.id === clientRef?.user?.id) {
    if (!newState.channelId) { destroySession(guild.id); return; }
    if (newState.channelId !== s.voiceChannel.id) s.voiceChannel = newState.channel;
  }

  const humans = s.voiceChannel.members.filter((m) => !m.user.bot).size;
  if (humans === 0) {
    if (!s.aloneTimer) {
      s.aloneTimer = setTimeout(() => {
        if (sessions.get(guild.id) !== s) return;
        s.textChannel?.send('Đứa nào cũng bỏ đi hết, tao cũng biến 🙄').catch(() => {});
        destroySession(guild.id);
      }, 45_000);
    }
  } else if (s.aloneTimer) {
    clearTimeout(s.aloneTimer);
    s.aloneTimer = null;
  }
}
