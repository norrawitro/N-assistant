
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
