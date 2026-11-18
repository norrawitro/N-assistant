package com.norrawitro.nassistant;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * "อ่านออกเสียง": reads pasted text aloud with the phone's own Thai text-to-speech (no internet), one sentence at a
 * time so the page can highlight the sentence being read. Runs as a foreground media service, so it keeps reading
 * with the screen off or the app in the background; the notification has a Stop button.
 */
public class ReadAloudService extends Service implements TextToSpeech.OnInitListener {
    static final String ACTION_START = "start";
    static final String ACTION_STOP = "stop";
    private static final String CH = "read_aloud_v1";
    private static final int NOTIF = 4200;

    /** What the page asks for when it comes back on screen. */
    static volatile boolean playing;
    static volatile int index = -1;
    static volatile int total;

    private static List<String> pending;
    private static int pendingStart;
    private static float pendingRate = 2f;

    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private boolean ready;
    private List<String> sentences = new ArrayList<>();
    private float rate = 2f;
    private int session; // utterance ids carry it, so a restart ignores callbacks from the previous run
    private PowerManager.WakeLock wake;

    // ---------- called from the page bridge ----------

    static void start(Context c, JSONArray list, int from, float rate) {
        List<String> s = new ArrayList<>();
        for (int i = 0; i < list.length(); i++) s.add(list.optString(i, ""));
        pending = s;
        pendingStart = Math.max(0, Math.min(from, Math.max(0, s.size() - 1)));
        pendingRate = rate;
        Intent i = new Intent(c, ReadAloudService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }

    static void stop(Context c) {
        if (!playing && index < 0) return;
        c.startService(new Intent(c, ReadAloudService.class).setAction(ACTION_STOP));
    }

    // ---------- service ----------

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_STOP : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            finish("stopped");
            return START_NOT_STICKY;
        }
        startAsForeground();
        sentences = pending != null ? pending : new ArrayList<>();
        rate = pendingRate;
        int from = pendingStart;
        pending = null;
        total = sentences.size();
        if (sentences.isEmpty()) { finish("done"); return START_NOT_STICKY; }
        holdWake();
        if (tts == null) {
            ready = false;
            index = from;
            tts = new TextToSpeech(this, this);
        } else if (ready) {
            speakFrom(from);
        } else {
            index = from;
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onInit(int status) {
        main.post(() -> {
            if (tts == null) return;
            if (status != TextToSpeech.SUCCESS) {
                boolean noEngine = tts.getEngines() == null || tts.getEngines().isEmpty();
                emit(noEngine ? "noengine" : "error", index, noEngine
                        ? "เครื่องนี้ไม่มีระบบอ่านออกเสียง แตะเพื่อติดตั้ง Speech Services by Google"
                        : "เปิดระบบเสียงพูดของเครื่องไม่ได้ ลองใหม่อีกครั้ง");
                finish("quiet");
                return;
            }
            int lang = tts.setLanguage(new Locale("th", "TH"));
            android.speech.tts.Voice voice = offlineThaiVoice(tts);
            if (voice != null) tts.setVoice(voice);
            if (voice == null && (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED)) {
                emit("novoice", index, "เครื่องยังไม่มีเสียงพูดภาษาไทยแบบไม่ใช้เน็ต แตะเพื่อติดตั้งเสียงไทย");
                finish("quiet");
                return;
            }
            emit("ready", index, voice != null
                    ? "เสียง " + voice.getName() + " (ไทย ไม่ใช้เน็ต)"
                    : "เสียงไทยของเครื่อง (" + (tts.getDefaultEngine() == null ? "-" : tts.getDefaultEngine()) + ")");
            tts.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {
                    int[] p = parse(id); if (p == null) return;
                    main.post(() -> { if (p[0] == session) { index = p[1]; emit("playing", p[1], null); updateNotification(); } });
                }
                @Override public void onDone(String id) {
                    int[] p = parse(id); if (p == null) return;
                    main.post(() -> { if (p[0] == session && p[1] >= sentences.size() - 1) finish("done"); });
                }
                @Override public void onError(String id) {
                    int[] p = parse(id); if (p == null) return;
                    main.post(() -> { if (p[0] == session && p[1] >= sentences.size() - 1) finish("done"); });
                }
            });
            ready = true;
            speakFrom(Math.max(0, index));
        });
    }

    /** The best Thai voice that is installed and needs no network, or null. */
    private static android.speech.tts.Voice offlineThaiVoice(TextToSpeech tts) {
        android.speech.tts.Voice best = null;
        try {
            for (android.speech.tts.Voice v : tts.getVoices()) {
                if (v.getLocale() == null || !"th".equals(v.getLocale().getLanguage())) continue;
                if (v.isNetworkConnectionRequired()) continue;
                if (v.getFeatures() != null && v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                if (best == null || v.getQuality() > best.getQuality()) best = v;
            }
        } catch (Exception ignored) {}
        return best;
    }

    private static int[] parse(String id) {
        try {
            String[] p = id.split(":");
            return new int[]{Integer.parseInt(p[0]), Integer.parseInt(p[1])};
        } catch (Exception e) {
            return null;
        }
    }

    /** Queues every sentence from `from` on; the engine reads them back to back. */
    private void speakFrom(int from) {
        session++;
        tts.stop();
        tts.setSpeechRate(rate);
        playing = true;
        index = from;
        emit("playing", from, null);
        for (int i = from; i < sentences.size(); i++) {
            String s = sentences.get(i).trim();
            if (s.isEmpty()) s = " ";
            tts.speak(s, i == from ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, null, session + ":" + i);
        }
        updateNotification();
    }

    private void finish(String state) {
        session++;
        boolean was = playing || index >= 0;
        playing = false;
        int at = index;
        index = -1;
        if (tts != null) { try { tts.stop(); tts.shutdown(); } catch (Exception ignored) {} tts = null; }
        ready = false;
        releaseWake();
        if (was && !"quiet".equals(state)) emit(state, at, null); // "quiet": the reason was already sent
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (tts != null) { try { tts.shutdown(); } catch (Exception ignored) {} tts = null; }
        playing = false;
        releaseWake();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void emit(String state, int at, String message) {
        MainActivity.readEvent(state, at, total, message);
    }

    // ---------- keep reading with the screen off ----------

    private void holdWake() {
        if (wake == null) {
            wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nassistant:readaloud");
            wake.setReferenceCounted(false);
        }
        wake.acquire(3 * 60 * 60 * 1000L); // at most 3 hours of reading
    }

    private void releaseWake() {
        if (wake != null && wake.isHeld()) wake.release();
    }

    // ---------- notification ----------

    private Notification buildNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CH) == null) {
            NotificationChannel ch = new NotificationChannel(CH, "อ่านออกเสียง", NotificationManager.IMPORTANCE_LOW);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
        PendingIntent open = PendingIntent.getActivity(this, 60,
                new Intent(this, MainActivity.class).putExtra("tab", "read").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 61,
                new Intent(this, ReadAloudService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String text = total > 0 && index >= 0 ? "ประโยคที่ " + (index + 1) + " จาก " + total + " · ความเร็ว x" + trim(rate) : "กำลังเตรียมเสียง…";
        return new Notification.Builder(this, CH)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle("กำลังอ่านออกเสียง")
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "หยุด", stop).build())
                .build();
    }

    private static String trim(float r) {
        return r == Math.round(r) ? String.valueOf(Math.round(r)) : String.valueOf(r);
    }

    private void startAsForeground() {
        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIF, n);
        }
    }

    private void updateNotification() {
        try { getSystemService(NotificationManager.class).notify(NOTIF, buildNotification()); } catch (SecurityException ignored) {}
    }
}
