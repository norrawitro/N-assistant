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
    [/ตั้งค่า|เซ็ตติ้ง|setting/, "settings", "ตั้งค่า"], [/เตือน/, "remind", "รายการเตือน"], [/ประวัติ/, "history", "ประวัติ"],
    [/เช้า|แผนวันนี้|วางแผน/, "morning", "แผนตอนเช้า"], [/เย็น|สรุปวัน/, "evening", "บันทึกตอนเย็น"], [/แชท|ผู้ช่วย/, "chat", "แชทผู้ช่วย"]
  ];
  const OPS = { "บวก": "+", "+": "+", "ลบ": "-", "-": "-", "คูณ": "*", "x": "*", "×": "*", "*": "*", "หาร": "/", "/": "/", "÷": "/" };

  function parse(text, ctx) {
    const now = (ctx && ctx.now) || new Date();
    const raw = String(text || "").trim().replace(/\s+/g, " ");
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

    // ----- control -----
    if (short && /^(หยุด|พอแล้ว|เลิกฟัง|ปิด ?(live|ไลฟ์|ไมค์))/.test(t)) return { type: "stop" };
    if (ctx && ctx.aiBusy) {
      if (short && /^(ยกเลิก|ไม่ต้องตอบ|ไม่เอาแล้ว)/.test(t)) return { type: "cancel" };
      if (/เสร็จ(หรือ|รึ)?ยัง|ถึงไหนแล้ว|อีกนานไหม|นานไหม|ได้(หรือ|รึ)ยัง/.test(t)) return { type: "aiStatus" };
    }

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
    if (short && /(คุณ|เธอ|นาย)(คือ|เป็น)ใคร|ชื่ออะไร/.test(t)) return { type: "say", say: "ผมคือ N-assistant ผู้ช่วยส่วนตัวของคุณครับ" };
    if (/ทำอะไรได้(บ้าง)?|ช่วยอะไรได้/.test(t) && t.length <= 30) {
      return { type: "say", say: "ผมบอกเวลา บอกวันที่ ตั้งเตือน บอกรายการเตือน คิดเลขง่ายๆ และเปิดหน้าต่างๆ ได้ทันที ส่วนเรื่องอื่นผมจะส่งให้เอไอคิดให้ครับ" };
    }
    if (short && /^(ได้ยิน(ไหม|มั้ย)|ทดสอบ|เทส)/.test(t)) return { type: "say", say: "ได้ยินชัดเจนครับ" };

    return null; // not simple: goes to the AI
  }

  const NBot = { parse, parseTime, digits };
  if (typeof module !== "undefined" && module.exports) module.exports = NBot;
  else root.NBot = NBot;
})(typeof window !== "undefined" ? window : globalThis);
