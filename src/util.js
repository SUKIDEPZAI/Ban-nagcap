import { PermissionFlagsBits } from 'discord.js';
import { cfg } from './config.js';

// bỏ dấu tiếng Việt, hạ chữ thường, gom khoảng trắng – để so khớp tên "mềm"
export const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[-_]+/g, ' ')
    .replace(/^[@#]/, '')
    .replace(/\s+/g, ' ')
    .trim();

export const digits = (s) => (String(s ?? '').match(/\d{15,22}/) || [])[0];

export const isOwnerLike = (m) => m.id === m.guild.ownerId || cfg.adminIds.includes(m.id);
export const checkAdmin = (m) => isOwnerLike(m) || m.permissions.has(PermissionFlagsBits.Administrator);

// Admin ra lệnh phải có role cao hơn đối tượng (member hoặc role), trừ chủ server / ADMIN_IDS
export function outranks(ctx, target) {
  const m = ctx.member;
  if (isOwnerLike(m)) return true;
  const pos = target.roles ? target.roles.highest.position : target.position;
  return m.roles.highest.position > pos;
}

// chọn đúng 1 phần tử khớp tên; nhiều kết quả cùng mức -> báo lỗi để hỏi lại (tránh kick nhầm người)
export function pick(items, q, names) {
  const n = norm(q);
  if (!n) return null;
  const levels = [
    (it) => names(it).some((x) => norm(x) === n),
    (it) => names(it).some((x) => norm(x).startsWith(n)),
    (it) => names(it).some((x) => norm(x).includes(n)),
  ];
  for (const f of levels) {
    const hit = items.filter(f);
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) {
      throw new Error(`Có ${hit.length} kết quả khớp "${q}": ${hit.slice(0, 6).map((h) => names(h)[0]).join(', ')} — nói rõ hơn hoặc dùng ID.`);
    }
  }
  return null;
}

export async function ensureMembers(guild) {
  if (guild.memberCount > 3000) return;
  if (Date.now() - (guild._mf || 0) < 600000) return;
  guild._mf = Date.now();
  await guild.members.fetch({ time: 20000 }).catch(() => {});
}

export async function findMember(guild, q) {
  const id = digits(q);
  if (id) {
    try { return await guild.members.fetch(id); } catch { /* thử theo tên */ }
  }
  await ensureMembers(guild);
  let items = [...guild.members.cache.values()];
  if (guild.memberCount > 3000 && items.length < guild.memberCount) {
    const r = await guild.members.search({ query: String(q).replace(/^@/, ''), limit: 10 }).catch(() => null);
    if (r) items = [...r.values()];
  }
  return pick(items, q, (m) => [m.displayName, m.user.username, m.user.globalName || '']);
}

export function findRole(guild, q) {
  const id = digits(q);
  if (id) return guild.roles.cache.get(id) || null;
  if (norm(q) === 'everyone') return guild.roles.everyone;
  const items = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id);
  return pick(items, q, (r) => [r.name]);
}

export async function findChannel(guild, q, types) {
  await guild.channels.fetch().catch(() => {});
  const id = digits(q);
  if (id) {
    const c = guild.channels.cache.get(id);
    if (c && (!types || types.includes(c.type))) return c;
  }
  const items = [...guild.channels.cache.values()].filter((c) => !types || types.includes(c.type));
  return pick(items, q, (c) => [c.name]);
}

const KEYS = Object.keys(PermissionFlagsBits);
const KMAP = Object.fromEntries(KEYS.map((k) => [k.toLowerCase(), k]));
export function parsePerms(arr) {
  return (arr || []).map((p) => {
    const k = KMAP[String(p).toLowerCase().replace(/[\s_-]/g, '')];
    if (!k) throw new Error(`Quyền không hợp lệ: "${p}"`);
    return k;
  });
}

const COLORS = {
  red: 0xe74c3c, đỏ: 0xe74c3c, do: 0xe74c3c, blue: 0x3498db, xanh: 0x3498db, green: 0x2ecc71, lục: 0x2ecc71,
  yellow: 0xf1c40f, vàng: 0xf1c40f, vang: 0xf1c40f, orange: 0xe67e22, cam: 0xe67e22, purple: 0x9b59b6, tím: 0x9b59b6,
  tim: 0x9b59b6, pink: 0xff69b4, hồng: 0xff69b4, hong: 0xff69b4, black: 0x111111, đen: 0x111111, den: 0x111111,
  white: 0xffffff, trắng: 0xffffff, trang: 0xffffff, gray: 0x95a5a6, xám: 0x95a5a6, xam: 0x95a5a6,
};
export function parseColor(c) {
  if (c === undefined || c === null || c === '') return undefined;
  const s = String(c).trim().toLowerCase();
  if (COLORS[s] !== undefined) return COLORS[s];
  const m = s.match(/^#?([0-9a-f]{6})$/);
  return m ? parseInt(m[1], 16) : undefined;
}

export function splitMessage(text, max = 1900) {
  const out = [];
  let t = String(text ?? '');
  while (t.length > max) {
    let i = t.lastIndexOf('\n', max);
    if (i < max * 0.5) i = t.lastIndexOf(' ', max);
    if (i < max * 0.5) i = max;
    out.push(t.slice(0, i));
    t = t.slice(i).trimStart();
  }
  if (t) out.push(t);
  return out;
}
