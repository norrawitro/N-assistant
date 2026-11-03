(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const A = window.Android || null; // native bridge (absent when opened in a normal browser)
  const pad = n => String(n).padStart(2, "0");
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const thDate = d => d.toLocaleDateString("th-TH", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  // ---------- storage (on this phone) ----------
  const LS_DOCS = "nassistant.docs";
  const LS_KEY = "nassistant.apikey";
  let docs = lsGet(LS_DOCS) || {}; // "settings", "day-YYYY-MM-DD"
  function save(id, body) { docs[id] = body; lsSet(LS_DOCS, docs); renderHistory(); }

  const DEFAULT_SETTINGS = { wake: "06:30", wakeOn: true, evening: "19:30", eveningOn: true, name: "", goals: "", model: "claude-opus-5-5" };
  const settings = () => ({ ...DEFAULT_SETTINGS, ...(docs.settings || {}) });
  const todayKey = () => "day-" + keyOf(new Date());
  const today = () => docs[todayKey()] || { date: keyOf(new Date()), morning: {}, evening: {} };
  const recentDays = n => Object.keys(docs).filter(k => k.startsWith("day-") && k !== todayKey()).sort().reverse().slice(0, n).map(k => docs[k]);
  function saveToday(patch) {
    const t = JSON.parse(JSON.stringify(today()));
    t.morning = { ...t.morning, ...(patch.morning || {}) };
    t.evening = { ...t.evening, ...(patch.evening || {}) };
    t.updatedAt = Date.now();
    save(todayKey(), t);
  }

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
  function showTab(name) {
    document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    ["morning", "evening", "history", "settings"].forEach(t => $("p-" + t).hidden = t !== name);
    if (name === "evening") renderChecks();
    window.scrollTo(0, 0);
  }
  document.querySelector("nav").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab); });

  // ---------- Claude API (user's own key, called from this device) ----------
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
  async function askClaude(prompt, { schema = null, effort = "medium" } = {}) {
    let key = ""; try { key = localStorage.getItem(LS_KEY) || ""; } catch {}
    if (!key) throw new Error("ยังไม่ได้ใส่ Claude API key ไปที่แท็บ \"ตั้งค่า\" ก่อน");
    const model = settings().model;
    const body = { model, max_tokens: 16000, messages: [{ role: "user", content: prompt }], output_config: { effort } };
    if (schema) body.output_config.format = { type: "json_schema", schema };
    const headers = {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2026-10-21",
      "anthropic-dangerous-direct-browser-access": "true"
    };
    // If a safety check declines the request, let the API retry on its recommended fallback model.
    if (model !== "claude-haiku-5-5") { body.fallbacks = "default"; headers["anthropic-beta"] = "server-side-fallback-2026-07-01"; }
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
    } catch {
      throw new Error("เชื่อมต่ออินเทอร์เน็ตไม่ได้ ตรวจสอบสัญญาณแล้วลองใหม่");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || "";
      if (res.status === 401) throw new Error("API key ไม่ถูกต้อง ตรวจสอบในแท็บ \"ตั้งค่า\"");
      if (res.status === 429) throw new Error("ใช้งานถี่เกินไป หรือเครดิตในบัญชี API หมด รอสักครู่แล้วลองใหม่");
      if (res.status === 529 || res.status >= 500) throw new Error("ระบบ Claude ยุ่งอยู่ ลองใหม่อีกครั้งในอีกสักครู่");
      throw new Error("Claude ตอบกลับข้อผิดพลาด: " + (msg || res.status));
    }
    if (data.stop_reason === "refusal") throw new Error("Claude ไม่สามารถตอบคำขอนี้ได้ ลองปรับข้อความแล้วส่งใหม่");
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    if (!text) throw new Error("Claude ไม่ได้ส่งคำตอบกลับมา ลองใหม่อีกครั้ง");
    return schema ? JSON.parse(text) : text;
  }

  function contextText() {
    const s = settings();
    const past = recentDays(3).map(d => {
      const pr = d.morning?.brief?.priorities || [];
      const done = d.evening?.done || [];
      return `- ${d.date}: งานหลัก ${pr.map((p, i) => `${p}${done.includes(i) ? " [เสร็จ]" : " [ไม่เสร็จ]"}`).join("; ") || "-"} | อัปเดต: ${d.evening?.notes || "-"} | ยกไปวันถัดไป: ${d.evening?.tomorrow || "-"} | อารมณ์ ${d.evening?.mood || "-"}/5`;
    }).join("\n");
    return `ชื่อเล่นผู้ใช้: ${s.name || "(ไม่ระบุ)"}\nเป้าหมายระยะยาว: ${s.goals || "(ไม่ระบุ)"}\nบันทึกย้อนหลัง:\n${past || "(ยังไม่มี)"}`;
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
    $("briefCard").innerHTML = `
      <div class="row" style="justify-content:space-between">
        <span class="label">แผนวันนี้</span>
        ${data.example ? '<span class="tag">ตัวอย่าง</span>' : `<span class="small muted">สร้างเมื่อ ${esc(new Date(b.at || Date.now()).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }))}</span>`}
      </div>
      ${data.greeting ? `<p>${esc(data.greeting)}</p>` : ""}
      ${data.focus ? `<p class="focus">${esc(data.focus)}</p>` : ""}
      <div class="sec"><h3>ต้องทำวันนี้</h3><ol>${list(data.priorities)}</ol></div>
      <div class="sec caution"><h3>ควรระวัง</h3><ul>${list(data.cautions)}</ul></div>
      ${(data.plan || []).length ? `<div class="sec"><h3>แผนตามเวลา</h3><dl class="plan">${data.plan.map(p => `<dt>${esc(p.time)}</dt><dd>${esc(p.item)}</dd>`).join("")}</dl></div>` : ""}
      ${data.tip ? `<p class="small"><b>เคล็ดลับ:</b> ${esc(data.tip)}</p>` : ""}
      ${data.example ? '<p class="small muted">นี่คือตัวอย่างหน้าตาแผน กรอกข้อมูลด้านบนแล้วกด "ขอแผนวันนี้" เพื่อสร้างแผนของคุณ</p>' : ""}`;
  }
  const morningInput = () => ({ tasks: $("mTasks").value.trim(), worry: $("mWorry").value.trim(), energy: getScale($("mEnergy")) });

  $("briefBtn").addEventListener("click", async () => {
    const m = morningInput();
    saveToday({ morning: m });
    const btn = $("briefBtn"); btn.disabled = true; $("mStatus").textContent = "Claude กำลังคิดแผนให้… (อาจใช้เวลาครึ่งนาที)";
    const now = new Date();
    const prompt = `คุณเป็นผู้ช่วยวางแผนตอนเช้าที่พูดจาเป็นกันเอง กระชับ และใช้งานได้จริง ตอบเป็นภาษาไทยทั้งหมด
วันนี้: ${thDate(now)} เวลาตอนนี้ ${hhmm(now)}
${contextText()}

ข้อมูลเช้านี้:
- งาน/นัดวันนี้: ${m.tasks || "(ไม่ได้ระบุ)"}
- เรื่องที่กังวล: ${m.worry || "(ไม่ได้ระบุ)"}
- พลังงาน: ${m.energy ? m.energy + "/5" : "(ไม่ได้ระบุ)"}

ให้คิดจากข้อมูลจริงข้างบน ถ้ามีงานค้างจากวันก่อนให้หยิบมาพิจารณา ถ้าพลังงานต่ำให้ลดงานและเตือนเรื่องพัก อย่าแต่งนัดหมายที่ผู้ใช้ไม่ได้บอก
greeting = ทักทายสั้น 1 ประโยค, focus = สิ่งเดียวที่สำคัญที่สุดวันนี้, priorities = งานสำคัญ 3-5 ข้อเรียงตามลำดับ, cautions = สิ่งที่ควรระวัง 2-4 ข้อ, plan = แผนตามเวลา (time เป็น HH:MM), tip = คำแนะนำสั้น 1 ข้อ`;
    try {
      const r = await askClaude(prompt, { schema: BRIEF_SCHEMA, effort: "medium" });
      const brief = {
        greeting: String(r.greeting || ""), focus: String(r.focus || ""),
        priorities: (r.priorities || []).map(String).slice(0, 6),
        cautions: (r.cautions || []).map(String).slice(0, 6),
        plan: (r.plan || []).filter(p => p && p.item).map(p => ({ time: String(p.time || ""), item: String(p.item) })).slice(0, 12),
        tip: String(r.tip || ""), at: Date.now()
      };
      saveToday({ morning: { brief } });
      renderBrief();
      $("mStatus").textContent = "บันทึกแผนวันนี้แล้ว";
    } catch (e) { $("mStatus").textContent = e.message || "ถาม Claude ไม่สำเร็จ ลองใหม่อีกครั้ง"; }
    finally { btn.disabled = false; }
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
  $("eSaveBtn").addEventListener("click", () => { saveToday({ evening: eveningInput() }); $("eStatus").textContent = "บันทึกวันนี้แล้ว พรุ่งนี้เช้าแผนจะคิดจากข้อมูลนี้"; });
  $("reflectBtn").addEventListener("click", async () => {
    const ev = eveningInput();
    saveToday({ evening: ev });
    const pr = today().morning.brief?.priorities || [];
    const btn = $("reflectBtn"); btn.disabled = true;
    const out = $("reflection"); out.hidden = false; out.innerHTML = '<p class="small muted">Claude กำลังอ่านบันทึก…</p>';
    const prompt = `คุณเป็นโค้ชส่วนตัวที่อบอุ่นและตรงไปตรงมา ตอบเป็นภาษาไทย ไม่เกิน 120 คำ ไม่ใช้ markdown
${contextText()}
วันนี้ (${thDate(new Date())}):
- งานหลักจากแผนเช้า: ${pr.map((p, i) => `${p}${ev.done.includes(i) ? " [เสร็จ]" : " [ไม่เสร็จ]"}`).join("; ") || "(ไม่มีแผน)"}
- อัปเดต: ${ev.notes || "-"}
- เรื่องดี: ${ev.wins || "-"}
- ยกไปพรุ่งนี้: ${ev.tomorrow || "-"}
- อารมณ์: ${ev.mood || "-"}/5
สรุปวันนี้สั้น ๆ ชมสิ่งที่ทำได้ แล้วแนะนำ 1-2 อย่างสำหรับพรุ่งนี้`;
    try {
      const text = await askClaude(prompt, { effort: "low" });
      out.innerHTML = `<h3>สรุปจาก Claude</h3><p>${esc(text)}</p>`;
      saveToday({ evening: { reflection: text } });
    } catch (e) { out.innerHTML = `<p class="small">${esc(e.message)}</p>`; }
    finally { btn.disabled = false; }
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
    if (kind === "json") return JSON.stringify({ app: "N-assistant", exportedAt: new Date().toISOString(), settings: settings(), days }, null, 2);
    if (kind === "csv") {
      const head = ["วันที่", "งานวันนี้", "เรื่องกังวล", "พลังงาน", "เป้าหลัก", "งานสำคัญ", "ควรระวัง", "แผนตามเวลา", "งานที่เสร็จ", "จำนวนเสร็จ", "อัปเดตตอนเย็น", "เรื่องดี", "ยกไปพรุ่งนี้", "อารมณ์", "สรุปจาก Claude"];
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
    const kind = b.dataset.export, filename = `n-assistant-${keyOf(new Date())}.${kind}`;
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
        const id = "day-" + d.date, cur = docs[id];
        if (!cur || (d.updatedAt || 0) >= (cur.updatedAt || 0)) { docs[id] = { morning: {}, evening: {}, ...d }; n++; }
      }
      if (data.settings && !docs.settings) docs.settings = data.settings;
      lsSet(LS_DOCS, docs); hydrate(); renderHistory();
      $("xStatus").textContent = `นำเข้าแล้ว ${n} วัน`;
    } catch { $("xStatus").textContent = "ไฟล์นี้ไม่ใช่ไฟล์สำรองของ N-assistant"; }
    e.target.value = "";
  });

  // ---------- settings & alarms ----------
  function pushAlarms() {
    const s = settings();
    if (A) A.setAlarms(s.wake, !!s.wakeOn, s.evening, !!s.eveningOn);
    renderAlarms();
  }
  $("sSaveBtn").addEventListener("click", () => {
    save("settings", {
      wake: $("sWake").value || "06:30", wakeOn: $("sWakeOn").checked,
      evening: $("sEve").value || "19:30", eveningOn: $("sEveOn").checked,
      name: $("sName").value.trim(), goals: $("sGoals").value.trim(), model: $("sModel").value, updatedAt: Date.now()
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
    if (!info || !(s.wakeOn || s.eveningOn)) { box.hidden = true; return; }
    if (!info.notifications) {
      box.innerHTML = 'แอปยังไม่ได้รับสิทธิ์แจ้งเตือน เสียงปลุกจะไม่ดัง <button class="btn" type="button" id="fixNotif">เปิดสิทธิ์</button>';
      box.hidden = false; $("fixNotif").onclick = () => A.openNotificationSettings();
    } else if (!info.exactAlarms) {
      box.innerHTML = 'แอปยังไม่ได้รับสิทธิ์ตั้งนาฬิกาปลุกตรงเวลา เสียงอาจช้าไปหลายนาที <button class="btn" type="button" id="fixAlarm">เปิดสิทธิ์</button>';
      box.hidden = false; $("fixAlarm").onclick = () => A.openAlarmPermission();
    } else box.hidden = true;
  }
  handlers.resume = () => { checkPermissions(); if (keyOf(new Date()) !== lastKey) { lastKey = keyOf(new Date()); hydrate(); } };

  // ---------- ringing ----------
  handlers.ring = kind => {
    const s = settings(), evening = kind === "evening";
    $("ring").hidden = false; $("ring").classList.toggle("evening", evening); $("ring").dataset.kind = kind;
    $("ringTime").textContent = hhmm(new Date());
    $("ringTitle").textContent = (evening ? "เย็นแล้ว" : "อรุณสวัสดิ์") + (s.name ? " " + s.name : "");
    $("ringMsg").textContent = evening ? "วันนี้เป็นยังไงบ้าง มาบันทึกกัน" : "ได้เวลาวางแผนวันนี้แล้ว";
    $("ringStop").focus();
  };
  $("ringStop").addEventListener("click", () => {
    if (A) A.stopRing();
    $("ring").hidden = true;
    showTab($("ring").dataset.kind === "evening" ? "evening" : "morning");
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
    $("sWakeOn").checked = !!s.wakeOn; $("sEveOn").checked = !!s.eveningOn;
    try { set("sKey", localStorage.getItem(LS_KEY) || ""); } catch {}
    set("mTasks", t.morning.tasks); set("mWorry", t.morning.worry); setScale($("mEnergy"), t.morning.energy);
    set("eNotes", t.evening.notes); set("eWins", t.evening.wins); set("eTomorrow", t.evening.tomorrow); setScale($("eMood"), t.evening.mood);
    if (t.evening.reflection) { $("reflection").hidden = false; $("reflection").innerHTML = `<h3>สรุปจาก Claude</h3><p>${esc(t.evening.reflection)}</p>`; }
    else { $("reflection").hidden = true; }
    renderBrief(); renderAlarms(); if (!$("p-evening").hidden) renderChecks();
  }

  // ---------- clock ----------
  let lastKey = keyOf(new Date());
  function tick() {
    const now = new Date();
    $("now").textContent = hhmm(now); $("today").textContent = thDate(now);
    if (keyOf(now) !== lastKey) { lastKey = keyOf(now); hydrate(); }
  }
  tick(); setInterval(tick, 5000);

  // ---------- start ----------
  const info = nativeInfo();
  $("appVer").textContent = info ? info.version : "เว็บ";
  hydrate(); renderHistory(); showTab(new Date().getHours() >= 16 ? "evening" : "morning");
  if (A && !docs.settings) pushAlarms(); // first launch: arm the default alarms
  checkPermissions();
  if (A) {
    let last = 0; try { last = +localStorage.getItem("nassistant.lastUpdateCheck") || 0; } catch {}
    if (Date.now() - last > 20 * 3600 * 1000) A.checkUpdate();
  }
})();
