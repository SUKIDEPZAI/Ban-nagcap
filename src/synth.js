// Tổng hợp giọng nói có retry + dự phòng + "circuit breaker".
// Engine được tiêm vào (edge/google) nên test được mà không cần mạng.

export function errorDetails(error) {
  const parts = [];
  let current = error;
  for (let i = 0; current && i < 4; i++, current = current.cause) {
    for (const value of [current.message, current.code, current.name, current.errno, current.address]) {
      if (value !== undefined && value !== null && String(value).trim()) parts.push(String(value).trim());
    }
  }
  const unique = [...new Set(parts)];
  return unique.join(' | ').slice(0, 700)
    || 'Không có thông tin lỗi chi tiết (thường là host chặn WebSocket/HTTPS ra ngoài tới Microsoft hoặc DNS lỗi)';
}

/**
 * edge(text, key)   -> Buffer           (ném lỗi nếu thất bại)
 * google(text, key) -> { buf, fx }      (dự phòng)
 * Trả về { buf, fx, engine }.
 */
export function createSynth({
  edge, google, attempts = 2, backoffMs = 800, cooldownMs = 180_000,
  now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console,
}) {
  let edgeDownUntil = 0;
  let edgeWasDown = false;

  return async function synthesize(text, key) {
    let edgeError = null;

    if (now() >= edgeDownUntil) {
      const n = edgeWasDown ? 1 : attempts; // sau cooldown chỉ "thăm dò" 1 lần
      let last;
      for (let i = 1; i <= n; i++) {
        try {
          const buf = await edge(text, key);
          if (!buf?.length) throw new Error('Edge TTS trả về dữ liệu âm thanh rỗng');
          if (edgeWasDown) log.warn('[tts] Edge TTS đã hoạt động lại.');
          edgeWasDown = false;
          return { buf, fx: '', engine: 'edge' };
        } catch (e) {
          last = e;
          if (i < n) await sleep(i * backoffMs);
        }
      }
      edgeError = errorDetails(last);
    } else {
      edgeError = 'Edge TTS tạm bị bỏ qua (đang lỗi, sẽ thử lại sau)';
    }

    try {
      const r = await google(text, key);
      if (!r?.buf?.length) throw new Error('Google TTS trả âm thanh rỗng');
      if (now() >= edgeDownUntil) { // vừa thử Edge và hỏng
        edgeDownUntil = now() + cooldownMs;
        edgeWasDown = true;
        log.warn(`[tts] Edge TTS lỗi, chuyển sang Google ${Math.round(cooldownMs / 1000)}s. Lỗi Edge: ${edgeError}`);
      }
      return { ...r, engine: 'google' };
    } catch (gErr) {
      edgeDownUntil = 0; // cả hai đều hỏng -> lần sau thử lại Edge ngay
      throw new Error(`TTS thất bại. Edge: ${edgeError}. Google dự phòng: ${errorDetails(gErr)}. Host cần cho phép HTTPS/WebSocket ra ngoài tới Microsoft hoặc Google.`);
    }
  };
}
