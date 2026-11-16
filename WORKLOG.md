
## 2026-11-16: Live voice mode, round 1 (no AI)

Request: owner order relayed by Manager on 2026-11-16: "สร้างได้เลย release ได้เลย". The owner had earlier given this session standing permission to merge.

### What was built
- **Home is now "Live":** a big round switch in the middle turns Live on and off.
  - While Live is on, the app listens in Thai with the phone's own speech recognizer (`SpeechRecognizer`, th-TH).
  - It then says back exactly what it heard with the phone's own text-to-speech (`TextToSpeech`, Thai), then listens again.
  - There is no AI in this round.
- **Conversation log** at the bottom of the screen:
  - each entry shows what was heard and what was answered, with the date and time;
  - it scrolls back through earlier entries, keeps the last 300, and has a clear button;
  - it is stored only on the phone (WebView localStorage) and is never uploaded.
- **Menu button** (top left): every earlier feature is still here, unchanged: เช้า, เย็น, ผู้ช่วย, เตือน, ประวัติ, ตั้งค่า. The old tab bar is still in the code, only hidden. No old code was removed.
- **Settings button** (top right): opens ตั้งค่า, where the existing "ตรวจหาอัปเดต" and "อัปเดตเลย" (GitHub Release) buttons are.
- **Dark theme always** (owner rule 2026-11-16): the page and the Android window theme are dark, whatever the phone setting.

### Limits and choices
- **On screen only:** Live runs only while the app is on screen. It turns itself off when the app goes to the background, so the microphone is never left open there. A background microphone would need a foreground service of type microphone, which this round does not include.
- **Permissions:** the microphone is asked for the first time Live is switched on. The manifest gains `RECORD_AUDIO`, plus `<queries>` so Android 11+ can find the phone's recognizer and TTS engine.
- **Silence and errors:**
  - silence or no match: the app keeps listening;
  - other errors: it retries with growing delays, and after 6 errors in a row it turns Live off and says why (no internet, no Thai speech data, code).
- **Thai voice missing:** if the phone has no Thai TTS voice, a message says where to install it.
- **Privacy:** no keys or personal data are in the code. Depending on the phone, its speech recognizer may use the phone maker's or Google's online service. That is the phone's own system, not this app.

### Checks
- Browser test with a mock bridge, 400 px wide:
  - Live opens as the home view with the dark background, and the old tab bar is hidden.
  - Switching on shows "กำลังฟัง"; a heard and a spoken entry appear in the log with times; switching off works.
  - The log survives a reload.
  - The menu lists every old section and opens it; the settings button opens ตั้งค่า, with the update check button working.
  - No script errors (only the blocked web fonts) and no sideways scrolling.
- Java compiles in CI.
- Not tested on a real phone: microphone, Thai recognition and the Thai voice.

## 2026-11-16: Live round 2, the AI decides how to react

Request: owner order relayed by Manager on 2026-11-16, after the owner tested v1.0.7 on the phone (hearing works, speaking works). The AI should take what was said, work out what it means and decide how to react: answer by voice, or do something in the app such as set a reminder. It uses the AI already chosen in Settings (Claude API key, or local Ollama through Termux). Build, then release.

### What was built
- **Mode switch on the Live screen:**
  - "ตอบด้วย AI" is the default.
  - "พูดซ้ำ (ทดสอบ)" keeps round 1 exactly as it was.
  - The choice is remembered on the phone.
- **AI mode, step by step:**
  1. The phone's recognizer hears Thai. The microphone then stays closed while the AI thinks, so it does not hear itself or the room.
  2. The page builds a job with the existing `buildJob` (same provider, model, key and Ollama URL as the assistant chat) and runs it through the existing background `AiService`.
  3. The AI answers in JSON:
     - `reply`: short spoken Thai, without markdown or emoji;
     - `reminders`: the same shape as the assistant chat; these are set with the existing `addReminder`;
     - `open`: a page to open when asked, such as "remind" or "settings".
  4. The reply is spoken with the phone's TTS, written in the conversation log, and Live listens again.
- **Waiting:** the screen shows "กำลังคิด… N วินาที" and, for local AI, "AI ในเครื่องอาจใช้ 1–3 นาที". The switch pulses slowly while thinking.
- **Never silent:**
  - **No Claude key:** the app says so.
  - **AI error:** the app says "ติดต่อ AI ไม่ได้" with the reason, plus "ตรวจว่าเปิด Ollama ใน Termux อยู่" for local AI.
  - **No answer within 5 minutes:** the app says that too.
  - These messages are spoken (web addresses are left out of speech) and also written in the log as "แจ้ง".
- **When the app is not on screen:** if Live is off, a late answer is ignored. If the app is not on screen when the answer arrives, the existing notification shows it and opens Live.

### Checks
- Browser test with a mock bridge and mock AI jobs:
  - AI mode is the default.
  - The thinking status counts seconds.
  - A local-AI (ollama) job is sent with the JSON schema.
  - "เตือนฉันพรุ่งนี้แปดโมงให้ส่งรายงาน" gives a spoken reply and sets the reminder for 2026-11-17 08:00.
  - A connection error is spoken without the URL.
  - "เปิดหน้าเตือน" opens the reminders page.
  - Switching to echo mode works. The round-1 test still passes.
  - No errors and no sideways scrolling.
- Java compiles in CI.
- Not tested: a real AI answer from Ollama or Claude on the phone.

## 2026-11-16 (later): any AI provider, and Termux started by the app

Request: relayed by Manager. The owner approved adding all the options discussed:
- the app starts Ollama in Termux by itself, and explains the one-time setup in simple Thai;
- Settings can use any common AI provider (provider, Base URL, API key, model), with Claude and Ollama still working;
- the AI-on-this-phone option stays.

### What was built
- **Provider "ผู้ให้บริการอื่น"** (OpenAI-compatible `/chat/completions`):
  - **Presets** that fill the Base URL: OpenAI, Google Gemini, Groq, OpenRouter, DeepSeek, Mistral, Together AI, or a custom address.
  - **Fields:** Base URL, API key and model. The key is stored in localStorage on the phone only, under its own name, and is not in the exported settings.
  - **AiService** accepts this format over https only, and reads `choices[0].message.content`.
  - **JSON answers** are asked for in the prompt instead of `response_format`, because not every provider supports `response_format`.
  - Claude and Ollama are unchanged.
- **Termux starts Ollama by itself** (`TermuxOllama`, Termux `RUN_COMMAND`):
  - It runs `bash -c "termux-wake-lock; pgrep -x ollama || nohup ollama serve &"` in the background.
  - **When it runs:** when a local AI job cannot connect, `AiService` asks Termux to start Ollama, waits up to 30 s, and sends the request again. This covers Live, chat, the morning plan and the plan prepared before waking.
  - **When it cannot:** if Termux is missing, the permission is missing, or Ollama never comes up, the error says which and points to the steps.
- **Settings → AI ในเครื่อง → "ให้แอปเปิด Ollama ใน Termux ให้เอง":**
  - A status line, plus 5 steps in Thai. Steps already done turn green.
  - Buttons: "ขอสิทธิ์สั่ง Termux", "เปิดแอป Termux" and "เปิด Ollama ตอนนี้". The last one tests and waits up to 30 s.
  - Manifest: `com.termux.permission.RUN_COMMAND`, and a `<queries>` entry for the `com.termux` package.
- **Live screen:** it names the AI in use, for example "Groq llama-3.3-70b-versatile". The "1–3 นาที" hint now shows for local AI only.

### Checks
- Browser test with a mock bridge:
  - the Termux status before and after permission;
  - "เปิด Ollama ตอนนี้" waiting until Ollama answers;
  - the provider switch and its boxes, and the Groq preset filling the URL;
  - a Live job sent as format openai to `.../chat/completions` with a Bearer key;
  - the key absent from saved settings;
  - a missing URL spoken clearly.
  - No errors and no sideways scrolling. The earlier Live tests pass.
- Java compiles in CI.
- Not tested on a phone:
  - Termux RUN_COMMAND starting Ollama;
  - a real answer from any provider.

## 2026-11-16 (later): talking through a Markdown file on GitHub

Request: item 4, relayed by Manager ("ใส่ไปด้วยเลย"). A new AI choice in Settings.
- The app writes what the owner said into an MD file on GitHub.
- An outside AI reads the newest entry and writes its answer into the same file.
- The app reads the answer and speaks it.
- Slow answers (10 s to over 1 min) are acceptable.
- Settings: repo, file path and token, kept on the phone.
- The content must be encrypted, because the repo may be public.
- The answering AI is not chosen yet, so the file format must be clear in the README.

### What was built
- **Provider "คุยผ่านไฟล์ MD บน GitHub"**, with these settings:
  - repo and file path (default `chat/n-assistant.md`);
  - GitHub token;
  - encryption key, with "สร้างกุญแจใหม่" (32 random characters) and "แสดงกุญแจ" buttons.
  - The token and key are stored in localStorage on the phone only. They are not in settings, exports or the repo.
- **`GithubMdChannel`**, run by `AiService` like any other AI job:
  1. Appends `## Q <id>` with metadata and an encrypted one-line body through the GitHub contents API. It creates the file with a short header if it does not exist, and retries once on a write conflict.
  2. Polls the file every 5 s for up to 5 min for `## A <id>`.
  3. Decrypts the answer.
  - Unencrypted answers are rejected.
  - Clear Thai errors cover: bad token (401), no write permission (403), repo not found (404), no internet, wrong key, no answer in 5 min.
- **Encryption:** OpenSSL AES-256-CBC + PBKDF2-SHA256 at 200000 iterations, "Salted__" header, base64 on one line. This is the same as NRW `chat.sh` and the GPS-Tracker status link, which was verified with OpenSSL 3.0.13.
- **What is sent:**
  - Live sends only what was said (`kind: live`).
  - Other features send their full prompt.
  - The answer can be plain text or the same JSON as Live (`reply`, `reminders`, `open`).
- **README:** a section "ช่องทางคุยผ่านไฟล์ MD บน GitHub" defines the format (v1) for whichever AI answers later.
- **Live:** shows "รอ AI ภายนอกตอบในไฟล์ MD (10 วินาที–1 นาทีขึ้นไป)" while waiting. The page's own timeout is 6.5 min, so the channel's 5-minute message arrives first.

### Checks
- The answer-section parser was tested in Java against a sample file: it finds the answer with its id, ignores metadata lines, and does not match a question that has no answer.
- Browser test with a mock bridge:
  - settings box with the default path;
  - key generation;
  - the Live status text;
  - a job sent with format githubmd, the repo, path and spoken text;
  - the answer spoken;
  - no secrets in the saved settings.
  - No errors and no sideways scrolling. The earlier tests still pass.
- Java compiles in CI.
- Not tested:
  - against a real repo (no token here);
  - with a real answering AI;
  - on the phone.

## 2026-11-16 (later): a clear way back to the Live home screen

The owner said there was no button to go back to the home screen after leaving Live; the only way was the menu.
- **Android Back:** it now closes the menu if it is open, and otherwise returns to Live from any page. On Live, Back leaves the app as before.
- **Page title:** on other pages the title shows "‹ <page>". Tapping it returns to Live.
- **Checks:** browser test of Back on Live (not handled), Back from Settings (returns to Live), tapping the title from Reminders (returns to Live), and Back with the menu open (closes it). No errors.

Owner phone notes from the same session:
- Play Protect blocked v1.0.12 at first; the owner went ahead and installed it.
- The Termux "Run commands" permission does not appear for this app. The Termux build seems to be the Play Store one (its welcome text points to doc.termux.com). So for now Ollama is started by hand in Termux, and it was already running.

## 2026-11-16 (later): the "ล้าง" button did nothing

**Report:** the owner said the clear button under the conversation log did not clear anything.

**Cause:** the WebView had no `WebChromeClient`. Without one, Android shows nothing for the page's `confirm()` and returns false at once, so "ล้างบันทึกการสนทนาทั้งหมด?" was always treated as "no". The same bug hit "สร้างกุญแจใหม่", which also asks first when a key already exists.

**Fix:** a `WebChromeClient` that shows `confirm()` and `alert()` as Android dialogs, with "ตกลง" and "ยกเลิก" buttons. They are dark, like the app theme.

**Checks:** the Java compiles in CI. The dialog itself shows only on the phone; it cannot be seen in the browser test.

**Note:** GPS-Tracker has the same gap. Its "ลบ token และกุญแจ" button uses `confirm()` too. It is not fixed yet; it is left for that app's next change.

## 2026-11-16 (later): turning Live off no longer throws the answer away

**Owner's point:** Live is only the voice way in and out. The thinking belongs to the conversation log. After Live is turned off, the phone is still thinking, and the answer should land in the log.

**Before:** turning Live off cleared the waiting job, so a late answer was silently dropped. The local AI cannot be stopped mid-answer, so the work was wasted.

**Now:**
- **While the AI works:** the conversation log shows a "ตอบ · กำลังคิด… N วินาที" row, whether Live is on or off.
- **When the answer arrives:**
  - it is always written in the log, and any reminders or page requests are applied;
  - it is spoken only if Live is still on.
- **Late answers:**
  - an answer that arrives after the 5-minute "no answer" message is ignored, so the log does not get it twice;
  - an answer to a question from before the app was reopened is still logged.

**Checks:** browser test with a mock bridge.
- Thinking row shown, and still shown after Live is switched off.
- The late answer is logged and not spoken, and the thinking row is removed.
- The earlier tests still pass with no errors.
