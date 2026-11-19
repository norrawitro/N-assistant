(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const A = window.Android || null; // native bridge (absent when opened in a normal browser)
  const pad = n => String(n).padStart(2, "0");
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dateOf = k => { const [y, m, d] = String(k).split("-").map(Number); return new Date(y, m - 1, d); };
  const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const thDate = d => d.toLocaleDateString("th-TH", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const thShort = d => d.toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short" });
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------- storage (on this phone) ----------
  const LS_DOCS = "nassistant.docs";
  const LS_KEY = "nassistant.apikey";
  const LS_OTHER_KEY = "nassistant.apikey.other"; // key for the "other provider" option; stays on this phone
  const LS_MD_TOKEN = "nassistant.mdchat.token"; // GitHub token for the Markdown-file channel; stays on this phone
  const LS_MD_KEY = "nassistant.mdchat.key";     // AES key for the Markdown-file channel; stays on this phone
  const LS_PENDING = "nassistant.pending";
  let docs = lsGet(LS_DOCS) || {}; // "settings", "reminders", "day-YYYY-MM-DD"
  function save(id, body) { docs[id] = body; lsSet(LS_DOCS, docs); renderHistory(); schedulePrepSync(); }

  const DEFAULT_SETTINGS = { wake: "06:30", wakeOn: true, evening: "19:30", eveningOn: true, prepMinutes: 15, name: "", goals: "", provider: "local", localUrl: "http://127.0.0.1:11434", localModel: "qwen-fast:latest", model: "claude-opus-5-5", otherUrl: "", otherModel: "", mdRepo: "", mdPath: "chat/n-assistant.md" };
  const settings = () => ({ ...DEFAULT_SETTINGS, ...(docs.settings || {}) });
  const dayKey = date => "day-" + date;
  const todayDate = () => keyOf(new Date());
  const getDay = date => docs[dayKey(date)] || { date, morning: {}, evening: {} };
  const today = () => getDay(todayDate());
  function saveDay(date, patch) {
    const t = JSON.parse(JSON.stringify(getDay(date)));
    t.morning = { ...t.morning, ...(patch.morning || {}) };
    t.evening = { ...t.evening, ...(patch.evening || {}) };
    t.updatedAt = Date.now();
    save(dayKey(date), t);
  }
  const saveToday = patch => saveDay(todayDate(), patch);
  /** Every note on every saved day (tasks, updates, things for tomorrow), newest day first: [{date, kind, text}]. */
  function recentNotes(maxDays = 90) {
    const out = [];
    Object.keys(docs).filter(k => k.startsWith("day-")).sort().reverse().slice(0, maxDays).forEach(k => {
      const d = docs[k] || {}, date = k.slice(4), clean = t => t.replace(/^•\s*/, "");
      linesOf(d.morning && d.morning.tasks).forEach(t => out.push({ date, kind: "งาน", text: clean(t) }));
      linesOf(d.evening && d.evening.notes).forEach(t => out.push({ date, kind: "อัปเดต", text: clean(t) }));
      linesOf(d.evening && d.evening.tomorrow).forEach(t => out.push({ date, kind: "ยกไปพรุ่งนี้", text: clean(t) }));
    });
    return out;
  }
  const daysBefore = (date, n) => Object.keys(docs).filter(k => k.startsWith("day-") && k.slice(4) < date).sort().reverse().slice(0, n).map(k => docs[k]);

  // ---------- native events ----------
  const handlers = {};
  window.__native = (event, payload) => { try { handlers[event] && handlers[event](payload); } catch (e) { console.error(e); } };
  const nativeInfo = () => { try { return A ? JSON.parse(A.info()) : null; } catch { return null; } };

  // ---------- scales ----------
  function scale(el) {
    el.innerHTML = [1, 2, 3, 4, 5].map(n => `<button type="button" aria-pressed="false" data-v="${n}">${n}</button>`).join("");
    el.addEventListener("click", e => { const b = e.target.closest("button"); if (b) setScale(el, +b.dataset.v); });
  }
  const setScale = (el, v) => el.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.v === v)));
  const getScale = el => +(el.querySelector('[aria-pressed="true"]')?.dataset.v || 0) || null;
  scale($("mEnergy")); scale($("eMood"));

  // ---------- tabs ----------
  let currentTab = "live";
  const TABS = ["read", "kb", "live", "morning", "evening", "chat", "remind", "history", "settings"];
  const TAB_TITLE = { read: "อ่านออกเสียง", kb: "คลังความรู้", live: "Live", morning: "เช้า", evening: "เย็น", chat: "ผู้ช่วย", remind: "เตือน", history: "ประวัติ", settings: "ตั้งค่า" };
  function showTab(name) {
    if (!TABS.includes(name)) name = "live";
    $("viewTitle").textContent = name === "live" ? "Live" : `‹ ${TAB_TITLE[name]}`;
    currentTab = name;
    document.querySelectorAll("#menu [data-go]").forEach(b => b.toggleAttribute("aria-current", b.dataset.go === name));
    if (name === "live") renderConvo();
    $("readBar").hidden = name !== "read";
    document.body.classList.toggle("reading", name === "read");
    if (name === "read") { setReadMode(readSentences.length > 0); requestAnimationFrame(sizeReadBox); syncRead(); }
    document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    TABS.forEach(t => $("p-" + t).hidden = t !== name);
    if (name === "evening") renderChecks();
    if (name === "remind") { renderReminders(); readWhere(); renderPlaceRules(); }
    if (name === "chat") { renderChat(); setTimeout(() => $("chatLog").lastElementChild?.scrollIntoView({ block: "end" }), 50); }
    window.scrollTo(0, 0);
  }
  document.querySelector("nav").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab); });
  handlers.tab = name => showTab(name);

  // ---------- menu (all earlier features) and settings button ----------
  function setMenu(open) { $("menu").hidden = !open; $("menuBtn").setAttribute("aria-expanded", String(open)); if (open) renderMenuAi(); }
  // The AI in use, and what the last "ทดสอบ AI" found (kept on this phone so it is there after a restart).
  const AI_STATUS_KEY = "nassistant.aiStatus";
  function aiLastTest() { try { return JSON.parse(localStorage.getItem(AI_STATUS_KEY) || "null"); } catch { return null; } }
  function renderMenuAi() {
    const t = aiLastTest(), name = aiName();
    let line;
    if (!t) line = "ยังไม่เคยทดสอบ กดทดสอบ AI ในตั้งค่า";
    else if (t.ok) line = `ใช้ได้ · ตอบใน ${t.sec} วินาที · ทดสอบเมื่อ ${t.when}`;
    else line = `ไม่สำเร็จ: ${t.msg} · ${t.when}`;
    if (t && t.name !== name) line += "\n(ทดสอบกับการตั้งค่าก่อนหน้า)";
    $("menuAi").textContent = `AI: ${name}\n${line}`;
  }
  $("menuBtn").addEventListener("click", e => { e.stopPropagation(); setMenu($("menu").hidden); });
  $("menu").addEventListener("click", e => {
    const b = e.target.closest("[data-go]"); if (!b) return;
    setMenu(false);
    // The typed assistant chat now lives in the Live conversation (one place for voice and typing).
    if (b.dataset.go === "chatlive") { showTab("live"); setTimeout(() => { $("typeInput").scrollIntoView({ block: "center" }); $("typeInput").focus(); }, 50); }
    else showTab(b.dataset.go);
  });
  document.addEventListener("click", e => { if (!$("menu").hidden && !e.target.closest("#menu")) setMenu(false); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") setMenu(false); });
  $("settingsBtn").addEventListener("click", () => { setMenu(false); showTab("settings"); });
  $("viewTitle").addEventListener("click", () => { setMenu(false); if (currentTab !== "live") showTab("live"); });
  // Android Back: close the menu, else return to Live; on Live, let Android handle it (leave the app).
  window.__back = () => {
    if (!$("menu").hidden) { setMenu(false); return true; }
    if (currentTab !== "live") { showTab("live"); return true; }
    return false;
  };

  // ---------- Live: Thai speech in, the same words spoken back (round 1, no AI) ----------
  let liveJob = null; // the AI question in progress from Live: { id, at, timer, tick }
  const CONVO_KEY = "nLiveConvo";
  const CONVO_MAX = 300;
  let convo = [];
  try { convo = JSON.parse(localStorage.getItem(CONVO_KEY) || "[]"); if (!Array.isArray(convo)) convo = []; } catch { convo = []; }
  function saveConvo() { try { localStorage.setItem(CONVO_KEY, JSON.stringify(convo.slice(-CONVO_MAX))); } catch {} }
  const convoTime = t => new Date(t).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function renderConvo() {
    const ol = $("convo"); ol.textContent = "";
    if (!convo.length) { const li = document.createElement("li"); li.className = "convo-empty"; li.textContent = "ยังไม่มีบทสนทนา"; ol.appendChild(li); return; }
    convo.forEach(m => {
      const li = document.createElement("li"); li.className = m.who === "me" ? "me" : m.who === "note" ? "note" : m.who === "bot" ? "bot" : "app";
      const w = document.createElement("span"); w.className = "who"; w.textContent = `${m.who === "me" ? (m.typed ? "พิมพ์" : "ได้ยิน") : m.who === "note" ? "แจ้ง" : m.who === "bot" ? "บอทตอบทันที" : "AI ตอบ"} · ${convoTime(m.t)}`;
      const p = document.createElement("span"); p.textContent = m.text;
      li.append(w, p); ol.appendChild(li);
    });
    if (liveJob) { // the AI is still working on the last thing that was said, whether Live is on or off
      const li = document.createElement("li"); li.className = "app thinking"; li.id = "convoThinking";
      const w = document.createElement("span"); w.className = "who"; w.textContent = "AI · กำลังคิด" + (liveQueue.length ? ` · มีข้อมูลเพิ่มรอส่ง ${liveQueue.length} ข้อความ` : "");
      const p = document.createElement("span"); p.id = "convoThinkingText"; p.textContent = thinkingText();
      li.append(w, p); ol.appendChild(li);
    }
    ol.scrollTop = ol.scrollHeight;
  }
  function addConvo(who, text, extra) { convo.push({ t: Date.now(), who, text, ...(extra || {}) }); if (convo.length > CONVO_MAX) convo = convo.slice(-CONVO_MAX); saveConvo(); renderConvo(); }
  $("convoClear").addEventListener("click", () => { if (convo.length && confirm("ล้างบันทึกการสนทนาทั้งหมด?")) { convo = []; saveConvo(); renderConvo(); } });

  function setLive(on, state, message) {
    const sw = $("liveSwitch");
    sw.setAttribute("aria-checked", String(on)); sw.dataset.state = on ? state : "off";
    $("liveSub").textContent = !on ? "แตะเพื่อเปิด" : state === "speaking" ? "กำลังพูด" : state === "thinking" ? "กำลังคิด" : "กำลังฟัง";
    if (on && state === "thinking") message = thinkingText();
    if (on && state === "listening" && liveJob) message = listeningWhileThinking();
    if (message) $("liveStatus").textContent = message;
    else if (!on) $("liveStatus").textContent = "ปิด Live อยู่";
    if (!on || state !== "listening") { $("livePartial").textContent = ""; $("liveSwitch").classList.remove("hearing"); }
    if (!on) $("micInfo").textContent = "";
  }
  $("liveSwitch").addEventListener("click", () => {
    if (!A || !A.liveStart) { $("liveStatus").textContent = "Live ใช้ได้ในแอปบนมือถือเท่านั้น"; return; }
    if ($("liveSwitch").getAttribute("aria-checked") === "true") { A.liveStop(); setLive(false, "off", "ปิด Live แล้ว"); }
    else { if (readPlaying) setReadUi(false, "หยุดอ่าน (เปิด Live)"); setLive(true, "listening", "กำลังเปิดไมโครโฟน…"); A.liveStart(); }
  });
  handlers.live = p => {
    if (!p) return;
    // Turning Live off does not stop the AI: its answer still goes into the conversation log (it is not spoken).
    setLive(!!p.on, p.state, p.message);
  };
  // Microphone light: loudness sets the glow, pitch sets the colour. Without pitch (most phones) the colour follows
  // the loudness, from blue (soft) to orange (loud). The light goes out when no level has come for a moment.
  let micOff = null;
  handlers.liveLevel = l => {
    const sw = $("liveSwitch");
    // The room's average noise (พื้นเสียง) and the level right now, in dB as the phone reports them.
    if (l && sw.getAttribute("aria-checked") === "true") $("micInfo").textContent = `พื้นเสียง ${(+l.floor).toFixed(1)} dB · ตอนนี้ ${(+l.db).toFixed(1)} dB`;
    if (!l || sw.getAttribute("aria-checked") !== "true" || sw.dataset.state !== "listening") { sw.classList.remove("hearing"); return; }
    const lv = Math.max(0, Math.min(1, +l.loud || 0)), hz = +l.hz || 0;
    // 80 Hz -> 210 (blue), 400 Hz+ -> 20 (orange), on a log scale like the ear hears it.
    const hue = hz > 0 ? 210 - 190 * Math.max(0, Math.min(1, Math.log(hz / 80) / Math.log(5))) : 210 - 190 * lv;
    sw.style.setProperty("--mic-lv", lv.toFixed(2));
    sw.style.setProperty("--mic-hue", String(Math.round(hue)));
    sw.classList.add("hearing");
    clearTimeout(micOff);
    micOff = setTimeout(() => sw.classList.remove("hearing"), 700);
  };
  handlers.livePartial = t => { $("livePartial").textContent = t || ""; };
  handlers.liveHeard = t => {
    $("livePartial").textContent = "";
    addConvo("me", t);
    if (liveMode === "ai") handleHeard(t);
  };

  // ---------- what Live writes down goes into the day's existing fields (no separate notes store) ----------
  // "จดว่า…" -> evening "อัปเดตวันนี้" (notes); "พรุ่งนี้ต้อง…" -> evening "ยกไปพรุ่งนี้" (tomorrow);
  // "วันนี้มีงาน…" -> morning "งานวันนี้" (tasks). Each line starts with "• ".
  const FIELD = { notes: ["evening", "notes", "อัปเดตวันนี้"], tomorrow: ["evening", "tomorrow", "ยกไปพรุ่งนี้"], tasks: ["morning", "tasks", "งานวันนี้"] };
  let lastWritten = null; // { date, field, line } for "ลบบันทึกล่าสุด"
  const linesOf = v => String(v || "").split("\n").map(x => x.trim()).filter(Boolean);
  function appendToDay(field, text, date = todayDate()) {
    const [part, key] = FIELD[field], day = getDay(date), line = "• " + String(text).trim();
    const cur = String((day[part] || {})[key] || "").trim();
    saveDay(date, { [part]: { [key]: cur ? cur + "\n" + line : line } });
    lastWritten = { date, field, line };
    if (date === todayDate()) hydrate();
  }
  function removeLine(date, field, line) {
    const [part, key] = FIELD[field], lines = String((getDay(date)[part] || {})[key] || "").split("\n");
    const i = lines.map(x => x.trim()).lastIndexOf(line); if (i < 0) return false;
    lines.splice(i, 1);
    saveDay(date, { [part]: { [key]: lines.join("\n").trim() } });
    if (date === todayDate()) hydrate();
    return true;
  }
  /** Where a sentence belongs: tomorrow's carry-over, today's tasks, or today's update. */
  function noteField(text) {
    if (/^(พรุ่งนี้|วันพรุ่งนี้)/.test(text)) return "tomorrow";
    if (/^(วันนี้มี|งานวันนี้|นัดวันนี้)/.test(text)) return "tasks";
    return "notes";
  }
  const dayName = date => date === todayDate() ? "วันนี้" : date === keyOf(new Date(Date.now() - 864e5)) ? "เมื่อวาน" : dateOf(date).toLocaleDateString("th-TH", { day: "numeric", month: "long" });
  /** Searches every day's tasks, worries, updates, wins and carry-overs. Newest first. */
  function searchDays(q) {
    const qq = String(q).toLowerCase().trim(), parts = qq.split(/\s+/).filter(x => x.length > 1);
    const fields = [["morning", "tasks", "งาน"], ["morning", "worry", "เรื่องกังวล"], ["evening", "notes", "อัปเดต"], ["evening", "wins", "เรื่องดี"], ["evening", "tomorrow", "ยกไปพรุ่งนี้"]];
    const hit = [];
    for (const d of allDays().slice().reverse()) {
      for (const [part, key, label] of fields) {
        for (const line of linesOf((d[part] || {})[key])) {
          const l = line.toLowerCase();
          if (l.includes(qq) || (parts.length > 1 && parts.every(x => l.includes(x)))) hit.push({ date: d.date, label, text: line.replace(/^•\s*/, "") });
        }
      }
    }
    return hit;
  }
  /** One-time move of the separate notes store (v1.0.23-1.0.25) into each day's "อัปเดตวันนี้". */
  function migrateNotes() {
    const list = docs.notes && Array.isArray(docs.notes.list) ? docs.notes.list : [];
    if (!list.length) { if (docs.notes) { delete docs.notes; lsSet(LS_DOCS, docs); } return; }
    for (const n of list) {
      if (!n || !n.text) continue;
      const date = keyOf(new Date(n.at || Date.now())), day = getDay(date);
      const cur = String((day.evening || {}).notes || "").trim(), line = "• " + n.text;
      if (!linesOf(cur).includes(line)) saveDay(date, { evening: { notes: cur ? cur + "\n" + line : line } });
    }
    delete docs.notes; lsSet(LS_DOCS, docs);
  }

  // ---------- typing into the same conversation (replaces the separate chat page) ----------
  function sendTyped() {
    const v = $("typeInput").value.trim(); if (!v) return;
    $("typeInput").value = "";
    addConvo("me", v, { typed: true });
    if (liveMode === "ai") handleHeard(v);
    else liveReply(v, "app"); // echo mode just repeats, as with voice
  }
  $("typeSend").addEventListener("click", sendTyped);
  $("typeInput").addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); sendTyped(); } });
  /** One-time copy of the old assistant-chat history into the Live conversation, in time order. */
  function migrateChat() {
    try { if (localStorage.getItem("nassistant.chatMigrated")) return; } catch { return; }
    const old = (docs.chat && Array.isArray(docs.chat.messages)) ? docs.chat.messages : [];
    if (old.length) {
      const moved = old.filter(m => m && m.text).map(m => ({ t: m.at || Date.now(), who: m.role === "user" ? "me" : m.role === "note" ? "note" : "app", text: m.text, typed: m.role === "user" }));
      convo = [...convo, ...moved].sort((a, b) => a.t - b.t).slice(-CONVO_MAX);
      saveConvo();
    }
    try { localStorage.setItem("nassistant.chatMigrated", "1"); } catch {}
  }

  // ---------- read aloud: paste text, read with the phone's Thai voice, sentence highlighted (karaoke) ----------
  const READ_KEY = "nassistant.read";
  let readRate = 2, readSentences = [], readAt = -1, readPlaying = false;
  try { const r = JSON.parse(localStorage.getItem(READ_KEY) || "{}"); if ([1, 1.5, 2, 3].includes(r.rate)) readRate = r.rate; if (r.text) $("readText").value = r.text; } catch {}
  const saveRead = () => { try { localStorage.setItem(READ_KEY, JSON.stringify({ rate: readRate, text: $("readText").value.slice(0, 200000) })); } catch {} };
  /** Sentences: split at line breaks and sentence ends; long runs of Thai are cut at spaces near 120 characters. */
  function splitSentences(text) {
    const out = [];
    for (const block of String(text || "").replace(/\r/g, "").split(/\n+/)) {
      for (let part of block.split(/(?<=[.!?。…])\s+|(?<=[ๆฯ])\s+/)) {
        part = part.trim();
        while (part.length > 160) {
          let cut = part.lastIndexOf(" ", 120);
          if (cut < 40) cut = part.indexOf(" ", 120);
          if (cut < 0) cut = 160;
          out.push(part.slice(0, cut).trim()); part = part.slice(cut).trim();
        }
        if (part) out.push(part);
      }
      if (out.length && !out[out.length - 1].endsWith("\n")) out[out.length - 1] += "\n"; // paragraph end, shown as a line break
    }
    return out;
  }
  /** The box fills the screen below the controls; the line being read stays at one height (ANCHOR) in it. */
  const ANCHOR = 0.3;
  function sizeReadBox() {
    if ($("p-read").hidden) return;
    const box = $("readBox"), top = box.getBoundingClientRect().top;
    box.style.height = Math.max(100, Math.floor(window.innerHeight - Math.max(top, 0) - 12)) + "px";
    // Space above the first and below the last sentence, so every sentence can sit at the anchor line.
    const r = $("reader"), h = box.clientHeight;
    r.style.paddingTop = Math.round(h * ANCHOR) + "px";
    r.style.paddingBottom = Math.round(h * (1 - ANCHOR)) + "px";
  }
  window.addEventListener("resize", sizeReadBox);
  /** Shows the text field (editing) or the sentences (reading) in the one box. */
  function setReadMode(reading) {
    $("readText").hidden = reading; $("reader").hidden = !reading;
    $("readEdit").disabled = !reading;
    sizeReadBox();
  }
  function renderReader() {
    const box = $("reader"); box.textContent = "";
    readSentences.forEach((s, i) => {
      const sp = document.createElement("span"); sp.textContent = s + " "; sp.dataset.i = i;
      if (i === readAt) sp.className = "now"; else if (readAt >= 0 && i < readAt) sp.className = "done";
      box.appendChild(sp);
      if (/\n\s*$/.test(s)) box.appendChild(document.createElement("br"));
    });
  }
  function markSentence(i) {
    readAt = i;
    const r = $("reader");
    r.querySelectorAll("span").forEach((sp, k) => { sp.className = k === i ? "now" : (i >= 0 && k < i) ? "done" : ""; });
    const now = r.querySelector("span.now");
    // Keep the highlighted sentence at the same place on screen and move the text up instead.
    if (now) r.scrollTo({ top: Math.max(0, now.offsetTop - Math.round(r.clientHeight * ANCHOR)), behavior: "smooth" });
  }
  function setReadUi(playing, msg) {
    readPlaying = playing;
    $("readPlay").textContent = playing ? "■ หยุด" : "▶ เล่น";
    $("readPlay").classList.toggle("primary", playing);
    if (msg !== undefined) $("readStatus").textContent = msg;
  }
  function startReading(from = 0) {
    const text = $("readText").value.trim();
    if (!text) { setReadUi(false, "ยังไม่มีข้อความ วางข้อความก่อน"); return; }
    readSentences = splitSentences(text); setReadMode(true); renderReader();
    from = Math.max(0, Math.min(from, readSentences.length - 1));
    saveRead();
    if (!A || !A.readStart) { setReadUi(false, "อ่านออกเสียงใช้ได้ในแอปบนมือถือเท่านั้น"); markSentence(from); return; }
    if (liveOn()) { if (A.liveStop) A.liveStop(); setLive(false, "off", "ปิด Live แล้ว (กำลังอ่านออกเสียง)"); }
    $("readFix").hidden = true;
    A.readStart(JSON.stringify(readSentences), from, readRate);
    markSentence(from); setReadUi(true, `กำลังเตรียมเสียง… ความเร็ว x${readRate}`);
  }
  /** Stop at once: the highlight goes, the place is kept so "เล่น" carries on from that sentence. */
  function clearHighlight() { $("reader").querySelectorAll("span.now").forEach(sp => sp.className = ""); }
  function stopReading() { if (A && A.readStop) A.readStop(); clearHighlight(); setReadUi(false, "หยุดแล้ว กดเล่นเพื่ออ่านต่อ หรือแตะประโยคไหนเพื่ออ่านจากตรงนั้น"); }
  let readVoice = "";
  handlers.read = e => {
    if (!e) return;
    if (e.state === "playing") { markSentence(e.index); setReadUi(true, `ประโยคที่ ${e.index + 1} จาก ${e.total} · ความเร็ว x${readRate}${readVoice ? " · " + readVoice : ""}`); }
    else if (e.state === "done") { markSentence(-1); setReadUi(false, "อ่านจบแล้ว"); }
    else if (e.state === "stopped") { clearHighlight(); setReadUi(false, "หยุดแล้ว กดเล่นเพื่ออ่านต่อ หรือแตะประโยคไหนเพื่ออ่านจากตรงนั้น"); }
    else if (e.state === "ready") { readVoice = e.message || ""; setReadUi(true, `พร้อมแล้ว · ${readVoice} · ความเร็ว x${readRate}`); }
    else if (e.state === "novoice" || e.state === "noengine") {
      clearHighlight(); setReadUi(false, e.message);
      const b = $("readFix"); b.hidden = false; b.dataset.kind = e.state;
      b.textContent = e.state === "novoice" ? "ติดตั้งเสียงภาษาไทย" : "ติดตั้ง Speech Services by Google";
    }
    else if (e.state === "error") setReadUi(readPlaying, e.message || "อ่านออกเสียงไม่ได้");
  };
  $("readPaste").addEventListener("click", async () => {
    let t = "";
    try { t = A && A.clipboardText ? A.clipboardText() : ""; } catch {}
    if (!t) { try { t = await navigator.clipboard.readText(); } catch {} }
    if (!t || !t.trim()) { setReadUi(readPlaying, "คลิปบอร์ดว่าง คัดลอกข้อความมาก่อน"); return; }
    $("readText").value = t; startReading(0);
  });
  $("readFix").addEventListener("click", () => {
    if (!A) return;
    if ($("readFix").dataset.kind === "novoice") { if (A.installThaiVoice) A.installThaiVoice(); }
    else if (A.installSpeechEngine) A.installSpeechEngine();
    $("readFix").hidden = true; $("readStatus").textContent = "ติดตั้งเสร็จแล้วกลับมากดเล่นอีกครั้ง";
  });
  $("readPlay").addEventListener("click", () => { if (readPlaying) stopReading(); else startReading(readAt >= 0 ? readAt : 0); });
  $("readClear").addEventListener("click", () => {
    if (readPlaying) stopReading();
    $("readText").value = ""; readSentences = []; readAt = -1; renderReader(); saveRead();
    setReadMode(false); setReadUi(false, "ล้างแล้ว วางหรือพิมพ์ข้อความใหม่");
  });
  $("readEdit").addEventListener("click", () => {
    if (readPlaying) stopReading();
    setReadMode(false); $("readText").focus();
    setReadUi(false, "แก้ไขข้อความ แล้วกดเล่น");
  });
  $("reader").addEventListener("click", e => { const sp = e.target.closest("span[data-i]"); if (sp) startReading(+sp.dataset.i); });
  $("readText").addEventListener("input", () => { if (!readPlaying) { readSentences = []; readAt = -1; renderReader(); } saveRead(); });
  document.querySelectorAll("#readBar .speeds button").forEach(b => b.addEventListener("click", () => {
    readRate = +b.dataset.rate; saveRead();
    document.querySelectorAll("#readBar .speeds button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    if (readPlaying) startReading(Math.max(0, readAt)); // restart the current sentence at the new speed
    else $("readStatus").textContent = `ความเร็ว x${readRate}`;
  }));
  document.querySelectorAll("#readBar .speeds button").forEach(x => x.setAttribute("aria-pressed", String(+x.dataset.rate === readRate)));
  /** Back on screen while reading goes on in the background: show where it is. */
  function syncRead() {
    let s = null; try { s = A && A.readStatus ? JSON.parse(A.readStatus()) : null; } catch {}
    if (!s) return;
    if (s.playing) { if (!readSentences.length) { readSentences = splitSentences($("readText").value); renderReader(); } setReadMode(true); markSentence(s.index); setReadUi(true); }
    else if (readPlaying) setReadUi(false, "อ่านจบแล้ว");
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncRead(); });

  // ---------- knowledge base: files the owner imports or types; searched by the bot, given to the AI ----------
  const kbFiles = () => (docs.kb && Array.isArray(docs.kb.files)) ? docs.kb.files : [];
  let kbChunks = null; // built from the files when first needed
  function kbAll() {
    if (!kbChunks) { kbChunks = []; for (const f of kbFiles()) for (const c of NKb.chunk(f.title, f.text)) kbChunks.push({ ...c, file: f.id }); }
    return kbChunks;
  }
  function saveKb(files) { save("kb", { files, updatedAt: Date.now() }); kbChunks = null; renderKb(); }
  function addKbFile(title, text, source) {
    title = String(title || "").trim() || "ไม่มีชื่อ"; text = String(text || "").trim();
    if (!text) return null;
    const files = kbFiles().slice(), same = files.findIndex(f => f.title === title && f.source === source);
    const f = { id: same >= 0 ? files[same].id : uid(), title, text, source, at: Date.now() };
    if (same >= 0) files[same] = f; else files.push(f);
    saveKb(files);
    return f;
  }
  /** "สอนว่า…" adds a line to one file kept for things said aloud. */
  function learn(text) {
    const files = kbFiles().slice(), i = files.findIndex(f => f.source === "voice");
    const line = "- " + text;
    if (i >= 0) files[i] = { ...files[i], text: files[i].text + "\n" + line, at: Date.now() };
    else files.push({ id: uid(), title: "สิ่งที่สอนด้วยเสียง", text: line, source: "voice", at: Date.now() });
    saveKb(files);
  }
  const KB_DIRECT = 0.6, KB_CONTEXT = 0.3; // direct answer from the bot / pieces given to the AI
  /** Pieces worth giving the AI for this question (empty when nothing is close enough). */
  function kbContext(q) { return NKb.search(kbAll(), q, 3).filter(r => r.cover >= KB_CONTEXT); }
  function renderKb() {
    const files = kbFiles().slice().reverse(), ol = $("kbList");
    $("kbCount").textContent = files.length ? `(${files.length} เรื่อง ${kbAll().length} ส่วน)` : "";
    ol.textContent = "";
    if (!files.length) { const li = document.createElement("li"); li.className = "muted small"; li.textContent = "ยังไม่มีเรื่องในคลัง"; ol.appendChild(li); return; }
    for (const f of files) {
      const li = document.createElement("li");
      const t = document.createElement("span"); t.className = "kt";
      const m = document.createElement("span"); m.className = "meta";
      m.textContent = `${f.source === "voice" ? "สอนด้วยเสียง" : f.source === "typed" ? "พิมพ์เอง" : "ไฟล์"} · ${f.text.length.toLocaleString("th-TH")} ตัวอักษร · ${new Date(f.at).toLocaleDateString("th-TH", { day: "numeric", month: "short" })}`;
      t.append(m, document.createTextNode(f.title));
      const del = document.createElement("button"); del.type = "button"; del.textContent = "×"; del.dataset.id = f.id; del.setAttribute("aria-label", "ลบเรื่องนี้");
      li.append(t, del); ol.appendChild(li);
    }
  }
  $("kbList").addEventListener("click", e => {
    const b = e.target.closest("button[data-id]"); if (!b) return;
    const f = kbFiles().find(x => x.id === b.dataset.id);
    if (f && confirm(`ลบเรื่อง "${f.title}" ออกจากคลัง?`)) saveKb(kbFiles().filter(x => x.id !== f.id));
  });
  $("kbFile").addEventListener("change", async e => {
    const list = [...(e.target.files || [])]; let n = 0, skipped = 0;
    for (const file of list) {
      try {
        if (file.size > 2 * 1024 * 1024) { skipped++; continue; }
        const text = await file.text();
        // A memory file ("ถาม: … / ตอบ: …", like ความจำ.md) goes back into the answer memory.
        if (parseMemText(text).length >= 1 && /^\s*#?\s*ความจำ|^\s*ถาม\s*[:：]/m.test(text)) { importMemText(text); n++; continue; }
        if (addKbFile(file.name.replace(/\.(md|markdown|txt)$/i, ""), text, "file")) n++; else skipped++;
      } catch { skipped++; }
    }
    $("kbStatus").textContent = `นำเข้าแล้ว ${n} ไฟล์` + (skipped ? ` (ข้าม ${skipped} ไฟล์ที่ว่างหรือใหญ่เกิน 2 MB)` : "");
    e.target.value = "";
  });
  $("kbNewBtn").addEventListener("click", () => { $("kbNew").hidden = false; $("kbTitle").focus(); });
  $("kbCancel").addEventListener("click", () => { $("kbNew").hidden = true; });
  $("kbSave").addEventListener("click", () => {
    const f = addKbFile($("kbTitle").value, $("kbText").value, "typed");
    if (!f) { $("kbStatus").textContent = "ใส่เนื้อหาก่อน"; return; }
    $("kbTitle").value = ""; $("kbText").value = ""; $("kbNew").hidden = true;
    $("kbStatus").textContent = `บันทึกเรื่อง "${f.title}" แล้ว`;
  });
  function kbSearchUi() {
    const q = $("kbQuery").value.trim(), box = $("kbResults"); box.textContent = "";
    if (!q) return;
    const res = NKb.search(kbAll(), q, 3);
    if (!res.length) { box.textContent = "ไม่พบในคลัง"; return; }
    for (const r of res) {
      const d = document.createElement("div"); d.className = "kbhit";
      const b = document.createElement("b"); b.textContent = `${r.chunk.title} · ตรง ${Math.round(r.cover * 100)}%`;
      d.append(b, document.createTextNode(NKb.excerpt(r.chunk.text, 400))); box.appendChild(d);
    }
  }
  $("kbSearch").addEventListener("click", kbSearchUi);
  $("kbQuery").addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); kbSearchUi(); } });

  // ---------- answer memory: questions the AI answered, reused when asked again ----------
  const memList = () => (docs.memory && Array.isArray(docs.memory.list)) ? docs.memory.list : [];
  const MEM_MAX = 500, MEM_MATCH = 0.8;
  /** Answers that change with time, or commands, are not remembered. */
  const NO_MEMORY = /วันนี้|ตอนนี้|พรุ่งนี้|เมื่อวาน|มะรืน|เดี๋ยวนี้|ล่าสุด|สัปดาห์นี้|อาทิตย์นี้|เดือนนี้|ปีนี้|กี่โมง|เวลา|อากาศ|ฝน|ราคา|หุ้น|ทอง|ข่าว|ผลบอล|เตือน|ตั้ง|เปิด|ปิด|จด|บันทึก|ลบ|ข้อมูลเพิ่มเติมจากผู้ใช้/;
  /** The remembered question that matches `q` both ways (so a short memory does not answer a longer question). */
  function memFind(q) {
    const list = memList(); if (!list.length) return null;
    const top = NKb.search(list.map(m => ({ title: "", text: m.q, m })), q, 3);
    for (const r of top) {
      if (r.cover < MEM_MATCH) break;
      const back = NKb.search([{ title: "", text: q }], r.chunk.m.q, 1)[0];
      if (back && back.cover >= MEM_MATCH) return r.chunk.m;
    }
    return null;
  }
  function saveMem(list) { save("memory", { list: list.slice(-MEM_MAX), updatedAt: Date.now() }); renderMem(); scheduleMemFile(); }
  /** The answer memory as a readable text file (Markdown), kept in Documents/N-assistant/ความจำ.md. */
  const MEM_FILE = "ความจำ.md";
  function memText() {
    const lines = ["# ความจำของ N-assistant", "", "คำถามที่ AI เคยตอบ บอทใช้ตอบซ้ำได้ทันที แก้ไขไฟล์นี้แล้วนำเข้าที่ คลังความรู้ → นำเข้าไฟล์ ได้", ""];
    for (const m of memList()) lines.push(`## ${new Date(m.at).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })}`, `ถาม: ${m.q}`, `ตอบ: ${m.a}`, "");
    return lines.join("\n");
  }
  let memFileTimer = null;
  function scheduleMemFile() {
    clearTimeout(memFileTimer);
    memFileTimer = setTimeout(() => { try { if (A && A.writeTextFile) A.writeTextFile(MEM_FILE, memText()); } catch {} }, 1500);
  }
  /** Reads "ถาม: … / ตอบ: …" pairs from a text file (for example an edited ความจำ.md). */
  function parseMemText(text) {
    const out = []; let q = null;
    for (const raw of String(text || "").replace(/\r/g, "").split("\n")) {
      const line = raw.trim(), mq = line.match(/^(?:ถาม|Q)\s*[:：]\s*(.+)$/i), ma = line.match(/^(?:ตอบ|A)\s*[:：]\s*(.+)$/i);
      if (mq) q = mq[1].trim();
      else if (ma && q) { out.push({ q, a: ma[1].trim() }); q = null; }
    }
    return out;
  }
  function importMemText(text) {
    const pairs = parseMemText(text); if (!pairs.length) return 0;
    let list = memList().slice();
    for (const p of pairs) {
      const i = list.findIndex(m => m.q === p.q);
      if (i >= 0) list[i] = { ...list[i], a: p.a }; else list.push({ id: uid(), q: p.q, a: p.a, at: Date.now(), uses: 0 });
    }
    saveMem(list);
    return pairs.length;
  }

  // ---------- built-in basic knowledge (faq.js): answered without AI from day one ----------
  const FAQ_MATCH = 0.75;
  let faqIndex = null;
  // Filler words that change nothing in a how-to question ("จะ…ยังไง", "วิธีการ…").
  const faqClean = x => String(x).replace(/(วิธีการ|วิธี|จะ|ต้อง|เลย|หน่อย|ล่ะ|นะ)/g, " ");
  /** The basic entry whose question matches best both ways (the weaker of the two directions counts). */
  function faqFind(q) {
    const faq = window.NFaq || []; if (!faq.length) return null;
    if (!faqIndex) { faqIndex = []; faq.forEach((f, i) => f.q.forEach(v => faqIndex.push({ title: "", text: faqClean(v), i }))); }
    const qc = faqClean(q);
    let best = null, bestScore = 0;
    for (const r of NKb.search(faqIndex, qc, 12)) {
      if (r.cover < FAQ_MATCH) break;
      const back = NKb.search([{ title: "", text: qc }], r.chunk.text, 1)[0];
      const score = Math.min(r.cover, back ? back.cover : 0);
      if (score > bestScore) { bestScore = score; best = faq[r.chunk.i]; }
    }
    return bestScore >= FAQ_MATCH ? best : null;
  }
  function renderFaq() {
    const faq = window.NFaq || [], ol = $("faqList"); ol.textContent = "";
    $("faqCount").textContent = faq.length ? `(${faq.length} เรื่อง)` : "";
    for (const f of faq) { const li = document.createElement("li"); const t = document.createElement("span"); t.className = "kt"; const b = document.createElement("b"); b.textContent = f.q[0]; t.append(b, document.createElement("br"), document.createTextNode(f.a)); li.appendChild(t); ol.appendChild(li); }
  }
  function remember(q, a) {
    q = String(q || "").trim(); a = String(a || "").trim();
    if (!q || !a || q.length > 300 || NO_MEMORY.test(q)) return;
    const old = memFind(q), list = memList().filter(m => !old || m.id !== old.id);
    list.push({ id: uid(), q, a, at: Date.now(), uses: 0 });
    saveMem(list);
  }
  function renderMem() {
    const list = memList().slice().reverse(), ol = $("memList");
    $("memCount").textContent = list.length ? `(${list.length})` : "";
    ol.textContent = "";
    if (!list.length) { const li = document.createElement("li"); li.className = "muted small"; li.textContent = "ยังไม่มีคำตอบที่จำไว้"; ol.appendChild(li); return; }
    for (const m of list.slice(0, 100)) {
      const li = document.createElement("li");
      const t = document.createElement("span"); t.className = "kt";
      const meta = document.createElement("span"); meta.className = "meta";
      meta.textContent = `${new Date(m.at).toLocaleDateString("th-TH", { day: "numeric", month: "short" })} · ใช้ซ้ำ ${m.uses || 0} ครั้ง`;
      const q = document.createElement("b"); q.textContent = m.q;
      t.append(meta, q, document.createElement("br"), document.createTextNode(m.a));
      const del = document.createElement("button"); del.type = "button"; del.textContent = "×"; del.dataset.id = m.id; del.setAttribute("aria-label", "ลบคำตอบนี้");
      li.append(t, del); ol.appendChild(li);
    }
  }
  $("memList").addEventListener("click", e => {
    const b = e.target.closest("button[data-id]"); if (!b) return;
    const m = memList().find(x => x.id === b.dataset.id);
    if (m && confirm(`ลบคำตอบที่จำไว้ของคำถามนี้?\n${m.q}`)) saveMem(memList().filter(x => x.id !== m.id));
  });
  $("memClear").addEventListener("click", () => { if (memList().length && confirm("ล้างคำตอบที่จำไว้ทั้งหมด?")) saveMem([]); });
  let lastAsked = ""; // the last question that went to the AI or was answered from memory, for "ถาม AI ใหม่"

  // ---------- place reminders, using where GPS-Tracker says the phone is ----------
  const placeRules = () => (docs.placeRules && Array.isArray(docs.placeRules.list)) ? docs.placeRules.list : [];
  function savePlaceRules(list) { save("placeRules", { list, updatedAt: Date.now() }); if (A && A.setPlaceRules) A.setPlaceRules(JSON.stringify(list)); renderPlaceRules(); }
  function addPlaceRule(when, place, text) { const r = { id: uid(), when, place: String(place).trim(), text: String(text).trim(), on: true, createdAt: Date.now() }; savePlaceRules([...placeRules(), r]); return r; }
  const whenLabel = w => w === "leave" ? "ออกจาก" : "ถึง";
  let where = null; // {place, at, since, places, type}
  function readWhere() { try { where = A && A.whereNow ? JSON.parse(A.whereNow()) : null; } catch { where = null; } return where; }
  const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "เมื่อสักครู่" : m < 60 ? `${m} นาทีที่แล้ว` : m < 1440 ? `${Math.round(m / 60)} ชั่วโมงที่แล้ว` : `${Math.round(m / 1440)} วันที่แล้ว`; };
  function whereText() {
    const w = where || readWhere();
    const gps = A && A.gpsTrackerInstalled ? A.gpsTrackerInstalled() : false;
    if (!gps) return "ยังไม่พบแอป GPS-Tracker ในเครื่องนี้";
    if (!w || !w.at) return "ยังไม่ได้รับตำแหน่งจาก GPS-Tracker เปิดบันทึกการเดินทางใน GPS-Tracker แล้วรอรอบจับพิกัดถัดไป";
    if (w.type === "stopped") return `GPS-Tracker หยุดบันทึกแล้ว (${ago(w.at)}) จึงไม่รู้ตำแหน่งตอนนี้`;
    return w.place ? `ตอนนี้อยู่ที่ ${w.place}${w.since ? ` ตั้งแต่ ${hhmm(new Date(w.since))}` : ""} (ข้อมูล ${ago(w.at)})` : `ตอนนี้ไม่ได้อยู่ในสถานที่ที่ตั้งชื่อไว้ (ข้อมูล ${ago(w.at)})`;
  }
  function renderPlaceRules() {
    $("whereNow").textContent = whereText();
    const dl = $("prPlaces"); dl.textContent = "";
    for (const n of (where && where.places) || []) { const o = document.createElement("option"); o.value = n; dl.appendChild(o); }
    const box = $("prList"), list = placeRules();
    box.innerHTML = list.length ? "" : '<p class="small muted">ยังไม่มีการเตือนตามสถานที่</p>';
    for (const r of list) {
      const d = document.createElement("div"); d.className = "day";
      d.innerHTML = `<span class="d">${esc(whenLabel(r.when))}</span><div class="s">${esc(r.place)}<div class="small muted">${esc(r.text)}</div></div>`;
      const b = document.createElement("button"); b.className = "link-btn"; b.type = "button"; b.textContent = "ลบ"; b.dataset.id = r.id; d.appendChild(b);
      box.appendChild(d);
    }
  }
  $("prList").addEventListener("click", e => {
    const b = e.target.closest("button[data-id]"); if (!b) return;
    const r = placeRules().find(x => x.id === b.dataset.id);
    if (r && confirm(`ลบการเตือน "${whenLabel(r.when)}${r.place}: ${r.text}"?`)) savePlaceRules(placeRules().filter(x => x.id !== r.id));
  });
  $("prAdd").addEventListener("click", () => {
    const text = $("prText").value.trim(), place = $("prPlace").value.trim();
    if (!text || !place) { $("prStatus").textContent = "ใส่เรื่องที่จะเตือนและชื่อสถานที่ก่อน"; return; }
    const r = addPlaceRule($("prWhen").value, place, text);
    $("prText").value = ""; $("prPlace").value = "";
    const known = ((where && where.places) || []).some(n => n.replace(/\s+/g, "") === r.place.replace(/\s+/g, ""));
    $("prStatus").textContent = `เพิ่มแล้ว: ${whenLabel(r.when)}${r.place} → ${r.text}` + (known ? "" : ` (ยังไม่พบ "${r.place}" ใน GPS-Tracker ชื่อต้องตรงกับที่ตั้งไว้ในแอปนั้น)`);
  });
  handlers.place = w => { where = w; renderPlaceRules(); };

  // ---------- wake word: press power, say "ผู้ช่วย …" (phone's own recognizer, screen on only) ----------
  function renderWake(st) {
    if (!st) { try { st = A && A.wakeStatus ? JSON.parse(A.wakeStatus()) : null; } catch { st = null; } }
    const on = !!(st && st.on);
    $("wakeBtn").setAttribute("aria-pressed", String(on));
    $("wakeBtn").textContent = on ? "โหมดคำปลุก: เปิด" : "โหมดคำปลุก: ปิด";
    if (st && st.word && document.activeElement !== $("wakeWord")) $("wakeWord").value = st.word;
    const w = $("wakeWord").value.trim() || "ผู้ช่วย";
    $("wakeHint").textContent = on
      ? `ฟังอยู่ตอนจอเปิด: กดปุ่ม power แล้วพูด "${w}…" ภายใน 30 วินาที เช่น "${w} จดว่าซื้อนม" จอดับแล้วหยุดฟัง`
      : `เปิดแล้ว: กดปุ่ม power แล้วพูด "${w}…" ภายใน 30 วินาที ประโยคที่ไม่ขึ้นต้นด้วยคำนี้จะไม่ถูกเก็บหรือส่งไปไหน`;
  }
  $("wakeBtn").addEventListener("click", () => {
    if (!A || !A.wakeStart) { $("wakeHint").textContent = "ใช้ได้ในแอปบนมือถือเท่านั้น"; return; }
    const on = $("wakeBtn").getAttribute("aria-pressed") === "true";
    if (on) A.wakeStop(); else A.wakeStart($("wakeWord").value.trim() || "ผู้ช่วย");
  });
  $("wakeWord").addEventListener("change", () => {
    if (A && A.wakeStart && $("wakeBtn").getAttribute("aria-pressed") === "true") A.wakeStart($("wakeWord").value.trim() || "ผู้ช่วย");
    else renderWake({ on: false, word: $("wakeWord").value.trim() });
  });
  handlers.wakeState = st => renderWake(st);
  /** The wake word was heard (the app may just have opened over the lock screen). */
  handlers.wake = rest => {
    showTab("live");
    if (liveMode !== "ai") setLiveMode("ai");
    if (!liveOn() && A && A.liveStart) { setLive(true, "listening", "ได้ยินคำปลุกแล้ว"); A.liveStart(); }
    const t = String(rest || "").trim();
    if (t) { addConvo("me", t); handleHeard(t); }
    else liveReply("ครับ ว่ามาเลย", "bot");
  };

  // ---------- going back to an older version: back up, download, uninstall, install ----------
  let olders = [], dgBackupPath = "";
  $("dgList").addEventListener("click", () => {
    if (!A || !A.listOlderVersions) { $("dgVersions").textContent = "ใช้ได้ในแอปบนมือถือเท่านั้น"; return; }
    $("dgVersions").textContent = "กำลังดูรายการเวอร์ชัน…"; A.listOlderVersions();
  });
  handlers.olderVersions = list => {
    const box = $("dgVersions"); box.textContent = "";
    if (!list || list.error || !Array.isArray(list)) { box.textContent = "ดูรายการไม่สำเร็จ: " + ((list && list.error) || ""); return; }
    olders = list.slice(0, 15);
    if (!olders.length) { box.textContent = "ไม่มีเวอร์ชันเก่าให้ย้อนกลับ"; return; }
    olders.forEach((v, i) => {
      const d = document.createElement("div"); d.className = "day";
      const restore = v.versionCode >= 28 ? "กู้ข้อมูลได้" : "เวอร์ชันนี้ยังไม่มีปุ่มกู้ข้อมูล";
      d.innerHTML = `<span class="d">${esc(v.version)}</span><div class="s">${esc(new Date(v.date).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" }))}<div class="small muted">${esc(restore)}</div></div>`;
      const b = document.createElement("button"); b.className = "btn"; b.type = "button"; b.textContent = "ย้อนไปเวอร์ชันนี้"; b.dataset.dg = i;
      d.appendChild(b); box.appendChild(d);
    });
  };
  $("dgVersions").addEventListener("click", e => {
    const b = e.target.closest("button[data-dg]"); if (!b) return;
    const v = olders[+b.dataset.dg]; if (!v) return;
    if (!confirm(`ย้อนไปเวอร์ชัน ${v.version}?\n\nแอปจะสำรองข้อมูล แล้วดาวน์โหลดเวอร์ชันนี้ไว้ในโฟลเดอร์ Download จากนั้นต้องถอนแอปนี้และติดตั้งไฟล์ที่ดาวน์โหลดเอง\n\nหลังถอนแอป ข้อมูลในแอปจะหายจากเครื่อง (มีไฟล์สำรองไว้ให้) API key และ token ต้องใส่ใหม่`)) return;
    $("dgSteps").hidden = false; $("dgHow").hidden = true; $("dgUninstall").hidden = true;
    $("dgMsg").textContent = "กำลังสำรองข้อมูล…";
    dgBackupPath = A && A.saveBackupFile ? A.saveBackupFile(buildExport("json")) : "";
    if (!dgBackupPath) { $("dgMsg").textContent = "สำรองข้อมูลไม่สำเร็จ จึงยังไม่ย้อนเวอร์ชัน ลองส่งออก JSON เองที่หน้าประวัติก่อน"; return; }
    $("dgMsg").textContent = "สำรองแล้ว กำลังดาวน์โหลด…";
    A.prepareDowngrade(v.url, v.name || `n-assistant-${v.version}.apk`);
  });
  handlers.downgrade = d => {
    if (!d) return;
    if (d.step === "error") { $("dgMsg").textContent = "ไม่สำเร็จ: " + (d.message || "") + " ข้อมูลในแอปยังอยู่ครบ"; return; }
    if (d.step !== "ready") { $("dgMsg").textContent = d.message || ""; return; }
    $("dgMsg").textContent = "พร้อมแล้ว ทำตามขั้นตอนนี้";
    $("dgBackup").textContent = dgBackupPath; $("dgFile").textContent = d.file || "";
    $("dgHow").hidden = false; $("dgUninstall").hidden = false;
  };
  $("dgUninstall").addEventListener("click", () => { if (A && A.uninstallSelf) A.uninstallSelf(); });

  // ---------- quick bot (rules, always there) in front of the AI ----------
  let botPending = null;   // a question the bot asked and is waiting on, e.g. the time for a reminder
  let liveQueue = [];      // things said while the AI was busy; sent to the AI after its current answer
  let aiIntroDone = false; // the long "while you wait" hint is spoken once per app start
  /** Decides at once what to do with what was heard: the bot answers, or the AI is asked while the bot keeps listening. */
  function handleHeard(t) {
    const r = window.NBot ? NBot.parse(t, { now: new Date(), pending: botPending, aiBusy: !!liveJob }) : null;
    botPending = null;
    if (r) { applyBot(r); return; }
    const kbTop = kbFiles().length ? NKb.search(kbAll(), t, 1)[0] : null;
    if (kbTop && kbTop.cover >= KB_DIRECT) {
      liveReply(`จากคลังความรู้ เรื่อง${kbTop.chunk.title} ${NKb.bestLines(kbTop.chunk.text, t)}`, "bot");
      return;
    }
    const mem = NO_MEMORY.test(t) ? null : memFind(t);
    if (mem) {
      lastAsked = t;
      saveMem(memList().map(m => m.id === mem.id ? { ...m, uses: (m.uses || 0) + 1 } : m));
      liveReply(`เคยตอบไว้เมื่อ ${new Date(mem.at).toLocaleDateString("th-TH", { day: "numeric", month: "short" })} ว่า ${mem.a}`, "bot");
      return;
    }
    const basic = faqFind(t);
    if (basic) { liveReply(basic.a, "bot"); return; }
    if (liveJob) {
      liveQueue.push(t);
      liveReply("รับทราบครับ จะส่งให้เอไอต่อจากคำตอบแรก", "bot");
      return;
    }
    if (!askLiveAI(t)) return; // it already said why the AI cannot be used
    if (!aiIntroDone) { aiIntroDone = true; liveReply("เรื่องนี้ขอคิดสักครู่นะครับ ระหว่างรอ ถามเรื่องง่ายๆ หรือบอกรายละเอียดเพิ่มได้เลย", "bot"); }
    else liveReply("ขอคิดสักครู่นะครับ", "bot");
  }
  let botPrefix = ""; // for a close match: "ถ้าหมายถึง … ก็คือ" before the answer
  function applyBot(r) {
    botPrefix = r.guess ? `ถ้าหมายถึง "${r.guess}" ก็คือ ` : "";
    try { applyBotInner(r); } finally { botPrefix = ""; }
  }
  function applyBotInner(r) {
    if (r.type === "say") liveReply(r.say, "bot");
    else if (r.type === "ask") { botPending = r.pending; liveReply(r.say, "bot"); }
    else if (r.type === "reminder") {
      const rr = addReminder(r.text, r.time, r.repeat, r.date);
      liveReply(`ตั้งเตือน ${reminderWhen(rr)} เรื่อง ${rr.text} แล้วครับ`, "bot");
    } else if (r.type === "listReminders") {
      const list = reminders().filter(x => x.on !== false && nextAt(x)).sort((a, b) => nextAt(a) - nextAt(b)).slice(0, 3);
      liveReply(list.length ? `การเตือนที่ใกล้ที่สุด ${list.map(x => `${reminderWhen(x)} ${x.text}`).join(" และ ")} ครับ` : "ตอนนี้ยังไม่มีการเตือนที่ตั้งไว้ครับ", "bot");
    } else if (r.type === "open") { liveReply(r.say, "bot"); showTab(r.tab); }
    else if (r.type === "note" || r.type === "dayTasks") {
      const field = r.type === "dayTasks" ? "tasks" : noteField(r.text);
      const text = field === "tomorrow" ? r.text.replace(/^(วัน)?พรุ่งนี้\s*(ต้อง|จะ)?\s*/, "") || r.text : r.text;
      appendToDay(field, text);
      liveReply(`จดลง${FIELD[field][2]}แล้วครับ ${text}`, "bot");
    } else if (r.type === "listNotes") {
      // Read from every saved day, not only today: the newest notes first, then how many there are in all.
      const notes = recentNotes(), parts = [];
      if (notes.length) parts.push(`จดไว้ทั้งหมด ${notes.length} รายการ ล่าสุด ${notes.slice(0, 12).map(n => `${dayName(n.date)} ${n.kind} ${n.text}`).join(" ต่อไป ")}`);
      const rem = reminders().filter(x => x.on !== false && nextAt(x)).sort((a, b) => nextAt(a) - nextAt(b)).slice(0, 2);
      if (rem.length) parts.push(`เตือนที่ใกล้ที่สุด ${rem.map(x => `${reminderWhen(x)} ${x.text}`).join(" และ ")}`);
      liveReply(parts.length ? parts.join(" ต่อไป ") + " ครับ" : "วันนี้ยังไม่ได้จดอะไรไว้ครับ", "bot");
    } else if (r.type === "findNotes") {
      const hit = searchDays(r.q);
      liveReply(!hit.length ? `ไม่พบเรื่อง ${r.q} ในบันทึกครับ`
        : `เจอ ${hit.length} ที่เกี่ยวกับ ${r.q} ${hit.slice(0, 3).map(h => `${dayName(h.date)} ใน${h.label} ${h.text}`).join(" และ ")}`, "bot");
    } else if (r.type === "deleteLastNote") {
      if (lastWritten && removeLine(lastWritten.date, lastWritten.field, lastWritten.line)) {
        liveReply(`ลบที่จดล่าสุดแล้วครับ ${lastWritten.line.replace(/^•\s*/, "")}`, "bot"); lastWritten = null;
      } else {
        const lines = linesOf(today().evening.notes);
        if (!lines.length) liveReply("วันนี้ยังไม่มีที่จดไว้ให้ลบครับ", "bot");
        else { const l = lines[lines.length - 1]; removeLine(todayDate(), "notes", l); liveReply(`ลบที่จดล่าสุดแล้วครับ ${l.replace(/^•\s*/, "")}`, "bot"); }
      }
    } else if (r.type === "placeReminder") {
      const pr = addPlaceRule(r.when, r.place, r.text);
      const known = ((readWhere() || {}).places || []).some(n => n.replace(/\s+/g, "") === pr.place.replace(/\s+/g, ""));
      liveReply(`ตั้งแล้วครับ เมื่อ${whenLabel(pr.when)}${pr.place} จะเตือนว่า ${pr.text}` + (known ? "" : ` แต่ยังไม่พบสถานที่ชื่อ ${pr.place} ใน GPS-Tracker ชื่อต้องตรงกับที่ตั้งไว้ในแอปนั้นครับ`), "bot");
    } else if (r.type === "readClipboard") {
      let txt = ""; try { txt = A && A.clipboardText ? A.clipboardText() : ""; } catch {}
      if (!txt || !txt.trim()) { liveReply("คลิปบอร์ดว่างอยู่ครับ คัดลอกข้อความมาก่อนแล้วสั่งใหม่", "bot"); return; }
      addConvo("bot", `อ่านข้อความที่คัดลอกไว้ให้ฟังครับ (${txt.trim().length.toLocaleString("th-TH")} ตัวอักษร) หยุดได้ที่หน้าอ่านออกเสียงหรือแจ้งเตือน`);
      $("readText").value = txt;
      showTab("read");
      startReading(0); // turns Live off: one voice at a time
    } else if (r.type === "whereNow") {
      readWhere(); liveReply(whereText(), "bot");
    } else if (r.type === "askAgain") {
      if (!lastAsked) liveReply("ยังไม่มีคำถามก่อนหน้าให้ถามใหม่ครับ", "bot");
      else if (liveJob) liveReply("เอไอกำลังคิดคำถามก่อนหน้าอยู่ครับ รอสักครู่", "bot");
      else if (askLiveAI(lastAsked)) liveReply(`ส่งคำถาม "${lastAsked}" ให้เอไอตอบใหม่แล้วครับ`, "bot");
    } else if (r.type === "learn") { learn(r.text); liveReply(`จำไว้ในคลังความรู้แล้วครับ ${r.text}`, "bot"); }
    else if (r.type === "askKb") {
      const hit = NKb.search(kbAll(), r.q, 1)[0];
      liveReply(!kbFiles().length ? "คลังความรู้ยังว่างอยู่ครับ นำเข้าไฟล์ได้ที่เมนู คลังความรู้"
        : hit && hit.cover >= KB_CONTEXT ? `จากคลังความรู้ เรื่อง${hit.chunk.title} ${NKb.bestLines(hit.chunk.text, r.q)}` : `ไม่พบเรื่อง ${r.q} ในคลังความรู้ครับ`, "bot");
    } else if (r.type === "planToday") {
      liveReply("ได้ครับ ส่งให้เอไอวางแผนวันนี้ แผนจะอยู่ในหน้าเช้า", "bot");
      $("briefBtn").click();
    }
    else if (r.type === "aiStatus") liveReply(`เอไอคิดมาแล้ว ${Math.floor((Date.now() - liveJob.at) / 1000)} วินาที ยังไม่เสร็จครับ`, "bot");
    else if (r.type === "cancel") {
      abandonedLive.add(liveJob.id); liveQueue = []; clearPending("live", "live"); stopThinking();
      liveReply("ยกเลิกคำถามที่ส่งให้เอไอแล้วครับ", "bot");
    } else if (r.type === "stop") {
      addConvo("bot", "ปิด Live แล้วครับ");
      if (A && A.liveStop) A.liveStop();
      setLive(false, "off", "ปิด Live แล้ว");
    }
  }

  // ---------- Live, round 2: the AI decides how to react ----------
  const LIVE_MODE_KEY = "nLiveMode";
  let liveMode = "ai";
  try { liveMode = localStorage.getItem(LIVE_MODE_KEY) === "echo" ? "echo" : "ai"; } catch {}
  function setLiveMode(m) {
    liveMode = m === "echo" ? "echo" : "ai";
    try { localStorage.setItem(LIVE_MODE_KEY, liveMode); } catch {}
    $("modeAi").setAttribute("aria-pressed", String(liveMode === "ai"));
    $("modeEcho").setAttribute("aria-pressed", String(liveMode === "echo"));
    if (A && A.liveMode) A.liveMode(liveMode);
    if ($("liveSwitch").getAttribute("aria-checked") !== "true") {
      $("liveStatus").textContent = liveMode === "ai"
        ? `เปิด Live แล้วพูดภาษาไทย เรื่องง่ายๆ บอทตอบทันที เรื่องอื่นส่งให้ AI (${aiName()})`
        : "เปิด Live แล้วพูดภาษาไทย แอปจะพูดสิ่งที่ได้ยินกลับ (ไม่ใช้ AI)";
    }
  }
  const aiName = () => {
    const s = settings();
    if (s.provider === "claude") return "Claude";
    if (s.provider === "githubmd") return "ผ่านไฟล์ MD บน GitHub";
    if (s.provider === "openai") { const o = [...$("sOtherPreset").options].find(x => x.value && x.value === String(s.otherUrl || "").replace(/\/+$/, "")); return (o ? o.textContent : "ผู้ให้บริการอื่น") + (s.otherModel ? " " + s.otherModel : ""); }
    return "AI ในเครื่อง";
  };
  $("modeAi").addEventListener("click", () => setLiveMode("ai"));
  $("modeEcho").addEventListener("click", () => setLiveMode("echo"));

  const LIVE_TIMEOUT_MS = 5 * 60 * 1000;
  function thinkingText() {
    const sec = liveJob ? Math.floor((Date.now() - liveJob.at) / 1000) : 0;
    const pv = settings().provider;
    const slow = pv === "local" ? " AI ในเครื่องอาจใช้ 1–3 นาที" : pv === "githubmd" ? " รอ AI ภายนอกตอบในไฟล์ MD (10 วินาที–1 นาทีขึ้นไป)" : "";
    return `กำลังคิด… ${sec} วินาที${slow}`;
  }
  // Questions sent to the AI, by job id, kept on the phone: an answer that arrives after the page was closed and
  // reopened is still matched to its question (for the answer memory), and a cancelled one is still ignored.
  const ASKED_KEY = "nassistant.liveAsked";
  function askedAll() { try { const m = JSON.parse(localStorage.getItem(ASKED_KEY) || "{}"); return m && typeof m === "object" ? m : {}; } catch { return {}; } }
  function askedPut(id, v) {
    const m = askedAll(), now = Date.now();
    for (const k of Object.keys(m)) if (!m[k] || now - (m[k].at || 0) > 24 * 3600 * 1000) delete m[k]; // drop entries older than a day
    if (v === null) delete m[id]; else m[id] = { ...(m[id] || {}), ...v };
    try { localStorage.setItem(ASKED_KEY, JSON.stringify(m)); } catch {}
  }
  const abandonedLive = { has: id => !!(askedAll()[id] || {}).abandoned, add: id => askedPut(id, { abandoned: true, at: Date.now() }) };
  /** Questions the page stopped waiting for after 5 minutes: their answer is still logged (and remembered) when it comes. */
  const lateLive = { has: id => !!(askedAll()[id] || {}).late, add: (id, q) => askedPut(id, { q, late: true, at: Date.now() }) };
  const listeningWhileThinking = () => `กำลังฟัง… พูดได้เลย (เอไอกำลังคิด ${liveJob ? Math.floor((Date.now() - liveJob.at) / 1000) : 0} วินาที)`;
  function stopThinking() {
    if (!liveJob) return;
    clearTimeout(liveJob.timer); clearInterval(liveJob.tick); liveJob = null;
    renderConvo();
  }
  const liveOn = () => $("liveSwitch").getAttribute("aria-checked") === "true";
  /** Says something to the person and writes it in the log. Live listens again afterwards. */
  function liveReply(text, kind = "app") {
    if (kind === "bot" && botPrefix) { text = botPrefix + text; botPrefix = ""; }
    addConvo(kind, text);
    if (liveOn() && A && A.liveSay) A.liveSay(text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ")); // web addresses are not read aloud
  }
  // A function, because CHAT_SCHEMA is defined further down the file.
  const liveSchema = () => ({
    type: "object", additionalProperties: false, required: ["reply", "reminders", "open"],
    properties: {
      reply: { type: "string" },
      reminders: CHAT_SCHEMA.properties.reminders,
      open: { type: "string", enum: ["", "morning", "evening", "chat", "remind", "history", "settings"] }
    }
  });
  function livePrompt(text) {
    const now = new Date();
    // Only the person and the AI; the quick bot's instant answers and notes are left out to keep the prompt short.
    let past = convo.filter(m => m.who === "me" || m.who === "app");
    if (past.length && past[past.length - 1].who === "me" && past[past.length - 1].text === text) past = past.slice(0, -1);
    const history = past.slice(-8).map(m => `${m.who === "me" ? "ผู้ใช้" : "ผู้ช่วย"}: ${m.text}`).join("\n");
    const rems = reminders().filter(r => r.on !== false && nextAt(r)).slice(0, 15).map(r => `${reminderWhen(r)} ${r.text}`).join("; ");
    const b = today().morning.brief;
    const td = today();
    const kbHits = kbContext(text);
    const kbText = kbHits.map(h => `[${h.chunk.title}]\n${h.chunk.text}`).join("\n---\n");
    return `คุณคือ N-assistant ผู้ช่วยส่วนตัวที่คุยกับผู้ใช้ด้วยเสียง ข้อความของผู้ใช้มาจากการแปลงเสียงเป็นข้อความ อาจสะกดผิดหรือขาดคำ ให้เดาความหมายที่ใกล้ที่สุด
ตอนนี้: ${thDate(now)} เวลา ${hhmm(now)} (วันที่ ${todayDate()})
${contextText(todayDate())}
แผนวันนี้: ${b ? `เป้าหลัก ${b.focus}; งาน ${(b.priorities || []).join("; ")}` : "(ยังไม่ได้ทำ)"}
การเตือนที่ตั้งไว้: ${rems || "(ไม่มี)"}
บันทึกที่จดไว้ทุกวัน (ล่าสุดก่อน, ใช้ตอบเมื่อถามว่าจดอะไรไว้): ${recentNotes().slice(0, 60).map(n => `${n.date} ${n.kind}: ${n.text}`).join("; ") || "(ยังไม่มี)"}
บันทึกวันนี้: งาน ${td.morning.tasks || "-"} | อัปเดต ${td.evening.notes || "-"} | ยกไปพรุ่งนี้ ${td.evening.tomorrow || "-"}
${kbText ? `ข้อมูลจากคลังความรู้ของผู้ใช้ (ถ้าตอบได้จากส่วนนี้ ให้ตอบตามนี้และบอกว่ามาจากคลังความรู้):\n${kbText}` : ""}

บทสนทนาก่อนหน้า:
${history || "(เริ่มบทสนทนาใหม่)"}

ผู้ใช้พูดว่า: ${text}

ตัดสินใจว่าจะตอบสนองอย่างไร แล้วตอบเป็น JSON เท่านั้น:
- reply = สิ่งที่จะพูดออกเสียงให้ผู้ใช้ฟัง ภาษาไทย สั้น 1-3 ประโยค เป็นภาษาพูด ห้ามมี markdown, emoji, รายการหัวข้อ หรือสัญลักษณ์
- reminders = การเตือนที่ต้องตั้งใหม่ (เฉพาะเมื่อผู้ใช้ขอให้เตือน ไม่อย่างนั้นให้เป็น []) แต่ละรายการมี text, time ("HH:MM" 24 ชั่วโมง), date ("YYYY-MM-DD" คำนวณจากวันที่ตอนนี้), repeat ("once" | "daily" | "weekdays" | "weekly") ถ้าตั้งเตือนให้บอกวันเวลาที่ตั้งใน reply
- open = หน้าที่จะเปิดให้ผู้ใช้ เฉพาะเมื่อผู้ใช้ขอให้เปิด: "morning" (แผนตอนเช้า), "evening" (บันทึกตอนเย็น), "chat" (แชทผู้ช่วย), "remind" (รายการเตือน), "history" (ประวัติ), "settings" (ตั้งค่า) ไม่อย่างนั้นให้เป็น ""`;
  }
  /** Sends what was said to the AI. Returns false (after saying why) when the AI cannot be used. */
  function askLiveAI(text) {
    stopThinking();
    let job;
    try { job = buildJob("live", "live", livePrompt(text), { schema: liveSchema(), effort: "low", userText: text }); }
    catch (e) { liveReply("ยังใช้ AI ไม่ได้ " + e.message.replace(/"/g, ""), "note"); return false; }
    liveJob = { id: job.id, at: Date.now(), q: text };
    askedPut(job.id, { q: text, at: Date.now() });
    lastAsked = text;
    liveJob.tick = setInterval(() => {
      const st = $("liveSwitch").dataset.state;
      if (st === "thinking") $("liveStatus").textContent = thinkingText();
      else if (st === "listening") $("liveStatus").textContent = listeningWhileThinking();
      const t = $("convoThinkingText"); if (t) t.textContent = thinkingText();
    }, 1000);
    liveJob.timer = setTimeout(() => {
      if (!liveJob || liveJob.id !== job.id) return;
      // Stop holding Live for it, but keep waiting in the background: the answer goes into the log when it comes.
      lateLive.add(job.id, text);
      stopThinking(); clearPending("live", "live");
      liveQueue = [];
      liveReply(`AI ยังไม่ตอบใน 5 นาที${settings().provider === "local" ? " (โมเดลในมือถืออาจช้า)" : ""} ถามเรื่องอื่นต่อได้เลย ถ้าคำตอบมาทีหลังจะขึ้นในบันทึกการสนทนา`, "note");
    }, settings().provider === "githubmd" ? LIVE_TIMEOUT_MS + 90 * 1000 : LIVE_TIMEOUT_MS); // the file channel waits 5 min itself
    renderConvo();
    startJob(job);
    return true;
  }
  /** After an AI answer: what was said meanwhile goes to the AI as the next question. */
  function sendQueued() {
    if (!liveQueue.length || liveJob) return;
    const more = liveQueue.join(" "); liveQueue = [];
    if (askLiveAI("ข้อมูลเพิ่มเติมจากผู้ใช้ (พูดระหว่างรอคำตอบก่อนหน้า): " + more)) addConvo("note", "ส่งข้อมูลเพิ่มให้ AI แล้ว");
  }
  function applyLiveResult(res) {
    if (abandonedLive.has(res.id)) { askedPut(res.id, null); return; } // cancelled, or already reported as "no answer in 5 minutes"
    const askedQ = liveJob && res.id === liveJob.id ? liveJob.q : ((askedAll()[res.id] || {}).q || "");
    askedPut(res.id, null);
    const late = lateLive.has(res.id) || !(liveJob && res.id === liveJob.id);
    if (liveJob && res.id === liveJob.id) stopThinking();
    // Otherwise it belongs to an earlier question (for example from before the app was reopened, or one that took
    // over 5 minutes): still log it, saying which question it answers.
    if (late && askedQ) addConvo("note", `คำตอบที่มาช้าของ "${askedQ.length > 60 ? askedQ.slice(0, 60) + "…" : askedQ}"`);
    if (!res.ok) {
      if (!late) liveQueue = [];
      liveReply(`ติดต่อ AI ไม่ได้ ${res.error || ""}`.trim(), "note");
      return;
    }
    let reply = cleanText(res.text), adds = [], open = "";
    try {
      const r = parseJsonLoose(res.text);
      if (r && typeof r.reply === "string") reply = r.reply;
      if (r && Array.isArray(r.reminders)) adds = r.reminders;
      if (r && typeof r.open === "string") open = r.open;
    } catch {}
    reply = String(reply || "").replace(/[*#`_>|~]/g, "").trim();
    const made = [];
    for (const a of adds) {
      if (!a || !a.text || !/^\d{1,2}:\d{2}$/.test(String(a.time || ""))) continue;
      const [h, m] = String(a.time).split(":").map(Number);
      if (h > 23 || m > 59) continue;
      const repeat = REPEAT_LABEL[a.repeat] ? a.repeat : "once";
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(a.date || "")) ? a.date : todayDate();
      const rr = addReminder(String(a.text), `${pad(h)}:${pad(m)}`, repeat, date);
      made.push(reminderWhen(rr) + " " + rr.text);
    }
    if (!reply) reply = made.length ? "ตั้งการเตือนให้แล้ว" : "ขอโทษ ไม่ได้คำตอบจาก AI ลองพูดใหม่อีกครั้ง";
    liveReply(reply);
    // Remember plain answers (no reminders set, no page opened) for the next time the same thing is asked.
    if (res.ok && askedQ && !adds.length && !open) remember(askedQ, reply);
    if (made.length) addConvo("note", "ตั้งการเตือนแล้ว: " + made.join(", "));
    if (open && TABS.includes(open)) showTab(open);
    sendQueued();
  }
  handlers.liveSpoke = t => addConvo("app", t);

  // ---------- reminders ----------
  const REPEAT_LABEL = { once: "ครั้งเดียว", daily: "ทุกวัน", weekdays: "จันทร์-ศุกร์", weekly: "ทุกสัปดาห์" };
  const reminders = () => (docs.reminders && Array.isArray(docs.reminders.list)) ? docs.reminders.list : [];
  function saveReminders(list) {
    save("reminders", { list, updatedAt: Date.now() });
    if (A) A.setReminders(JSON.stringify(list));
    renderReminders();
  }
  function occursOn(r, date) {
    if (r.on === false) return false;
    const d = dateOf(date), dow = d.getDay();
    if (r.repeat === "daily") return true;
    if (r.repeat === "weekdays") return dow >= 1 && dow <= 5;
    if (r.repeat === "weekly") return dateOf(r.date).getDay() === dow && date >= r.date;
    return r.date === date;
  }
  const remindersOn = date => reminders().filter(r => occursOn(r, date)).sort((a, b) => a.time.localeCompare(b.time));
  function nextAt(r) {
    const now = new Date();
    if (r.on === false) return null;
    if (r.repeat === "once") {
      const [h, m] = String(r.time).split(":").map(Number), d = dateOf(r.date);
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
      return at > now ? at : null;
    }
    for (let i = 0; i < 8; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      const k = keyOf(d);
      if (!occursOn(r, k)) continue;
      const [h, m] = r.time.split(":").map(Number);
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
      if (at > now) return at;
    }
    return null;
  }
  function reminderWhen(r) {
    const n = nextAt(r);
    if (r.repeat === "once") return n ? `${thShort(n)} ${r.time}` : `${thShort(dateOf(r.date))} ${r.time} (ผ่านไปแล้ว)`;
    const base = r.repeat === "weekly" ? `ทุก${dateOf(r.date).toLocaleDateString("th-TH", { weekday: "long" })}` : REPEAT_LABEL[r.repeat];
    return `${base} ${r.time}`;
  }
  function renderReminders() {
    const list = reminders().slice().sort((a, b) => {
      const na = nextAt(a), nb = nextAt(b);
      if (na && nb) return na - nb;
      return na ? -1 : nb ? 1 : 0;
    });
    $("rList").innerHTML = list.length ? list.map(r => {
      const live = r.on !== false && nextAt(r);
      return `<div class="day rem${live ? "" : " off"}">
        <span class="d">${esc(r.time)}</span>
        <div class="s">${esc(r.text)}<div class="small muted">${esc(reminderWhen(r))}</div></div>
        <div class="chips">
          <label class="toggle small"><input type="checkbox" data-rtoggle="${esc(r.id)}" ${r.on !== false ? "checked" : ""}> เปิด</label>
          <button class="btn small-btn" type="button" data-rdel="${esc(r.id)}">ลบ</button>
        </div></div>`;
    }).join("") : '<div class="card"><p class="muted small">ยังไม่มีการเตือน เพิ่มได้จากฟอร์มด้านบน หรือกด "เตือน" ข้างรายการในแผนตามเวลา</p></div>';
  }
  $("rList").addEventListener("change", e => {
    const id = e.target.dataset.rtoggle; if (!id) return;
    saveReminders(reminders().map(r => r.id === id ? { ...r, on: e.target.checked } : r));
  });
  $("rList").addEventListener("click", e => {
    const id = e.target.dataset.rdel; if (!id) return;
    saveReminders(reminders().filter(r => r.id !== id));
    $("rStatus").textContent = "ลบการเตือนแล้ว";
  });
  function addReminder(text, time, repeat, date) {
    const r = { id: uid(), text, time, repeat, date, on: true, createdAt: Date.now() };
    saveReminders([...reminders(), r]);
    return r;
  }
  $("rAdd").addEventListener("click", () => {
    const text = $("rText").value.trim(), time = $("rTime").value, repeat = $("rRepeat").value, date = $("rDate").value || todayDate();
    if (!text) { $("rStatus").textContent = "พิมพ์ว่าจะให้เตือนเรื่องอะไรก่อน"; return; }
    if (!time) { $("rStatus").textContent = "เลือกเวลาที่จะให้เตือน"; return; }
    const r = addReminder(text, time, repeat, date);
    $("rText").value = "";
    const n = nextAt(r);
    $("rStatus").textContent = n ? `ตั้งเตือนแล้ว: ${reminderWhen(r)}` : "เวลานี้ผ่านไปแล้ว เลือกวันหรือเวลาใหม่";
    if (!A) $("rStatus").textContent += " (การแจ้งเตือนทำงานเฉพาะในแอปบนมือถือ)";
  });
  $("rRepeat").addEventListener("change", () => { $("rDateField").hidden = !["once", "weekly"].includes($("rRepeat").value); });

  // ---------- AI jobs (run by the app in the background) ----------
  const BRIEF_SCHEMA = {
    type: "object", additionalProperties: false,
    required: ["greeting", "focus", "priorities", "cautions", "plan", "tip"],
    properties: {
      greeting: { type: "string" }, focus: { type: "string" }, tip: { type: "string" },
      priorities: { type: "array", items: { type: "string" } },
      cautions: { type: "array", items: { type: "string" } },
      plan: { type: "array", items: { type: "object", additionalProperties: false, required: ["time", "item"], properties: { time: { type: "string" }, item: { type: "string" } } } }
    }
  };
  function apiKey() { try { return localStorage.getItem(LS_KEY) || ""; } catch { return ""; } }
  function otherKey() { try { return localStorage.getItem(LS_OTHER_KEY) || ""; } catch { return ""; } }
  const lsStr = k => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
  function lsPut(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch {} }

  /** Builds the request the native service sends. Throws with a message the person can act on. */
  function buildJob(kind, date, prompt, { schema = null, effort = "medium", userText = "" } = {}) {
    const s = settings();
    const job = { id: uid(), kind, date };
    if (s.provider === "claude") {
      const key = apiKey();
      if (!key) throw new Error("ยังไม่ได้ใส่ Claude API key ไปที่แท็บ \"ตั้งค่า\" ก่อน");
      const body = { model: s.model, max_tokens: 16000, messages: [{ role: "user", content: prompt }], output_config: { effort } };
      if (schema) body.output_config.format = { type: "json_schema", schema };
      const headers = { "x-api-key": key, "anthropic-version": "2026-10-21", "anthropic-dangerous-direct-browser-access": "true" };
      // If a safety check declines the request, let the API retry on its recommended fallback model.
      if (s.model !== "claude-haiku-5-5") { body.fallbacks = "default"; headers["anthropic-beta"] = "server-side-fallback-2026-07-01"; }
      Object.assign(job, { format: "claude", url: "https://api.anthropic.com/v1/messages", headers, body });
    } else if (s.provider === "githubmd") {
      // Talk through a Markdown file on GitHub. Live sends only what was said; other features send the full prompt.
      const repo = String(s.mdRepo || "").trim(), path = String(s.mdPath || "").trim().replace(/^\/+/, "");
      const token = lsStr(LS_MD_TOKEN), key = lsStr(LS_MD_KEY);
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("ยังไม่ได้ใส่ repo ของไฟล์ MD ไปที่ \"ตั้งค่า\" ก่อน");
      if (!/\.md$/i.test(path)) throw new Error("ยังไม่ได้ใส่ไฟล์ .md ไปที่ \"ตั้งค่า\" ก่อน");
      if (!token) throw new Error("ยังไม่ได้ใส่ GitHub token ไปที่ \"ตั้งค่า\" ก่อน");
      if (key.length < 16) throw new Error("ยังไม่ได้ใส่กุญแจเข้ารหัส ไปที่ \"ตั้งค่า\" ก่อน");
      Object.assign(job, { format: "githubmd", url: "", headers: {}, body: {}, repo, path, token, key, text: userText || prompt });
    } else if (s.provider === "openai") {
      // Any provider with an OpenAI-compatible API. JSON is asked for in the prompt, which every provider supports.
      // The app adds /chat/completions itself; people often paste the whole endpoint, which doubled it (a 404).
      const base = String(s.otherUrl || "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
      const key = otherKey(), model = String(s.otherModel || "").trim();
      if (!/^https:\/\//.test(base)) throw new Error("ยังไม่ได้ใส่ที่อยู่ API ที่ขึ้นต้นด้วย https ไปที่ \"ตั้งค่า\" ก่อน");
      if (!key) throw new Error("ยังไม่ได้ใส่ API key ของผู้ให้บริการ ไปที่ \"ตั้งค่า\" ก่อน");
      if (!model) throw new Error("ยังไม่ได้ใส่ชื่อโมเดล ไปที่ \"ตั้งค่า\" ก่อน");
      const body = { model, messages: [{ role: "user", content: prompt }], temperature: 0.4 };
      Object.assign(job, { format: "openai", url: base + "/chat/completions", headers: { Authorization: "Bearer " + key }, body });
    } else {
      const base = (s.localUrl || DEFAULT_SETTINGS.localUrl).replace(/\/+$/, "");
      const body = { model: s.localModel || DEFAULT_SETTINGS.localModel, messages: [{ role: "user", content: prompt }], stream: false, think: false, options: { temperature: 0.4 } };
      if (schema) body.format = schema;
      Object.assign(job, { format: "ollama", url: base + "/api/chat", headers: {}, body });
    }
    return job;
  }

  const pending = () => lsGet(LS_PENDING) || {};
  function setPending(kind, date, id) { const p = pending(); p[kind + ":" + date] = { id, at: Date.now() }; lsSet(LS_PENDING, p); }
  function clearPending(kind, date) { const p = pending(); delete p[kind + ":" + date]; lsSet(LS_PENDING, p); }
  function isPending(kind, date) { const p = pending()[kind + ":" + date]; return !!p && Date.now() - p.at < 15 * 60 * 1000; }

  /** In the app: hand the job to the background service. In a plain browser: call Claude directly (for testing). */
  async function startJob(job) {
    setPending(job.kind, job.date, job.id);
    if (A) { A.runJob(JSON.stringify(job)); return; }
    let res;
    try {
      if (job.format !== "claude") throw new Error("AI ในเครื่องใช้ได้เฉพาะในแอปบนมือถือ");
      const r = await fetch(job.url, { method: "POST", headers: { "content-type": "application/json", ...job.headers }, body: JSON.stringify(job.body) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error?.message || ("Claude ตอบกลับรหัส " + r.status));
      res = { id: job.id, kind: job.kind, date: job.date, ok: true, text: (data.content || []).filter(b => b.type === "text").map(b => b.text).join("") };
    } catch (e) { res = { id: job.id, kind: job.kind, date: job.date, ok: false, error: e.message }; }
    applyResult(res);
  }

  function parseJsonLoose(text) {
    const t = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    try { return JSON.parse(t); } catch {}
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (fence) { try { return JSON.parse(fence[1]); } catch {} }
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
    throw new Error("AI ตอบกลับมาในรูปแบบที่อ่านไม่ได้ ลองกดอีกครั้ง");
  }
  const cleanText = t => String(t || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  function applyResult(res) {
    if (!res || !res.kind || !res.date) return;
    clearPending(res.kind, res.date);
    const isToday = res.date === todayDate();
    if (res.kind === "brief") {
      // A plan prepared before waking never replaces one the person already asked for.
      if (res.prepared && getDay(res.date).morning.brief) return;
      if (!res.ok) { if (isToday) $("mStatus").textContent = res.error || "ถาม AI ไม่สำเร็จ ลองใหม่อีกครั้ง"; renderBriefButton(); return; }
      try {
        const r = parseJsonLoose(res.text);
        const brief = {
          greeting: String(r.greeting || ""), focus: String(r.focus || ""),
          priorities: (Array.isArray(r.priorities) ? r.priorities : []).map(String).slice(0, 6),
          cautions: (Array.isArray(r.cautions) ? r.cautions : []).map(String).slice(0, 6),
          plan: (Array.isArray(r.plan) ? r.plan : []).filter(p => p && p.item).map(p => ({ time: String(p.time || ""), item: String(p.item) })).slice(0, 12),
          tip: String(r.tip || ""), at: res.at || Date.now(), prepared: !!res.prepared
        };
        if (!brief.priorities.length && !brief.focus) throw new Error("AI ส่งแผนที่ว่างเปล่ากลับมา ลองกดอีกครั้ง");
        saveDay(res.date, { morning: { brief } });
        if (isToday) $("mStatus").textContent = res.prepared ? "แผนนี้เตรียมไว้ก่อนเวลาปลุก กด \"ขอแผนวันนี้\" อีกครั้งถ้าอยากเพิ่มงาน" : "บันทึกแผนวันนี้แล้ว";
      } catch (e) { if (isToday) $("mStatus").textContent = e.message; }
      renderBrief(); renderBriefButton();
    } else if (res.kind === "chat") {
      if (!res.ok) { pushChat({ role: "note", text: res.error || "ผู้ช่วยตอบไม่สำเร็จ ลองใหม่อีกครั้ง" }); renderChatButton(); return; }
      let reply = cleanText(res.text), adds = [];
      try {
        const r = parseJsonLoose(res.text);
        if (r && typeof r.reply === "string") reply = r.reply;
        if (r && Array.isArray(r.reminders)) adds = r.reminders;
      } catch {}
      pushChat({ role: "ai", text: reply || "(ไม่มีคำตอบ)" });
      const made = [];
      for (const a of adds) {
        if (!a || !a.text || !/^\d{1,2}:\d{2}$/.test(String(a.time || ""))) continue;
        const [h, m] = String(a.time).split(":").map(Number);
        const repeat = REPEAT_LABEL[a.repeat] ? a.repeat : "once";
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(a.date || "")) ? a.date : todayDate();
        const rr = addReminder(String(a.text), `${pad(h)}:${pad(m)}`, repeat, date);
        made.push(reminderWhen(rr) + " " + rr.text);
      }
      if (made.length) pushChat({ role: "note", text: "ตั้งการเตือนแล้ว: " + made.join(", ") });
      renderChatButton();
    } else if (res.kind === "live") {
      applyLiveResult(res);
    } else if (res.kind === "test") {
      aiTestDone(res);
    } else if (res.kind === "reflection") {
      const out = $("reflection");
      if (!res.ok) { if (isToday) { out.hidden = false; out.innerHTML = `<p class="small">${esc(res.error)}</p>`; } renderReflectButton(); return; }
      const text = cleanText(res.text);
      saveDay(res.date, { evening: { reflection: text } });
      if (isToday) { out.hidden = false; out.innerHTML = `<h3>สรุปจาก AI</h3><p>${esc(text)}</p>`; }
      renderReflectButton();
    }
  }
  handlers.job = res => { applyResult(res); if (A && res && res.id) A.ackResult(res.id); };
  function pullResults() {
    if (!A) return;
    let list = []; try { list = JSON.parse(A.takeResults() || "[]"); } catch {}
    list.sort((a, b) => (a.at || 0) - (b.at || 0)).forEach(applyResult);
  }

  // ---------- assistant chat ----------
  const CHAT_SCHEMA = {
    type: "object", additionalProperties: false, required: ["reply", "reminders"],
    properties: {
      reply: { type: "string" },
      reminders: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "time", "date", "repeat"],
        properties: { text: { type: "string" }, time: { type: "string" }, date: { type: "string" }, repeat: { type: "string", enum: ["once", "daily", "weekdays", "weekly"] } } } }
    }
  };
  const chatMsgs = () => (docs.chat && Array.isArray(docs.chat.messages)) ? docs.chat.messages : [];
  function pushChat(m) {
    const list = [...chatMsgs(), { ...m, at: Date.now() }].slice(-60);
    save("chat", { messages: list, updatedAt: Date.now() });
    renderChat();
  }
  function renderChat() {
    const list = chatMsgs();
    const busy = isPending("chat", "chat");
    $("chatSuggest").hidden = list.length > 0;
    $("chatLog").innerHTML = list.map(m => `<div class="msg ${m.role === "user" ? "user" : m.role === "note" ? "note" : "ai"}">${esc(m.text)}${m.role !== "note" ? `<span class="t">${esc(new Date(m.at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }))}</span>` : ""}</div>`).join("")
      + (busy ? '<div class="msg ai muted">กำลังคิด… ออกจากแอปได้ จะมีแจ้งเตือนเมื่อตอบเสร็จ</div>' : "");
    const last = $("chatLog").lastElementChild;
    if (last && !$("p-chat").hidden) last.scrollIntoView({ block: "nearest" });
  }
  function renderChatButton() {
    const busy = isPending("chat", "chat");
    $("chatSend").disabled = busy;
    $("chatSend").textContent = busy ? "รอ…" : "ส่ง";
    renderChat();
  }
  function chatPrompt(text) {
    const now = new Date(), b = today().morning.brief;
    const history = chatMsgs().filter(m => m.role !== "note").slice(-8).map(m => `${m.role === "user" ? "ผู้ใช้" : "ผู้ช่วย"}: ${m.text}`).join("\n");
    const rems = reminders().filter(r => r.on !== false && nextAt(r)).slice(0, 15).map(r => `${reminderWhen(r)} ${r.text}`).join("; ");
    return `คุณคือ N-assistant ผู้ช่วยส่วนตัวบนมือถือ ตอบเป็นภาษาไทย สั้น กระชับ เป็นกันเอง และใช้งานได้จริง
ตอนนี้: ${thDate(now)} เวลา ${hhmm(now)} (วันที่ ${todayDate()})
${contextText(todayDate())}
แผนวันนี้: ${b ? `เป้าหลัก ${b.focus}; งาน ${(b.priorities || []).join("; ")}` : "(ยังไม่ได้ทำ)"}
การเตือนที่ตั้งไว้: ${rems || "(ไม่มี)"}

บทสนทนาก่อนหน้า:
${history || "(เริ่มบทสนทนาใหม่)"}

ข้อความล่าสุดจากผู้ใช้: ${text}

ตอบเป็น JSON เท่านั้น: reply = คำตอบถึงผู้ใช้, reminders = การเตือนที่ต้องตั้งใหม่ (ใส่เฉพาะเมื่อผู้ใช้ขอให้เตือน ไม่อย่างนั้นให้เป็น []) แต่ละรายการมี text, time ("HH:MM" แบบ 24 ชั่วโมง), date ("YYYY-MM-DD" คำนวณจากวันที่ตอนนี้), repeat ("once" | "daily" | "weekdays" | "weekly") ถ้าตั้งเตือนให้บอกเวลาที่ตั้งไว้ใน reply ด้วย`;
  }
  async function sendChat(text) {
    text = String(text || "").trim();
    if (!text || isPending("chat", "chat")) return;
    let job;
    try { job = buildJob("chat", "chat", chatPrompt(text), { schema: CHAT_SCHEMA, effort: "low" }); }
    catch (e) { $("chatStatus").textContent = e.message; return; }
    $("chatStatus").textContent = "";
    $("chatInput").value = "";
    pushChat({ role: "user", text });
    await startJob(job);
    renderChatButton();
  }
  $("chatSend").addEventListener("click", () => sendChat($("chatInput").value));
  $("chatInput").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat($("chatInput").value); } });
  $("chatSuggest").addEventListener("click", e => { const b = e.target.closest("button"); if (b) sendChat(b.textContent); });
  $("chatClear").addEventListener("click", () => { save("chat", { messages: [], updatedAt: Date.now() }); renderChat(); $("chatStatus").textContent = "ล้างบทสนทนาแล้ว"; });

  // ---------- prompts ----------
  function contextText(date) {
    const s = settings();
    const past = daysBefore(date, 3).map(d => {
      const pr = d.morning?.brief?.priorities || [];
      const done = d.evening?.done || [];
      return `- ${d.date}: งานหลัก ${pr.map((p, i) => `${p}${done.includes(i) ? " [เสร็จ]" : " [ไม่เสร็จ]"}`).join("; ") || "-"} | อัปเดต: ${d.evening?.notes || "-"} | ยกไปวันถัดไป: ${d.evening?.tomorrow || "-"} | อารมณ์ ${d.evening?.mood || "-"}/5`;
    }).join("\n");
    return `ชื่อเล่นผู้ใช้: ${s.name || "(ไม่ระบุ)"}\nเป้าหมายระยะยาว: ${s.goals || "(ไม่ระบุ)"}\nบันทึกย้อนหลัง:\n${past || "(ยังไม่มี)"}`;
  }
  function briefPrompt(date, input, { prepared = false } = {}) {
    const d = dateOf(date);
    const rems = remindersOn(date).map(r => `${r.time} ${r.text}`).join("; ");
    const timeLine = prepared ? `แผนนี้ทำไว้ล่วงหน้าก่อนผู้ใช้ตื่น (ตื่นประมาณ ${settings().wake})` : `เวลาตอนนี้ ${hhmm(new Date())}`;
    return `คุณเป็นผู้ช่วยวางแผนตอนเช้าที่พูดจาเป็นกันเอง กระชับ และใช้งานได้จริง ตอบเป็นภาษาไทยทั้งหมด
วันนี้: ${thDate(d)} ${timeLine}
${contextText(date)}

ข้อมูลวันนี้:
- งาน/นัดวันนี้: ${input.tasks || "(ไม่ได้ระบุ)"}
- การเตือนที่ตั้งไว้วันนี้: ${rems || "(ไม่มี)"}
- เรื่องที่กังวล: ${input.worry || "(ไม่ได้ระบุ)"}
- พลังงาน: ${input.energy ? input.energy + "/5" : "(ไม่ได้ระบุ)"}

ให้คิดจากข้อมูลจริงข้างบน ถ้ามีงานค้างจากวันก่อนให้หยิบมาพิจารณา ใส่การเตือนที่ตั้งไว้ลงในแผนตามเวลา ถ้าพลังงานต่ำให้ลดงานและเตือนเรื่องพัก อย่าแต่งนัดหมายที่ผู้ใช้ไม่ได้บอก
ตอบเป็น JSON เท่านั้น: greeting = ทักทายสั้น 1 ประโยค, focus = สิ่งเดียวที่สำคัญที่สุดวันนี้, priorities = งานสำคัญ 3-5 ข้อเรียงตามลำดับ, cautions = สิ่งที่ควรระวัง 2-4 ข้อ, plan = แผนตามเวลา [{time: "HH:MM", item}], tip = คำแนะนำสั้น 1 ข้อ`;
  }

  // ---------- plan prepared before the wake-up alarm ----------
  let prepTimer = null;
  function schedulePrepSync() { clearTimeout(prepTimer); prepTimer = setTimeout(syncPrep, 800); }
  function syncPrep() {
    if (!A) return;
    const s = settings();
    const minutes = s.wakeOn ? (+s.prepMinutes || 0) : 0;
    const jobs = {};
    if (minutes > 0) {
      const now = new Date();
      for (let i = 0; i < 2; i++) {
        const date = keyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i));
        if (getDay(date).morning.brief) continue;
        const carry = daysBefore(date, 1)[0];
        const input = { tasks: carry?.evening?.tomorrow ? "งานที่ยกมาจากเมื่อวาน: " + carry.evening.tomorrow : "", worry: "", energy: null };
        try { jobs[date] = buildJob("brief", date, briefPrompt(date, input, { prepared: true }), { schema: BRIEF_SCHEMA, effort: "medium" }); } catch {}
      }
    }
    try { A.setPrepJobs(JSON.stringify(jobs), minutes); } catch {}
  }

  // ---------- morning ----------
  const EXAMPLE = {
    example: true,
    greeting: "อรุณสวัสดิ์ วันนี้งานเยอะแต่จัดการได้",
    focus: "ส่งใบเสนอราคาให้เสร็จก่อนเที่ยง",
    priorities: ["เช็กตัวเลขใบเสนอราคาแล้วส่งลูกค้า", "เตรียมหัวข้อประชุมทีม 10:00", "ออกจากที่ทำงานทันรับลูก 16:30"],
    cautions: ["นอนน้อย ช่วงบ่ายอาจง่วง เลี่ยงงานที่ต้องคิดตัวเลขหลังกินข้าว", "อย่ารับงานใหม่ระหว่างวันจนกว่าใบเสนอราคาจะส่งแล้ว"],
    plan: [{ time: "08:30", item: "เช็กตัวเลขใบเสนอราคา" }, { time: "10:00", item: "ประชุมทีม" }, { time: "11:30", item: "ส่งใบเสนอราคา" }, { time: "16:00", item: "ปิดงาน เตรียมออกไปรับลูก" }],
    tip: "ดื่มน้ำหนึ่งแก้วตอนนี้เลย แล้วเริ่มจากงานที่ยากที่สุดก่อน"
  };
  function renderBrief() {
    const b = today().morning.brief;
    const data = b || EXAMPLE;
    const list = a => (a || []).map(x => `<li>${esc(x)}</li>`).join("");
    const canRemind = !data.example;
    $("briefCard").innerHTML = `
      <div class="row" style="justify-content:space-between">
        <span class="label">แผนวันนี้</span>
        ${data.example ? '<span class="tag">ตัวอย่าง</span>' : `<span class="small muted">${b.prepared ? "เตรียมไว้ล่วงหน้า " : "สร้างเมื่อ "}${esc(new Date(b.at || Date.now()).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }))}</span>`}
      </div>
      ${data.greeting ? `<p>${esc(data.greeting)}</p>` : ""}
      ${data.focus ? `<p class="focus">${esc(data.focus)}</p>` : ""}
      <div class="sec"><h3>ต้องทำวันนี้</h3><ol>${list(data.priorities)}</ol></div>
      <div class="sec caution"><h3>ควรระวัง</h3><ul>${list(data.cautions)}</ul></div>
      ${(data.plan || []).length ? `<div class="sec"><h3>แผนตามเวลา</h3><dl class="plan">${data.plan.map((p, i) => `<dt>${esc(p.time)}</dt><dd><span>${esc(p.item)}</span>${canRemind && /^\d{1,2}:\d{2}$/.test(p.time) ? ` <button class="link-btn" type="button" data-remind="${i}">เตือน</button>` : ""}</dd>`).join("")}</dl></div>` : ""}
      ${data.tip ? `<p class="small"><b>เคล็ดลับ:</b> ${esc(data.tip)}</p>` : ""}
      ${data.example ? '<p class="small muted">นี่คือตัวอย่างหน้าตาแผน กรอกข้อมูลด้านบนแล้วกด "ขอแผนวันนี้" เพื่อสร้างแผนของคุณ</p>' : ""}`;
  }
  $("briefCard").addEventListener("click", e => {
    const i = e.target.dataset.remind; if (i === undefined) return;
    const p = today().morning.brief?.plan?.[+i]; if (!p) return;
    const [h, m] = p.time.split(":").map(Number);
    const time = `${pad(h)}:${pad(m)}`;
    if (reminders().some(r => r.repeat === "once" && r.date === todayDate() && r.time === time && r.text === p.item)) { $("mStatus").textContent = "ตั้งเตือนรายการนี้ไว้แล้ว"; return; }
    const r = addReminder(p.item, time, "once", todayDate());
    $("mStatus").textContent = nextAt(r) ? `ตั้งเตือน "${p.item}" เวลา ${time} แล้ว` : `เวลา ${time} ผ่านไปแล้ว ตั้งเตือนไม่ได้`;
    e.target.textContent = "ตั้งแล้ว"; e.target.disabled = true;
  });
  function renderBriefButton() {
    const busy = isPending("brief", todayDate());
    $("briefBtn").disabled = busy;
    $("briefBtn").textContent = busy ? "AI กำลังคิด…" : "ขอแผนวันนี้";
    if (busy && !$("mStatus").textContent) $("mStatus").textContent = "AI กำลังคิดแผนให้ ออกจากแอปได้ จะมีแจ้งเตือนเมื่อเสร็จ";
  }
  const morningInput = () => ({ tasks: $("mTasks").value.trim(), worry: $("mWorry").value.trim(), energy: getScale($("mEnergy")) });

  $("briefBtn").addEventListener("click", async () => {
    const m = morningInput(), date = todayDate();
    saveToday({ morning: m });
    let job;
    try { job = buildJob("brief", date, briefPrompt(date, m), { schema: BRIEF_SCHEMA, effort: "medium" }); }
    catch (e) { $("mStatus").textContent = e.message; return; }
    $("mStatus").textContent = settings().provider === "claude"
      ? "Claude กำลังคิดแผนให้… ออกจากแอปได้ จะมีแจ้งเตือนเมื่อเสร็จ"
      : "AI ในเครื่องกำลังคิดแผนให้ อาจใช้เวลา 1-3 นาที ออกจากแอปได้ จะมีแจ้งเตือนเมื่อเสร็จ (อย่าปิด Termux)";
    await startJob(job);
    renderBriefButton();
  });
  $("mSaveBtn").addEventListener("click", () => { saveToday({ morning: morningInput() }); $("mStatus").textContent = "บันทึกแล้ว"; });

  // ---------- evening ----------
  function renderChecks() {
    const t = today(), pr = t.morning.brief?.priorities || [], done = t.evening.done || [];
    $("eChecks").innerHTML = pr.length
      ? pr.map((p, i) => `<label><input type="checkbox" id="chk${i}" data-i="${i}" ${done.includes(i) ? "checked" : ""}><span>${esc(p)}</span></label>`).join("")
      : '<p class="small muted">เช้านี้ยังไม่ได้ทำแผน เขียนเล่าในช่องอัปเดตด้านล่างได้เลย</p>';
  }
  const doneList = () => [...$("eChecks").querySelectorAll("input:checked")].map(x => +x.dataset.i);
  const eveningInput = () => ({ done: doneList(), notes: $("eNotes").value.trim(), wins: $("eWins").value.trim(), tomorrow: $("eTomorrow").value.trim(), mood: getScale($("eMood")), at: Date.now() });
  function renderReflectButton() {
    const busy = isPending("reflection", todayDate());
    $("reflectBtn").disabled = busy;
    $("reflectBtn").textContent = busy ? "AI กำลังสรุป…" : "ขอสรุปจาก AI";
  }
  $("eSaveBtn").addEventListener("click", () => { saveToday({ evening: eveningInput() }); $("eStatus").textContent = "บันทึกวันนี้แล้ว พรุ่งนี้เช้าแผนจะคิดจากข้อมูลนี้"; });
  $("reflectBtn").addEventListener("click", async () => {
    const ev = eveningInput(), date = todayDate();
    saveToday({ evening: ev });
    const pr = today().morning.brief?.priorities || [];
    const prompt = `คุณเป็นโค้ชส่วนตัวที่อบอุ่นและตรงไปตรงมา ตอบเป็นภาษาไทย ไม่เกิน 120 คำ ไม่ใช้ markdown
${contextText(date)}
วันนี้ (${thDate(new Date())}):
- งานหลักจากแผนเช้า: ${pr.map((p, i) => `${p}${ev.done.includes(i) ? " [เสร็จ]" : " [ไม่เสร็จ]"}`).join("; ") || "(ไม่มีแผน)"}
- อัปเดต: ${ev.notes || "-"}
- เรื่องดี: ${ev.wins || "-"}
- ยกไปพรุ่งนี้: ${ev.tomorrow || "-"}
- อารมณ์: ${ev.mood || "-"}/5
สรุปวันนี้สั้น ๆ ชมสิ่งที่ทำได้ แล้วแนะนำ 1-2 อย่างสำหรับพรุ่งนี้`;
    let job;
    try { job = buildJob("reflection", date, prompt, { effort: "low" }); }
    catch (e) { $("eStatus").textContent = e.message; return; }
    const out = $("reflection"); out.hidden = false;
    out.innerHTML = '<p class="small muted">AI กำลังอ่านบันทึก ออกจากแอปได้ จะมีแจ้งเตือนเมื่อเสร็จ</p>';
    await startJob(job);
    renderReflectButton();
  });

  // ---------- history ----------
  const allDays = () => Object.keys(docs).filter(k => k.startsWith("day-")).sort().map(k => docs[k]);
  function renderHistory() {
    const days = allDays().reverse();
    $("histList").innerHTML = days.length ? days.map(d => {
      const pr = d.morning?.brief?.priorities || [], done = (d.evening?.done || []).length;
      return `<div class="day"><span class="d">${esc(String(d.date).slice(5).replace("-", "/"))}</span>
        <div class="s">${esc(d.morning?.brief?.focus || d.morning?.tasks || "ไม่มีแผน")}${d.evening?.notes ? `<div class="small muted">${esc(d.evening.notes)}</div>` : ""}</div>
        <div class="chips">${pr.length ? `<span class="chip ${done === pr.length ? "ok" : ""}">เสร็จ ${done}/${pr.length}</span>` : ""}${d.morning?.energy ? `<span class="chip">พลังงาน ${d.morning.energy}/5</span>` : ""}${d.evening?.mood ? `<span class="chip">อารมณ์ ${d.evening.mood}/5</span>` : ""}</div></div>`;
    }).join("") : '<div class="card"><p class="muted small">ยังไม่มีบันทึก เริ่มจากแท็บ "เช้า" แล้ววันที่บันทึกไว้จะขึ้นตรงนี้ ล่าสุดอยู่บนสุด</p></div>';
  }

  // ---------- export / import ----------
  const csvCell = v => `"${String(v ?? "").replace(/"/g, '""').replace(/\r?\n/g, " / ")}"`;
  function buildExport(kind) {
    const days = allDays();
    if (kind === "json") return JSON.stringify({ app: "N-assistant", exportedAt: new Date().toISOString(), settings: settings(), reminders: reminders(), placeRules: placeRules(), kb: kbFiles(), memory: memList(), days }, null, 2);
    if (kind === "csv") {
      const head = ["วันที่", "งานวันนี้", "เรื่องกังวล", "พลังงาน", "เป้าหลัก", "งานสำคัญ", "ควรระวัง", "แผนตามเวลา", "งานที่เสร็จ", "จำนวนเสร็จ", "อัปเดตตอนเย็น", "เรื่องดี", "ยกไปพรุ่งนี้", "อารมณ์", "สรุปจาก AI"];
      const rows = days.map(d => { const b = d.morning?.brief || {}, pr = b.priorities || [], dn = d.evening?.done || [];
        return [d.date, d.morning?.tasks, d.morning?.worry, d.morning?.energy, b.focus, pr.join(" | "), (b.cautions || []).join(" | "), (b.plan || []).map(p => p.time + " " + p.item).join(" | "), dn.map(i => pr[i]).filter(Boolean).join(" | "), pr.length ? `${dn.length}/${pr.length}` : "", d.evening?.notes, d.evening?.wins, d.evening?.tomorrow, d.evening?.mood, d.evening?.reflection].map(csvCell).join(","); });
      return "﻿" + [head.map(csvCell).join(","), ...rows].join("\r\n");
    }
    return ["# N-assistant บันทึกประจำวัน", "", ...days.flatMap(d => { const b = d.morning?.brief || {}, pr = b.priorities || [], dn = d.evening?.done || [];
      return [`## ${d.date}`, "", b.focus ? `**เป้าหลัก:** ${b.focus}` : "", d.morning?.tasks ? `**งานวันนี้:** ${d.morning.tasks}` : "",
        pr.length ? "\n**ต้องทำ**\n" + pr.map((p, i) => `- [${dn.includes(i) ? "x" : " "}] ${p}`).join("\n") : "",
        (b.cautions || []).length ? "\n**ควรระวัง**\n" + b.cautions.map(c => "- " + c).join("\n") : "",
        (b.plan || []).length ? "\n**แผน**\n" + b.plan.map(p => `- ${p.time} ${p.item}`).join("\n") : "",
        d.evening?.notes ? `\n**อัปเดตตอนเย็น:** ${d.evening.notes}` : "", d.evening?.wins ? `**เรื่องดี:** ${d.evening.wins}` : "",
        d.evening?.tomorrow ? `**ยกไปพรุ่งนี้:** ${d.evening.tomorrow}` : "", d.evening?.mood ? `**อารมณ์:** ${d.evening.mood}/5` : "",
        d.evening?.reflection ? `\n> ${d.evening.reflection}` : "", ""].filter(x => x !== ""); })].join("\n");
  }
  const MIME = { csv: "text/csv", md: "text/markdown", json: "application/json" };
  document.querySelectorAll("[data-export]").forEach(b => b.addEventListener("click", () => {
    const kind = b.dataset.export, filename = `n-assistant-${todayDate()}.${kind}`;
    if (!A) { $("xStatus").textContent = "ส่งออกไฟล์ได้เฉพาะในแอปบนมือถือ"; return; }
    $("xStatus").textContent = "เลือกที่เก็บไฟล์…";
    A.saveFile(filename, MIME[kind], buildExport(kind));
  }));
  handlers.saved = r => { $("xStatus").textContent = r && r.message ? r.message : ""; };
  $("shareMd").addEventListener("click", () => { if (A) A.shareText("N-assistant บันทึกประจำวัน", buildExport("md")); });
  $("importFile").addEventListener("change", async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.days)) throw new Error();
      let n = 0;
      for (const d of data.days) {
        if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue;
        const id = dayKey(d.date), cur = docs[id];
        if (!cur || (d.updatedAt || 0) >= (cur.updatedAt || 0)) { docs[id] = { morning: {}, evening: {}, ...d }; n++; }
      }
      if (data.settings && !docs.settings) docs.settings = data.settings;
      if (Array.isArray(data.reminders)) {
        const have = new Set(reminders().map(r => r.id));
        const merged = [...reminders(), ...data.reminders.filter(r => r && r.id && r.text && r.time && !have.has(r.id))];
        docs.reminders = { list: merged, updatedAt: Date.now() };
        if (A) A.setReminders(JSON.stringify(merged));
      }
      if (Array.isArray(data.notes)) { docs.notes = { list: data.notes }; migrateNotes(); } // backups from v1.0.23-1.0.25
      if (Array.isArray(data.placeRules)) {
        const have = new Set(placeRules().map(r => r.id));
        docs.placeRules = { list: [...placeRules(), ...data.placeRules.filter(r => r && r.id && r.place && r.text && !have.has(r.id))], updatedAt: Date.now() };
        if (A && A.setPlaceRules) A.setPlaceRules(JSON.stringify(docs.placeRules.list));
      }
      if (Array.isArray(data.memory)) {
        const have = new Set(memList().map(m => m.id));
        docs.memory = { list: [...memList(), ...data.memory.filter(m => m && m.id && m.q && m.a && !have.has(m.id))].slice(-MEM_MAX), updatedAt: Date.now() };
        renderMem();
      }
      if (Array.isArray(data.kb)) {
        const have = new Set(kbFiles().map(f => f.id));
        docs.kb = { files: [...kbFiles(), ...data.kb.filter(f => f && f.id && f.text && !have.has(f.id))], updatedAt: Date.now() };
        kbChunks = null; renderKb();
      }
      lsSet(LS_DOCS, docs); hydrate(); renderHistory(); schedulePrepSync();
      $("xStatus").textContent = `นำเข้าแล้ว ${n} วัน`;
    } catch { $("xStatus").textContent = "ไฟล์นี้ไม่ใช่ไฟล์สำรองของ N-assistant"; }
    e.target.value = "";
  });

  // ---------- settings & alarms ----------
  function pushAlarms() {
    const s = settings();
    if (A) A.setAlarms(s.wake, !!s.wakeOn, s.evening, !!s.eveningOn);
    syncPrep();
    renderAlarms();
  }
  $("sSaveBtn").addEventListener("click", () => {
    save("settings", {
      wake: $("sWake").value || "06:30", wakeOn: $("sWakeOn").checked,
      evening: $("sEve").value || "19:30", eveningOn: $("sEveOn").checked, prepMinutes: +$("sPrep").value || 0,
      name: $("sName").value.trim(), goals: $("sGoals").value.trim(), model: $("sModel").value,
      otherUrl: $("sOtherUrl").value.trim(), otherModel: $("sOtherModel").value.trim(),
      mdRepo: $("sMdRepo").value.trim(), mdPath: $("sMdPath").value.trim() || "chat/n-assistant.md",
      provider: $("sProvider").value, localUrl: $("sLocalUrl").value.trim() || DEFAULT_SETTINGS.localUrl, localModel: $("sLocalModel").value || DEFAULT_SETTINGS.localModel, updatedAt: Date.now()
    });
    try { const k = $("sKey").value.trim(); if (k) localStorage.setItem(LS_KEY, k); else localStorage.removeItem(LS_KEY); } catch {}
    try { const k = $("sOtherKey").value.trim(); if (k) localStorage.setItem(LS_OTHER_KEY, k); else localStorage.removeItem(LS_OTHER_KEY); } catch {}
    lsPut(LS_MD_TOKEN, $("sMdToken").value.trim());
    const mdKey = $("sMdKey").value.trim();
    if (mdKey && mdKey.length < 16) { $("sStatus").textContent = "กุญแจเข้ารหัสของไฟล์ MD ต้องยาวอย่างน้อย 16 ตัว (ส่วนอื่นบันทึกแล้ว)"; }
    else lsPut(LS_MD_KEY, mdKey);
    if ($("liveSwitch").getAttribute("aria-checked") !== "true") setLiveMode(liveMode); // refresh the AI name on the Live screen
    pushAlarms();
    $("sStatus").textContent = "บันทึกการตั้งค่าแล้ว";
    setTimeout(checkPermissions, 800);
  });
  $("testBeep").addEventListener("click", () => {
    if (A) { A.testRing(); $("sStatus").textContent = "กำลังทดสอบเสียงปลุก กดหยุดได้ที่การแจ้งเตือน"; }
    else $("sStatus").textContent = "ทดสอบเสียงได้เฉพาะในแอปบนมือถือ";
  });
  function renderAlarms() {
    const s = settings();
    $("tMorning").textContent = s.wakeOn ? s.wake : "ปิด";
    $("tEvening").textContent = s.eveningOn ? s.evening : "ปิด";
    $("amMorning").classList.toggle("armed", !!s.wakeOn && !!A);
    $("amEvening").classList.toggle("armed", !!s.eveningOn && !!A);
  }
  function checkPermissions() {
    const info = nativeInfo(), s = settings(), box = $("permWarn");
    if (!info || !(s.wakeOn || s.eveningOn || reminders().length)) { box.hidden = true; return; }
    if (!info.notifications) {
      box.innerHTML = 'แอปยังไม่ได้รับสิทธิ์แจ้งเตือน เสียงปลุกและการเตือนจะไม่ขึ้น <button class="btn" type="button" id="fixNotif">เปิดสิทธิ์</button>';
      box.hidden = false; $("fixNotif").onclick = () => A.openNotificationSettings();
    } else if (!info.exactAlarms) {
      box.innerHTML = 'แอปยังไม่ได้รับสิทธิ์ตั้งนาฬิกาปลุกตรงเวลา การเตือนอาจช้าไปหลายนาที <button class="btn" type="button" id="fixAlarm">เปิดสิทธิ์</button>';
      box.hidden = false; $("fixAlarm").onclick = () => A.openAlarmPermission();
    } else box.hidden = true;
  }
  handlers.resume = () => {
    checkPermissions(); pullResults(); renderBriefButton(); renderReflectButton(); renderChatButton();
    if (todayDate() !== lastKey) { lastKey = todayDate(); hydrate(); }
  };

  // ---------- ringing ----------
  handlers.ring = kind => {
    const s = settings(), evening = kind === "evening";
    $("ring").hidden = false; $("ring").classList.toggle("evening", evening); $("ring").dataset.kind = kind;
    $("ringTime").textContent = hhmm(new Date());
    $("ringTitle").textContent = (evening ? "เย็นแล้ว" : "อรุณสวัสดิ์") + (s.name ? " " + s.name : "");
    $("ringMsg").textContent = evening ? "วันนี้เป็นยังไงบ้าง มาบันทึกกัน" : (today().morning.brief ? "แผนวันนี้เตรียมไว้ให้แล้ว" : "ได้เวลาวางแผนวันนี้แล้ว");
    $("ringStop").focus();
  };
  $("ringStop").addEventListener("click", () => {
    if (A) A.stopRing();
    $("ring").hidden = true;
    showTab($("ring").dataset.kind === "evening" ? "evening" : "morning");
  });

  // ---------- provider settings ----------
  function showProviderBox() {
    const p = $("sProvider").value;
    $("claudeBox").hidden = p !== "claude"; $("localBox").hidden = p !== "local"; $("otherBox").hidden = p !== "openai"; $("mdBox").hidden = p !== "githubmd";
    if (p === "local") renderTermux();
  }
  $("mdNewKey").addEventListener("click", () => {
    if ($("sMdKey").value && !confirm("สร้างกุญแจใหม่แทนกุญแจเดิม? AI ฝั่งที่ตอบต้องเปลี่ยนเป็นกุญแจใหม่ด้วย")) return;
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789", r = new Uint32Array(32);
    crypto.getRandomValues(r);
    $("sMdKey").value = Array.from(r, n => abc[n % abc.length]).join("");
    $("sMdKey").type = "text"; $("mdShowKey").textContent = "ซ่อนกุญแจ";
    $("sStatus").textContent = "สร้างกุญแจแล้ว จดไว้ให้ AI ฝั่งที่ตอบ แล้วกด \"บันทึกการตั้งค่า\"";
  });
  $("mdShowKey").addEventListener("click", () => { const show = $("sMdKey").type === "password"; $("sMdKey").type = show ? "text" : "password"; $("mdShowKey").textContent = show ? "ซ่อนกุญแจ" : "แสดงกุญแจ"; });
  $("sOtherPreset").addEventListener("change", () => { const v = $("sOtherPreset").value; if (v) $("sOtherUrl").value = v; $("sOtherUrl").focus(); });

  // ---------- Termux: let the app start "ollama serve" by itself ----------
  function termuxInfo() { try { return A && A.termuxStatus ? JSON.parse(A.termuxStatus()) : null; } catch { return null; } }
  function renderTermux() {
    const t = termuxInfo();
    if (!t) { $("termuxState").textContent = "ใช้ได้เฉพาะในแอปบนมือถือ"; return; }
    $("tsInstall").classList.toggle("done", t.installed); $("tsPerm").classList.toggle("done", t.permitted);
    const unsupported = t.installed && t.supported === false;
    $("termuxPerm").hidden = t.permitted || !t.installed || unsupported;
    $("termuxStart").hidden = unsupported;
    $("termuxState").textContent = !t.installed ? "ยังไม่พบแอป Termux ในเครื่อง ทำตามขั้นตอนด้านล่าง"
      : unsupported ? "Termux ในเครื่องนี้ไม่ยอมให้แอปอื่นสั่งงาน (น่าจะเป็นตัวจาก Play Store) แอปจึงเปิด Ollama ให้เองไม่ได้ ให้เปิด Termux แล้วพิมพ์ termux-wake-lock; ollama serve ทิ้งไว้ก่อนใช้ AI ถ้าอยากให้เปิดเอง ต้องเปลี่ยนไปใช้ Termux จาก F-Droid หรือ GitHub"
      : !t.permitted ? "พบ Termux แล้ว แต่แอปนี้ยังไม่ได้รับสิทธิ์สั่งงาน Termux"
      : "พร้อมแล้ว แอปจะเปิด Ollama ใน Termux ให้เองเมื่อต้องใช้";
  }
  handlers.termuxPerm = ok => { renderTermux(); $("termuxStatus").textContent = ok === "unsupported" ? "Termux ตัวนี้ไม่มีสิทธิ์นี้ให้ขอ (ดูข้อความด้านบน)" : ok ? "ได้รับสิทธิ์แล้ว" : "ยังไม่ได้รับสิทธิ์ ถ้าไม่มีหน้าต่างขออนุญาตขึ้น ให้เปิด ตั้งค่าเครื่อง → แอป → N-assistant → สิทธิ์ → สั่งงาน Termux"; };
  $("termuxPerm").addEventListener("click", () => A && A.askTermuxPermission());
  $("termuxOpen").addEventListener("click", () => A && A.openTermux());
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  $("termuxStart").addEventListener("click", async () => {
    if (!A || !A.termuxStart) return;
    const btn = $("termuxStart"); btn.disabled = true;
    try {
      try { await localGet("/api/tags"); $("termuxStatus").textContent = "Ollama ทำงานอยู่แล้ว เชื่อมต่อได้"; return; } catch {}
      const r = A.termuxStart();
      if (r !== "started") { $("termuxStatus").textContent = r === "no_termux" ? "ไม่พบแอป Termux" : r === "no_permission" ? "ยังไม่ได้รับสิทธิ์สั่ง Termux กด \"ขอสิทธิ์สั่ง Termux\" ก่อน" : "สั่ง Termux ไม่สำเร็จ: " + r; renderTermux(); return; }
      for (let i = 0; i < 15; i++) {
        $("termuxStatus").textContent = `สั่ง Termux แล้ว กำลังรอ Ollama… ${i * 2} วินาที`;
        await sleep(2000);
        try { await localGet("/api/tags"); $("termuxStatus").textContent = "เปิด Ollama สำเร็จ เชื่อมต่อได้แล้ว"; return; } catch {}
      }
      $("termuxStatus").textContent = "สั่งแล้วแต่ Ollama ยังไม่ตอบ ตรวจขั้นตอนที่ 2 และ 3 (ติดตั้ง Ollama และ allow-external-apps)";
    } finally { btn.disabled = false; }
  });
  function ensureModelOption(name) {
    if (!name) return;
    const sel = $("sLocalModel");
    if (![...sel.options].some(o => o.value === name)) sel.append(new Option(name, name));
  }
  $("sProvider").addEventListener("change", showProviderBox);
  let reqSeq = 0;
  const pendingLocal = {};
  handlers.local = r => { const p = r && pendingLocal[r.id]; if (p) { delete pendingLocal[r.id]; p(r); } };
  function localGet(path) {
    const base = ($("sLocalUrl").value.trim() || settings().localUrl).replace(/\/+$/, "");
    if (!A) return Promise.reject(new Error("AI ในเครื่องใช้ได้เฉพาะในแอปบนมือถือ"));
    return new Promise(resolve => {
      const id = "r" + (++reqSeq); pendingLocal[id] = resolve; A.localRequest(id, "GET", base + path, "");
      // Never leave a button waiting forever.
      setTimeout(() => { if (pendingLocal[id]) { delete pendingLocal[id]; resolve({ id, error: "Ollama ไม่ตอบภายใน 20 วินาที" }); } }, 20000);
    })
      .then(r => {
        if (r.error === "offline") throw new Error("ติดต่อ Ollama ไม่ได้ เปิด Termux แล้วรัน: ollama serve");
        if (r.error) throw new Error("ติดต่อ AI ในเครื่องไม่สำเร็จ: " + r.error);
        let data = {}; try { data = JSON.parse(r.body || "{}"); } catch {}
        if (!r.ok) throw new Error(data.error || ("Ollama ตอบกลับรหัส " + r.status));
        return data;
      });
  }
  // ---------- "ทดสอบ AI": a real question through the same path Live uses ----------
  let aiTestAt = 0, aiTestTick = null;
  $("aiTest").addEventListener("click", () => {
    $("sSaveBtn").click(); // test what is on screen, not what was saved before
    const out = $("aiTestStatus");
    let job;
    try { job = buildJob("test", "test", "ตอบสั้นๆ ภาษาไทยหนึ่งประโยคว่า สวัสดีครับ ผมพร้อมช่วยแล้ว", { effort: "low", userText: "สวัสดี (ทดสอบ)" }); }
    catch (e) { out.textContent = "ยังทดสอบไม่ได้: " + e.message; return; }
    aiTestAt = Date.now();
    $("aiTest").disabled = true;
    clearInterval(aiTestTick);
    const name = { local: "Ollama ในเครื่อง", claude: "Claude API", openai: "ผู้ให้บริการที่ตั้งไว้", githubmd: "ไฟล์ MD บน GitHub" }[settings().provider] || "AI";
    aiTestTick = setInterval(() => { out.textContent = `ส่งไปที่ ${name} แล้ว รอคำตอบ ${Math.floor((Date.now() - aiTestAt) / 1000)} วินาที…`; }, 1000);
    out.textContent = `ส่งไปที่ ${name} แล้ว รอคำตอบ…`;
    startJob(job);
  });
  function aiTestDone(res) {
    clearInterval(aiTestTick); $("aiTest").disabled = false;
    const sec = aiTestAt ? Math.round((Date.now() - aiTestAt) / 1000) : 0;
    const out = $("aiTestStatus");
    try {
      const when = new Date().toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      localStorage.setItem(AI_STATUS_KEY, JSON.stringify({ ok: !!res.ok, sec, when, name: aiName(), msg: res.ok ? "" : String(res.error || "").slice(0, 90) }));
    } catch {}
    if (!res.ok) { out.textContent = `ไม่สำเร็จ (${sec} วินาที): ${res.error || "ไม่ทราบสาเหตุ"}`; return; }
    out.textContent = `ใช้ได้ ตอบใน ${sec} วินาที: "${cleanText(res.text).slice(0, 120)}"` + (sec > 120 ? " · ช้ามาก ลองโมเดลที่เล็กลง" : "");
  }

  $("testLocal").addEventListener("click", async () => {
    const btn = $("testLocal"); btn.disabled = true; $("localStatus").textContent = "กำลังติดต่อ Ollama…";
    const keep = $("sLocalModel").value;
    try {
      const data = await localGet("/api/tags");
      const names = (data.models || []).map(m => m.name).filter(Boolean);
      const sel = $("sLocalModel"); sel.innerHTML = "";
      names.forEach(ensureModelOption);
      ensureModelOption(keep);
      sel.value = names.includes(keep) ? keep : (names[0] || keep);
      $("localStatus").textContent = names.length ? `เชื่อมต่อได้ พบโมเดล ${names.length} ตัว เลือกแล้วกด "บันทึกการตั้งค่า"` : "เชื่อมต่อได้ แต่ยังไม่มีโมเดลใน Ollama (ลอง: ollama pull qwen3.5:4b)";
    } catch (e) { $("localStatus").textContent = e.message; }
    finally { btn.disabled = false; }
  });

  // ---------- OTA updates ----------
  let latestUpdate = null;
  handlers.update = u => {
    if (!u) return;
    try { localStorage.setItem("nassistant.lastUpdateCheck", String(Date.now())); } catch {}
    if (u.error) { $("updState").textContent = "ตรวจหาอัปเดตไม่สำเร็จ: " + u.error; return; }
    if (u.available) {
      latestUpdate = u;
      $("updVer").textContent = u.latest;
      $("updNotes").textContent = (u.notes || "").split("\n").filter(Boolean).slice(0, 2).join(" ");
      $("updBanner").hidden = false;
      $("updState").textContent = `มีเวอร์ชัน ${u.latest} ให้อัปเดต`;
    } else {
      $("updBanner").hidden = true;
      $("updState").textContent = u.message || "เป็นเวอร์ชันล่าสุดแล้ว";
    }
  };
  handlers.updateProgress = pct => {
    $("updNow").disabled = pct < 100;
    $("updNow").textContent = pct < 100 ? `กำลังดาวน์โหลด ${pct}%` : "ติดตั้ง";
    if (pct >= 100) $("updState").textContent = "ดาวน์โหลดแล้ว กดติดตั้งในหน้าต่างที่ขึ้นมา";
  };
  $("updNow").addEventListener("click", () => {
    if (!A || !latestUpdate || !latestUpdate.url) return;
    $("updNow").disabled = true; $("updNow").textContent = "กำลังดาวน์โหลด…";
    A.installUpdate(latestUpdate.url);
  });
  $("checkUpd").addEventListener("click", () => {
    if (!A) { $("updState").textContent = "ตรวจหาอัปเดตได้เฉพาะในแอป"; return; }
    $("updState").textContent = "กำลังตรวจ…"; A.checkUpdate();
  });

  // ---------- fill forms ----------
  function hydrate() {
    const s = settings(), t = today();
    const set = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v ?? ""; };
    set("sWake", s.wake); set("sEve", s.evening); set("sName", s.name); set("sGoals", s.goals); set("sModel", s.model);
    set("sPrep", String(s.prepMinutes)); set("sProvider", s.provider); set("sLocalUrl", s.localUrl);
    ensureModelOption(s.localModel); set("sLocalModel", s.localModel); showProviderBox();
    $("sWakeOn").checked = !!s.wakeOn; $("sEveOn").checked = !!s.eveningOn;
    set("sKey", apiKey());
    set("sOtherUrl", s.otherUrl); set("sOtherModel", s.otherModel); set("sOtherKey", otherKey());
    set("sMdRepo", s.mdRepo); set("sMdPath", s.mdPath || "chat/n-assistant.md"); set("sMdToken", lsStr(LS_MD_TOKEN)); set("sMdKey", lsStr(LS_MD_KEY));
    { const preset = [...$("sOtherPreset").options].find(o => o.value && o.value === String(s.otherUrl || "").replace(/\/+$/, "")); $("sOtherPreset").value = preset ? preset.value : (s.otherUrl ? "" : $("sOtherPreset").options[0].value); }
    set("mTasks", t.morning.tasks); set("mWorry", t.morning.worry); setScale($("mEnergy"), t.morning.energy);
    set("eNotes", t.evening.notes); set("eWins", t.evening.wins); set("eTomorrow", t.evening.tomorrow); setScale($("eMood"), t.evening.mood);
    if (t.evening.reflection) { $("reflection").hidden = false; $("reflection").innerHTML = `<h3>สรุปจาก AI</h3><p>${esc(t.evening.reflection)}</p>`; }
    else if (!isPending("reflection", todayDate())) { $("reflection").hidden = true; }
    if (!$("rDate").value) $("rDate").value = todayDate();
    renderBrief(); renderBriefButton(); renderReflectButton(); renderChatButton(); renderAlarms(); renderReminders();
    if (!$("p-evening").hidden) renderChecks();
  }

  // ---------- clock ----------
  let lastKey = todayDate();
  function tick() {
    const now = new Date();
    $("now").textContent = hhmm(now); $("today").textContent = thDate(now);
    if (todayDate() !== lastKey) { lastKey = todayDate(); hydrate(); schedulePrepSync(); }
  }
  tick(); setInterval(tick, 5000);

  // ---------- start ----------
  const info = nativeInfo();
  $("appVer").textContent = info ? info.version : "เว็บ";
  pullResults();
  migrateNotes(); migrateChat();
  if (A && A.setPlaceRules) A.setPlaceRules(JSON.stringify(placeRules())); // native copy for the event receiver
  hydrate(); renderHistory(); renderKb(); renderMem(); renderFaq(); renderWake(); setLiveMode(liveMode); showTab("live");
  if (A) {
    A.setReminders(JSON.stringify(reminders()));
    if (!docs.settings) pushAlarms(); else syncPrep();
  }
  checkPermissions();
  if (A) {
    let last = 0; try { last = +localStorage.getItem("nassistant.lastUpdateCheck") || 0; } catch {}
    if (Date.now() - last > 20 * 3600 * 1000) A.checkUpdate();
  }
})();
