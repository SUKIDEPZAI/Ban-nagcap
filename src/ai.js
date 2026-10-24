import OpenAI from 'openai';
import { cfg } from './config.js';
import { visibleText } from './ttstext.js';

const client = new OpenAI({ baseURL: cfg.aiBase, apiKey: cfg.aiKey, timeout: cfg.aiTimeoutMs, maxRetries: 1 });

const clean = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

// Gọi API; nếu model chính lỗi mà có AI_FALLBACK_MODEL thì thử lại bằng model dự phòng
async function create(body, opts) {
  try {
    return await client.chat.completions.create(body, opts);
  } catch (e) {
    if (opts?.signal?.aborted || !cfg.fallbackModel || cfg.fallbackModel === body.model) throw e;
    console.warn(`[ai] ${body.model} lỗi (${e?.status || e?.code || e?.message}); thử model dự phòng ${cfg.fallbackModel}`);
    return client.chat.completions.create({ ...body, model: cfg.fallbackModel }, opts);
  }
}

// Gọi model; nếu model gọi tool thì chạy exec() rồi lặp lại (tối đa 6 vòng)
export async function chat(messages, { tools, exec, maxTokens = cfg.maxTokens, temperature = 0.9 } = {}) {
  let grown = false;
  for (let i = 0; i < 6; i++) {
    const body = { model: cfg.model, messages, temperature, max_tokens: maxTokens, ...cfg.aiExtra };
    if (tools?.length && exec) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const r = await create(body);
    const msg = r.choices?.[0]?.message;
    if (!msg) throw new Error('AI trả về rỗng');
    if (!msg.tool_calls?.length && !clean(msg.content) && r.choices[0].finish_reason === 'length' && !grown) {
      grown = true; maxTokens *= 2; // model suy nghĩ ăn hết max_tokens -> cho thêm ngân sách rồi gọi lại
      console.warn(`[ai] nội dung rỗng do hết max_tokens, thử lại với ${maxTokens}`);
      continue;
    }

    if (msg.tool_calls?.length && exec) {
      messages.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: msg.tool_calls,
        ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
      });
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* args rỗng */ }
        const out = await exec(tc.function.name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out).slice(0, 6000) });
      }
      continue;
    }
    return clean(msg.content);
  }
  return 'Làm lằng nhằng quá, tao bỏ cuộc.';
}

// Phiên bản STREAM: gọi onSentence(câu) ngay khi model vừa viết xong mỗi câu -> bot bắt đầu nói sớm
export async function chatStream(messages, { tools, exec, onSentence, signal, maxTokens = cfg.maxTokens, temperature = 0.9 } = {}) {
  let spokenAll = '';
  let grown = false;
  for (let round = 0; round < 6; round++) {
    const body = { model: cfg.model, messages, temperature, max_tokens: maxTokens, stream: true, ...cfg.aiExtra };
    if (tools?.length && exec) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const stream = await create(body, { signal });
    let content = '';
    let reasoning = '';
    let raw = '';
    let seen = 0;
    let buf = '';
    const calls = [];
    let finish = null;

    const emit = (final) => {
      for (;;) {
        const m = buf.match(/^([\s\S]{8,}?[.!?…]+)\s/) || buf.match(/^([\s\S]{8,}?)\n/);
        if (!m) break;
        const s = m[1].trim();
        buf = buf.slice(m[0].length);
        if (s) { onSentence?.(s); spokenAll += s + ' '; }
      }
      if (final && buf.trim()) { onSentence?.(buf.trim()); spokenAll += buf.trim() + ' '; buf = ''; }
    };

    for await (const chunk of stream) {
      if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
      const d = chunk.choices?.[0]?.delta;
      if (!d) continue;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          const c = (calls[tc.index ?? 0] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.function.name += tc.function.name;
          if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
        }
      }
      if (d.content) {
        content += d.content;
        raw += d.content;
        const v = visibleText(raw);
        if (v.length > seen) { buf += v.slice(seen); seen = v.length; emit(false); }
      }
    }
    { const v = visibleText(raw); if (v.length > seen) { buf += v.slice(seen); seen = v.length; } }
    emit(true);

    const real = calls.filter((c) => c && c.function.name);
    if (!real.length && !spokenAll.trim() && !clean(content) && finish === 'length' && !grown) {
      grown = true; maxTokens *= 2;
      console.warn(`[ai] nội dung rỗng do hết max_tokens, thử lại với ${maxTokens}`);
      continue;
    }
    if (real.length && exec) {
      real.forEach((c, i) => { if (!c.id) c.id = `call_${Date.now()}_${i}`; });
      messages.push({
        role: 'assistant', content: content || '', tool_calls: real,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      });
      for (const tc of real) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* args rỗng */ }
        const out = await exec(tc.function.name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out).slice(0, 6000) });
      }
      continue;
    }
    return clean(spokenAll || content);
  }
  return 'Làm lằng nhằng quá, tao bỏ cuộc.';
}
