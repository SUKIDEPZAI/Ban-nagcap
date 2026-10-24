const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const num = (v, d) => (Number.isFinite(Number(v)) && String(v ?? '').trim() !== '' ? Number(v) : d);

let aiExtra = {};
try { aiExtra = JSON.parse(process.env.AI_EXTRA_BODY || '{}'); } catch { console.warn('AI_EXTRA_BODY không phải JSON hợp lệ, bỏ qua'); }

export const cfg = {
  token: process.env.DISCORD_TOKEN,
  aiBase: process.env.AI_BASE_URL || 'https://motapis.com/v1',
  aiKey: process.env.MOTAPIS_API_KEY || process.env.AI_API_KEY,
  model: process.env.AI_MODEL || 'DeepSeek-V4-Flash-0731',
  // model dự phòng: nếu model chính lỗi (5xx/timeout/hết quota) thì gọi lại bằng model này
  fallbackModel: process.env.AI_FALLBACK_MODEL || '',
  aiTimeoutMs: num(process.env.AI_TIMEOUT_MS, 60000),
  aiExtra,
  maxTokens: Number(process.env.AI_MAX_TOKENS) || 1500,
  botName: process.env.BOT_NAME || 'Bot Mất Dạy',
  botNames: list(process.env.BOT_NAMES || 'bot'),
  adminIds: list(process.env.ADMIN_IDS),
  // voice
  silenceMs: num(process.env.VOICE_SILENCE_MS, 900),   // im lặng bao lâu thì coi là hết câu
  minRms: num(process.env.VOICE_MIN_RMS, 250),         // dưới ngưỡng này coi là tiếng ồn
  minSecs: num(process.env.VOICE_MIN_SECS, 0.6),       // câu ngắn hơn thì bỏ
  maxUtterSecs: num(process.env.VOICE_MAX_SECS, 20),   // độ dài tối đa 1 câu nói
  bargeMs: num(process.env.VOICE_BARGE_MS, 450),       // phải nói liên tục bao lâu mới ngắt bot
  confirmDanger: process.env.CONFIRM_DANGEROUS !== 'false',
  tavilyKey: process.env.TAVILY_API_KEY || '',
  ytdlpArgs: list((process.env.YTDLP_ARGS ?? '--js-runtimes node').split(' ').join(',')),
};
