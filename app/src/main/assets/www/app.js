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
  const LS_PENDING = "nassistant.pending";
  let docs = lsGet(LS_DOCS) || {}; // "settings", "reminders", "day-YYYY-MM-DD"
  function save(id, body) { docs[id] = body; lsSet(LS_DOCS, docs); renderHistory(); schedulePrepSync(); }

  const DEFAULT_SETTINGS = { wake: "06:30", wakeOn: true, evening: "19:30", eveningOn: true, prepMinutes: 15, name: "", goals: "", provider: "local", localUrl: "http://127.0.0.1:11434", localModel: "qwen-fast:latest", model: "claude-opus-5-5" };
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
  const TABS = ["morning", "evening", "chat", "remind", "history", "settings"];
  function showTab(name) {
    if (!TABS.includes(name)) name = "morning";
    document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    TABS.forEach(t => $("p-" + t).hidden = t !== name);
    if (name === "evening") renderChecks();
    if (name === "remind") renderReminders();
    if (name === "chat") { renderChat(); setTimeout(() => $("chatLog").lastElementChild?.scrollIntoView({ block: "end" }), 50); }
    window.scrollTo(0, 0);
  }
  document.querySelector("nav").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab); });
  handlers.tab = name => showTab(name);

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

  /** Builds the request the native service sends. Throws with a message the person can act on. */
  function buildJob(kind, date, prompt, { schema = null, effort = "medium" } = {}) {
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
    if (kind === "json") return JSON.stringify({ app: "N-assistant", exportedAt: new Date().toISOString(), settings: settings(), reminders: reminders(), days }, null, 2);
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
      provider: $("sProvider").value, localUrl: $("sLocalUrl").value.trim() || DEFAULT_SETTINGS.localUrl, localModel: $("sLocalModel").value || DEFAULT_SETTINGS.localModel, updatedAt: Date.now()
    });
    try { const k = $("sKey").value.trim(); if (k) localStorage.setItem(LS_KEY, k); else localStorage.removeItem(LS_KEY); } catch {}
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
  function showProviderBox() { const c = $("sProvider").value === "claude"; $("claudeBox").hidden = !c; $("localBox").hidden = c; }
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
    return new Promise(resolve => { const id = "r" + (++reqSeq); pendingLocal[id] = resolve; A.localRequest(id, "GET", base + path, ""); })
      .then(r => {
        if (r.error === "offline") throw new Error("ติดต่อ Ollama ไม่ได้ เปิด Termux แล้วรัน: ollama serve");
        if (r.error) throw new Error("ติดต่อ AI ในเครื่องไม่สำเร็จ: " + r.error);
        let data = {}; try { data = JSON.parse(r.body || "{}"); } catch {}
        if (!r.ok) throw new Error(data.error || ("Ollama ตอบกลับรหัส " + r.status));
        return data;
      });
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
  hydrate(); renderHistory(); showTab(new Date().getHours() >= 16 ? "evening" : "morning");
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
