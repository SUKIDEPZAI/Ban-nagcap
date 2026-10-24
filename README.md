# Discord AI Bot (mất dạy nhưng có kiểm soát)

Bot Discord chạy bằng **discord.js + @discordjs/voice**, não là API `https://motapis.com/v1` (model `DeepSeek-V4-Flash-0731`).
**Không có slash command nào** – chỉ cần nhắn bình thường hoặc nói trong voice.

## Tính năng

| Yêu cầu | Cách hoạt động |
|---|---|
| Không có lệnh | AI tự hiểu ý rồi gọi "tool" (phát nhạc, kick, tạo role...) |
| Chat + khóa kênh | Bot trả lời khi bị **@mention / nhắc tên / reply**. Admin nói "chỉ chat ở kênh này" → bot chỉ nói chuyện ở kênh đó. "Kênh này chỉ admin được dùng bot" → khóa cho admin |
| Voice realtime | Bot vào voice, nghe từng người nói (STT) → AI → nói lại (TTS). Nói chen là bot im để nghe |
| Nhạc + tìm kiếm | YouTube qua yt-dlp (hàng chờ, skip, pause, loop, volume) + tìm web |
| Tính cách | Cà khịa, chửi nhẹ; có giới hạn cứng trong system prompt (không xúc phạm nhóm người, không đe dọa, tự dịu lại khi người ta buồn) |
| Quản lý server | Tạo/sửa/xóa role & kênh, gán role, khóa/ẩn kênh, quyền riêng từng kênh, timeout, kick, ban (kể cả ban tạm), unban, nickname, warn (3 warn = timeout, 5 = kick), điều khiển người trong voice, purge tin nhắn, gửi thông báo/embed, tạo invite, lockdown chống raid, automod (spam / link mời / mention hàng loạt), kênh log, chào thành viên mới |
| Nhiều giọng | `nu, be_gai, ba_gia, nam, be_trai, nam_tram, ong_gia, noi_nhanh` + Anh/Nhật/Hàn/Trung |

### An toàn
- Quyền admin do **code kiểm tra** (Administrator / chủ server / `ADMIN_IDS`), không phải do AI quyết định. Người thường không được cấp tool quản trị.
- Không cho tác động người có role ngang/cao hơn admin ra lệnh, không đụng chủ server.
- Lệnh nguy hiểm (kick, ban, xóa kênh/role, purge > 30, lockdown) **hỏi xác nhận** – admin nói "ok" mới chạy (tắt bằng `CONFIRM_DANGEROUS=false`).
- Cấp quyền `Administrator` cho role chỉ chủ server / `ADMIN_IDS` làm được.

## Ví dụ nói chuyện

- `bot phát bài Có chàng trai viết lên cây` · `skip` · `bot chỉnh âm lượng 30` · `lặp bài này đi`
- `bot vào voice đi` · `đổi giọng bé gái` · `nói câu "xin chào" bằng giọng ông già`
- `tạo role Mod màu xanh có quyền xóa tin nhắn và mute` · `gán role Mod cho @A @B`
- `tạo kênh voice riêng tư tên Họp kín, chỉ role Mod vào được`
- `mute @A 30 phút` · `kick @B` (→ bot hỏi lại → `ok`) · `xóa 50 tin của @C`
- `khóa kênh này` · `khóa cả server` · `bật automod chống spam và link mời`
- `chỉ chat ở kênh này thôi` · `kênh này chỉ admin được nói chuyện với bot`
- `đặt kênh log là #mod-log` · `chào người mới ở #welcome`
- Trong voice, admin có thể nói thẳng: *"bot mute thằng A trong voice đi"*.

## 1. Tạo bot Discord
1. https://discord.com/developers/applications → **New Application** → tab **Bot** → Reset Token → copy `DISCORD_TOKEN`.
2. Cùng trang **Bot**, bật **Privileged Gateway Intents**: ✅ **Server Members Intent**, ✅ **Message Content Intent**.
3. Mời bot vào server (thay `CLIENT_ID`):
   `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot&permissions=8`
   (`permissions=8` = Administrator, đơn giản nhất. Muốn chặt hơn thì tự chọn quyền, nhưng thiếu quyền thì lệnh tương ứng sẽ báo lỗi.)
4. **Kéo role của bot lên cao** trong Server Settings → Roles (bot chỉ quản được role/người thấp hơn nó).

## 2. Voice: STT đám mây (khuyên dùng) hoặc Whisper cục bộ
**Host yếu (vd Falix free)**: Whisper cục bộ có thể mất >20s/câu và làm tràn RAM. Hãy lấy key miễn phí ở console.groq.com và đặt `STT_API_KEY`; Whisper cục bộ trở thành dự phòng.

Whisper cục bộ:
Bot nghe bằng `whisper.cpp` chạy ngay trên máy chủ: đặt binary vào `bin/whisper-cli` và model vào `models/ggml-tiny.bin`.
Khi khởi động, bot **tự kiểm tra** Whisper và FFmpeg và ghi kết quả vào log (`[stt] ✅/⚠️`, `[ffmpeg] ✅/⚠️`).
Không có Whisper thì chat/nhạc/quản lý vẫn chạy, chỉ voice không nghe được.

**Whisper báo lỗi?** Xem log `[stt]` (in đầy đủ stderr) và đọc phần gợi ý trong tin nhắn:
- `kill EACCES` + chạy lâu → host KHÔNG cho kill tiến trình khi quá timeout (không phải thiếu quyền chạy); `OOMKilled` → tràn RAM
- `SIGKILL` → hết RAM của gói host · `SIGILL` → CPU không hỗ trợ AVX, build lại với `GGML_NATIVE=OFF`
- `EACCES`/`ENOEXEC` → thiếu quyền chạy / sai kiến trúc · thử `WHISPER_EXTRA_ARGS=-ng -nfa`

**TTS báo lỗi?** Bot thử Edge TTS rồi tự chuyển sang Google TTS (giữ cao độ/tốc độ bằng FFmpeg). Nếu Edge hỏng, bot nhớ và dùng thẳng Google trong 3 phút để khỏi chờ. Cả hai lỗi nghĩa là host chặn HTTPS/WebSocket ra ngoài.

## 3. Đưa lên GitHub
```bash
git init && git add . && git commit -m "init"
git branch -M main
git remote add origin https://github.com/<ban>/<repo>.git
git push -u origin main
```
(`.env` đã nằm trong `.gitignore`, đừng đẩy token lên.)

## 4. Deploy lên Render
1. Render → **New → Web Service** → chọn repo.
2. **Runtime/Language: Docker** (Dockerfile đã cài ffmpeg + yt-dlp). Hoặc dùng **Blueprint** với file `render.yaml`.
3. Thêm Environment Variables (xem `.env.example`): tối thiểu `DISCORD_TOKEN`, `MOTAPIS_API_KEY` (hoặc `AI_API_KEY`), file `bin/whisper-cli` và `models/ggml-tiny.bin`, `ADMIN_IDS` (ID Discord của bạn).
4. Deploy. Log thấy `✅ Đã đăng nhập` là xong.

### Lưu ý khi dùng Render
- **Gói free ngủ sau ~15 phút không có truy cập HTTP** → bot offline. Dùng UptimeRobot/cron-job.org ping URL của service mỗi 5 phút để giữ thức.
- **Ổ đĩa free bị xóa mỗi lần restart** → cấu hình kênh/log/warn sẽ mất. Muốn giữ: gắn Render Disk (gói trả phí), mount `/data` và đặt `DATA_DIR=/data`.
- **Voice dùng UDP.** Nếu bot kẹt ở "Connecting" / báo không vào được voice thì host đang chặn UDP → đổi sang VPS (hoặc Railway/Fly.io).
- **YouTube thường chặn IP datacenter** ("Sign in to confirm you're not a bot"). Cách xử lý: xuất `cookies.txt` từ trình duyệt đã đăng nhập YouTube (tài khoản phụ) → `base64 -w0 cookies.txt` → dán vào `YT_COOKIES_B64`.

## Giọng nói – nói thật về giới hạn
Edge TTS chỉ có **2 giọng tiếng Việt gốc** (nữ HoaiMy, nam NamMinh). Các giọng "bé gái, bé trai, ông già, bà già, nam trầm, nói nhanh" là hiệu ứng chỉnh **cao độ + tốc độ**, nghe khác rõ nhưng không phải diễn viên khác. Muốn giọng thật đa dạng hơn: đổi `src/tts.js` sang ElevenLabs / FPT.AI / Viettel AI (chỉ cần sửa hàm `synthesize`).

## Cấu trúc
```
src/index.js      Discord client, nhận tin nhắn, kênh/khóa kênh, webserver cho Render
src/brain.js      Tính cách + ngữ cảnh + lịch sử hội thoại
src/ai.js         Gọi motapis (có model dự phòng), vòng lặp tool-calling, bản STREAM cho voice
src/tools.js      Toàn bộ chức năng (nhạc, voice, quản trị) + kiểm tra quyền + xác nhận
src/voice.js      Vào voice, nghe (STT), nói (TTS), nói chen
src/music.js      Hàng chờ nhạc (yt-dlp + ffmpeg)
src/tts.js        Giọng nói (Edge + Google dự phòng)   src/synth.js  retry + circuit breaker
src/stt.js        Whisper cục bộ + tự kiểm tra          src/audio.js, ttstext.js  hàm thuần (có test)
src/automod.js    Chống spam/link mời/mention
src/store.js      Lưu cấu hình từng server (JSON)
```

## Chỉnh nhanh
- Tính cách: sửa `PERSONA` trong `src/brain.js`.
- Voice trả lời chậm: thử `AI_EXTRA_BODY={"thinking":{"type":"disabled"}}` (nếu motapis hỗ trợ).
- Chỉ trả lời trong voice khi gọi tên: nói "bot chỉ nghe khi gọi tên".
- Model không hỗ trợ function-calling thì các chức năng nhạc/quản trị sẽ không kích hoạt – lúc đó cần đổi model.


## Sửa lỗi bot nghe nhưng không trả lời (Falix)

- STT chạy local qua `bin/whisper-cli` và `models/ggml-tiny.bin`; không còn yêu cầu `STT_API_KEY`.
- Tải binary Whisper Linux x64 vào đúng `bin/whisper-cli` (không để thành `bin/whisper-cli/whisper-cli`) và model vào `models/ggml-tiny.bin`.
- FFmpeg dùng để chuyển MP3 từ Edge TTS thành PCM Discord phát được. Nếu `ffmpeg` không có trong PATH, cấu hình `FFMPEG_PATH` trỏ đến binary FFmpeg có sẵn.
- Khóa AI đặt `MOTAPIS_API_KEY`; `AI_API_KEY` vẫn được hỗ trợ để tương thích bản cũ.
- Sau khi upload file, restart server và đọc Console. Lỗi STT/AI/FFmpeg sẽ được ghi log; lỗi xử lý voice sẽ gửi thông báo vào kênh text đã dùng để gọi bot vào voice.


## FalixNodes: sửa voice/nhạc và khóa kênh voice

- Bộ giải mã voice dùng `opusscript` thuần JavaScript để tránh lỗi binary native `@discordjs/opus` không khớp Node ABI trên host. Sau khi thay file, chạy `npm install` hoặc xóa `node_modules` rồi cài lại để tránh dùng dependency cũ.
- Nếu chưa có `yt-dlp`, tính năng nhạc tự tải binary Linux phù hợp vào `./bin/yt-dlp` khi được gọi lần đầu. Host cần cho phép kết nối tải file. Có thể đặt `YTDLP_PATH` nếu bạn tự đặt binary ở đường dẫn khác; `FFMPEG_PATH` vẫn cần trỏ tới FFmpeg nếu host không cung cấp sẵn.
- Admin có thể nói với bot: **khóa bot chỉ nói trong kênh voice này**; AI sẽ đặt `set_voice_channel` với kênh voice hoặc `none` để gỡ khóa. Khi đã khóa, bot từ chối tham gia kênh voice khác. Cấu hình này chỉ giới hạn hội thoại voice, không tắt trả lời tin nhắn Discord bình thường.
