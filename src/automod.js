import { PermissionFlagsBits } from 'discord.js';

const spamLog = new Map();
const INVITE = /(discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/i;

// trả về true nếu đã xử lý (xóa tin) -> index.js bỏ qua tin này
export async function automod(message, member, g) {
  const a = g.automod;
  if (!a || (!a.spam && !a.invites && !a.mentions)) return false;
  if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return false;

  const say = (t) => message.channel.send({ content: t, allowedMentions: { users: [member.id] } }).catch(() => {});

  if (a.invites && INVITE.test(message.content)) {
    await message.delete().catch(() => {});
    say(`${member} quảng cáo server ở đây hả? Xóa rồi đó.`);
    return true;
  }

  if (a.mentions && message.mentions.users.size >= 6) {
    await message.delete().catch(() => {});
    if (member.moderatable) await member.timeout(10 * 60 * 1000, 'automod: mention hàng loạt').catch(() => {});
    say(`${member} tag cả làng làm gì? Im 10 phút cho tỉnh.`);
    return true;
  }

  if (a.spam) {
    const key = `${message.guild.id}:${member.id}`;
    const now = Date.now();
    const rec = (spamLog.get(key) || []).filter((t) => now - t < 6000);
    rec.push(now);
    spamLog.set(key, rec);
    if (rec.length >= 7) {
      spamLog.set(key, []);
      await message.delete().catch(() => {});
      if (member.moderatable) await member.timeout(5 * 60 * 1000, 'automod: spam').catch(() => {});
      say(`${member} spam ít thôi, câm 5 phút.`);
      return true;
    }
  }
  return false;
}
