import http from 'node:http';
import { execFile } from 'node:child_process';
import { Client, GatewayIntentBits, ActivityType } from 'discord.js';
import { cfg } from './config.js';
import { getGuild, saveGuild } from './store.js';
import { norm, checkAdmin, splitMessage } from './util.js';
import { respond, quickSay } from './brain.js';
import { automod } from './automod.js';
import * as voice from './voice.js';
import { sttSelfTest } from './stt.js';

if (!cfg.token || !cfg.aiKey) {
  console.error('❌ Thiếu DISCORD_TOKEN hoặc MOTAPIS_API_KEY (có thể dùng AI_API_KEY tương thích ngược).');
  process.exit(1);
}

// Render (Web Service) cần một cổng HTTP đang mở. UptimeRobot có thể ping vào đây để bot không ngủ.
http.createServer((_req, res) => { res.writeHead(200); res.end('bot ok'); }).listen(process.env.PORT || 3000);

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,       // privileged: bật trong Developer Portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,     // privileged: bật trong Developer Portal
    GatewayIntentBits.GuildVoiceStates,
  ],
});

/* ---------- tiện ích ---------- */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameRes = cfg.botNames
  .map(norm)
  .filter(Boolean)
  .map((n) => new RegExp(`(^|\\s)${esc(n)}(?=\\s|$|[,.!?])`));

const stamps = new Map();
function cooldown(key, ms) {
  const now = Date.now();
  if (now - (stamps.get(key) || 0) < ms) return false;
  stamps.set(key, now);
  return true;
}

const chains = new Map();
function enqueue(key, fn) {
  const p = (chains.get(key) || Promise.resolve()).then(fn).catch((e) => console.error('[queue]', e));
  chains.set(key, p);
  p.finally(() => { if (chains.get(key) === p) chains.delete(key); });
  return p;
}

async function sendReply(message, text) {
  const parts = splitMessage(text || '...');
  for (let i = 0; i < parts.length; i++) {
    const opts = { content: parts[i], allowedMentions: { parse: ['users'], repliedUser: false } };
    try {
      if (i === 0) await message.reply(opts);
      else await message.channel.send(opts);
    } catch {
      // tin gốc có thể đã bị xóa (vd: lệnh purge) -> gửi thẳng vào kênh
      try { await message.channel.send(opts); } catch (e) { console.error('[send]', e.message); }
    }
  }
}

/* ---------- nhận tin nhắn: KHÔNG có lệnh nào, nhắn bình thường ---------- */
client.on('messageCreate', async (message) => {
  try {
    if (!message.guild || message.author.bot || message.webhookId || message.system) return;
    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return;

    const g = getGuild(message.guild.id);
    const isAdmin = checkAdmin(member);
    if (!isAdmin && await automod(message, member, g)) return;

    const ch = message.channel;
    const parentId = ch.isThread?.() ? ch.parentId : ch.id;
    const myId = client.user.id;

    const ref = message.reference?.messageId ? await message.fetchReference().catch(() => null) : null;
    const mentioned = message.mentions.users.has(myId);
    const named = nameRes.some((r) => r.test(norm(message.content)));
    const replied = ref?.author?.id === myId;
    const triggered = mentioned || named || replied;

    const active = g.chatChannels.includes(ch.id) || g.chatChannels.includes(parentId);
    const open = g.chatChannels.length === 0 || isAdmin; // khi đã giới hạn kênh, người thường chỉ nói chuyện trong kênh đó
    if (!(active || (open && triggered))) return;

    if (g.adminOnlyChannels.includes(ch.id) || g.adminOnlyChannels.includes(parentId)) {
      if (!isAdmin) {
        if (triggered && cooldown(`ao:${ch.id}`, 60_000)) {
          await ch.send('Kênh này chỉ admin được nói chuyện với tao, mày qua chỗ khác chơi 😒').catch(() => {});
        }
        return;
      }
    }
    if (!cooldown(`u:${message.author.id}`, 1200)) return;

    let text = message.content.replace(new RegExp(`<@!?${myId}>`, 'g'), '').trim();
    if (!text) text = message.attachments.size ? '(gửi file/ảnh)' : 'chào';
    if (ref && !replied) {
      text = `(đang trả lời tin của ${ref.member?.displayName || ref.author.username}: "${ref.content.slice(0, 150)}") ${text}`;
    }

    enqueue(ch.id, async () => {
      await ch.sendTyping().catch(() => {});
      const ctx = { client, guild: message.guild, member, channel: ch, isAdmin, isVoice: false, session: voice.getSession(message.guild.id) };
      try {
        const reply = await respond(ctx, text);
        await sendReply(message, reply);
      } catch (e) {
        console.error('[respond]', e);
        await message.reply({ content: 'Não tao đơ rồi, lát thử lại đi.', allowedMentions: { repliedUser: false } }).catch(() => {});
      }
    });
  } catch (e) {
    console.error('[messageCreate]', e);
  }
});

/* ---------- chào thành viên mới ---------- */
client.on('guildMemberAdd', async (m) => {
  try {
    const g = getGuild(m.guild.id);
    if (!g.welcomeChannel) return;
    const ch = m.guild.channels.cache.get(g.welcomeChannel);
    if (!ch?.isTextBased()) return;
    let msg = '';
    try {
      msg = await quickSay(m.guild.name, `Thành viên mới vừa vào server: ${m.displayName}. Chào nó 1–2 câu theo tính cách (láo nhưng không xúc phạm nặng).`);
    } catch { /* AI lỗi thì dùng câu mặc định */ }
    await ch.send({ content: `${m} ${msg || 'vào đây làm gì thế? Thôi chào mừng.'}`, allowedMentions: { users: [m.id] } });
  } catch (e) { console.error('[welcome]', e.message); }
});

client.on('voiceStateUpdate', (o, n) => {
  try { voice.onVoiceState(o, n); } catch (e) { console.error('[voiceState]', e.message); }
});

/* ---------- voice realtime: người nói -> STT -> AI (cùng bộ não + tools) -> TTS ---------- */
voice.setVoiceHandler(async (session, member, text, opts) => {
  const ctx = {
    client, guild: session.guild, member, channel: session.voiceChannel,
    isAdmin: checkAdmin(member), isVoice: true, session,
  };
  return respond(ctx, text, opts);
}, client);

/* ---------- ban tạm: tự gỡ khi hết hạn ---------- */
setInterval(() => {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    const g = getGuild(guild.id);
    let changed = false;
    for (const [uid, exp] of Object.entries(g.tempbans)) {
      if (exp <= now) {
        guild.members.unban(uid, 'Hết hạn ban tạm').catch(() => {});
        delete g.tempbans[uid];
        changed = true;
      }
    }
    if (changed) saveGuild();
  }
}, 60_000);

client.once('clientReady', () => {
  console.log(`✅ Đã đăng nhập: ${client.user.tag} | model: ${cfg.model}`);
  client.user.setPresence({ activities: [{ name: 'tụi bây cãi nhau', type: ActivityType.Watching }], status: 'online' });
  // tự kiểm tra voice: Whisper + FFmpeg (kết quả hiện trong log)
  sttSelfTest().then((r) => console.log(r.ok ? '[stt] ✅' : '[stt] ⚠️', r.message));
  execFile(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { timeout: 10000 }, (e, out) => {
    console.log(e ? `[ffmpeg] ⚠️ không chạy được: ${e.code || e.message} (voice/TTS sẽ không phát được)` : `[ffmpeg] ✅ ${String(out).split('\n')[0]}`);
  });
  // cập nhật yt-dlp ngầm (YouTube hay đổi)
  execFile('yt-dlp', ['-U'], { timeout: 60000 }, (e, out) => { if (!e) console.log('[yt-dlp]', String(out).trim().split('\n').pop()); });
});

client.login(cfg.token);
