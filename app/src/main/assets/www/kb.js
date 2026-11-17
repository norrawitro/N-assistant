/*
 * Knowledge base ("คลังความรู้"): text the owner imports from files (.md / .txt) or types in. Everything stays on
 * the phone. Search needs no AI and works on Thai, which has no spaces between words: texts are compared by
 * overlapping pairs of letters (bigrams), weighted so that rare pairs count more than common ones.
 *
 * NKb.chunk(title, text)            -> [{ title, text }]  pieces of about one paragraph, under their nearest heading
 * NKb.search(chunks, query, n)      -> [{ chunk, score, cover }] best first; cover = share of the query found (0..1)
 * NKb.cleanQuery(q)                 -> the query without question and polite words
 */
(function (root) {
  "use strict";

  const STOP = /(ควร|เมื่อไหร่|เมื่อไร|ตอนไหน|อยู่ไหน|ที่ไหน|ไหน|คืออะไร|คือ|อะไร|ยังไง|อย่างไร|เท่าไหร่|เท่าไร|ไหม|มั้ย|หรือเปล่า|หรือไม่|บ้าง|ช่วย|บอก|หน่อย|ด้วย|ครับ|ค่ะ|คะ|นะ|เกี่ยวกับ|เรื่อง|ขอ|ทราบ|อยาก|รู้|ที่|ของ|ใน|ได้|แล้ว|จาก|คลังความรู้|ความรู้|ค้นหา|ค้น|หา)/g;
  // Words that mean the same are written one way before comparing.
  const SAME = [[/รับประทาน|กิน/g, "ทาน"], [/โทรศัพท์|เบอร์โทร/g, "เบอร์"], [/รถยนต์/g, "รถ"], [/คุณแม่/g, "แม่"], [/คุณพ่อ/g, "พ่อ"]];
  const same = s => SAME.reduce((x, [re, to]) => x.replace(re, to), String(s || "").toLowerCase());
  const norm = s => same(s).replace(/[​ ]/g, " ")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").replace(/\s+/g, " ").trim();
  function cleanQuery(q) { return norm(String(q || "").replace(STOP, " ")); }

  function bigrams(s) {
    const out = new Map();
    for (const w of norm(s).split(" ")) {
      if (!w) continue;
      if (w.length === 1) { out.set(w, (out.get(w) || 0) + 1); continue; }
      for (let i = 0; i < w.length - 1; i++) { const g = w.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); }
    }
    return out;
  }

  /** Splits a file into searchable pieces. Markdown headings name the pieces under them. */
  function chunk(title, text) {
    const pieces = [];
    let heading = String(title || "").trim(), buf = [];
    const flush = () => {
      const body = buf.join("\n").trim();
      buf = [];
      if (!body) return;
      // Long blocks are cut at sentence or line ends into pieces of about 600 characters.
      let rest = body;
      while (rest.length > 900) {
        let cut = rest.lastIndexOf("\n", 600);
        if (cut < 200) cut = rest.lastIndexOf(" ", 600);
        if (cut < 200) cut = 600;
        pieces.push({ title: heading, text: rest.slice(0, cut).trim() });
        rest = rest.slice(cut).trim();
      }
      if (rest) pieces.push({ title: heading, text: rest });
    };
    for (const line of String(text || "").replace(/\r/g, "").split("\n")) {
      const h = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      if (h) { flush(); heading = (title && h[1] !== title ? `${title} › ` : "") + h[1].trim(); continue; }
      if (!line.trim()) { if (buf.length && buf.join("").length > 300) flush(); else buf.push(""); continue; }
      buf.push(line);
    }
    flush();
    return pieces;
  }

  /** Best pieces for the query. The title counts too, so "เบอร์ช่างแอร์" finds a piece titled "ช่างแอร์". */
  function search(chunks, query, n = 3) {
    const q = bigrams(cleanQuery(query));
    if (!q.size || !chunks.length) return [];
    const grams = chunks.map(c => bigrams(c.title + " " + c.title + " " + c.text));
    const df = new Map();
    for (const g of q.keys()) { let k = 0; for (const m of grams) if (m.has(g)) k++; df.set(g, k); }
    const N = chunks.length;
    const idf = g => Math.log(1 + N / (1 + df.get(g)));
    let total = 0; for (const g of q.keys()) total += idf(g);
    const res = chunks.map((c, i) => {
      let hit = 0, score = 0;
      for (const g of q.keys()) if (grams[i].has(g)) { hit += idf(g); score += idf(g) * (1 + Math.log(grams[i].get(g))); }
      const len = c.text.length;
      return { chunk: c, cover: total ? hit / total : 0, score: score / Math.sqrt(1 + len / 400) };
    }).filter(r => r.cover > 0);
    res.sort((a, b) => (b.cover - a.cover) || (b.score - a.score));
    return res.slice(0, n);
  }

  /** The first sentences of a piece, short enough to be spoken. */
  function excerpt(text, max = 220) {
    const t = String(text || "").replace(/^[#>*\-\s•]+/gm, "").replace(/\s+/g, " ").trim();
    if (t.length <= max) return t;
    const cut = t.lastIndexOf(" ", max);
    return t.slice(0, cut > 80 ? cut : max) + " …";
  }

  /** The lines of a piece that answer the query best (in their original order), for a short spoken answer. */
  function bestLines(text, query, max = 2) {
    const q = bigrams(cleanQuery(query));
    const lines = String(text || "").split(/\n|(?<=[.!?])\s+/).map(x => x.replace(/^[#>*\-\s•]+/, "").trim()).filter(Boolean);
    if (!q.size || lines.length <= 1) return excerpt(text);
    const scored = lines.map((l, i) => { const g = bigrams(l); let hit = 0; for (const k of q.keys()) if (g.has(k)) hit++; return { i, l, hit }; });
    const ranked = scored.filter(x => x.hit > 0).sort((a, b) => b.hit - a.hit);
    // A second line only when it matches as well as the best one (otherwise "ช่างประปา" would also read the aircon line).
    const top = ranked.filter((x, k) => k === 0 || (k < max && x.hit >= ranked[0].hit)).sort((a, b) => a.i - b.i);
    return top.length ? excerpt(top.map(x => x.l).join(" "), 260) : excerpt(text);
  }

  const NKb = { chunk, search, cleanQuery, excerpt, bestLines };
  if (typeof module !== "undefined" && module.exports) module.exports = NKb;
  else root.NKb = NKb;
})(typeof window !== "undefined" ? window : globalThis);
