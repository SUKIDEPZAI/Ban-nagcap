import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { silentWav } from '../src/audio.js';

// STT đám mây giả: nhận multipart, trả JSON như API OpenAI/Groq
let mode = 'ok';
let hits = 0;
const server = http.createServer((req, res) => {
  hits++;
  req.resume();
  req.on('end', () => {
    if (mode === 'fail') { res.writeHead(503); return res.end('down'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: mode === 'blank' ? ' [BLANK_AUDIO] ' : 'bot phát nhạc đi' }));
  });
});
await new Promise((r) => server.listen(0, r));
process.env.STT_API_KEY = 'k';
process.env.STT_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
process.env.WHISPER_CLI_PATH = '/nonexistent/whisper-cli';
const { transcribe, sttEnabled, sttSelfTest, explainFailure } = await import('../src/stt.js');
test.after(() => server.close());

test('STT đám mây: trả transcript, [BLANK_AUDIO] thành rỗng', async () => {
  assert.equal(sttEnabled(), true);
  assert.equal(await transcribe(silentWav(1)), 'bot phát nhạc đi');
  mode = 'blank';
  assert.equal(await transcribe(silentWav(1)), '');
});

test('STT đám mây lỗi + không có Whisper cục bộ -> ném lỗi; rồi tạm nghỉ 60s không gọi lại', async () => {
  mode = 'fail';
  await assert.rejects(transcribe(silentWav(1)), /HTTP 503/);
  const before = hits;
  await assert.rejects(transcribe(silentWav(1)), /Thiếu|tạm lỗi/);
  assert.equal(hits, before, 'không gọi cloud trong thời gian nghỉ');
});

test('selfTest báo lỗi rõ ràng khi cloud hỏng', async () => {
  const r = await sttSelfTest();
  assert.equal(r.ok, false);
});

test('explainFailure: timeout/EACCES do host cấm kill KHÔNG bị nhầm là thiếu quyền chạy', () => {
  const kill = Object.assign(new Error('kill EACCES'), { code: 'EACCES', syscall: 'kill' });
  assert.match(explainFailure(kill, { timedOut: true }), /KHÔNG CHO KILL/);
  assert.match(explainFailure({ code: 'EACCES' }), /quyền thực thi/);
  assert.match(explainFailure({ signal: 'SIGKILL' }), /RAM/);
});
