package com.norrawitro.nassistant;

import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import java.util.ArrayList;

/**
 * Wake word ("คำปลุก"), no API key, no outside service: the owner presses the power button, then says the wake word.
 * Listening only happens while the screen is on, for a short window after it turns on, using the phone's own
 * speech recognizer. Everything that does not start with the wake word is ignored and kept nowhere.
 * On the wake word the app opens (over the lock screen too) and Live takes the rest of the sentence, or listens
 * for it when only the wake word was said.
 */
public class WakeWordService extends Service implements RecognitionListener {
    static final String ACTION_START = "start";
    static final String ACTION_STOP = "stop";
    static final String ACTION_PAUSE = "pause";
    private static final String CH = "wake_word_v1";
    private static final String CH_WAKE = "wake_word_open_v1";
    private static final int NOTIF = 4300;
    private static final int NOTIF_WAKE = 4301;
    private static final long WINDOW_MS = 30_000;

    static volatile boolean running;

    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechRecognizer rec;
    private boolean listening;
    private long windowEnd;
    private BroadcastReceiver screen;

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences("wake_word", Context.MODE_PRIVATE); }
    static String word(Context c) { return prefs(c).getString("word", "ผู้ช่วย"); }
    static boolean enabled(Context c) { return prefs(c).getBoolean("on", false); }

    /** Must be called while the app is on screen (Android only lets a microphone service start then). */
    static void start(Context c, String word) {
        prefs(c).edit().putBoolean("on", true).putString("word", word == null || word.trim().isEmpty() ? "ผู้ช่วย" : word.trim()).apply();
        Intent i = new Intent(c, WakeWordService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }

    /** Live is taking the microphone: stop the current listening window. */
    static void pause(Context c) {
        if (running) c.startService(new Intent(c, WakeWordService.class).setAction(ACTION_PAUSE));
    }

    static void stop(Context c) {
        prefs(c).edit().putBoolean("on", false).apply();
        if (running) c.startService(new Intent(c, WakeWordService.class).setAction(ACTION_STOP));
    }

    // ---------- service ----------

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) { shutdown(); return START_NOT_STICKY; }
        if (intent != null && ACTION_PAUSE.equals(intent.getAction())) { closeWindow(); return START_STICKY; }
        startAsForeground();
        running = true;
        if (screen == null) {
            screen = new BroadcastReceiver() {
                @Override public void onReceive(Context c, Intent i) {
                    if (Intent.ACTION_SCREEN_ON.equals(i.getAction())) openWindow();
                    else if (Intent.ACTION_SCREEN_OFF.equals(i.getAction())) closeWindow();
                }
            };
            IntentFilter f = new IntentFilter();
            f.addAction(Intent.ACTION_SCREEN_ON);
            f.addAction(Intent.ACTION_SCREEN_OFF);
            registerReceiver(screen, f);
            PowerManager pm = getSystemService(PowerManager.class);
            if (pm != null && pm.isInteractive()) openWindow(); // the screen is on now: listen right away
        }
        return START_STICKY;
    }

    private void shutdown() {
        closeWindow();
        if (screen != null) { try { unregisterReceiver(screen); } catch (Exception ignored) {} screen = null; }
        running = false;
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        closeWindow();
        if (screen != null) { try { unregisterReceiver(screen); } catch (Exception ignored) {} screen = null; }
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ---------- the listening window after the screen turns on ----------

    private void openWindow() {
        windowEnd = System.currentTimeMillis() + WINDOW_MS;
        main.removeCallbacksAndMessages(null);
        unhushBeep();
        main.postDelayed(this::listen, 300);
        main.postDelayed(this::closeWindow, WINDOW_MS + 500);
    }

    private void closeWindow() {
        windowEnd = 0;
        main.removeCallbacksAndMessages(null);
        unhushBeep();
        listening = false;
        if (rec != null) { try { rec.cancel(); rec.destroy(); } catch (Exception ignored) {} rec = null; }
    }

    private void listen() {
        if (System.currentTimeMillis() > windowEnd) { closeWindow(); return; }
        PowerManager pm = getSystemService(PowerManager.class);
        if (pm != null && !pm.isInteractive()) { closeWindow(); return; }
        // The app's own Live screen already has the microphone: let it be and check again shortly.
        if (MainActivity.liveActive()) { main.postDelayed(this::listen, 1500); return; }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) { closeWindow(); return; }
        if (rec == null) { rec = SpeechRecognizer.createSpeechRecognizer(this); rec.setRecognitionListener(this); }
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "th-TH")
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
                .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
        hushBeep();
        try { rec.startListening(i); listening = true; } catch (Exception e) { main.postDelayed(this::listen, 1000); }
    }

    // ---------- no "ting" each time listening starts ----------
    private static final int[] BEEP_STREAMS = {AudioManager.STREAM_MUSIC, AudioManager.STREAM_NOTIFICATION, AudioManager.STREAM_SYSTEM};
    private final boolean[] hushed = new boolean[BEEP_STREAMS.length];
    private final Runnable unhush = this::unhushBeep;

    /**
     * Many phones' speech recognizers play a short tone every time they start listening. The wake word restarts
     * listening every few seconds while the screen is on, so that tone kept sounding. Mute the tone's streams for
     * a moment around each start; streams the owner had muted already are left alone.
     */
    private void hushBeep() {
        AudioManager am = getSystemService(AudioManager.class);
        if (am == null) return;
        main.removeCallbacks(unhush);
        for (int k = 0; k < BEEP_STREAMS.length; k++) {
            if (hushed[k]) continue;
            try {
                if (!am.isStreamMute(BEEP_STREAMS[k])) {
                    am.adjustStreamVolume(BEEP_STREAMS[k], AudioManager.ADJUST_MUTE, 0);
                    hushed[k] = true;
                }
            } catch (Exception ignored) {} // Do Not Disturb can refuse; then the tone may still sound
        }
        main.postDelayed(unhush, 900);
    }

    private void unhushBeep() {
        AudioManager am = getSystemService(AudioManager.class);
        for (int k = 0; k < BEEP_STREAMS.length; k++) {
            if (!hushed[k]) continue;
            hushed[k] = false;
            try { if (am != null) am.adjustStreamVolume(BEEP_STREAMS[k], AudioManager.ADJUST_UNMUTE, 0); } catch (Exception ignored) {}
        }
    }

    /** Text after the wake word, "" when only the wake word was said, or null when it was not said. */
    static String afterWakeWord(String heard, String word) {
        String h = heard.trim(), w = word.trim();
        String hn = h.replaceAll("\\s+", ""), wn = w.replaceAll("\\s+", "");
        if (wn.isEmpty()) return null;
        int at = hn.indexOf(wn);
        if (at < 0 || at > 6) return null; // the wake word must come first (a short "เฮ้"/"นี่" before it is fine)
        // Map the position back into the original text (with its spaces).
        int seen = 0, k = 0;
        while (k < h.length() && seen < at + wn.length()) { if (!Character.isWhitespace(h.charAt(k))) seen++; k++; }
        return h.substring(k).replaceAll("^(\\s|,|ครับ|ค่ะ|คะ)+", "").trim();
    }

    private void woke(String rest) {
        closeWindow();
        Intent open = new Intent(this, MainActivity.class).putExtra("wake", rest == null ? "" : rest)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (MainActivity.deliverWake(rest)) return; // the app is on screen: hand it over directly
        // From the background or the lock screen: a full-screen intent opens the app over the lock screen.
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CH_WAKE) == null) {
            nm.createNotificationChannel(new NotificationChannel(CH_WAKE, "เปิดแอปเมื่อได้ยินคำปลุก", NotificationManager.IMPORTANCE_HIGH));
        }
        PendingIntent pi = PendingIntent.getActivity(this, 80, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CH_WAKE)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle("N-assistant")
                .setContentText(rest == null || rest.isEmpty() ? "ว่ามาเลยครับ" : rest)
                .setCategory(Notification.CATEGORY_CALL)
                .setAutoCancel(true)
                .setTimeoutAfter(30_000)
                .setContentIntent(pi)
                .setFullScreenIntent(pi, true)
                .build();
        try { nm.notify(NOTIF_WAKE, n); } catch (SecurityException ignored) {}
        // When the phone is unlocked and in use, Android shows the notification instead of opening; try directly too.
        KeyguardManager km = getSystemService(KeyguardManager.class);
        if (km != null && !km.isKeyguardLocked()) { try { startActivity(open); } catch (Exception ignored) {} }
    }

    // ---------- RecognitionListener ----------

    @Override
    public void onResults(Bundle results) {
        listening = false;
        ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        String w = word(this);
        if (list != null) {
            for (String heard : list) {
                String rest = afterWakeWord(heard == null ? "" : heard, w);
                if (rest != null) { woke(rest); return; }
            }
        }
        main.postDelayed(this::listen, 200); // not the wake word: ignore it and keep listening in the window
    }

    @Override
    public void onError(int error) {
        listening = false;
        if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) { closeWindow(); return; }
        if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) { try { rec.cancel(); } catch (Exception ignored) {} }
        main.postDelayed(this::listen, error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ? 200 : 1000);
    }

    @Override public void onReadyForSpeech(Bundle params) {}
    @Override public void onBeginningOfSpeech() {}
    @Override public void onRmsChanged(float rmsdB) {}
    @Override public void onBufferReceived(byte[] buffer) {}
    @Override public void onEndOfSpeech() {}
    @Override public void onPartialResults(Bundle partialResults) {}
    @Override public void onEvent(int eventType, Bundle params) {}

    // ---------- notification ----------

    private void startAsForeground() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CH) == null) {
            NotificationChannel ch = new NotificationChannel(CH, "โหมดคำปลุก", NotificationManager.IMPORTANCE_MIN);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
        PendingIntent stop = PendingIntent.getService(this, 81, new Intent(this, WakeWordService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent open = PendingIntent.getActivity(this, 82, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CH)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle("โหมดคำปลุกเปิดอยู่")
                .setContentText("กดปุ่ม power แล้วพูด \"" + word(this) + "\" ภายใน 30 วินาที")
                .setOngoing(true)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "หยุดฟัง", stop).build())
                .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(NOTIF, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIF, n);
        }
    }
}
