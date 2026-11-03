package com.norrawitro.nassistant;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Runs AI requests (Ollama on this phone, or the Claude API) as a foreground service, so a plan keeps
 * being worked on after the person leaves the app. Results are stored until the page picks them up,
 * and a notification says when they are ready.
 *
 * A job is JSON: {id, kind: "brief"|"reflection", date: "YYYY-MM-DD", format: "ollama"|"claude",
 * url, headers: {}, body: {}, prepared?: true}.
 */
public class AiService extends Service {
    private static final String CH_WORK = "ai_work_v1";
    private static final String CH_DONE = "ai_done_v1";
    private static final int NOTIF_RUN = 4300;
    private static final int NOTIF_DONE = 4301;
    private static final String PREFS = "ai";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private int running;

    public static void start(Context c, String jobJson) {
        Intent i = new Intent(c, AiService.class).putExtra("job", jobJson);
        try {
            c.startForegroundService(i);
        } catch (Exception e) {
            // Android refused to start background work right now; report it like any other failure.
            try {
                JSONObject job = new JSONObject(jobJson);
                storeResult(c, failure(job, "Android ไม่อนุญาตให้เริ่มงานเบื้องหลังตอนนี้ เปิดแอปแล้วลองใหม่"));
            } catch (Exception ignored) {}
        }
    }

    /** Runs the plan prepared for today, if the page left one. Called shortly before the wake-up alarm. */
    public static void startPrep(Context c) {
        SharedPreferences p = prefs(c);
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        try {
            JSONObject jobs = new JSONObject(p.getString("prepJobs", "{}"));
            JSONObject job = jobs.optJSONObject(today);
            if (job == null) return;
            if (today.equals(p.getString("prepDoneDate", ""))) return;
            job.put("prepared", true);
            start(c, job.toString());
        } catch (Exception ignored) {}
    }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannels(this);
        Notification n = new Notification.Builder(this, CH_WORK)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle("AI กำลังคิดให้อยู่")
                .setContentText("ออกจากแอปได้ จะแจ้งเตือนเมื่อเสร็จ")
                .setOngoing(true)
                .setContentIntent(openApp(this, null))
                .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_RUN, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_RUN, n);
        }
        String jobJson = intent == null ? null : intent.getStringExtra("job");
        if (jobJson == null) {
            maybeStop();
            return START_NOT_STICKY;
        }
        synchronized (this) { running++; }
        worker.execute(() -> {
            JSONObject res;
            try {
                res = run(new JSONObject(jobJson));
            } catch (Exception e) {
                res = new JSONObject();
                try { res.put("ok", false); res.put("error", "งานไม่ถูกต้อง: " + e.getMessage()); } catch (Exception ignored) {}
            }
            storeResult(this, res);
            if (res.optBoolean("prepared") && res.optBoolean("ok")) {
                prefs(this).edit().putString("prepDoneDate", res.optString("date")).apply();
            }
            if (!MainActivity.deliver(res)) notifyDone(res);
            synchronized (this) { running--; }
            maybeStop();
        });
        return START_NOT_STICKY;
    }

    private synchronized void maybeStop() {
        if (running <= 0) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
    }

    // ---------- the request itself ----------

    private static JSONObject failure(JSONObject job, String msg) throws Exception {
        JSONObject r = base(job);
        r.put("ok", false);
        r.put("error", msg);
        return r;
    }

    private static JSONObject base(JSONObject job) throws Exception {
        JSONObject r = new JSONObject();
        r.put("id", job.optString("id"));
        r.put("kind", job.optString("kind"));
        r.put("date", job.optString("date"));
        r.put("prepared", job.optBoolean("prepared"));
        r.put("at", System.currentTimeMillis());
        return r;
    }

    static JSONObject run(JSONObject job) throws Exception {
        String url = job.optString("url");
        String format = job.optString("format", "ollama");
        Uri u = Uri.parse(url);
        boolean local = "http".equals(u.getScheme()) && ("127.0.0.1".equals(u.getHost()) || "localhost".equals(u.getHost()));
        boolean claude = "https".equals(u.getScheme()) && "api.anthropic.com".equals(u.getHost());
        if (!local && !claude) return failure(job, "ที่อยู่ AI นี้ไม่ได้รับอนุญาต");

        JSONObject body = job.optJSONObject("body");
        if (body == null) return failure(job, "ไม่มีข้อความที่จะส่งให้ AI");
        JSONObject headers = job.optJSONObject("headers");

        String[] resp;
        try {
            resp = post(url, headers, body);
            // Some Ollama models have no thinking switch and reject "think"; ask again without it.
            if ("ollama".equals(format) && "400".equals(resp[0]) && resp[1].toLowerCase(Locale.ROOT).contains("think")) {
                body.remove("think");
                resp = post(url, headers, body);
            }
        } catch (ConnectException e) {
            return failure(job, local
                    ? "ติดต่อ Ollama ไม่ได้ เปิด Termux แล้วรัน: ollama serve"
                    : "เชื่อมต่ออินเทอร์เน็ตไม่ได้");
        } catch (SocketTimeoutException e) {
            return failure(job, "AI ใช้เวลานานเกินไป ลองใหม่อีกครั้ง หรือเลือกโมเดลที่เล็กลง");
        }

        int status = Integer.parseInt(resp[0]);
        JSONObject data;
        try { data = new JSONObject(resp[1]); } catch (Exception e) { data = new JSONObject(); }
        if (status >= 400) {
            String apiMsg = data.optJSONObject("error") != null
                    ? data.optJSONObject("error").optString("message") : data.optString("error");
            String msg;
            if (status == 404 && "ollama".equals(format)) msg = "ไม่พบโมเดลนี้ใน Ollama เลือกโมเดลใหม่ในแท็บ \"ตั้งค่า\"";
            else if (status == 401) msg = "API key ไม่ถูกต้อง ตรวจสอบในแท็บ \"ตั้งค่า\"";
            else if (status == 429) msg = "ใช้งานถี่เกินไป หรือเครดิตในบัญชี API หมด รอสักครู่แล้วลองใหม่";
            else if (status >= 500) msg = "ระบบ AI ยุ่งอยู่ ลองใหม่อีกครั้งในอีกสักครู่";
            else msg = "AI ตอบกลับข้อผิดพลาด: " + (apiMsg.isEmpty() ? String.valueOf(status) : apiMsg);
            return failure(job, msg);
        }

        String text;
        if ("claude".equals(format)) {
            if ("refusal".equals(data.optString("stop_reason"))) return failure(job, "Claude ไม่สามารถตอบคำขอนี้ได้ ลองปรับข้อความแล้วส่งใหม่");
            StringBuilder sb = new StringBuilder();
            JSONArray content = data.optJSONArray("content");
            if (content != null) {
                for (int i = 0; i < content.length(); i++) {
                    JSONObject b = content.optJSONObject(i);
                    if (b != null && "text".equals(b.optString("type"))) sb.append(b.optString("text"));
                }
            }
            text = sb.toString();
        } else {
            JSONObject msg = data.optJSONObject("message");
            text = msg == null ? "" : msg.optString("content");
        }
        if (text.trim().isEmpty()) return failure(job, "AI ไม่ได้ส่งคำตอบกลับมา ลองใหม่อีกครั้ง");
        JSONObject r = base(job);
        r.put("ok", true);
        r.put("text", text);
        return r;
    }

    private static String[] post(String url, JSONObject headers, JSONObject body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(10 * 60 * 1000); // a 4B model on a phone can take minutes
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        if (headers != null) {
            for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                String k = it.next();
                c.setRequestProperty(k, headers.optString(k));
            }
        }
        try (OutputStream os = c.getOutputStream()) {
            os.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        int status = c.getResponseCode();
        InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
        String text = "";
        if (in != null) {
            try (InputStream s = in) {
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = s.read(buf)) > 0) bo.write(buf, 0, n);
                text = bo.toString(StandardCharsets.UTF_8.name());
            }
        }
        return new String[]{String.valueOf(status), text};
    }

    // ---------- results kept until the page reads them ----------

    static synchronized void storeResult(Context c, JSONObject res) {
        SharedPreferences p = prefs(c);
        try {
            JSONArray arr = new JSONArray(p.getString("results", "[]"));
            arr.put(res);
            while (arr.length() > 20) arr.remove(0);
            p.edit().putString("results", arr.toString()).apply();
        } catch (Exception ignored) {}
    }

    /** Returns and clears every stored result. */
    static synchronized String takeResults(Context c) {
        SharedPreferences p = prefs(c);
        String s = p.getString("results", "[]");
        p.edit().putString("results", "[]").apply();
        return s;
    }

    static synchronized void ack(Context c, String id) {
        SharedPreferences p = prefs(c);
        try {
            JSONArray arr = new JSONArray(p.getString("results", "[]"));
            JSONArray keep = new JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o != null && !id.equals(o.optString("id"))) keep.put(o);
            }
            p.edit().putString("results", keep.toString()).apply();
        } catch (Exception ignored) {}
    }

    static boolean preparedToday(Context c) {
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        return today.equals(prefs(c).getString("prepDoneDate", ""));
    }

    // ---------- notifications ----------

    static PendingIntent openApp(Context c, String tab) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (tab != null) i.putExtra("tab", tab);
        return PendingIntent.getActivity(c, tab == null ? 40 : 41 + Math.abs(tab.hashCode() % 50), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void notifyDone(JSONObject res) {
        boolean ok = res.optBoolean("ok");
        String kind = res.optString("kind");
        boolean evening = "reflection".equals(kind);
        boolean chat = "chat".equals(kind);
        String title = ok
                ? (chat ? "ผู้ช่วยตอบแล้ว" : evening ? "สรุปวันนี้พร้อมแล้ว" : (res.optBoolean("prepared") ? "เตรียมแผนวันนี้ไว้ให้แล้ว" : "แผนวันนี้พร้อมแล้ว"))
                : "AI ทำงานไม่สำเร็จ";
        String text = ok ? (chat ? replyPreview(res.optString("text")) : "แตะเพื่อเปิดดู") : res.optString("error");
        Notification n = new Notification.Builder(this, CH_DONE)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setContentIntent(openApp(this, chat ? "chat" : evening ? "evening" : "morning"))
                .build();
        try {
            getSystemService(NotificationManager.class).notify(NOTIF_DONE, n);
        } catch (SecurityException ignored) {}
    }

    /** First line of the assistant's reply, for the notification. */
    private static String replyPreview(String raw) {
        String t = raw;
        try {
            int a = raw.indexOf('{'), b = raw.lastIndexOf('}');
            if (a >= 0 && b > a) t = new JSONObject(raw.substring(a, b + 1)).optString("reply", raw);
        } catch (Exception ignored) {}
        t = t.trim();
        return t.length() > 160 ? t.substring(0, 160) + "…" : (t.isEmpty() ? "แตะเพื่อเปิดดู" : t);
    }

    static void ensureChannels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CH_WORK) == null) {
            NotificationChannel w = new NotificationChannel(CH_WORK, "AI กำลังทำงาน", NotificationManager.IMPORTANCE_LOW);
            w.setDescription("แสดงระหว่างที่ AI กำลังคิดแผนให้");
            nm.createNotificationChannel(w);
        }
        if (nm.getNotificationChannel(CH_DONE) == null) {
            NotificationChannel d = new NotificationChannel(CH_DONE, "แผนพร้อมแล้ว", NotificationManager.IMPORTANCE_DEFAULT);
            d.setDescription("แจ้งเมื่อ AI ทำแผนหรือสรุปเสร็จ");
            nm.createNotificationChannel(d);
        }
    }
}
