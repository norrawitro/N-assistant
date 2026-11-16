package com.norrawitro.nassistant;

import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * "Talk through a Markdown file on GitHub": the app appends what was said to a .md file in a repo, any outside AI
 * reads the newest question and appends its answer to the same file, and the app polls the file until the answer
 * appears. The file format is documented in README.md ("ช่องทางคุยผ่านไฟล์ MD บน GitHub").
 *
 * Every message body is encrypted: OpenSSL AES-256-CBC, PBKDF2-SHA256, 200000 iterations, "Salted__" header, base64 on
 * one line (the same as NRW chat.sh), so the other side decrypts with
 *   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -a -A -pass pass:KEY
 */
final class GithubMdChannel {
    static final int ITER = 200_000;
    static final String ENC = "aes-256-cbc+pbkdf2-sha256-200000+base64";
    private static final long POLL_MS = 5_000;
    private static final long WAIT_MS = 5 * 60_000;

    private GithubMdChannel() {}

    static final class Fail extends Exception { Fail(String m) { super(m); } }

    /** Sends job.text and waits for the answer. Returns the decrypted answer text. */
    static String exchange(JSONObject job) throws Exception {
        String repo = job.optString("repo").trim();
        String path = job.optString("path").trim().replaceAll("^/+", "");
        String token = job.optString("token").trim();
        String key = job.optString("key");
        String text = job.optString("text");
        String kind = job.optString("kind", "live");
        if (!repo.matches("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")) throw new Fail("ชื่อ repo ต้องเป็นแบบ เจ้าของ/ชื่อ ตรวจในตั้งค่า");
        if (!path.endsWith(".md")) throw new Fail("ไฟล์ต้องลงท้ายด้วย .md ตรวจในตั้งค่า");
        if (token.isEmpty()) throw new Fail("ยังไม่ได้ใส่ GitHub token ในตั้งค่า");
        if (key.length() < 16) throw new Fail("กุญแจเข้ารหัสต้องยาวอย่างน้อย 16 ตัว ตรวจในตั้งค่า");

        String id = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date())
                + "-" + Integer.toHexString(new SecureRandom().nextInt(0x10000) | 0x10000).substring(1);
        String now = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssZ", Locale.US).format(new Date());
        String block = "\n## Q " + id + "\n"
                + "- from: n-assistant\n"
                + "- kind: " + kind + "\n"
                + "- time: " + now + "\n"
                + "- enc: " + ENC + "\n\n"
                + encrypt(text, key) + "\n";

        // Append the question; retry once if someone else wrote the file at the same moment.
        for (int attempt = 0; ; attempt++) {
            Resp cur = call("GET", url(repo, path), token, null);
            String body, sha = null;
            if (cur.code == 404) {
                body = header();
            } else if (cur.code == 200) {
                JSONObject o = new JSONObject(cur.body);
                sha = o.optString("sha");
                body = decodeContent(o);
            } else {
                throw new Fail(httpReason(cur));
            }
            JSONObject put = new JSONObject();
            put.put("message", "N-assistant: Q " + id);
            put.put("content", Base64.encodeToString((body + block).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
            if (sha != null) put.put("sha", sha);
            Resp r = call("PUT", url(repo, path), token, put.toString());
            if (r.code == 200 || r.code == 201) break;
            if ((r.code == 409 || r.code == 422) && attempt == 0) continue;
            throw new Fail(httpReason(r));
        }

        // Wait for "## A <id>".
        Pattern answer = Pattern.compile("(?m)^## A " + Pattern.quote(id) + "\\s*$([\\s\\S]*?)(?=^## |\\z)");
        long until = System.currentTimeMillis() + WAIT_MS;
        while (System.currentTimeMillis() < until) {
            Thread.sleep(POLL_MS);
            Resp cur;
            try { cur = call("GET", url(repo, path) + "?t=" + System.currentTimeMillis(), token, null); }
            catch (java.io.IOException netHiccup) { continue; }
            if (cur.code != 200) continue;
            String body = decodeContent(new JSONObject(cur.body));
            Matcher m = answer.matcher(body);
            if (!m.find()) continue;
            String section = m.group(1);
            boolean plain = section.contains("- enc: none");
            StringBuilder payload = new StringBuilder();
            for (String line : section.split("\n")) {
                String t = line.trim();
                if (t.isEmpty() || t.startsWith("- ") || t.startsWith("<!--")) continue;
                payload.append(plain ? (payload.length() > 0 ? "\n" : "") + line : t);
            }
            if (payload.length() == 0) continue;
            if (plain) throw new Fail("คำตอบในไฟล์ไม่ได้เข้ารหัส (enc: none) แอปไม่อ่านข้อความที่ไม่เข้ารหัส");
            try {
                return decrypt(payload.toString(), key);
            } catch (Exception e) {
                throw new Fail("ถอดรหัสคำตอบไม่ได้ ตรวจว่าฝั่ง AI ใช้กุญแจเดียวกัน");
            }
        }
        throw new Fail("ยังไม่มีคำตอบในไฟล์ภายใน 5 นาที ตรวจว่า AI ฝั่งที่ตอบทำงานอยู่");
    }

    private static String header() {
        return "# N-assistant chat\n\n"
                + "<!-- n-assistant-md-chat v1. Questions are \"## Q <id>\" sections written by the app; answer each with a \"## A <same id>\"\n"
                + "     section below it. Bodies are one line of base64: openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -a -A.\n"
                + "     The full format is in README.md of github.com/norrawitro/n-assistant. -->\n";
    }

    private static String decodeContent(JSONObject o) {
        String b64 = o.optString("content", "").replace("\n", "");
        return new String(Base64.decode(b64, Base64.DEFAULT), StandardCharsets.UTF_8);
    }

    private static String url(String repo, String path) throws Exception {
        StringBuilder b = new StringBuilder("https://api.github.com/repos/").append(repo).append("/contents/");
        String[] parts = path.split("/");
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) b.append('/');
            b.append(URLEncoder.encode(parts[i], "UTF-8").replace("+", "%20"));
        }
        return b.toString();
    }

    private static final class Resp { int code; String body; }

    private static Resp call(String method, String url, String token, String json) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        try {
            h.setConnectTimeout(15_000);
            h.setReadTimeout(30_000);
            h.setRequestMethod(method);
            h.setUseCaches(false);
            h.setRequestProperty("Accept", "application/vnd.github+json");
            h.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
            h.setRequestProperty("User-Agent", "N-assistant-Android");
            h.setRequestProperty("Authorization", "Bearer " + token);
            if (json != null) {
                h.setDoOutput(true);
                h.setRequestProperty("Content-Type", "application/json");
                try (OutputStream o = h.getOutputStream()) { o.write(json.getBytes(StandardCharsets.UTF_8)); }
            }
            Resp r = new Resp();
            r.code = h.getResponseCode();
            InputStream in = r.code < 400 ? h.getInputStream() : h.getErrorStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (in != null) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                in.close();
            }
            r.body = out.toString("UTF-8");
            return r;
        } catch (java.net.UnknownHostException e) {
            throw new Fail("เชื่อมต่ออินเทอร์เน็ตไม่ได้");
        } finally {
            h.disconnect();
        }
    }

    private static String httpReason(Resp r) {
        switch (r.code) {
            case 401: return "GitHub token ใช้ไม่ได้หรือหมดอายุ";
            case 403: return "GitHub token ไม่มีสิทธิ์เขียน repo นี้ (ต้องมีสิทธิ์ Contents: Read and write)";
            case 404: return "ไม่พบ repo หรือ token มองไม่เห็น repo นี้";
            default: return "GitHub ตอบรหัส " + r.code;
        }
    }

    // ---------- OpenSSL-compatible AES ----------

    static String encrypt(String plain, String pass) throws Exception {
        byte[] salt = new byte[8];
        new SecureRandom().nextBytes(salt);
        byte[][] kiv = derive(pass, salt);
        Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(kiv[0], "AES"), new IvParameterSpec(kiv[1]));
        byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write("Salted__".getBytes(StandardCharsets.US_ASCII));
        out.write(salt);
        out.write(ct);
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }

    static String decrypt(String b64, String pass) throws Exception {
        byte[] all = Base64.decode(b64.trim(), Base64.DEFAULT);
        if (all.length < 32 || !new String(all, 0, 8, StandardCharsets.US_ASCII).equals("Salted__")) throw new Exception("bad format");
        byte[] salt = Arrays.copyOfRange(all, 8, 16);
        byte[][] kiv = derive(pass, salt);
        Cipher c = Cipher.getInstance("AES/CBC/PKCS5Padding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(kiv[0], "AES"), new IvParameterSpec(kiv[1]));
        return new String(c.doFinal(Arrays.copyOfRange(all, 16, all.length)), StandardCharsets.UTF_8);
    }

    private static byte[][] derive(String pass, byte[] salt) throws Exception {
        byte[] k = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
                .generateSecret(new PBEKeySpec(pass.toCharArray(), salt, ITER, 48 * 8)).getEncoded();
        return new byte[][]{Arrays.copyOfRange(k, 0, 32), Arrays.copyOfRange(k, 32, 48)};
    }
}
