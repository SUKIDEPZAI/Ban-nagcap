import { ChannelType, PermissionsBitField, EmbedBuilder } from 'discord.js';
import { cfg } from './config.js';
import { getGuild, saveGuild } from './store.js';
import * as voice from './voice.js';
import * as music from './music.js';
import { VOICES } from './tts.js';
import { webSearch } from './websearch.js';
import {
  norm, digits, isOwnerLike, outranks, pick, ensureMembers,
  findMember, findRole, findChannel, parsePerms, parseColor,
} from './util.js';

const CT = ChannelType;
const TEXTISH = [CT.GuildText, CT.GuildAnnouncement];
const VOICEISH = [CT.GuildVoice, CT.GuildStageVoice];

/* ---------- helpers schema ---------- */
const T = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const S = (description = '') => ({ type: 'string', description });
const N = (description = '') => ({ type: 'number', description });
const B = (description = '') => ({ type: 'boolean', description });
const A = (description = '') => ({ type: 'array', items: { type: 'string' }, description });
const E = (values, description = '') => ({ type: 'string', enum: values, description });

const VOICE_DESC = Object.entries(VOICES).map(([k, v]) => `${k}=${v.label}`).join('; ');
const VOICE_KEYS = Object.keys(VOICES);

/* ---------- tools cho MỌI NGƯỜI ---------- */
const PUBLIC = [
  T('play_music', 'Phát nhạc: tìm trên YouTube theo tên bài/ca sĩ hoặc link, thêm vào hàng chờ. Tự vào voice của người dùng nếu bot chưa vào.', { query: S('tên bài, ca sĩ hoặc link YouTube') }, ['query']),
  T('search_music', 'Tìm nhạc trên YouTube, trả về 5 kết quả (chưa phát).', { query: S('từ khóa') }, ['query']),
  T('skip_music', 'Bỏ qua bài đang phát'),
  T('stop_music', 'Dừng nhạc và xóa hàng chờ'),
  T('pause_music', 'Tạm dừng nhạc'),
  T('resume_music', 'Phát tiếp nhạc đang tạm dừng'),
  T('show_queue', 'Xem bài đang phát và hàng chờ'),
  T('set_volume', 'Chỉnh âm lượng nhạc (1-100)', { level: N('1-100') }, ['level']),
  T('loop_music', 'Lặp nhạc', { mode: E(['off', 'track', 'queue'], 'off=tắt, track=lặp bài hiện tại, queue=lặp cả hàng chờ') }, ['mode']),
  T('join_voice', 'Vào kênh voice để nghe và nói chuyện realtime.', { channel: S('tên/ID kênh voice; bỏ trống = kênh người dùng đang ở') }),
  T('leave_voice', 'Rời kênh voice'),
  T('set_voice', 'Đổi giọng nói mặc định của bot trong voice (lưu cho cả server). ' + VOICE_DESC, { voice: E(VOICE_KEYS) }, ['voice']),
  T('say_in_voice', 'Nói một câu trong voice bằng giọng chỉ định (không đổi giọng mặc định). ' + VOICE_DESC, { text: S('nội dung cần nói'), voice: E(VOICE_KEYS) }, ['text']),
  T('web_search', 'Tìm thông tin trên web (tin tức, kiến thức mới, thời tiết...).', { query: S('từ khóa') }, ['query']),
  T('user_info', 'Xem thông tin một thành viên', { member: S('tên/mention/ID; bỏ trống = chính người hỏi') }),
  T('server_info', 'Xem thông tin server'),
];

/* ---------- tools chỉ ADMIN ---------- */
const ADMIN = [
  T('list_roles', 'Liệt kê role của server'),
  T('list_channels', 'Liệt kê kênh của server theo danh mục'),
  T('list_members', 'Tìm/liệt kê thành viên theo tên hoặc role', { query: S('một phần tên'), role: S('tên/ID role'), limit: N('tối đa, mặc định 25') }),
  T('create_role', 'Tạo role mới', { name: S(), color: S('hex #ff0000 hoặc tên màu'), permissions: A('tên quyền kiểu PermissionFlagsBits: SendMessages, ManageMessages, KickMembers, MuteMembers...'), hoist: B('hiển thị tách riêng'), mentionable: B() }, ['name']),
  T('edit_role', 'Sửa role (tên, màu, thêm/bớt quyền...)', { role: S('tên/ID'), name: S(), color: S(), add_permissions: A(), remove_permissions: A(), hoist: B(), mentionable: B() }, ['role']),
  T('delete_role', 'Xóa role', { role: S('tên/ID') }, ['role']),
  T('manage_member_roles', 'Gán hoặc gỡ role cho một hoặc nhiều thành viên', { members: A('tên/mention/ID'), role: S(), action: E(['add', 'remove']) }, ['members', 'role', 'action']),
  T('create_channel', 'Tạo kênh/danh mục mới', {
    name: S(), type: E(['text', 'voice', 'category', 'announcement', 'forum', 'stage']), category: S('tên danh mục cha'), topic: S(),
    private: B('true = ẩn với mọi người, chỉ allowed_roles + admin thấy'), allowed_roles: A('role được thấy khi private'), slowmode: N('giây'), nsfw: B(),
  }, ['name']),
  T('delete_channel', 'Xóa một hoặc nhiều kênh', { channels: A('tên/ID kênh') }, ['channels']),
  T('edit_channel', 'Sửa kênh: đổi tên, topic, slowmode, nsfw, giới hạn người (voice), chuyển danh mục', { channel: S('mặc định kênh hiện tại'), name: S(), topic: S(), slowmode: N('giây, 0 = tắt'), nsfw: B(), user_limit: N(), category: S() }),
  T('clone_channel', 'Nhân bản kênh (giữ quyền)', { channel: S(), name: S('tên mới') }, ['channel']),
  T('channel_access', 'Khóa/mở khóa chat (lock/unlock) hoặc ẩn/hiện (hide/show) một kênh với một role', { channel: S('mặc định kênh hiện tại'), mode: E(['lock', 'unlock', 'hide', 'show']), role: S('mặc định @everyone') }, ['mode']),
  T('set_channel_permission', 'Chỉnh quyền riêng của role/thành viên trong một kênh', { channel: S(), target: S('role hoặc thành viên'), allow: A('quyền cho phép'), deny: A('quyền cấm'), reset: A('quyền trả về mặc định') }, ['channel', 'target']),
  T('timeout_member', 'Mute chat (timeout) thành viên; minutes=0 để gỡ', { members: A(), minutes: N('1-40320; 0 = gỡ'), reason: S() }, ['members', 'minutes']),
  T('kick_member', 'Kick thành viên', { members: A(), reason: S() }, ['members']),
  T('ban_member', 'Ban thành viên (có thể là ID người đã rời); minutes>0 = ban tạm', { members: A(), reason: S(), delete_message_hours: N('xóa tin nhắn trong N giờ qua'), minutes: N('ban tạm, tự gỡ sau N phút') }, ['members']),
  T('unban_member', 'Gỡ ban', { user: S('ID hoặc username') }, ['user']),
  T('set_nickname', 'Đổi nickname thành viên (rỗng = reset)', { member: S(), nickname: S() }, ['member']),
  T('warn_member', 'Cảnh cáo thành viên. Đủ 3 warn tự timeout 60 phút, đủ 5 warn tự kick.', { member: S(), reason: S() }, ['member']),
  T('list_warns', 'Xem số lần bị cảnh cáo', { member: S() }, ['member']),
  T('clear_warns', 'Xóa cảnh cáo', { member: S() }, ['member']),
  T('voice_control', 'Điều khiển thành viên trong voice', { members: A(), action: E(['mute', 'unmute', 'deafen', 'undeafen', 'disconnect', 'move']), channel: S('kênh đích khi move') }, ['members', 'action']),
  T('purge_messages', 'Xóa hàng loạt tin nhắn gần đây (tối đa 300, không xóa được tin > 14 ngày)', { count: N('số tin cần quét'), member: S('chỉ xóa tin của người này'), channel: S('mặc định kênh hiện tại') }, ['count']),
  T('send_message', 'Gửi tin/thông báo vào một kênh (có thể dạng embed)', { channel: S(), content: S(), embed_title: S('nếu có sẽ gửi dạng embed'), color: S(), ping: E(['none', 'roles', 'everyone']) }, ['content']),
  T('create_invite', 'Tạo link mời', { channel: S(), max_age_minutes: N('0 = vĩnh viễn'), max_uses: N('0 = không giới hạn') }),
  T('lockdown_server', 'Khóa chat toàn bộ kênh text (chống raid) hoặc mở lại', { locked: B('true = khóa, false = mở lại') }, ['locked']),
  T('configure_chat_channels', 'Cấu hình kênh bot được chat: chat_add (bot trả lời mọi tin trong kênh), chat_remove, chat_clear, adminonly_add (kênh chỉ admin nói chuyện với bot), adminonly_remove, adminonly_clear, show', { action: E(['chat_add', 'chat_remove', 'chat_clear', 'adminonly_add', 'adminonly_remove', 'adminonly_clear', 'show']), channel: S('mặc định kênh hiện tại') }, ['action']),
  T('set_log_channel', 'Đặt kênh ghi log hành động quản trị ("none" để tắt)', { channel: S() }, ['channel']),
  T('set_welcome_channel', 'Đặt kênh chào thành viên mới ("none" để tắt)', { channel: S() }, ['channel']),
  T('set_automod', 'Bật/tắt automod: chống spam, link mời discord, mention hàng loạt', { spam: B(), invites: B(), mentions: B() }),
  T('set_voice_listening', 'Voice: wake_word_only=true thì chỉ trả lời khi nghe gọi tên bot; false thì trả lời mọi người nói', { wake_word_only: B() }, ['wake_word_only']),
  T('set_voice_channel', 'Khóa bot chỉ nghe/nói realtime trong một kênh voice. channel=none để gỡ khóa; không ảnh hưởng chat bằng tin nhắn bình thường.', { channel: S('mention/ID/tên kênh voice; dùng none để gỡ khóa') }, ['channel']),
  T('show_bot_settings', 'Xem cấu hình bot của server'),
];

const ADMIN_NAMES = new Set(ADMIN.map((t) => t.function.name));
const READONLY = new Set(['list_roles', 'list_channels', 'list_members', 'list_warns', 'show_bot_settings']);

export const toolsFor = (ctx) => (ctx.isAdmin ? [...PUBLIC, ...ADMIN] : PUBLIC);

/* ---------- helpers thực thi ---------- */
const reason = (ctx) => `Bởi ${ctx.member.user.tag} (qua bot)`;
const must = (v, what, q) => { if (!v) throw new Error(`Không tìm thấy ${what}: "${q}"`); return v; };
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const nameOf = (t) => t.displayName ?? t.name ?? String(t.id);

async function resolveMembers(ctx, q) {
  const arr = list(q);
  if (!arr.length) throw new Error('Thiếu đối tượng (members)');
  const out = [];
  for (const x of arr) out.push(must(await findMember(ctx.guild, x), 'thành viên', x));
  return out;
}

async function each(targets, fn) {
  const lines = [];
  for (const t of targets) {
    try { await fn(t); lines.push(`✅ ${nameOf(t)}`); } catch (e) { lines.push(`❌ ${nameOf(t)}: ${e.message}`); }
  }
  return lines.join('\n');
}

function guardMember(ctx, t) {
  if (t.id === ctx.guild.ownerId) throw new Error('đó là chủ server, không đụng được');
  if (t.id === ctx.client.user.id) throw new Error('không tự làm với chính tao');
  if (!outranks(ctx, t)) throw new Error('role của người này ngang/cao hơn admin ra lệnh');
}

function guardPerms(ctx, keys) {
  if (keys.includes('Administrator') && !isOwnerLike(ctx.member)) {
    throw new Error('chỉ chủ server / ADMIN_IDS mới được cấp quyền Administrator');
  }
}

async function ensureSession(ctx) {
  const s = voice.getSession(ctx.guild.id);
  if (s) {
    if (ctx.channel?.isTextBased?.()) s.textChannel = ctx.channel;
    return s;
  }
  const vc = ctx.member.voice?.channel;
  if (!vc) throw new Error('người dùng chưa ở kênh voice nào và bot cũng chưa vào voice');
  if (!vc.joinable) throw new Error('bot không có quyền vào kênh voice đó');
  return voice.joinVoice(vc, ctx.channel);
}

const needSession = (ctx) => {
  const s = voice.getSession(ctx.guild.id);
  if (!s) throw new Error('bot chưa ở trong voice');
  return s;
};

const defChannel = async (ctx, q, types) =>
  q ? must(await findChannel(ctx.guild, q, types), 'kênh', q) : ctx.channel;

/* ---------- implementations ---------- */
const IMPL = {
  /* ===== nhạc & voice ===== */
  async play_music({ query }, ctx) {
    const s = await ensureSession(ctx);
    const tracks = await music.resolve(query);
    if (!tracks.length) return 'Không tìm thấy bài nào.';
    const t = { ...tracks[0], requester: ctx.member.displayName };
    const pos = music.enqueue(s, t);
    return pos === 0 ? `Bắt đầu phát: ${t.title}` : `Đã thêm vào hàng chờ (vị trí ${pos}): ${t.title}`;
  },
  async search_music({ query }) {
    const r = await music.search(query, 5);
    if (!r.length) return 'Không có kết quả.';
    return r.map((x, i) => `${i + 1}. ${x.title} — ${x.by} (${music.fmt(x.duration)}) ${x.url}`).join('\n');
  },
  async skip_music(_a, ctx) { return music.skip(needSession(ctx)) ? 'Đã skip.' : 'Có phát gì đâu mà skip.'; },
  async stop_music(_a, ctx) { music.stop(needSession(ctx)); return 'Đã dừng nhạc và xóa hàng chờ.'; },
  async pause_music(_a, ctx) { music.pause(needSession(ctx)); return 'Đã tạm dừng.'; },
  async resume_music(_a, ctx) { music.resume(needSession(ctx)); return 'Phát tiếp.'; },
  async show_queue(_a, ctx) { return music.queueText(needSession(ctx)); },
  async set_volume({ level }, ctx) { music.setVolume(needSession(ctx), Number(level)); return `Âm lượng nhạc: ${Math.round(Math.max(1, Math.min(100, level)))}`; },
  async loop_music({ mode }, ctx) {
    if (!['off', 'track', 'queue'].includes(mode)) throw new Error('mode không hợp lệ');
    needSession(ctx).loop = mode;
    return `Chế độ lặp: ${mode}`;
  },
  async join_voice({ channel }, ctx) {
    const vc = channel ? must(await findChannel(ctx.guild, channel, VOICEISH), 'kênh voice', channel) : ctx.member.voice?.channel;
    if (!vc) throw new Error('chưa chỉ định kênh voice và người dùng cũng không ở voice nào');
    if (!vc.joinable) throw new Error('bot không có quyền vào kênh đó');
    await voice.joinVoice(vc, ctx.channel);
    return `Đã vào voice: ${vc.name}`;
  },
  async leave_voice(_a, ctx) { needSession(ctx); voice.destroySession(ctx.guild.id); return 'Đã rời voice.'; },
  async set_voice({ voice: v }, ctx) {
    if (!VOICES[v]) throw new Error('giọng không tồn tại: ' + v);
    getGuild(ctx.guild.id).voice = v;
    saveGuild();
    return `Đã đổi giọng mặc định sang: ${VOICES[v].label}`;
  },
  async say_in_voice({ text, voice: v }, ctx) {
    if (v && !VOICES[v]) throw new Error('giọng không tồn tại: ' + v);
    const s = await ensureSession(ctx);
    voice.speak(s, text, v).catch(() => {});
    return 'Đang nói trong voice.';
  },
  async web_search({ query }) { return webSearch(query); },
  async user_info({ member }, ctx) {
    const m = member ? must(await findMember(ctx.guild, member), 'thành viên', member) : ctx.member;
    const g = getGuild(ctx.guild.id);
    return [
      `Tên: ${m.displayName} (@${m.user.username}) | ID: ${m.id}${m.user.bot ? ' | BOT' : ''}`,
      `Tạo tài khoản: ${m.user.createdAt.toLocaleDateString('vi-VN')} | Vào server: ${m.joinedAt?.toLocaleDateString('vi-VN') ?? '?'}`,
      `Role: ${m.roles.cache.filter((r) => r.id !== ctx.guild.id).map((r) => r.name).join(', ') || 'không có'}`,
      `Voice: ${m.voice?.channel?.name ?? 'không ở voice'} | Timeout: ${m.isCommunicationDisabled() ? 'đang bị' : 'không'} | Cảnh cáo: ${(g.warns[m.id] || []).length}`,
    ].join('\n');
  },
  async server_info(_a, ctx) {
    const g = ctx.guild;
    return `Server: ${g.name} | Thành viên: ${g.memberCount} | Kênh: ${g.channels.cache.size} | Role: ${g.roles.cache.size} | Boost: ${g.premiumSubscriptionCount ?? 0} | Tạo: ${g.createdAt.toLocaleDateString('vi-VN')}`;
  },

  /* ===== liệt kê ===== */
  async list_roles(_a, ctx) {
    await ctx.guild.roles.fetch();
    return [...ctx.guild.roles.cache.values()].filter((r) => r.id !== ctx.guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => `${r.name} (id ${r.id}, ${r.members.size} người${r.managed ? ', của bot' : ''})`).join('\n') || 'Chưa có role.';
  },
  async list_channels(_a, ctx) {
    await ctx.guild.channels.fetch();
    const cats = [...ctx.guild.channels.cache.values()].filter((c) => c.type === CT.GuildCategory).sort((a, b) => a.position - b.position);
    const line = (c) => `  - ${c.name} [${CT[c.type]}] (id ${c.id})`;
    const out = [];
    for (const cat of cats) {
      out.push(`📁 ${cat.name} (id ${cat.id})`);
      [...ctx.guild.channels.cache.values()].filter((c) => c.parentId === cat.id).sort((a, b) => a.position - b.position).forEach((c) => out.push(line(c)));
    }
    const loose = [...ctx.guild.channels.cache.values()].filter((c) => !c.parentId && c.type !== CT.GuildCategory);
    if (loose.length) { out.push('📁 (không danh mục)'); loose.forEach((c) => out.push(line(c))); }
    return out.join('\n');
  },
  async list_members({ query, role, limit }, ctx) {
    await ensureMembers(ctx.guild);
    let arr = [...ctx.guild.members.cache.values()];
    if (role) { const r = must(findRole(ctx.guild, role), 'role', role); arr = arr.filter((m) => m.roles.cache.has(r.id)); }
    if (query) { const n = norm(query); arr = arr.filter((m) => norm(m.displayName).includes(n) || norm(m.user.username).includes(n)); }
    return `${arr.length} người:\n` + arr.slice(0, limit || 25).map((m) => `${m.displayName} (@${m.user.username}, ${m.id})${m.user.bot ? ' [bot]' : ''}`).join('\n');
  },

  /* ===== role ===== */
  async create_role(a, ctx) {
    const perms = parsePerms(a.permissions);
    guardPerms(ctx, perms);
    const role = await ctx.guild.roles.create({
      name: a.name, color: parseColor(a.color), permissions: perms,
      hoist: a.hoist, mentionable: a.mentionable, reason: reason(ctx),
    });
    return `Đã tạo role ${role.name} (id ${role.id})`;
  },
  async edit_role(a, ctx) {
    const role = must(findRole(ctx.guild, a.role), 'role', a.role);
    if (!role.editable) throw new Error('bot không sửa được role này (role cao hơn bot)');
    if (!outranks(ctx, role)) throw new Error('role này ngang/cao hơn admin ra lệnh');
    const upd = { reason: reason(ctx) };
    if (a.name) upd.name = a.name;
    if (a.color !== undefined) upd.color = parseColor(a.color);
    if (a.hoist !== undefined) upd.hoist = a.hoist;
    if (a.mentionable !== undefined) upd.mentionable = a.mentionable;
    if (a.add_permissions || a.remove_permissions) {
      const p = new PermissionsBitField(role.permissions);
      if (a.add_permissions) { const k = parsePerms(a.add_permissions); guardPerms(ctx, k); p.add(k); }
      if (a.remove_permissions) p.remove(parsePerms(a.remove_permissions));
      upd.permissions = p;
    }
    await role.edit(upd);
    return `Đã sửa role ${role.name}`;
  },
  async delete_role({ role }, ctx) {
    const r = must(findRole(ctx.guild, role), 'role', role);
    if (!r.editable) throw new Error('bot không xóa được role này (role cao hơn bot)');
    if (!outranks(ctx, r)) throw new Error('role này ngang/cao hơn admin ra lệnh');
    const n = r.name;
    await r.delete(reason(ctx));
    return `Đã xóa role ${n}`;
  },
  async manage_member_roles({ members, role, action }, ctx) {
    const r = must(findRole(ctx.guild, role), 'role', role);
    if (!r.editable) throw new Error('bot không quản được role này (role cao hơn bot)');
    if (!outranks(ctx, r)) throw new Error('role này ngang/cao hơn admin ra lệnh');
    const targets = await resolveMembers(ctx, members);
    return each(targets, (t) => (action === 'add' ? t.roles.add(r, reason(ctx)) : t.roles.remove(r, reason(ctx))));
  },

  /* ===== kênh ===== */
  async create_channel(a, ctx) {
    const map = { text: CT.GuildText, voice: CT.GuildVoice, category: CT.GuildCategory, announcement: CT.GuildAnnouncement, forum: CT.GuildForum, stage: CT.GuildStageVoice };
    const type = map[a.type || 'text'];
    if (type === undefined) throw new Error('loại kênh không hợp lệ');
    const opts = { name: a.name, type, reason: reason(ctx) };
    if (a.category && type !== CT.GuildCategory) {
      opts.parent = must(await findChannel(ctx.guild, a.category, [CT.GuildCategory]), 'danh mục', a.category).id;
    }
    if (a.topic && [CT.GuildText, CT.GuildAnnouncement, CT.GuildForum].includes(type)) opts.topic = a.topic;
    if (a.slowmode !== undefined && type === CT.GuildText) opts.rateLimitPerUser = a.slowmode;
    if (a.nsfw !== undefined) opts.nsfw = a.nsfw;
    if (a.private) {
      const ids = list(a.allowed_roles).map((q) => must(findRole(ctx.guild, q), 'role', q).id);
      const allow = ['ViewChannel', 'SendMessages', 'Connect', 'Speak', 'ReadMessageHistory'];
      opts.permissionOverwrites = [
        { id: ctx.guild.id, deny: ['ViewChannel'] },
        { id: ctx.client.user.id, allow: [...allow, 'ManageChannels'] },
        { id: ctx.member.id, allow },
        ...ids.map((id) => ({ id, allow })),
      ];
    }
    const ch = await ctx.guild.channels.create(opts);
    return `Đã tạo ${a.type || 'text'}: ${ch.name} (id ${ch.id})`;
  },
  async delete_channel({ channels }, ctx) {
    const out = [];
    for (const q of list(channels)) {
      try {
        const ch = must(await findChannel(ctx.guild, q), 'kênh', q);
        const n = ch.name;
        await ch.delete(reason(ctx));
        out.push(`✅ đã xóa ${n}`);
      } catch (e) { out.push(`❌ ${q}: ${e.message}`); }
    }
    return out.join('\n');
  },
  async edit_channel(a, ctx) {
    const ch = await defChannel(ctx, a.channel);
    const upd = { reason: reason(ctx) };
    if (a.name) upd.name = a.name;
    if (a.topic !== undefined && 'topic' in ch) upd.topic = a.topic;
    if (a.slowmode !== undefined) upd.rateLimitPerUser = Math.max(0, Math.min(21600, a.slowmode));
    if (a.nsfw !== undefined) upd.nsfw = a.nsfw;
    if (a.user_limit !== undefined) upd.userLimit = a.user_limit;
    if (a.category) upd.parent = must(await findChannel(ctx.guild, a.category, [CT.GuildCategory]), 'danh mục', a.category).id;
    await ch.edit(upd);
    return `Đã sửa kênh ${ch.name}`;
  },
  async clone_channel({ channel, name }, ctx) {
    const ch = must(await findChannel(ctx.guild, channel), 'kênh', channel);
    const c = await ch.clone({ name: name || undefined, reason: reason(ctx) });
    return `Đã nhân bản thành ${c.name} (id ${c.id})`;
  },
  async channel_access({ channel, mode, role }, ctx) {
    const ch = await defChannel(ctx, channel);
    const target = role ? must(findRole(ctx.guild, role), 'role', role) : ctx.guild.roles.everyone;
    const isVoice = VOICEISH.includes(ch.type);
    let ov;
    if (mode === 'lock') ov = isVoice ? { Connect: false } : { SendMessages: false, AddReactions: false, SendMessagesInThreads: false, CreatePublicThreads: false };
    else if (mode === 'unlock') ov = isVoice ? { Connect: null } : { SendMessages: null, AddReactions: null, SendMessagesInThreads: null, CreatePublicThreads: null };
    else if (mode === 'hide') ov = { ViewChannel: false };
    else if (mode === 'show') ov = { ViewChannel: null };
    else throw new Error('mode không hợp lệ');
    await ch.permissionOverwrites.edit(target, ov, { reason: reason(ctx) });
    return `Đã ${mode} kênh ${ch.name} với ${target.name}`;
  },
  async set_channel_permission(a, ctx) {
    const ch = must(await findChannel(ctx.guild, a.channel), 'kênh', a.channel);
    let target = null;
    try { target = findRole(ctx.guild, a.target); } catch { /* thử member */ }
    if (!target) target = await findMember(ctx.guild, a.target);
    must(target, 'role/thành viên', a.target);
    const ov = {};
    parsePerms(a.allow).forEach((k) => { ov[k] = true; });
    parsePerms(a.deny).forEach((k) => { ov[k] = false; });
    parsePerms(a.reset).forEach((k) => { ov[k] = null; });
    await ch.permissionOverwrites.edit(target, ov, { reason: reason(ctx) });
    return `Đã chỉnh quyền ${nameOf(target)} trong ${ch.name}`;
  },

  /* ===== thành viên ===== */
  async timeout_member({ members, minutes, reason: rs }, ctx) {
    const mins = Math.max(0, Math.min(Number(minutes ?? 10), 40320));
    const targets = await resolveMembers(ctx, members);
    return each(targets, async (t) => {
      guardMember(ctx, t);
      if (!t.moderatable) throw new Error('bot không đủ quyền/role thấp hơn');
      await t.timeout(mins ? mins * 60000 : null, rs || reason(ctx));
    });
  },
  async kick_member({ members, reason: rs }, ctx) {
    const targets = await resolveMembers(ctx, members);
    return each(targets, async (t) => {
      guardMember(ctx, t);
      if (!t.kickable) throw new Error('bot không kick được (role cao hơn bot)');
      await t.kick(rs || reason(ctx));
    });
  },
  async ban_member({ members, reason: rs, delete_message_hours = 0, minutes = 0 }, ctx) {
    const g = getGuild(ctx.guild.id);
    const out = [];
    for (const q of list(members)) {
      try {
        let m = null;
        try { m = await findMember(ctx.guild, q); } catch (e) { if (!digits(q)) throw e; }
        const id = m?.id || digits(q);
        if (!id) throw new Error('không tìm thấy');
        if (m) {
          guardMember(ctx, m);
          if (!m.bannable) throw new Error('bot không ban được (role cao hơn bot)');
        }
        await ctx.guild.members.ban(id, {
          reason: rs || reason(ctx),
          deleteMessageSeconds: Math.min(604800, Math.round(delete_message_hours * 3600)),
        });
        if (minutes > 0) { g.tempbans[id] = Date.now() + minutes * 60000; saveGuild(); }
        out.push(`✅ đã ban ${m?.displayName || id}${minutes > 0 ? ` (${minutes} phút)` : ''}`);
      } catch (e) { out.push(`❌ ${q}: ${e.message}`); }
    }
    return out.join('\n');
  },
  async unban_member({ user }, ctx) {
    const bans = await ctx.guild.bans.fetch();
    const id = digits(user);
    const ban = id ? bans.get(id) : [...bans.values()].find((b) => norm(b.user.username) === norm(user));
    if (!ban) throw new Error('không thấy người này trong danh sách ban');
    await ctx.guild.members.unban(ban.user.id, reason(ctx));
    const g = getGuild(ctx.guild.id);
    delete g.tempbans[ban.user.id];
    saveGuild();
    return `Đã gỡ ban ${ban.user.username}`;
  },
  async set_nickname({ member, nickname }, ctx) {
    const m = must(await findMember(ctx.guild, member), 'thành viên', member);
    guardMember(ctx, m);
    if (!m.manageable) throw new Error('bot không đổi được nickname người này');
    await m.setNickname(nickname || null, reason(ctx));
    return nickname ? `Đã đổi nickname thành ${nickname}` : 'Đã reset nickname';
  },
  async warn_member({ member, reason: rs }, ctx) {
    const m = must(await findMember(ctx.guild, member), 'thành viên', member);
    guardMember(ctx, m);
    const g = getGuild(ctx.guild.id);
    const arr = (g.warns[m.id] ||= []);
    arr.push({ reason: rs || 'không ghi lý do', by: ctx.member.id, at: Date.now() });
    saveGuild();
    let extra = '';
    if (arr.length >= 5 && m.kickable) { await m.kick('Đủ 5 cảnh cáo'); extra = ' → đủ 5 warn nên đã KICK'; }
    else if (arr.length >= 3 && m.moderatable) { await m.timeout(60 * 60000, 'Đủ 3 cảnh cáo'); extra = ' → đủ 3 warn nên đã TIMEOUT 60 phút'; }
    return `Đã cảnh cáo ${m.displayName} (${arr.length} lần)${extra}`;
  },
  async list_warns({ member }, ctx) {
    const m = must(await findMember(ctx.guild, member), 'thành viên', member);
    const arr = getGuild(ctx.guild.id).warns[m.id] || [];
    if (!arr.length) return `${m.displayName} chưa bị cảnh cáo lần nào.`;
    return arr.map((w, i) => `${i + 1}. ${w.reason} (${new Date(w.at).toLocaleDateString('vi-VN')})`).join('\n');
  },
  async clear_warns({ member }, ctx) {
    const m = must(await findMember(ctx.guild, member), 'thành viên', member);
    delete getGuild(ctx.guild.id).warns[m.id];
    saveGuild();
    return `Đã xóa cảnh cáo của ${m.displayName}`;
  },
  async voice_control({ members, action, channel }, ctx) {
    const targets = await resolveMembers(ctx, members);
    const dest = action === 'move' ? must(await findChannel(ctx.guild, channel, VOICEISH), 'kênh voice', channel) : null;
    return each(targets, async (t) => {
      guardMember(ctx, t);
      if (!t.voice.channel) throw new Error('không ở trong voice');
      const r = reason(ctx);
      if (action === 'mute') await t.voice.setMute(true, r);
      else if (action === 'unmute') await t.voice.setMute(false, r);
      else if (action === 'deafen') await t.voice.setDeaf(true, r);
      else if (action === 'undeafen') await t.voice.setDeaf(false, r);
      else if (action === 'disconnect') await t.voice.disconnect(r);
      else if (action === 'move') await t.voice.setChannel(dest, r);
      else throw new Error('action không hợp lệ');
    });
  },

  /* ===== tin nhắn / server ===== */
  async purge_messages({ count, member, channel }, ctx) {
    const ch = await defChannel(ctx, channel, [...TEXTISH, CT.GuildVoice]);
    const target = member ? must(await findMember(ctx.guild, member), 'thành viên', member) : null;
    let left = Math.max(1, Math.min(Number(count) || 10, 300));
    let deleted = 0;
    let before;
    while (left > 0) {
      const batch = await ch.messages.fetch({ limit: Math.min(100, left), before });
      if (!batch.size) break;
      before = batch.last().id;
      let arr = [...batch.values()];
      if (target) arr = arr.filter((m) => m.author.id === target.id);
      if (arr.length) deleted += (await ch.bulkDelete(arr, true)).size;
      left -= batch.size;
    }
    return `Đã xóa ${deleted} tin nhắn${target ? ` của ${target.displayName}` : ''} trong #${ch.name}`;
  },
  async send_message(a, ctx) {
    const ch = await defChannel(ctx, a.channel, TEXTISH);
    const parse = a.ping === 'everyone' ? ['users', 'roles', 'everyone'] : a.ping === 'roles' ? ['users', 'roles'] : ['users'];
    const payload = { allowedMentions: { parse } };
    if (a.embed_title) {
      payload.embeds = [new EmbedBuilder().setTitle(a.embed_title).setDescription(a.content).setColor(parseColor(a.color) ?? 0x5865f2)];
    } else payload.content = a.content;
    await ch.send(payload);
    return `Đã gửi vào #${ch.name}`;
  },
  async create_invite({ channel, max_age_minutes = 0, max_uses = 0 }, ctx) {
    const ch = await defChannel(ctx, channel, [...TEXTISH, ...VOICEISH]);
    const inv = await ch.createInvite({ maxAge: max_age_minutes * 60, maxUses: max_uses, unique: true, reason: reason(ctx) });
    return `Link mời: ${inv.url}`;
  },
  async lockdown_server({ locked = true }, ctx) {
    const g = getGuild(ctx.guild.id);
    const everyone = ctx.guild.roles.everyone;
    await ctx.guild.channels.fetch();
    let n = 0;
    if (locked) {
      const chans = [...ctx.guild.channels.cache.values()].filter((c) => TEXTISH.includes(c.type));
      for (const c of chans) {
        const ow = c.permissionOverwrites.cache.get(everyone.id);
        if (ow?.deny.has('SendMessages')) continue; // đã khóa sẵn từ trước, không đụng
        try { await c.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason: reason(ctx) }); g.lockdown.push(c.id); n++; } catch { /* thiếu quyền kênh đó */ }
      }
      saveGuild();
      return `Đã khóa chat ${n} kênh.`;
    }
    for (const id of g.lockdown) {
      const c = ctx.guild.channels.cache.get(id);
      if (!c) continue;
      try { await c.permissionOverwrites.edit(everyone, { SendMessages: null }, { reason: reason(ctx) }); n++; } catch { /* bỏ qua */ }
    }
    g.lockdown = [];
    saveGuild();
    return `Đã mở lại chat ${n} kênh.`;
  },

  /* ===== cấu hình bot ===== */
  async configure_chat_channels({ action, channel }, ctx) {
    const g = getGuild(ctx.guild.id);
    const ch = action === 'show' || action.endsWith('_clear') ? null : await defChannel(ctx, channel, TEXTISH);
    const set = (arr, id, on) => { const i = arr.indexOf(id); if (on && i < 0) arr.push(id); if (!on && i >= 0) arr.splice(i, 1); };
    if (action === 'chat_add') set(g.chatChannels, ch.id, true);
    else if (action === 'chat_remove') set(g.chatChannels, ch.id, false);
    else if (action === 'chat_clear') g.chatChannels = [];
    else if (action === 'adminonly_add') set(g.adminOnlyChannels, ch.id, true);
    else if (action === 'adminonly_remove') set(g.adminOnlyChannels, ch.id, false);
    else if (action === 'adminonly_clear') g.adminOnlyChannels = [];
    else if (action !== 'show') throw new Error('action không hợp lệ');
    saveGuild();
    const names = (ids) => ids.map((id) => ctx.guild.channels.cache.get(id)?.name || id).join(', ') || '(trống)';
    return `Kênh bot tự trả lời mọi tin: ${names(g.chatChannels)}${g.chatChannels.length ? '' : ' → bot trả lời khi được gọi ở mọi kênh'}\nKênh chỉ admin: ${names(g.adminOnlyChannels)}`;
  },
  async set_log_channel({ channel }, ctx) {
    const g = getGuild(ctx.guild.id);
    if (norm(channel) === 'none') { g.logChannel = null; saveGuild(); return 'Đã tắt kênh log.'; }
    const ch = must(await findChannel(ctx.guild, channel, TEXTISH), 'kênh', channel);
    g.logChannel = ch.id;
    saveGuild();
    return `Kênh log: #${ch.name}`;
  },
  async set_welcome_channel({ channel }, ctx) {
    const g = getGuild(ctx.guild.id);
    if (norm(channel) === 'none') { g.welcomeChannel = null; saveGuild(); return 'Đã tắt chào thành viên mới.'; }
    const ch = must(await findChannel(ctx.guild, channel, TEXTISH), 'kênh', channel);
    g.welcomeChannel = ch.id;
    saveGuild();
    return `Kênh chào thành viên mới: #${ch.name}`;
  },
  async set_automod(a, ctx) {
    const g = getGuild(ctx.guild.id);
    for (const k of ['spam', 'invites', 'mentions']) if (a[k] !== undefined) g.automod[k] = !!a[k];
    saveGuild();
    return `Automod → spam: ${g.automod.spam}, link mời: ${g.automod.invites}, mention hàng loạt: ${g.automod.mentions}`;
  },
  async set_voice_listening({ wake_word_only }, ctx) {
    getGuild(ctx.guild.id).voiceWake = !!wake_word_only;
    saveGuild();
    return wake_word_only ? 'Trong voice bot chỉ trả lời khi nghe gọi tên.' : 'Trong voice bot trả lời mọi người nói.';
  },
  async set_voice_channel({ channel }, ctx) {
    const g = getGuild(ctx.guild.id);
    if (norm(channel) === 'none' || norm(channel) === 'off' || norm(channel) === 'tat') {
      g.voiceChannelId = null; saveGuild();
      return 'Đã gỡ khóa kênh voice. Chat tin nhắn bình thường vẫn hoạt động.';
    }
    const ch = must(await findChannel(ctx.guild, channel, VOICEISH), 'kênh voice', channel);
    g.voiceChannelId = ch.id; saveGuild();
    const s = voice.getSession(ctx.guild.id);
    if (s && s.voiceChannel.id !== ch.id) voice.destroySession(ctx.guild.id);
    return `Đã khóa voice vào #${ch.name}. Bot chỉ nghe/nói realtime trong kênh này; chat bằng tin nhắn vẫn hoạt động bình thường.`;
  },
  async show_bot_settings(_a, ctx) {
    const g = getGuild(ctx.guild.id);
    const nm = (id) => (id ? '#' + (ctx.guild.channels.cache.get(id)?.name || id) : 'chưa đặt');
    return [
      `Giọng: ${VOICES[g.voice]?.label || g.voice} | Voice chỉ nghe khi gọi tên: ${g.voiceWake}`,
      `Kênh voice bị khóa: ${g.voiceChannelId ? (ctx.guild.channels.cache.get(g.voiceChannelId)?.name || g.voiceChannelId) : 'không khóa'}`,
      `Kênh log: ${nm(g.logChannel)} | Kênh welcome: ${nm(g.welcomeChannel)}`,
      `Automod: ${JSON.stringify(g.automod)}`,
      `Kênh bot tự trả lời: ${g.chatChannels.map(nm).join(', ') || 'không (chỉ khi được gọi)'}`,
      `Kênh chỉ admin: ${g.adminOnlyChannels.map(nm).join(', ') || 'không'}`,
    ].join('\n');
  },
};

/* ---------- xác nhận lệnh nguy hiểm ---------- */
const pending = new Map(); // `${guildId}:${userId}` -> { name, args, exp }

const isDangerous = (name, a) =>
  ['delete_channel', 'delete_role', 'kick_member', 'ban_member'].includes(name)
  || (name === 'purge_messages' && (Number(a.count) || 0) > 30)
  || (name === 'lockdown_server' && a.locked !== false);

const YES = /^\s*(?:ok|oke|okie|ok luôn|đồng ý|dong y|xác nhận|xac nhan|làm đi|lam di|yes|y|ừ|ừm|uh|chắc|chắc chắn|duyệt|chốt|đi)(?=\s|$|[.!,~])/i;
const NO = /^\s*(?:không|khong|ko|hủy|huỷ|huy|thôi|thoi|no|cancel|đừng|dung)(?=\s|$|[.!,~])/i;

export async function tryConfirm(ctx, text) {
  const key = `${ctx.guild.id}:${ctx.member.id}`;
  const p = pending.get(key);
  if (!p) return null;
  if (Date.now() > p.exp) { pending.delete(key); return null; }
  if (YES.test(text)) {
    pending.delete(key);
    return runTool(p.name, p.args, { ...ctx, confirmed: true });
  }
  if (NO.test(text)) {
    pending.delete(key);
    return 'ĐÃ HỦY lệnh theo yêu cầu của admin, chưa thực hiện gì.';
  }
  return null;
}

async function modLog(ctx, name, args, result) {
  const g = getGuild(ctx.guild.id);
  if (!g.logChannel || READONLY.has(name)) return;
  const ch = ctx.guild.channels.cache.get(g.logChannel);
  if (!ch) return;
  await ch.send({
    content: `🛠️ **${ctx.member.user.tag}** → \`${name}\` \`${JSON.stringify(args).slice(0, 300)}\`\n${String(result).slice(0, 500)}`,
    allowedMentions: { parse: [] },
  }).catch(() => {});
}

export async function runTool(name, args, ctx) {
  const admin = ADMIN_NAMES.has(name);
  if (admin && !ctx.isAdmin) return 'TỪ CHỐI: người này không phải admin nên không được dùng chức năng quản trị.';
  if (!IMPL[name]) return `Tool "${name}" không tồn tại.`;
  args = args || {};

  if (admin && cfg.confirmDanger && !ctx.confirmed && isDangerous(name, args)) {
    pending.set(`${ctx.guild.id}:${ctx.member.id}`, { name, args, exp: Date.now() + 60_000 });
    return `CẦN XÁC NHẬN: lệnh nguy hiểm "${name}" với tham số ${JSON.stringify(args)}. Hãy hỏi admin ngắn gọn có chắc không (admin nói "ok" để thực hiện, "hủy" để bỏ). CHƯA thực hiện gì.`;
  }
  try {
    const r = await IMPL[name](args, ctx);
    const out = typeof r === 'string' ? r : JSON.stringify(r);
    if (admin) await modLog(ctx, name, args, out);
    return out;
  } catch (e) {
    console.error(`[tool:${name}]`, e.message);
    return 'LỖI: ' + (e.message || e);
  }
}
