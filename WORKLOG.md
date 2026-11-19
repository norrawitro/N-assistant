
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

## 2026-11-17: say clearly when Termux cannot be commanded

**Request:** relayed by Manager. Continue what is left without waiting for the owner. Both items Manager listed were already released:
- the Live-off answer: v1.0.18;
- the MD-on-GitHub channel: v1.0.12.

**What remained:** on the owner's phone, "ขอสิทธิ์สั่ง Termux" did nothing. That Termux build does not offer the `RUN_COMMAND` permission to other apps, so Android shows no prompt, and the permission is missing from the app's settings.

**Fix:**
- **Detecting the case:** the app checks whether Android knows the permission at all (`getPermissionInfo`).
- **When it does not, Settings:**
  - say that this Termux, probably the Play Store one, does not allow other apps to give it commands;
  - say to start `termux-wake-lock; ollama serve` by hand;
  - say that switching to Termux from F-Droid or GitHub enables auto-start;
  - hide the permission and start buttons.
- **The permission button itself** now explains this instead of staying silent.

**Checks:** a browser test with a mock bridge shows the message and the hidden buttons. CI compiles the Java.

**Not tested** on the phone.

## 2026-11-17: a quick rule-based bot in front of the AI

**Owner's request:** a bot that is always there and answers at once with plain logic. Simple questions get an instant answer; complex ones go to the AI. While the AI works on its first answer, the bot keeps talking with the owner and can ask for more information.

### What was built
- **`bot.js` (new, rules only, no AI).** It answers at once:
  - **Time and date:** "กี่โมง", "วันนี้วันอะไร", "พรุ่งนี้วันอะไร".
  - **Reminders:** it reads Thai times ("8 โมง", "แปดโมง", "บ่าย 3", "2 ทุ่มครึ่ง", "14:45", "อีก 20 นาที"), days (วันนี้, พรุ่งนี้, มะรืน) and repeats (ทุกวัน, ทุกสัปดาห์, จันทร์ถึงศุกร์).
    - If the time or the subject is missing, the bot asks for it ("ให้เตือนกี่โมง", "ให้เตือนเรื่องอะไร") and uses the next thing said. "ยกเลิก" drops it.
    - A reminder sentence that needs thought ("ควร…", "ตอนไหนดี", "แนะนำ…") goes to the AI instead.
  - **Other instant answers:** list the next reminders, open a page, small sums ("12 คูณ 4"), greetings and thanks, "ทำอะไรได้บ้าง", "ได้ยินไหม".
  - **Control:** "หยุด" turns Live off. While the AI is busy, "เสร็จหรือยัง" gives the elapsed time and "ยกเลิก" drops the AI question.
  - Anything else returns null and goes to the AI.
- **Live flow (page):**
  - The bot is tried first. If it has no rule, the question goes to the AI and the bot says so at once.
  - **The microphone stays open while the AI thinks.** Before, it was closed until the AI answered.
  - Simple questions asked meanwhile are answered by the bot.
  - Other things said meanwhile are kept as extra information. After the first AI answer they are sent to the AI as the next question, with the first answer in the history.
  - When the AI answer arrives it is spoken, even if the app was listening at that moment.
- **Voice loop (`LiveVoice`):**
  - Speaking can now start at any time. It stops the recognizer first, so the app does not hear itself, and queues behind speech still in progress.
  - Listening resumes when all speech has finished.
  - If the page does not answer within 4 s, listening resumes anyway.
- **Conversation log:** entries are labelled "บอทตอบทันที" or "AI ตอบ". The thinking row shows how many extra messages are waiting.
- **AI prompt:** the history now holds only the person and the AI. The bot's instant answers are left out, which keeps the prompt short.
- **Mode button:** renamed "บอท + AI". "พูดซ้ำ (ทดสอบ)" is unchanged.

### Checks
- **Bot rules:** 34 cases in Node, all pass:
  - times, days and repeats;
  - missing time, then answered;
  - missing subject, then answered;
  - cancel, sums, pages;
  - sentences that must go to the AI.
- **Browser test with a mock bridge:** all of these work, with no errors and no sideways scrolling.
  - an instant answer with no AI job;
  - a reminder in two turns;
  - a complex question sent to the AI;
  - the status line while listening;
  - a bot answer while the AI is busy;
  - extra information queued, then sent as a follow-up with the first answer in its history;
  - cancel and stop.
- **Earlier tests:** three had to be changed, because they used "สวัสดี" and "วันนี้วันอะไร", which the bot now answers itself. With AI-type sentences they pass.
- **Not tested on the phone:** hearing while the AI thinks, and speaking the AI answer in the middle of listening.
- **Not released.** The owner stopped the last merge, so this stays on the branch (PR #9) until they say to release.

## 2026-11-17 (later): notes in the quick bot

**Owner's request:** make the answering algorithm smarter: it should take notes and be able to say what has been noted.

### What was built (no AI needed)
- **Saying "จดว่า…", "จดบันทึกว่า…", "บันทึกว่า…", "จำไว้ว่า…" or "ช่วยจดไว้หน่อยว่า…"** saves a note. The bot answers "จดแล้วครับ …".
  - **No text after it** ("จดบันทึกหน่อย"): the bot asks "จะให้จดว่าอะไรครับ" and saves the next thing said. "ยกเลิก" drops it.
- **Saying "มีอะไรจดไว้บ้าง", "จดอะไรไว้บ้าง" or "อ่านบันทึก"** makes the bot say how many notes there are, then read the latest 5.
- **Saying "หาบันทึกเรื่อง…", "มีบันทึกเรื่อง…ไหม" or "เคยจดเรื่อง…ไว้ไหม"** searches the notes. The bot reads up to 3 matches, with when each was noted. If nothing matches, it says so.
- **Saying "ลบบันทึกล่าสุด"** removes the newest note.
- **Live screen card "สิ่งที่จดไว้":**
  - a text box to type a note;
  - the list of notes, newest first, each with its time and a × button to delete it (asks first).
- **Storage:** notes live with the other app data on the phone. They are included in the JSON backup, in its import (merged, no duplicates), and in the Markdown export.
- **AI:** the latest 15 notes go into the AI prompt, so the AI can use them when they are relevant.
- **"ทำอะไรได้บ้าง":** the answer now mentions notes.

### Checks
- **Bot rules (Node):** 21 note cases pass, including cases that must still go elsewhere: "บันทึกวันนี้เป็นอย่างไรบ้าง" goes to the AI, and reminders still go to reminders. The earlier 34 cases still pass.
- **Browser test with a mock bridge:**
  - notes saved by voice, including the two-step ask and answer;
  - list, search with a match, search with no match;
  - delete the latest note;
  - type a note, delete one from the list;
  - notes present in the AI prompt and in the JSON export;
  - notes still there after a reload.
  - No errors and no sideways scrolling. The earlier bot and AI test still passes.
- **Not tested** on the phone.

## 2026-11-17 (later): close matches ("คำใกล้เคียง")

**Owner's request:** if a sentence holds the words the bot knows, but in another order or with other words ("จดอะไรบ้าง", "บันทึกอะไรใว้"), link it to the real command. Then say "ถ้าหมายถึง … ก็คือ (the real answer)".

### What was built (bot.js, still no AI)
- **Normalizing first:** common misspellings and variants are fixed before any rule runs: ใว้→ไว้, ใหม→ไหม (at the end of a question), มั้ย/มั๊ย→ไหม, โน๊ต→โน้ต, and a few typos.
- **Close-match layer:** it runs after the exact rules and before the AI.
  - **Word groups.** Each group stands for one idea:
    - note: จด, บันทึก, โน้ต, เมโม;
    - what: อะไร, เรื่องไหน;
    - all: บ้าง, ทั้งหมด, รายการ;
    - show: ดู, อ่าน, ทวน, เช็ค, บอก, ฟัง;
    - find: หา, ค้น, มี…ไหม, เคย;
    - about: เรื่อง, เกี่ยวกับ;
    - delete: ลบ, ทิ้ง;
    - last: ล่าสุด, เมื่อกี้;
    - reminder: เตือน, อลาร์ม, นัด;
    - time;
    - date.
  - **Order does not matter.** An intent fires when the sentence holds the ideas it needs:
    - note + (what / all / show) → list notes;
    - note + (about / find) + a subject → search notes;
    - note + delete → delete the latest;
    - reminder + (what / all / show) without a time → list reminders;
    - time or date words → say the time or the date.
  - **The bot names what it understood.** A close match is answered as `ถ้าหมายถึง "<the real command>" ก็คือ <answer>`.
  - **Guard:** long sentences (over 45 characters) and thinking words skip this layer and go to the AI. Thinking words are ควร, ยังไง, อย่างไร, สรุป, แนะนำ, ตอนไหน and similar.
- **Exact rule fixed:** "มีโน้ตแอร์ไหม" (a subject plus ไหม) is now a search, not the whole list.

### Checks
- Node: 21 close-match cases pass:
  - the owner's examples;
  - other word orders;
  - searches by subject;
  - delete;
  - reminders, time and date;
  - four sentences that must still go to the AI.
- The earlier 34 bot cases and 21 note cases still pass.
- Browser test with a mock bridge: close matches are spoken with the "ถ้าหมายถึง" prefix, an exact command has no prefix, and a thinking question still goes to the AI. No errors.
- Not tested on the phone.

## 2026-11-17 (later): one place for everything, no duplicate notes store

**Owner:** the separate "สิ่งที่จดไว้" store duplicated what the app already had. They asked me to find what exists and connect Live to it, and approved the proposal.

### What changed
- **Separate notes store removed.** What Live writes now goes into each day's existing fields:
  - "จดว่า…" goes to evening "อัปเดตวันนี้";
  - "จดว่าพรุ่งนี้ต้อง…" goes to evening "ยกไปพรุ่งนี้", and the next morning plan already reads it;
  - "วันนี้มีงาน…" or "งานวันนี้…" goes to morning "งานวันนี้";
  - a sentence with a time is still a reminder.
  - Each written line starts with "• ". The bot says which field it used.
- **"มีอะไรจดไว้บ้าง" (and close matches)** reads today's tasks, update and carry-over, plus the next two reminders.
- **"หาบันทึกเรื่อง…"** searches every day's tasks, worries, updates, wins and carry-overs, newest first, and says the day and the field.
- **"ลบบันทึกล่าสุด"** removes the last line Live wrote, or else the last line of today's update.
- **"ขอแผนวันนี้" / "วางแผนวันนี้"** starts the existing morning AI plan.
- **The typed assistant chat is merged into the Live conversation.**
  - A text box under the log takes typed questions and commands. They go through the same bot, then the AI, and are labelled "พิมพ์". They are spoken only when Live is on.
  - The menu item "ผู้ช่วย" became "พิมพ์คุยกับผู้ช่วย" and focuses that box.
  - The old chat page and its code are kept, only unreachable from the menu.
- **Migration, once, on start:**
  - notes from v1.0.23-1.0.25 move into the "อัปเดตวันนี้" of the day each was written, and the old store is removed;
  - old chat messages are copied into the Live log in time order.
  - A v1.0.23-1.0.25 JSON backup with `notes` is migrated the same way when imported.
- **AI prompt:** it now holds today's tasks, update and carry-over instead of the notes list.
- **Notes removed elsewhere:** the export no longer has a separate notes list, because notes are inside the days.

### Checks
- Node: all bot cases pass (34 + 27 + 21), including the new "วันนี้มีงาน…", "วันนี้มีงานอะไรบ้าง" and "ขอแผนวันนี้", and a trip-planning sentence that must still go to the AI.
- Browser test with a mock bridge:
  - old notes and old chat migrated;
  - voice notes landing in the right fields, which are visible on the evening page;
  - read back, search across days, delete the last line;
  - the plan request starting the brief job;
  - the menu focusing the typing box;
  - a typed question answered by the bot, and another sent to the AI with today's log in the prompt.
  - No errors and no sideways scrolling. The earlier Live tests pass.
- Not tested on the phone.

## 2026-11-17 (later): knowledge base ("คลังความรู้")

**Owner:** connect the system to a knowledge base, perhaps as files about different subjects, so that anything asked can be answered.

### What was built
- **`kb.js` (new, no AI):** splits each file into pieces of about one paragraph, under its nearest Markdown heading.
  - **Search** compares overlapping letter pairs (bigrams), so it works on Thai text without spaces. Rarer pairs count more.
  - Question and polite words are removed first, and a few words that mean the same are unified (กิน/ทาน, รถยนต์/รถ, โทรศัพท์/เบอร์, คุณแม่/แม่).
  - Each result has a "cover" (the share of the question found) and a score.
  - `bestLines` picks the line(s) of a piece that answer best, for a short spoken answer.
- **Menu "คลังความรู้" page:**
  - import .md / .txt files (several at once, up to 2 MB each);
  - type a new topic, with a title and `#` headings;
  - a search box to try questions;
  - the list of topics, with source, size and date, each deletable.
- **Live:**
  - **Answer straight from the base.** When the bot has no rule and the best piece covers at least 60% of the question, the bot answers from it at once: "จากคลังความรู้ เรื่อง… …". No AI is used.
  - **Pass pieces to the AI.** Otherwise the up to 3 pieces covering at least 30% go into the AI prompt, which is told to answer from them and say so.
  - **"สอนว่า…" / "เพิ่มความรู้ว่า…"** adds a line to a topic "สิ่งที่สอนด้วยเสียง".
  - **"ค้นคลังความรู้เรื่อง…"** searches the base. "เปิดคลังความรู้" opens the page.
- **File picker:** the WebView now has a file picker (`onShowFileChooser`). Before this, `<input type=file>` did nothing in the app, which also affected the old "นำเข้าไฟล์ JSON".
- **Backup and storage:** the base is in the JSON backup and its import. Everything stays on the phone.
- **Bot fix:** "แมวชื่ออะไร" was taken as "what is your name". That reply now needs คุณ/เธอ, or the sentence to start with ชื่ออะไร.

### Checks
- Node, search on sample files (house, car, health): 10 questions. The 8 that should be found are on top with enough cover, and 2 unrelated questions fall below the threshold.
- All bot rule tests pass.
- Browser test with a mock bridge:
  - file import (2 files → 3 pieces), a typed topic, and the search box;
  - Live answering 4 questions straight from the base with the right line, and nothing sent to the AI;
  - "สอนว่า…" then asking about it;
  - pieces passed to the AI for a related question needing thought;
  - export, and the base still there after a reload.
  - No errors and no sideways scrolling.
- **Test-tool note:** the browser tool could not attach files with Thai file names, so ASCII names were used. On the phone the system picker gives the file directly.
- **Not tested on the phone:** the file picker and real files.

## 2026-11-18: read aloud ("อ่านออกเสียง") and answer memory

**Requests:**
- **Read aloud:** relayed by Manager from the owner, then confirmed by the owner in this session. Add a read-aloud menu like the owner's offline tts-app:
  - paste & play, play/stop, clear;
  - karaoke highlight;
  - speeds x1, x1.5, x2 and x3, default x2;
  - on-device Thai TTS only;
  - every button visible on a phone (the standalone tts-app lost buttons when its controls moved to the top).
- **Background reading:** the owner answered yes to reading on with the screen off or the app in the background.
- **Answer memory:** the owner answered yes. Remember what the AI answered and reuse it next time, without the AI.
- **Release:** none until the owner says so.

### Read aloud
- **`ReadAloudService` (new):** a foreground service of type mediaPlayback.
  - It uses the phone's TextToSpeech in Thai, with the media audio stream. There is no internet and no server.
  - It queues the sentences one by one, with ids `session:index`. A restart, a new speed or a tap on another sentence ignores callbacks from the previous run.
  - A partial wake lock (at most 3 hours) keeps it reading with the screen off.
  - Its notification shows "ประโยคที่ N จาก M · ความเร็ว xR". It has a "หยุด" button and opens the read page.
- **Menu ☰ → "อ่านออกเสียง" page:**
  - A text box (the text is remembered).
  - The sentences under it, one tappable span each. The one being read is highlighted, earlier ones are dimmed, and it scrolls along. Tapping a sentence reads from there.
  - **Splitting:** at line breaks, at sentence ends, and at ๆ/ฯ followed by a space. Long Thai runs are cut at a space near 120 characters.
- **Control bar fixed to the BOTTOM of the screen** (above the system navigation and safe area):
  - "วางและเล่น", "เล่น/หยุด" and "ล้าง" on one row;
  - x1, x1.5, x2 and x3 on the next (default x2, remembered).
  - Changing the speed while reading restarts the current sentence at the new speed.
  - The bar shows only on this page.
- **Clipboard:** "วางและเล่น" reads it through Android's ClipboardManager (bridge `clipboardText`), with the WebView clipboard as a fallback.
- **One voice at a time:** starting to read turns Live off, and starting Live stops reading.
- **Returning to the app** while reading in the background shows the current sentence (`readStatus`).
- **Manifest:** `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, and the service.

### Answer memory
- **What is kept:** every plain AI answer in Live (no reminder set, no page opened) is stored as question → answer. The newest 500 are kept on the phone, and they are in the JSON backup and its import.
- **When it answers:**
  - Before asking the AI, after the bot rules and the knowledge base, a remembered question that matches the new one both ways (80% or more) is answered at once: "เคยตอบไว้เมื่อ <date> ว่า …". A use counter goes up.
  - Matching both ways keeps a short memory from answering a longer question.
- **Not remembered:**
  - questions about now or a date (วันนี้, ตอนนี้, พรุ่งนี้, กี่โมง…);
  - weather, prices, gold, shares, news, scores;
  - commands (เตือน, ตั้ง, เปิด, ปิด, จด, บันทึก, ลบ);
  - follow-up "extra information" questions;
  - errors.
- **"ถาม AI ใหม่" / "ถามเอไออีกที" / "ถามใหม่"** sends the last question to the AI again, skipping memory. The new answer replaces the old one.
- **Managing it:** the knowledge page has a "คำตอบที่จำไว้" card: the list with the question, answer, date and uses; × deletes one; "ล้างทั้งหมด" clears all.

### Checks
- **Browser, read aloud, at 320×568, 360×640 and 400×860:**
  - every one of the 7 buttons is inside the screen and at least 44×40 px;
  - paste & play reads the clipboard, splits 3 sentences and highlights the one being read;
  - x3 restarts the current sentence; stop; a tap on sentence 3 starts there; clear;
  - the speed is remembered after a reload;
  - the bar is hidden on Live;
  - no errors and no sideways scrolling.
- **Browser, answer memory:**
  - first ask → AI; the same question and a close one → memory, no AI;
  - a different question → AI;
  - "ถาม AI ใหม่" → AI again, and the new answer replaces the old one;
  - a question with "วันนี้" is not remembered; an answer that set a reminder is not remembered;
  - the list and delete work.
- **Node:** every bot rule test passes, with the "ถาม AI ใหม่" forms added.
- **Not tested on the phone:**
  - the service with the screen off;
  - the notification Stop button;
  - real Thai TTS at each speed;
  - the clipboard.

## 2026-11-18 (later): reminders by place, using GPS-Tracker

**Owner:** link N-assistant to GPS-Tracker to know where the phone is and remind by place. Example: driving out of home → "อย่าลืมเติมน้ำมันรถ".

### What changed
- **`PlaceEvents` receiver (new):**
  - Takes GPS-Tracker's enter/leave/fix/stopped broadcasts. They are protected by the signature permission `com.norrawitro.gpstracker.permission.PLACE_EVENTS`, declared in both apps.
  - Keeps where the phone is now: place, since when, last update, and the saved place names.
  - Shows a high-priority notification for each matching place reminder, e.g. "ออกจากบ้าน" / "อย่าลืมเติมน้ำมันรถ".
- **Reminders page, new card "เตือนตามสถานที่":**
  - where the phone is now;
  - a form: what to remind, when (ออกจาก / ถึง), and the place, with a picker of GPS-Tracker's saved names;
  - the list, each item deletable;
  - a warning when a name is not one of GPS-Tracker's places.
  - The rules are stored with the app data and copied to native for the receiver. They are in the JSON backup and its import.
- **Quick bot:**
  - "ออกจากบ้านเตือนให้เติมน้ำมันรถ", "เตือนให้เติมน้ำมันเมื่อออกจากบ้าน", "ถึงที่ทำงานเตือนให้…" and "พอกลับถึงบ้านเตือนว่า…" make a place reminder.
  - "ตอนนี้อยู่ที่ไหน" says the current place and how old the information is.

### Limits
- GPS-Tracker must be recording.
- Events come at its fix interval, so a reminder can be late by up to one interval.
- Place names must match GPS-Tracker's names (spaces and case are ignored).

### Checks
- Node: 9 place / where cases pass, including that "กุญแจสำรองอยู่ไหน" is not a where question. All earlier bot tests pass.
- Browser test with a mock bridge:
  - where now;
  - voice place reminders, including one for an unknown place with a warning;
  - the page card with the picker, the form and delete;
  - the native copy of the rules;
  - a live event updating the page.
  - No errors and no sideways scrolling. The read-aloud and memory tests still pass.
- Not tested on the phone: the broadcast from GPS-Tracker, and the notification.

## 2026-11-18 (later): wake word, and "read what I copied" in Live

**Owner:**
- **Wake word:** use a wake word to call the assistant to ask a question or take a note. No API key, because N-assistant itself does the work. The owner presses the power button first, then says the wake word.
- **Clipboard:** in Live, ask it to read aloud the text copied to the clipboard.

### Wake word
- **`WakeWordService` (new):** a foreground service of type microphone. It is started from the Live screen, because Android only allows a microphone service to start while the app is visible.
  - It listens only while the screen is on, for 30 s after the screen turns on (the power button), with the phone's own speech recognizer in Thai.
  - When the screen goes off, it stops listening at once.
  - While Live itself has the microphone, it leaves it alone. Starting Live pauses it.
- **Only the wake word counts:**
  - A sentence counts only if it **starts** with the wake word (up to 6 characters before it are allowed, e.g. "เฮ้"). The default word is "ผู้ช่วย" and can be changed on the Live screen.
  - Everything else is ignored, not stored, and not sent anywhere. A sentence with the word in the middle ("ฉันอยากได้ผู้ช่วยทำงานบ้าน") does not wake it.
- **When the wake word is heard:**
  - The app opens: straight away if it is on screen, otherwise through a full-screen intent, which opens over the lock screen because the activity already has showWhenLocked.
  - Live turns on in "บอท + AI" mode.
  - The rest of the sentence goes to the bot, then the AI, as if spoken in Live ("ผู้ช่วย จดว่าซื้อนม" writes the note). If only the wake word was said, it answers "ครับ ว่ามาเลย" and listens.
- **Notification:** "โหมดคำปลุกเปิดอยู่", with a "หยุดฟัง" button. If the service was killed, it starts again when the app comes on screen.
- **Manifest:** `FOREGROUND_SERVICE_MICROPHONE` and the service.

### Read the clipboard from Live
- **Commands:** "อ่านคลิปบอร์ด", "อ่านข้อความที่ก๊อปไว้ให้ฟัง" and "ช่วยอ่านที่คัดลอกไว้ให้ฟัง". They read Android's clipboard and open the read-aloud page, which starts reading (Live turns off, one voice at a time).
- **Empty clipboard:** the bot says so.

### Checks
- **Java:** the wake-word parsing was checked with sample sentences:
  - "ผู้ช่วย จดว่า…" and "ผู้ช่วยตอนนี้กี่โมง" give the rest;
  - the wake word alone gives "";
  - "เฮ้ผู้ช่วย ครับ …" strips the polite word;
  - other sentences, and the word in the middle, do not wake it;
  - a two-word wake word works.
- **Browser, with a mock bridge:**
  - the wake toggle on and off;
  - changing the word restarts the service with the new word;
  - a wake event with a command, from another page, opens Live, starts it and writes the note;
  - a wake with the word only is answered;
  - the clipboard is read into the read-aloud page and reading starts, and an empty clipboard is answered.
  - The earlier tests all pass.
- **Not tested on the phone:**
  - listening after the power button, and on the lock screen;
  - the full-screen open;
  - the recognizer's start beep.
- **Note:** on Android 14 the full-screen permission may need to be allowed in settings. The existing permission warning covers it.

## 2026-11-18 (later): read-aloud page reworked

**Owner asked for three changes:**
1. All controls at the top, with no button lost or off the frame.
2. One text box instead of two.
3. The sentence being read stays in the same place while the text moves up, so the highlight never goes off the screen.

### What changed
- **Controls at the top.** The bar sits at the top of the page and stays there (sticky) if the page scrolls.
  - **Row 1:** วางและเล่น, เล่น/หยุด, แก้ไข (new), ล้าง.
  - **Row 2:** x1, x1.5, x2, x3.
  - **Status line** under the rows.
  - The big clock header is hidden on this page to give the text room. The old bar fixed to the bottom is gone.
- **One box.** It is a text field while editing. While reading, the same box shows the sentences.
  - **"แก้ไข"** stops reading and goes back to the text field.
  - **"ล้าง"** empties the box and returns to editing.
  - The box fills the screen below the controls and is resized when the window changes.
- **Highlight held in place.** The sentence being read is kept at 30% of the box height; the text scrolls up under it. The box has space above the first sentence and below the last, so every sentence, the first and last included, reaches that line. Paragraph breaks show as line breaks.

### Checks
- **Browser, at 320×568, 360×640 and 400×860**, with a 41-sentence text:
  - all 8 buttons are fully on screen and at least 44×40 px, in editing, in reading, and after scrolling the page;
  - the box ends inside the screen, and only one of its two views shows at a time;
  - the highlighted sentence stays at the same height in the box at sentences 1, 6, 16, 31 and 41, and is always inside it;
  - "แก้ไข" returns to the text field;
  - no errors and no sideways scrolling.
- **Earlier tests:** the clipboard and wake-word tests still pass.
- **Note:** the test page shows the notification-permission warning above the controls. On a phone where that permission is allowed, the box gets more room.
- **Not tested** on the phone.

## 2026-11-18 (later): answer memory survives the page being closed

**Owner's question:** after Live is stopped, are questions still sent to the AI, with the answer awaited so the memory gets updated?

**Answer:** mostly yes. The AI job runs in `AiService`, and the answer is always written into the conversation log.

**Gap found:** which question a job belonged to was only kept in the page's memory. If Android closed the page while the AI was thinking, the answer still arrived and was logged when the app reopened. But it was not saved to the answer memory, and a cancelled question's late answer could show up again.

**Fix:**
- The questions sent to the AI are kept on the phone by job id (localStorage, entries older than a day are dropped).
- An answer that arrives after a reopen is matched to its question and remembered.
- A cancelled or timed-out job is marked, so its late answer is still ignored after a reopen.

**Checks:** a browser test with a mock bridge:
- ask, close and reopen the page with the answer waiting: the answer is logged;
- the same question then comes from memory;
- a cancelled question's answer after a reopen is ignored.
- The earlier memory and Live-off tests still pass.

## 2026-11-18 (later): going back to an older version

**Why:** the owner now lets every finished change be released at once, because "we can go back to an older version". GPS-Tracker had that button, N-assistant did not, so I added it, with the owner's go-ahead for improvements I see fit.

### What was built (Settings → "ย้อนกลับไปเวอร์ชันเก่า")
- **"ดูเวอร์ชันเก่า"** lists up to 15 older releases that have an APK (`Updater.olderReleases`, from the GitHub releases API). Each one says whether that version can restore a backup: v1.0.28 and later have a working "นำเข้าไฟล์ JSON".
- **Choosing a version** asks first, saying what is lost. Then:
  1. The app writes the full JSON backup (settings, reminders, place reminders, knowledge base, answer memory, all days) to `Documents/N-assistant/backup/` through MediaStore, so it survives the uninstall. API keys and tokens are not included. If the backup fails, nothing else happens.
  2. Live, read aloud and the wake word are stopped. The APK is downloaded into Download with Android's download manager, with progress shown.
  3. The steps are shown, with a "ถอนแอปนี้" button that opens Android's uninstall prompt (`REQUEST_DELETE_PACKAGES`). Then the owner installs the file from Download, and restores with ประวัติ → นำเข้าไฟล์ JSON.
- **If anything fails before the uninstall,** the app says so, and the data in the app is untouched.

### Checks
- Browser test with a mock bridge:
  - the list with restore notes;
  - the confirm;
  - the backup content, which has every section and no API key;
  - the download progress, then the ready steps with the backup path and file;
  - the uninstall call.
  - No errors and no sideways scrolling. The read-aloud and wake-word tests still pass.
- Java compiles in CI.
- Not tested on the phone.

## 2026-11-18 (later): built-in basic answers, and the memory as a text file

**Owner:**
- Put basic answers linked to basic questions into the app, so it works at a basic level from the start. It then learns more by talking: what it does not know goes to the AI once, and the answer is kept for next time.
- Is all memory inside the app? Can it be saved as a text file?

### Answers to the questions
- **Where the memory is:** everything is in the N-assistant app on the phone (WebView storage). Nothing is kept in the AI. The AI only receives the question and some context when asked.
- **Text file:** yes. Done below.

### Built-in basic knowledge (`faq.js`, new)
- **35 topics**, each with several ways of asking and one spoken answer:
  - what the assistant can do and how it learns;
  - how to use each feature: reminders, place reminders, notes, read aloud, wake word, knowledge base, going back a version, updates, AI settings, a slow AI, where data is kept;
  - small talk;
  - Thai emergency numbers (1669 medical, 191 police, 199 fire, 1155 tourist police);
  - simple facts that do not change: days in a year/week, hours in a day, km/m, mile, kg/lb, rai/ngan/wa, boiling point, water per day, hours of sleep, the capital of Thailand.
- **Order in Live:**
  1. bot rules;
  2. knowledge base;
  3. answer memory;
  4. **basic knowledge**;
  5. the AI.
  The owner's own data always comes first, and the basics are the floor.
- **Matching** uses the same letter-pair search, both ways, and the weaker direction must reach 75%. A few filler words (จะ, วิธี, วิธีการ, ต้อง, เลย…) are ignored. So "ตั้งเตือนยังไงครับ" and "วิธีการตั้งเตือน" find the how-to, while "ตั้งเตือนพรุ่งนี้แปดโมง…" still sets a reminder.
- **Knowledge page:** a "ความรู้พื้นฐานในแอป" card lists them.

### Memory as a text file
- **Writing it:** every change to the answer memory rewrites `Documents/N-assistant/ความจำ.md` (Markdown: date heading, then "ถาม: …" and "ตอบ: …"), a moment after the change. It goes through MediaStore and overwrites the same file (bridge `writeTextFile`).
- **Reading it back:** importing a file with "ถาม:/ตอบ:" pairs on the knowledge page (for example an edited ความจำ.md) puts them back into the memory. An existing question gets its answer replaced; new ones are added.

### Checks
- Node: 14 basic-knowledge cases pass, including reworded questions and 4 that must not match (trip planning, gold price, a real reminder, nautical mile).
- Browser test with a mock bridge:
  - a how-to and the emergency numbers answered with no AI job;
  - a real reminder still set;
  - an AI answer written to ความจำ.md;
  - an edited memory file imported (2 pairs, one answer replaced);
  - both answered from memory afterwards.
  - No errors and no sideways scrolling. The earlier tests still pass.
- Not tested on the phone, including the file in Documents.

## 2026-11-18 (later): microphone light in Live

- While Live listens, the LIVE button's ring glows brighter the louder the sound, and changes colour:
  from blue-green (soft or low voice) to orange (loud or high voice). It goes out after 0.7 s without sound.
- Loudness comes from the phone's speech recognizer (`onRmsChanged`). Pitch only when the recognizer also hands over
  the raw sound (`onBufferReceived`, zero-crossing estimate); most phones do not, and then the colour follows loudness.
- Not tested on a real phone yet.

## 2026-11-18 (later): wake word without the repeated "ting"

- The owner heard a listening tone again and again, and saw the microphone icon. Cause: wake-word mode listens for
  30 s after each screen-on and restarts the phone's recognizer every few seconds; many recognizers play a tone on
  each start. Now the music, notification and system streams are muted for 0.9 s around each start (streams already
  muted are left alone) and always unmuted when the window closes.
- The microphone icon in the status bar is Android's own privacy sign while any app listens; it cannot be hidden.
  Turning wake-word mode off (Live page) stops both.

## 2026-11-18 (later): AI answers that never arrived

- The owner reported never getting an answer from the AI. Found in the code:
  - After 5 minutes the page gave up on a Live question and **threw away** the answer when it came later, while the
    background request waits up to 10 minutes (a 4B model on a phone can take that long). Now the page stops
    holding Live after 5 minutes but keeps the question; a late answer goes into the conversation log, under
    "คำตอบที่มาช้าของ …", and into answer memory. Only "ยกเลิก" still discards an answer.
  - AiService used notification ids 4300/4301, the same as the wake-word service; finishing an AI job removed the
    wake-word notification. Now 4100/4101.
- New in Settings: "ทดสอบ AI" saves the settings and sends a short real question through the same path as Live,
  then shows the reply and the seconds it took, or the exact error.

## 2026-11-18 (later): Ollama buttons that did nothing

- "ทดสอบการเชื่อมต่อ" and "เปิด Ollama ตอนนี้" stayed greyed out with no message on the owner's phone. Both ask
  Ollama through `localRequest`, which shared one background thread with update checks and downloads and waited
  up to 10 minutes. Now: its own threads, a 15 s limit for the model list, and the page gives up after 20 s with a
  message, so a button never hangs.
- "Model not found" now names the models Ollama does have (or says none are downloaded yet).

## 2026-11-18 (later): read-aloud checklist from General (via Manager)

Checked ☰ → อ่านออกเสียง against the tts-app checklist. Already passing: A1, A4-A8, A12, B1, B2, B4, B7, B8.
Fixed:
- A2: buttons read "▶ เล่น" / "■ หยุด"; "📋 วางและเล่น".
- A3: stopping clears the highlight at once (the place is kept, so เล่น carries on).
- A10: status shows "กำลังเตรียมเสียง…", then "พร้อมแล้ว · เสียง <name> (ไทย ไม่ใช้เน็ต)", and the voice while reading.
- B3: picks the best installed Thai voice that needs no network (`isNetworkConnectionRequired()` false, not
  "notInstalled").
- B5: no offline Thai voice → a button "ติดตั้งเสียงภาษาไทย" opens Android's voice install screen.
- B6: no speech engine at all → a button opens Speech Services by Google in the Play Store.
- A11 / edge-to-edge (targetSdk 35): the WebView now sits in a holder padded by the system bars, the camera cutout
  and the keyboard (adjustResize is ignored on Android 15). Read box minimum 100 px so it fits with the keyboard open.
  Checked in a browser at 360×640, at 130 % font and with a 300 px keyboard: every control visible, no sideways scroll.
- B9 (real sound on the owner's Tecno Pova 6 Pro) still needs the owner to try.

## 2026-11-19: custom AI (Tailscale address) would not connect

- The owner's custom provider is an OpenAI-style server reached by a `.ts.net` (Tailscale) address. The app adds
  `/chat/completions` itself, so a pasted full endpoint became `.../chat/completions/chat/completions` (404).
  Now a trailing `/chat/completions` is removed before use.
- Network failures other than "connection refused" and timeout used to surface as "งานไม่ถูกต้อง: …". Now: name not
  found, https/certificate failure and other I/O errors each get a plain message naming the host, with a reminder that
  `.ts.net` addresses work only while the Tailscale app is connected. The 404 message shows the full address tried.

## DRAFT, not built (2026-11-19): next steps, written while the AI quota is nearly used up

Nothing below is built. Pick one at a time when there is quota again.

**First, from the owner's phone (no code needed)**
1. Custom AI over Tailscale: on v1.0.50 press Settings → "ทดสอบ AI" and read the message. Base URL must end at `/v1`.
2. Real-phone checks still open: read aloud makes sound with the screen off (B9); wake word after the power button and on the lock screen; the wake-word "ting" is gone; the microphone light on Live; GPS-Tracker arrive/leave reminders reaching N-assistant; GPS-Tracker distance columns.

**Ideas, in the order I would do them**
1. Fuel reminder from distance (GPS-Tracker now records the day's distance): "remind me to refuel every N km", counted
   from the last refuel the owner reports ("เติมน้ำมันแล้ว"). Needs: running total across days in GPS-Tracker, a
   broadcast to N-assistant when the total passes N, a reminder text. Small.
2. GPS-Tracker: the same "ย้อนกลับไปเวอร์ชันเก่า" button N-assistant has (list releases, back up, uninstall flow).
3. Use less AI quota in the app: show how many AI calls were answered by the bot / knowledge base / memory / FAQ and how many went to the AI; widen the FAQ.
4. Mic light colour from pitch only works where the phone hands over raw sound; if it matters, measure the pitch ourselves from the microphone (needs a second audio reader beside the recognizer; check first that Android allows it).
5. Clean-up: today's GPS-Tracker CSV keeps its old header over the new distance columns; a header rewrite at midnight would fix it.

## 2026-11-19: wording while the AI thinks

- The bot's line while the AI works is now "ขอคิดสักครู่นะครับ" (was "ขอส่งให้เอไอคิดสักครู่นะครับ"); the first-time line starts "เรื่องนี้ขอคิดสักครู่นะครับ ระหว่างรอ …".

## 2026-11-19: AI status in the menu

- The ☰ menu now opens with "AI: <name>" and the last "ทดสอบ AI" result (ok + seconds, or the error), with the time.
  The result is kept on the phone (`nassistant.aiStatus`), so it is still there after a restart. If the AI setting was
  changed after the test, the menu says the test was made with the earlier setting.

## Noted, not built (2026-11-19): wait for silence before Live answers

- Owner's request: before Live answers, stay quiet for more than 3 seconds so we are sure the speaker has finished.
- Idea: hold the recognized text in LiveVoice and answer only after 3 s with no new speech; new words are added to the
  same phrase. Stop listening before answering. Recognizer errors while holding re-arm the 3 s timer.
- Status: the code change was made and then reverted at the owner's request ("แค่จดก็พอ"). Nothing is built or released.

## 2026-11-19: custom AI connected on the owner's phone

- The AI that now answers is the owner's own server at `wkw` (the Tailscale address `wkw.tail85b885.ts.net`), used
  through "ผู้ให้บริการอื่น" with a base URL ending at `/v1`. It works while the Tailscale app on the phone is connected.
- Not yet recorded: the model name and the reply time. The owner can read them from ตั้งค่า → ทดสอบ AI, or from ☰ menu.

## Noted, not built (2026-11-19): a how-to for the wkw AI

- Owner's request: know how to use every function of wkw. Nothing about wkw's functions is in the repo; the app only
  sends chat messages to its `/v1/chat/completions` and reads the reply text.
- Needed from the owner: wkw's documentation, or the output of its `/v1/models` list (from a phone or PC with Tailscale on).
- Then: write a how-to for wkw (in the app's help and here), covering only what wkw actually offers.
- Status: noted only. Nothing built.

## Noted, not built (2026-11-19): check that the person has finished before Live replies

- Owner's request, same idea as the 3-second quiet wait above: before Live answers, check that no person is still
  speaking (not only a quiet gap). Not built; the owner has not asked for a build yet.
