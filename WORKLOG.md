
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
