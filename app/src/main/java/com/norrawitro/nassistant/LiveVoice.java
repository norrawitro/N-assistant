package com.norrawitro.nassistant;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import java.util.ArrayList;
import java.util.Locale;

/**
 * "Live" voice loop, round 1 (no AI): listen in Thai with the phone's own speech recognizer, then say back what was heard
 * with the phone's own text-to-speech, then listen again, until Live is turned off.
 * Runs only while the app is on screen. Nothing is sent anywhere by this class; the phone's recognizer may use its own
 * online service, depending on the phone.
 */
final class LiveVoice implements RecognitionListener, TextToSpeech.OnInitListener {
    interface Events {
        /** state: listening, speaking, off, error. */
        void state(String state, String message);
        void heard(String text);
        void spoke(String text);
        void partial(String text);
        /**
         * The microphone light: loudness 0..1 and the voice's pitch in Hz (0 when unknown), about 12 times a second
         * while listening.
         */
        void level(float loud, float hz, float floorDb, float db);
    }

    private static final Locale THAI = new Locale("th", "TH");

    private final Context ctx;
    private final Events ev;
    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechRecognizer rec;
    private TextToSpeech tts;
    private boolean on;
    private boolean ttsReady;
    private String waitingToSay;
    private int errorsInRow;
    private int utterance;
    /** true: say back what was heard (round 1). false: the page asks the AI and calls say() with the answer. */
    private boolean echo = true;
    /** Heard something and waiting for the page to say what to do (answer() is expected within moments). */
    private boolean thinking;
    /** Utterances handed to the text-to-speech engine that have not finished yet. */
    private int speaking;
    private final Runnable listenTask = this::listen;
    private final Runnable pageTimeout = () -> { if (thinking) { thinking = false; relisten(0); } };

    /**
     * Turn-taking (manners): nobody answers or speaks over a person who is still talking. The person's words are held
     * until QUIET_MS of silence; an answer waits for the same silence before the phone speaks it.
     */
    private static final long QUIET_MS = 2000;
    private final StringBuilder held = new StringBuilder(); // what the person said, not yet given to the page
    private String pendingSay;                              // an answer waiting for silence before it is spoken
    private boolean quietArmed;
    private boolean listening;                              // the recognizer is running now
    private final Runnable quietDone = this::onQuiet;

    private void restartQuiet() { restartQuietIn(QUIET_MS); }
    private void restartQuietIn(long ms) { main.removeCallbacks(quietDone); quietArmed = true; main.postDelayed(quietDone, Math.max(50, ms)); }
    /** Recognizer errors while words or an answer are waiting must not cancel the wait, but must not extend it either. */
    private void armIfIdle() { if (!quietArmed && (held.length() > 0 || pendingSay != null)) restartQuiet(); }
    private void cancelRec() {
        listening = false;
        try { if (rec != null) rec.cancel(); } catch (Exception ignored) {}
    }

    /**
     * The room's own noise (the "พื้นเสียง"): an average of the quiet moments, in the recognizer's dB. A sound counts
     * when it is SOUND_MARGIN_DB above that average. Starts from the first reading and keeps adjusting slowly.
     */
    private static final float SOUND_MARGIN_DB = 4f;
    private float noiseFloor = Float.NaN;
    private long lastSoundAt;

    private void onQuiet() {
        quietArmed = false;
        if (!on) return;
        // Silence means the room's sound level has stayed at the room's own noise for QUIET_MS. The recognizer's
        // events are not used for this: room noise makes it report text, which would keep the phrase open forever.
        long since = System.currentTimeMillis() - lastSoundAt;
        if (since < QUIET_MS) { restartQuietIn(QUIET_MS - since); return; }
        if (held.length() > 0) {
            String text = held.toString();
            held.setLength(0);
            main.removeCallbacks(listenTask);
            cancelRec();
            ev.heard(text);
            if (echo) { pendingSay = text; speakPending(); return; } // round 1: say back exactly what was heard
            // The page answers through answer(). Until then the phone waits in thinking.
            thinking = true;
            main.removeCallbacks(pageTimeout);
            main.postDelayed(pageTimeout, 4000);
            if (pendingSay != null) { restartQuiet(); listen(); } // an earlier answer still waits for silence
            return;
        }
        if (pendingSay != null) speakPending();
    }

    private void speakPending() {
        String t = pendingSay;
        pendingSay = null;
        if (t != null) say(t);
    }

    LiveVoice(Context ctx, Events ev) {
        this.ctx = ctx.getApplicationContext();
        this.ev = ev;
    }

    boolean isOn() { return on; }

    void setEcho(boolean echo) { this.echo = echo; }

    /** Speed of the spoken answers (1, 1.5, 2 or 3), chosen in Settings. */
    private float rate = 1f;
    void setRate(float r) { rate = r; }

    /** Speaks the page's answer, then listens again. Empty text just listens again. Call on the main thread. */
    void answer(String text) {
        if (!on) return;
        thinking = false;
        main.removeCallbacks(pageTimeout);
        String t = text == null ? "" : text.trim();
        if (t.isEmpty()) { if (speaking == 0) relisten(200); return; }
        if (speaking > 0) { say(t); return; } // already speaking: queue behind it
        pendingSay = t;
        if (held.length() == 0 && !quietArmed) restartQuiet(); // speak once the person has been quiet for QUIET_MS
        listen(); // keep listening: if the person starts again, the answer keeps waiting
    }

    /** Call on the main thread. */
    void start() {
        if (on) return;
        if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
            ev.state("error", "เครื่องนี้ไม่มีระบบแปลงเสียงเป็นข้อความ ลองติดตั้งหรือเปิดแอป Google");
            return;
        }
        on = true;
        errorsInRow = 0;
        rec = SpeechRecognizer.createSpeechRecognizer(ctx);
        rec.setRecognitionListener(this);
        ttsReady = false;
        tts = new TextToSpeech(ctx, this);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) {}
            @Override public void onDone(String id) { main.post(LiveVoice.this::afterSpeaking); }
            @Override public void onError(String id) { main.post(LiveVoice.this::afterSpeaking); }
        });
        listen();
    }

    /** Call on the main thread. */
    void stop() {
        if (!on) return;
        on = false;
        main.removeCallbacksAndMessages(null);
        held.setLength(0);
        pendingSay = null;
        quietArmed = false;
        listening = false;
        try { rec.cancel(); rec.destroy(); } catch (Exception ignored) {}
        rec = null;
        try { tts.stop(); tts.shutdown(); } catch (Exception ignored) {}
        tts = null;
        waitingToSay = null;
        thinking = false;
        speaking = 0;
        ev.state("off", "");
    }

    private void listen() {
        if (!on || rec == null || listening) return;
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "th-TH");
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "th-TH");
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.getPackageName());
        try {
            rec.startListening(i);
            listening = true;
            ev.state("listening", "กำลังฟัง… พูดได้เลย");
        } catch (Exception e) {
            fail("เริ่มฟังไม่ได้: " + e.getMessage());
        }
    }

    private void relisten(long delayMs) {
        if (!on || thinking || speaking > 0) return;
        main.removeCallbacks(listenTask);
        main.postDelayed(listenTask, delayMs);
    }

    private void say(String text) {
        if (!on) return;
        if (!ttsReady) { waitingToSay = text; return; }
        // The page may speak at any moment (for example when the AI's answer arrives while the microphone is open):
        // stop listening first so the app does not hear itself, and queue behind anything still being spoken.
        main.removeCallbacks(listenTask);
        cancelRec();
        ev.state("speaking", "กำลังพูด…");
        try { tts.setSpeechRate(rate); } catch (Exception ignored) {}
        String id = "u" + (++utterance);
        int r = tts.speak(text, speaking > 0 ? TextToSpeech.QUEUE_ADD : TextToSpeech.QUEUE_FLUSH, null, id);
        if (r == TextToSpeech.SUCCESS) speaking++;
        if (r != TextToSpeech.SUCCESS) {
            ev.state("error", "พูดออกเสียงไม่ได้ ตรวจการตั้งค่าเสียงพูด (TTS) ของเครื่อง");
            relisten(800);
            return;
        }
        if (echo) ev.spoke(text); // in AI mode the page logs the answer itself
    }

    private void afterSpeaking() {
        if (speaking > 0) speaking--;
        relisten(250);
    }

    private void fail(String message) {
        stop();
        ev.state("error", message); // after stop, so the message stays on screen
    }

    // ---------- TextToSpeech ----------

    @Override
    public void onInit(int status) {
        main.post(() -> {
            if (!on || tts == null) return;
            if (status != TextToSpeech.SUCCESS) {
                ev.state("error", "เปิดระบบเสียงพูด (TTS) ของเครื่องไม่ได้");
                return;
            }
            int lang = tts.setLanguage(THAI);
            if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) {
                ev.state("error", "เครื่องยังไม่มีเสียงพูดภาษาไทย ไปที่ ตั้งค่าเครื่อง → การเข้าถึง → เอาต์พุตการอ่านออกเสียง แล้วติดตั้งภาษาไทย");
            }
            ttsReady = true;
            if (waitingToSay != null) { String t = waitingToSay; waitingToSay = null; say(t); }
        });
    }

    // ---------- SpeechRecognizer ----------

    @Override
    public void onResults(Bundle results) {
        listening = false;
        if (!on) return;
        errorsInRow = 0;
        ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        String text = list == null || list.isEmpty() ? "" : list.get(0).trim();
        if (text.isEmpty()) { armIfIdle(); relisten(200); return; }
        if (held.length() > 0) held.append(' ');
        held.append(text);
        ev.partial(held.toString());
        restartQuiet(); // the person may go on: answer only after QUIET_MS of silence
        if (!thinking) listen();
    }

    @Override
    public void onPartialResults(Bundle partial) {
        ArrayList<String> list = partial.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (list != null && !list.isEmpty() && !list.get(0).trim().isEmpty()) {
            ev.partial((held.length() > 0 ? held + " " : "") + list.get(0).trim());
        }
    }

    @Override
    public void onError(int error) {
        listening = false;
        if (!on) return;
        if (speaking > 0) return; // listening was cancelled on purpose so the app can speak
        armIfIdle();
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                relisten(250); // silence: keep listening
                return;
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                fail("ไม่ได้รับอนุญาตให้ใช้ไมโครโฟน");
                return;
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                try { rec.cancel(); } catch (Exception ignored) {}
                break;
            default:
                break;
        }
        errorsInRow++;
        if (errorsInRow >= 6) {
            fail(error == SpeechRecognizer.ERROR_NETWORK || error == SpeechRecognizer.ERROR_NETWORK_TIMEOUT
                    ? "แปลงเสียงไม่ได้เพราะไม่มีอินเทอร์เน็ต (เครื่องนี้อาจต้องใช้เน็ตหรือดาวน์โหลดภาษาไทยแบบออฟไลน์)"
                    : "แปลงเสียงไม่ได้ (รหัส " + error + ") ปิด Live แล้ว ลองเปิดใหม่");
            return;
        }
        relisten(600L * errorsInRow);
    }

    @Override public void onReadyForSpeech(Bundle params) {}
    @Override public void onBeginningOfSpeech() {}
    // ---------- microphone light ----------
    private long lastLevelAt;
    private float hz;

    /** Called by the recognizer about 10-50 times a second with the sound level in dB (about -2 quiet to 10 loud). */
    @Override public void onRmsChanged(float rmsdB) {
        long now = System.currentTimeMillis();
        // Any sound in the room (a voice, a TV, a car) counts: the phone does not speak until the air has been still.
        if (Float.isNaN(noiseFloor)) noiseFloor = rmsdB;
        if (rmsdB > noiseFloor + SOUND_MARGIN_DB) lastSoundAt = now;
        else noiseFloor = noiseFloor * 0.98f + rmsdB * 0.02f; // quiet moments update the average
        if (now - lastLevelAt < 80) return;
        lastLevelAt = now;
        float loud = Math.max(0f, Math.min(1f, (rmsdB + 2f) / 12f));
        ev.level(loud, loud < 0.15f ? 0f : hz, noiseFloor, rmsdB);
    }

    /**
     * Some recognizers also hand over the raw sound (16-bit, 16 kHz): estimate the pitch from how often the wave
     * crosses zero. Most phones never call this; the light then follows the loudness only.
     */
    @Override public void onBufferReceived(byte[] buffer) {
        if (buffer == null || buffer.length < 320) return;
        int n = buffer.length / 2, crossings = 0;
        short prev = 0;
        for (int i = 0; i < n; i++) {
            short s = (short) ((buffer[2 * i] & 0xff) | (buffer[2 * i + 1] << 8));
            if (i > 0 && ((prev < 0) != (s < 0))) crossings++;
            prev = s;
        }
        float est = crossings * 16000f / (2f * n);
        if (est >= 60 && est <= 1000) hz = hz == 0 ? est : hz * 0.7f + est * 0.3f;
    }
    @Override public void onEndOfSpeech() {}
    @Override public void onEvent(int eventType, Bundle params) {}
}
