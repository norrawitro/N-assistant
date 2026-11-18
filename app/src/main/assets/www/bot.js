/*
 * Quick bot: plain rules, no AI. It answers simple things at once and is always available, also while the AI is
 * still working on an earlier question. Anything it does not understand returns null and goes to the AI.
 *
 * NBot.parse(text, ctx) -> null, or one of:
 *   { type: "say", say }                                   just answer
 *   { type: "reminder", text, time, date, repeat }         set a reminder (the page builds the spoken reply)
 *   { type: "ask", say, pending }                          needs more information; pass `pending` back in ctx next time
 *   { type: "open", tab, say }                             open a page
 *   { type: "listReminders" } | { type: "aiStatus" } | { type: "cancel" } | { type: "stop" }
 *   { type: "note", text }        save a note        { type: "listNotes" }        read the latest notes
 *   { type: "findNotes", q }      search the notes   { type: "deleteLastNote" }   remove the newest note
 *   { type: "learn", text }       add to the knowledge base   { type: "askKb", q }   look something up in it
 *   { type: "askAgain" }          ask the AI again, skipping the answer memory
 *   { type: "placeReminder", when: "enter"|"leave", place, text }   remind on arriving at / leaving a place
 *   { type: "whereNow" }          where the phone is (from GPS-Tracker)
 *   { type: "readClipboard" }     read aloud the text copied to the clipboard
 *   { type: "dayTasks", text }    add to today's tasks   { type: "planToday" }    ask the AI for today's plan
 * ctx: { now: Date, pending: object|null, aiBusy: boolean }
 */
(function (root) {
  "use strict";
  const pad = n => String(n).padStart(2, "0");
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const thDate = d => d.toLocaleDateString("th-TH", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());

  const NUM = { "สิบเอ็ด": 11, "สิบสอง": 12, "หนึ่ง": 1, "สอง": 2, "สาม": 3, "สี่": 4, "ห้า": 5, "หก": 6, "เจ็ด": 7, "แปด": 8, "เก้า": 9, "สิบ": 10 };
  const NUM_RE = new RegExp(`(${Object.keys(NUM).join("|")})(?= ?(โมง|ทุ่ม|นาที|ชั่วโมง|นาฬิกา))`, "g");
  const NUM_AFTER_RE = new RegExp(`(ตี|บ่าย|อีก) ?(${Object.keys(NUM).join("|")})`, "g");
  /** Thai number words next to a time word become digits ("แปดโมง" -> "8โมง"). */
  function digits(t) {
    return t.replace(NUM_RE, w => String(NUM[w])).replace(NUM_AFTER_RE, (_, a, w) => a + String(NUM[w]));
  }

  /** Finds a clock time or "in N minutes/hours". Returns { h, m, rel?: Date, match } or null. */
  function parseTime(raw, now) {
    const t = digits(raw);
    let m;
    if ((m = t.match(/อีก ?(\d{1,3}) ?นาที/))) { const at = new Date(now.getTime() + m[1] * 60000); return { h: at.getHours(), m: at.getMinutes(), rel: at, match: m[0] }; }
    if ((m = t.match(/อีก ?(\d{1,2}) ?ชั่วโมง(ครึ่ง)?/))) { const at = new Date(now.getTime() + (m[1] * 60 + (m[2] ? 30 : 0)) * 60000); return { h: at.getHours(), m: at.getMinutes(), rel: at, match: m[0] }; }
    if ((m = t.match(/อีกครึ่งชั่วโมง/))) { const at = new Date(now.getTime() + 30 * 60000); return { h: at.getHours(), m: at.getMinutes(), rel: at, match: m[0] }; }
    const minutes = s => { const x = s.match(/^ ?(ครึ่ง|(\d{1,2}) ?นาที)/); return x ? { v: x[1] === "ครึ่ง" ? 30 : +x[2], len: x[0].length } : { v: 0, len: 0 }; };
    const done = (h, idx, len) => {
      const mm = minutes(t.slice(idx + len));
      if (h > 23 || mm.v > 59) return null;
      return { h, m: mm.v, match: t.slice(idx, idx + len + mm.len) };
    };
    if ((m = t.match(/(\d{1,2})[:.](\d{2})( ?น\.?)?/)) && +m[1] < 24 && +m[2] < 60) return { h: +m[1], m: +m[2], match: m[0] };
    if ((m = t.match(/(\d{1,2}) ?นาฬิกา/))) return done(+m[1], m.index, m[0].length);
    if ((m = t.match(/เที่ยงคืน/))) return done(0, m.index, m[0].length);
    if ((m = t.match(/ตี ?(\d)/))) return done(+m[1], m.index, m[0].length);
    if ((m = t.match(/(\d{1,2}) ?โมงเช้า/))) return done(+m[1], m.index, m[0].length);
    if ((m = t.match(/บ่าย ?(\d)( ?โมง)?/))) return done(12 + +m[1], m.index, m[0].length);
    if ((m = t.match(/บ่ายโมง/))) return done(13, m.index, m[0].length);
    if ((m = t.match(/(\d) ?โมงเย็น/))) return done(12 + +m[1], m.index, m[0].length);
    if ((m = t.match(/(\d) ?ทุ่ม/))) return done(18 + +m[1], m.index, m[0].length);
    if ((m = t.match(/เที่ยง(วัน|ตรง)?/))) return done(12, m.index, m[0].length);
    if ((m = t.match(/(\d{1,2}) ?โมง(ตรง)?/))) { const h = +m[1]; return done(h >= 1 && h <= 5 ? h + 12 : h, m.index, m[0].length); }
    return null;
  }

  function parseDay(t, now) {
    if (/มะรืน/.test(t)) return { date: keyOf(addDays(now, 2)), match: "มะรืนนี้|มะรืน" };
    if (/พรุ่งนี้/.test(t)) return { date: keyOf(addDays(now, 1)), match: "พรุ่งนี้" };
    if (/วันนี้|คืนนี้|เย็นนี้|เช้านี้|บ่ายนี้/.test(t)) return { date: keyOf(now), match: "วันนี้|คืนนี้|เย็นนี้|เช้านี้|บ่ายนี้" };
    return null;
  }

  function parseRepeat(t) {
    if (/จันทร์ ?(ถึง|-) ?ศุกร์|วันทำงาน|วันธรรมดา/.test(t)) return "weekdays";
    if (/ทุก ?วัน/.test(t)) return "daily";
    if (/ทุก ?(สัปดาห์|อาทิตย์)/.test(t)) return "weekly";
    return "once";
  }

  /** What to be reminded of: the sentence without the command, day and time words. */
  function reminderText(raw, time, day) {
    let t = digits(raw);
    const after = t.match(/(?:ให้|ว่า|เรื่อง)(.+)$/);
    if (after && !/^ ?(เตือน|หน่อย|ด้วย)/.test(after[1])) t = after[1];
    if (time) t = t.replace(time.match, " ");
    if (day) t = t.replace(new RegExp(day.match, "g"), " ");
    t = t.replace(/(ช่วย|รบกวน)?(ตั้ง)?(การ)?(แจ้ง)?เตือน(ความจำ)?(ฉัน|ผม|หนู|เรา)?(หน่อย|ด้วย|ที)?/g, " ")
      .replace(/จันทร์ ?(ถึง|-) ?ศุกร์|วันทำงาน|วันธรรมดา|ทุก ?วัน|ทุก ?(สัปดาห์|อาทิตย์)/g, " ")
      .replace(/(^| )(ให้|ว่า|เรื่อง|ตอน|เวลา|ใน|ที่|นะ|น่ะ|ครับ|ค่ะ|คะ|จ้ะ|หน่อย|ด้วย|ที)(?= |$)/g, " ")
      .replace(/\s+/g, " ").trim()
      .replace(/ ?(หน่อย|ด้วย|นะ|น่ะ|ครับ|ค่ะ|คะ|จ้ะ)+$/, "").trim(); // Thai has no spaces, so these often stick to the last word
    return t;
  }

  function finishReminder(p, now) {
    if (!p.time) return { type: "ask", say: "ได้ครับ ให้เตือนกี่โมง", pending: p };
    if (!p.text) return { type: "ask", say: "ให้เตือนเรื่องอะไรครับ", pending: p };
    let date = p.date;
    if (!date) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), p.time.h, p.time.m);
      date = keyOf(p.repeat === "once" && at <= now ? addDays(now, 1) : now);
    }
    return { type: "reminder", text: p.text, time: `${pad(p.time.h)}:${pad(p.time.m)}`, date, repeat: p.repeat || "once" };
  }

  const TABS = [
    [/คลังความรู้|ความรู้/, "kb", "คลังความรู้"], [/ตั้งค่า|เซ็ตติ้ง|setting/, "settings", "ตั้งค่า"], [/เตือน/, "remind", "รายการเตือน"], [/ประวัติ/, "history", "ประวัติ"],
    [/เช้า|แผนวันนี้|วางแผน/, "morning", "แผนตอนเช้า"], [/เย็น|สรุปวัน/, "evening", "บันทึกตอนเย็น"], [/แชท|ผู้ช่วย/, "chat", "แชทผู้ช่วย"]
  ];
  const OPS = { "บวก": "+", "+": "+", "ลบ": "-", "-": "-", "คูณ": "*", "x": "*", "×": "*", "*": "*", "หาร": "/", "/": "/", "÷": "/" };

  /** Removes polite endings and fillers around the text of a note. */
  function cleanNote(s) {
    return String(s).replace(/^(ไว้ว่า|ด้วยว่า|หน่อยว่า|ให้หน่อยว่า|ให้ว่า|ว่า)\s*/, "")
      .replace(/\s*(ด้วย|หน่อย|นะ|น่ะ|ครับ|ค่ะ|คะ|จ้ะ)+$/, "").trim();
  }

  function parseNote(raw, t) {
    // reading the notes
    if (/(มี|ดู|ขอดู|อ่าน|เปิด|ทวน).{0,8}(อะไร)?.{0,4}(ที่)?(จด|บันทึกย่อ|โน้ต|โน๊ต)(ไว้)?(บ้าง|ทั้งหมด)?|(จด|โน้ต|โน๊ต)อะไรไว้(บ้าง)?|บันทึกอะไรไว้(บ้าง)?|^(อ่าน|ดู)(บันทึก|โน้ต|โน๊ต)$/.test(t)
        && !/(จด|บันทึก)(ว่า|ไว้ว่า)/.test(t)) {
      const q = t.match(/(?:เรื่อง|เกี่ยวกับ)\s*(.+?)(?:\s*(?:บ้าง|ไหม|มั้ย|หรือเปล่า|ไว้))*$/);
      if (q && q[1]) return { type: "findNotes", q: cleanNote(q[1]) };
      // "มีโน้ตแอร์ไหม": a subject plus a yes/no question is a search, not the whole list
      if (/(ไหม|หรือเปล่า|รึเปล่า|ป่าว)\s*(ครับ|ค่ะ|คะ)?$/.test(t)) { const sub = subjectOf(t); if (sub) return { type: "findNotes", q: sub }; }
      return { type: "listNotes" };
    }
    // searching
    let m = t.match(/^(?:ช่วย)?(?:หา|ค้น|ค้นหา)(?:ใน)?(?:บันทึก|โน้ต|โน๊ต|ที่จด)(?:ไว้)?\s*(?:เรื่อง|เกี่ยวกับ|ว่า)?\s*(.+)$/)
      || t.match(/^มี(?:บันทึก|โน้ต|โน๊ต|ที่จด)(?:ไว้)?\s*(?:เรื่อง|เกี่ยวกับ)\s*(.+?)\s*(?:ไว้)?\s*(?:ไหม|มั้ย|หรือเปล่า|รึเปล่า|บ้างไหม)\s*(?:ครับ|ค่ะ|คะ)?$/)
      || t.match(/^(?:เคย)?(?:จด|บันทึก)(?:เรื่อง|เกี่ยวกับ)\s*(.+?)\s*(?:ไว้)?\s*(?:ไหม|มั้ย|หรือเปล่า|รึเปล่า|บ้างไหม)\s*(?:ครับ|ค่ะ|คะ)?$/);
    if (m && cleanNote(m[1])) return { type: "findNotes", q: cleanNote(m[1]) };
    // deleting the last one
    if (/^(ลบ|ยกเลิก)(บันทึก|โน้ต|โน๊ต|ที่จด)(ล่าสุด|อันล่าสุด|เมื่อกี้|อันสุดท้าย)/.test(t)) return { type: "deleteLastNote" };
    // writing a note
    m = raw.match(/^(?:ช่วย|รบกวน)?\s*(?:จด(?:บันทึก)?|บันทึก(?:ย่อ)?|โน้ต|โน๊ต|จำ|เขียน)(?:ไว้|ลงไป|ให้หน่อย|ให้|หน่อย|ด้วย)*\s*(?:ว่า|ด้วยว่า|หน่อยว่า|เรื่อง)\s*(.*)$/);
    if (m) {
      const text = cleanNote(m[1]);
      return text ? { type: "note", text } : { type: "ask", say: "จะให้จดว่าอะไรครับ", pending: { kind: "note" } };
    }
    if (/^(?:ช่วย|รบกวน)?\s*(?:จด(?:บันทึก)?|บันทึกย่อ|โน้ต|โน๊ต)\s*(?:ไว้|ให้|หน่อย|ด้วย|ที|ครับ|ค่ะ)*\s*$/.test(t)) {
      return { type: "ask", say: "จะให้จดว่าอะไรครับ", pending: { kind: "note" } };
    }
    return null;
  }

  /** Common misspellings and spelling variants, so typed and spoken text look alike to the rules. */
  function normalize(text) {
    return String(text || "").trim().replace(/\s+/g, " ")
      .replace(/ใว้/g, "ไว้").replace(/ใหม(?=$| |ครับ|ค่ะ|คะ)/g, "ไหม").replace(/มั๊ย|มั้ย/g, "ไหม")
      .replace(/โน๊ต/g, "โน้ต").replace(/เตื่อน/g, "เตือน").replace(/บันทืก/g, "บันทึก").replace(/อ่ะไร|อะไล/g, "อะไร");
  }

  // ---------- close-match layer ----------
  // Each word group stands for one idea. An intent fires when the sentence holds the ideas it needs, in any order.
  const GROUPS = {
    NOTE: /จด|บันทึก|โน้ต|เมโม|memo|ที่เขียนไว้|ที่จำไว้/,
    WHAT: /อะไร|เรื่องไหน|อันไหน/,
    ALL: /บ้าง|ทั้งหมด|หมดเลย|รายการ|ทุกอัน|ทุกเรื่อง/,
    SHOW: /ดู|อ่าน|ทวน|เช็ค|เช็ก|บอก|เปิด|แสดง|ฟัง/,
    FIND: /หา|ค้น|มี.*(ไหม|หรือเปล่า|รึเปล่า|ป่าว)|เคย/,
    ABOUT: /เรื่อง|เกี่ยวกับ/,
    DEL: /ลบ|เอาออก|ทิ้ง/,
    LAST: /ล่าสุด|เมื่อกี้|เมื่อกี๊|อันสุดท้าย|อันเมื่อกี้/,
    REMIND: /เตือน|อลาร์ม|ปลุก|นัด/,
    TIME: /กี่โมง|เวลา|นาฬิกา/,
    DATE: /วันที่|วันอะไร|วันนี้วัน/,
    THOUGHT: /ควร|คิดว่า|ช่วยคิด|ยังไง|อย่างไร|ทำไม|แนะนำ|สรุป|วิเคราะห์|เป็นไง|ดีไหม|ตอนไหน/
  };
  const has = (t, g) => GROUPS[g].test(t);
  /** The words of the sentence that are not command words: the subject to search for. */
  function subjectOf(t) {
    const m = t.match(/(?:เรื่อง|เกี่ยวกับ)\s*(.+)$/);
    let x = m ? m[1] : t;
    x = x.replace(/(ช่วย|หน่อย|ที|ด้วย|ครับ|ค่ะ|คะ|นะ|ไหม|หรือเปล่า|รึเปล่า|ป่าว|บ้าง|ไว้|เคย|มี|หา|ค้น|ดู|อ่าน|จด|บันทึก|โน้ต|ที่|ใน|เรื่อง|เกี่ยวกับ|อะไร)/g, " ").replace(/\s+/g, " ").trim();
    return x.length >= 2 ? x : "";
  }
  function fuzzy(t, now, ctx) {
    if (t.length > 45 || has(t, "THOUGHT")) return null; // long or thinking questions belong to the AI
    if (has(t, "NOTE")) {
      if (has(t, "DEL") && (has(t, "LAST") || t.length <= 16)) return { type: "deleteLastNote", guess: "ลบบันทึกล่าสุด" };
      if (has(t, "DEL")) return null; // deleting a particular note: leave it to the person (the × in the list)
      if (has(t, "ABOUT") || has(t, "FIND")) {
        const q = subjectOf(t);
        if (q) return { type: "findNotes", q, guess: `หาบันทึกเรื่อง${q}` };
      }
      if (has(t, "WHAT") || has(t, "ALL") || has(t, "SHOW")) return { type: "listNotes", guess: "มีอะไรจดไว้บ้าง" };
      return null;
    }
    if (has(t, "REMIND") && (has(t, "WHAT") || has(t, "ALL") || has(t, "SHOW")) && !parseTime(t, now)) {
      return { type: "listReminders", guess: "มีการเตือนอะไรบ้าง" };
    }
    if (has(t, "TIME") && !has(t, "REMIND") && t.length <= 24 && /ตอนนี้|เท่าไ|กี่|บอก|ดู/.test(t)) {
      return { type: "say", say: `ตอนนี้ ${now.getHours()} นาฬิกา ${now.getMinutes()} นาที ครับ`, guess: "ตอนนี้กี่โมง" };
    }
    if (has(t, "DATE") && t.length <= 24) {
      const tomorrow = /พรุ่งนี้/.test(t);
      const d = tomorrow ? addDays(now, 1) : now;
      return { type: "say", say: `${tomorrow ? "พรุ่งนี้" : "วันนี้"}${thDate(d)}ครับ`, guess: tomorrow ? "พรุ่งนี้วันอะไร" : "วันนี้วันอะไร" };
    }
    return null;
  }

  function parse(text, ctx) {
    const now = (ctx && ctx.now) || new Date();
    const raw = normalize(text);
    const t = raw.toLowerCase();
    if (!t) return null;
    const short = t.length <= 24;
    const pending = ctx && ctx.pending;

    // ----- an earlier question from the bot is waiting for its answer -----
    if (pending && pending.kind === "reminder") {
      if (/^(ยกเลิก|ไม่เอา|ไม่ต้อง|ช่างมัน)/.test(t)) return { type: "say", say: "ยกเลิกการตั้งเตือนแล้วครับ" };
      const p = { ...pending };
      const time = parseTime(t, now), day = parseDay(t, now);
      if (!p.time && time) { p.time = { h: time.h, m: time.m }; if (time.rel) p.date = keyOf(time.rel); }
      if (!p.date && day) p.date = day.date;
      if (!p.text) { const txt = reminderText(raw, time, day); if (txt) p.text = txt; }
      if (p.repeat === "once") p.repeat = parseRepeat(t);
      const filled = (!pending.time && p.time) || (!pending.text && p.text);
      if (filled) return finishReminder(p, now);
      return { type: "ask", say: pending.time ? "ยังไม่ได้ยินว่าให้เตือนเรื่องอะไร พูดอีกครั้ง หรือพูดว่ายกเลิก" : "ยังไม่ได้ยินเวลา บอกเวลา เช่น 8 โมง หรือพูดว่ายกเลิก", pending };
    }

    if (pending && pending.kind === "note") {
      if (/^(ยกเลิก|ไม่เอา|ไม่ต้อง|ช่างมัน)/.test(t)) return { type: "say", say: "ไม่จดแล้วครับ" };
      const text = cleanNote(raw);
      return text ? { type: "note", text } : { type: "ask", say: "ยังไม่ได้ยิน จะให้จดว่าอะไรครับ", pending };
    }

    // ----- read aloud what was copied: "อ่านคลิปบอร์ด", "อ่านข้อความที่ก๊อปไว้ให้ฟัง" -----
    if (t.length <= 40 && /อ่าน/.test(t) && /คลิปบอร์ด|คลิปบอด|ก๊อป|ก็อป|ก้อป|copy|คัดลอก|ที่ลอกไว้/.test(t)) return { type: "readClipboard" };

    // ----- answer memory: "ถาม AI ใหม่" skips a remembered answer -----
    if (short && /^(ถาม)?(เอไอ|ai|เอ ไอ)?\s*(ใหม่|อีกที|อีกครั้ง)|^ถาม\s*(เอไอ|ai|เอ ไอ)\s*(ใหม่|อีกที|อีกครั้ง)|^ไม่ใช่.{0,6}ถามใหม่/.test(t) && /ถาม|เอไอ|ai/.test(t)) return { type: "askAgain" };

    // ----- knowledge base: "สอนว่า…", "เพิ่มความรู้ว่า…"; "ค้นคลังความรู้เรื่อง…" -----
    let kb = raw.match(/^(?:ช่วย)?\s*(?:สอน|เพิ่มความรู้|จำความรู้|บันทึกความรู้|ใส่คลังความรู้)(?:ให้)?(?:หน่อย|ด้วย)?\s*(?:ว่า|เรื่อง)\s*(.+)$/);
    if (kb && cleanNote(kb[1])) return { type: "learn", text: cleanNote(kb[1]) };
    kb = t.match(/^(?:ค้น|หา|ถาม|เปิด)(?:ใน|จาก)?คลังความรู้\s*(?:เรื่อง|ว่า|เกี่ยวกับ)?\s*(.*)$/);
    if (kb) return kb[1].trim() ? { type: "askKb", q: cleanNote(kb[1]) } : { type: "open", tab: "kb", say: "เปิดคลังความรู้ให้แล้วครับ" };

    // ----- notes: "จดว่า…", "บันทึกว่า…", "จำไว้ว่า…"; "มีอะไรจดไว้บ้าง"; "หาบันทึกเรื่อง…"; "ลบบันทึกล่าสุด" -----
    const note = parseNote(raw, t);
    if (note) return note;

    // ----- today's tasks and plan (the morning page) -----
    if (/^(วันนี้มี(งาน|นัด)|งานวันนี้|นัดวันนี้)/.test(t)) {
      if (/อะไร|บ้าง|ไหม|หรือเปล่า/.test(t)) return { type: "listNotes" };
      const m = raw.match(/^(?:วันนี้มี(?:งาน|นัด)|งานวันนี้(?:มี)?|นัดวันนี้(?:มี)?)\s*(?:คือ|ได้แก่)?\s*(.+)$/);
      if (m && cleanNote(m[1])) return { type: "dayTasks", text: cleanNote(m[1]) };
    }
    if (t.length <= 30 && /^(ช่วย|ขอ)?\s*(ทำ|วาง|จัด|คิด)?\s*แผน(งาน)?วันนี้|^วางแผน(ให้)?วันนี้/.test(t)) return { type: "planToday" };

    // ----- control -----
    if (short && /^(หยุด|พอแล้ว|เลิกฟัง|ปิด ?(live|ไลฟ์|ไมค์))/.test(t)) return { type: "stop" };
    if (ctx && ctx.aiBusy) {
      if (short && /^(ยกเลิก|ไม่ต้องตอบ|ไม่เอาแล้ว)/.test(t)) return { type: "cancel" };
      if (/เสร็จ(หรือ|รึ)?ยัง|ถึงไหนแล้ว|อีกนานไหม|นานไหม|ได้(หรือ|รึ)ยัง/.test(t)) return { type: "aiStatus" };
    }

    // ----- place reminders (GPS-Tracker): "ออกจากบ้านเตือนให้เติมน้ำมัน", "เตือนเติมน้ำมันเมื่อออกจากบ้าน" -----
    if (/เตือน/.test(t) && /(ออกจาก|ถึง|ไปถึง|มาถึง|กลับถึง)/.test(t) && !parseTime(t, now)) {
      let m = raw.match(/^(?:ช่วย)?(?:ตั้ง)?(?:เมื่อ|ตอน|พอ|ถ้า|หลัง)?\s*(ออกจาก|ไปถึง|มาถึง|กลับถึง|ถึง)\s*(.+?)\s*(?:แล้ว)?\s*(?:ก็)?\s*(?:ให้|ช่วย)?\s*(?:ตั้ง)?(?:แจ้ง)?เตือน(?:ฉัน|ผม|หนู)?\s*(?:ให้|ว่า|เรื่อง)?\s*(.+)$/);
      let when, place, text;
      if (m) { when = m[1] === "ออกจาก" ? "leave" : "enter"; place = m[2]; text = m[3]; }
      else if ((m = raw.match(/^(?:ช่วย)?(?:ตั้ง)?(?:แจ้ง)?เตือน(?:ฉัน|ผม|หนู)?\s*(?:ให้|ว่า|เรื่อง)?\s*(.+?)\s*(?:เมื่อ|ตอน|พอ|ถ้า|หลัง)\s*(ออกจาก|ไปถึง|มาถึง|กลับถึง|ถึง)\s*(.+)$/))) {
        when = m[2] === "ออกจาก" ? "leave" : "enter"; text = m[1]; place = m[3];
      }
      if (when) {
        place = cleanNote(String(place).replace(/(แล้ว|นะ|ด้วย)$/g, "")); text = cleanNote(text);
        if (place && text) return { type: "placeReminder", when, place, text };
      }
    }
    if (/(ตอนนี้|อยู่).{0,6}(อยู่)?(ที่)?ไหน|ฉันอยู่ที่ไหน|ผมอยู่ที่ไหน|อยู่ตรงไหน/.test(t) && t.length <= 30 && !/ไฟล์|บันทึก|โน้ต|จด|กุญแจ/.test(t)) return { type: "whereNow" };

    // ----- reminders -----
    if (/(มี|ดู|ขอดู|รายการ).{0,12}เตือน|เตือนอะไร(บ้าง|ไว้)/.test(t)) return { type: "listReminders" };
    // A request that needs thinking ("when should I...", "what do you think...") goes to the AI even if it mentions a reminder.
    const needsThought = /ควร|คิดว่า|ช่วยคิด|ยังไง|อย่างไร|ตอนไหน|เมื่อไ[หร]|ดีไหม|ดีมั้ย|หรือเปล่า|ทำไม|แนะนำ/.test(t);
    if (/เตือน/.test(t) && !/^(เปิด|ไป)/.test(t) && !needsThought) {
      const time = parseTime(t, now), day = parseDay(t, now);
      const p = { kind: "reminder", time: time ? { h: time.h, m: time.m } : null, date: time && time.rel ? keyOf(time.rel) : day ? day.date : null,
        text: reminderText(raw, time, day), repeat: parseRepeat(t) };
      return finishReminder(p, now);
    }

    // ----- open a page -----
    const open = t.match(/^(ช่วย)?(เปิด|ไป(ที่)?)(หน้า)? ?(.+)$/);
    if (open && t.length <= 30) {
      for (const [re, tab, name] of TABS) if (re.test(open[5])) return { type: "open", tab, say: `เปิดหน้า${name}ให้แล้วครับ` };
    }

    // ----- time and date -----
    if (/กี่โมง|เวลาเท่าไ[หร]|ตอนนี้เวลา/.test(t)) return { type: "say", say: `ตอนนี้ ${now.getHours()} นาฬิกา ${now.getMinutes()} นาที ครับ` };
    if (/(พรุ่งนี้).{0,6}(วันอะไร|วันที่เท่าไ[หร])/.test(t)) return { type: "say", say: `พรุ่งนี้${thDate(addDays(now, 1))}ครับ` };
    if (/วันนี้.{0,6}(วันอะไร|วันที่เท่าไ[หร])|^วันที่เท่าไ[หร]|^วันอะไร/.test(t)) return { type: "say", say: `วันนี้${thDate(now)}ครับ` };

    // ----- small sums -----
    const sum = t.match(/^(-?\d+(?:\.\d+)?) ?(บวก|ลบ|คูณ|หาร|[+\-x×*\/÷]) ?(-?\d+(?:\.\d+)?) ?(เท่ากับ)? ?(ได้)?(เท่าไห?ร่?|=)? ?(ครับ|ค่ะ|คะ)?$/);
    if (sum) {
      const a = +sum[1], b = +sum[3], op = OPS[sum[2]];
      if (op === "/" && b === 0) return { type: "say", say: "หารด้วยศูนย์ไม่ได้ครับ" };
      const v = op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : a / b;
      return { type: "say", say: `ได้ ${Math.round(v * 10000) / 10000} ครับ` };
    }

    // ----- small talk -----
    if (short && /^(สวัสดี|หวัดดี|ดีครับ|ดีค่ะ|ฮัลโหล|hello|hi)/.test(t)) return { type: "say", say: "สวัสดีครับ มีอะไรให้ช่วยไหม" };
    if (short && /ขอบคุณ|ขอบใจ|แต๊งกิ้ว/.test(t)) return { type: "say", say: "ยินดีครับ" };
    if (short && /(คุณ|เธอ|นาย)(คือ|เป็น)ใคร|^(คุณ|เธอ|นาย)?ชื่ออะไร/.test(t)) return { type: "say", say: "ผมคือ N-assistant ผู้ช่วยส่วนตัวของคุณครับ" };
    if (/ทำอะไรได้(บ้าง)?|ช่วยอะไรได้/.test(t) && t.length <= 30) {
      return { type: "say", say: "ผมบอกเวลา บอกวันที่ ตั้งเตือน จดลงบันทึกวันนี้ จดงานวันนี้ ขอแผนวันนี้ ค้นบันทึกย้อนหลัง คิดเลขง่ายๆ และเปิดหน้าต่างๆ ได้ทันที ส่วนเรื่องอื่นผมจะส่งให้เอไอคิดให้ครับ" };
    }
    if (short && /^(ได้ยิน(ไหม|มั้ย)|ทดสอบ|เทส)/.test(t)) return { type: "say", say: "ได้ยินชัดเจนครับ" };

    // ----- close match: the right words in another order or with other words, e.g. "บันทึกอะไรไว้" -----
    const near = fuzzy(t, now, ctx);
    if (near) return near;

    return null; // not simple: goes to the AI
  }

  const NBot = { parse, parseTime, digits, normalize };
  if (typeof module !== "undefined" && module.exports) module.exports = NBot;
  else root.NBot = NBot;
})(typeof window !== "undefined" ? window : globalThis);
