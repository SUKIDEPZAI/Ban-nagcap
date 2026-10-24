import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.DATA_DIR || './data';
fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, 'guilds.json');

let db = {};
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { db = {}; }

let timer = null;
export function saveGuild() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(db, null, 1)); } catch (e) { console.error('[store]', e.message); }
  }, 500);
}

const DEFAULTS = () => ({
  chatChannels: [],        // bot tự trả lời mọi tin trong các kênh này (rỗng = chỉ khi được gọi)
  adminOnlyChannels: [],   // kênh chỉ admin được nói chuyện với bot
  voice: 'nu',             // giọng đọc mặc định
  voiceWake: false,        // true = trong voice chỉ trả lời khi gọi tên
  voiceChannelId: null,    // chỉ được nghe/nói realtime trong kênh voice đã khóa; null = không khóa
  logChannel: null,
  welcomeChannel: null,
  automod: { spam: false, invites: false, mentions: false },
  warns: {},               // userId -> [{reason, by, at}]
  tempbans: {},            // userId -> timestamp hết hạn
  lockdown: [],            // kênh đã bị khóa bởi lockdown
});

export function getGuild(id) {
  if (!db[id]) db[id] = DEFAULTS();
  const d = DEFAULTS();
  for (const k of Object.keys(d)) if (db[id][k] === undefined) db[id][k] = d[k];
  return db[id];
}
