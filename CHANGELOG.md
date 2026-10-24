# 1.1.2
- Voice tự trả lời: lượt trả lời không còn bị hủy âm thầm khi có tiếng động lúc AI đang nghĩ (nói chen chỉ áp dụng khi bot ĐANG phát tiếng).
- Model suy nghĩ ăn hết `max_tokens` làm nội dung rỗng -> tự gọi lại với ngân sách gấp đôi; voice nâng 500 -> 900 token.
- AI rỗng/lỗi trong voice: bot vẫn nói một câu báo thay vì im lặng. Thêm log `[voice] bot → ...` và lý do mỗi lần không nói.

# 1.1.1
- Sửa chẩn đoán sai: `code=EACCES` kèm chạy lâu là do HOST CẤM `kill()` khi Whisper quá timeout, không phải thiếu quyền thực thi.
- Whisper quá hạn mà không kill được → không chạy tiếp (tránh tích tụ tiến trình gây OOMKilled); `music.js` đóng pipe để yt-dlp/ffmpeg tự thoát.
- STT đám mây tùy chọn (`STT_API_KEY`, Groq...), tự rơi về Whisper cục bộ; Whisper cục bộ mặc định dùng giải mã tham lam (nhanh hơn).
- Bỏ câu nói chờ quá 30s; giới hạn độ dài 1 câu 20s (`VOICE_MAX_SECS`).

# 1.1.0

**Voice**
- Nối `chatStream` vào voice: bot nói từng câu ngay khi AI viết xong (trước đây chờ cả đoạn).
- Nói chen dùng "epoch": hủy các câu chưa nói + hủy luôn yêu cầu AI; chỉ ngắt khi người kia nói liên tục ≥ `VOICE_BARGE_MS` (không bị ho/tiếng ồn cắt lời).
- Sửa `playBuf` có thể treo 30s sau khi nói chen; thêm handler `stdin` (EPIPE); không nhả nhạc giữa các câu.
- Whisper trả rỗng (im lặng/tiếng ồn) không còn spam "Voice gặp lỗi"; cảnh báo lên kênh text giới hạn 1 tin/30s.

**TTS**
- `synth.js`: retry 2 lần + circuit breaker (Edge hỏng → dùng thẳng Google 3 phút, sau đó thăm dò 1 lần).
- Google dự phòng giữ cao độ/tốc độ bằng bộ lọc ffmpeg; mọi mảnh văn bản ≤ 180 ký tự (hết lỗi 400 do câu quá dài).

**STT / chẩn đoán**
- Log đầy đủ stderr của whisper, lọc dòng init, giải thích SIGKILL (hết RAM) / SIGILL (thiếu AVX) / EACCES / ENOEXEC.
- Tự kiểm tra Whisper + FFmpeg khi khởi động; `WHISPER_EXTRA_ARGS`.

**Khác**
- `AI_FALLBACK_MODEL`, `AI_TIMEOUT_MS`; ẩn `<think>` trong luồng stream.
- Dọn config thừa (`cfg.stt`), sửa `render.yaml`/README/.env.example; test hành vi thay cho test "grep".
