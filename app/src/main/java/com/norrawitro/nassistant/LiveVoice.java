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

    LiveVoice(Context ctx, Events ev) {
        this.ctx = ctx.getApplicationContext();
        this.ev = ev;
    }

    boolean isOn() { return on; }

    void setEcho(boolean echo) { this.echo = echo; }

    /** Speaks the page's answer, then listens again. Empty text just listens again. Call on the main thread. */
    void answer(String text) {
        if (!on) return;
        thinking = false;
        main.removeCallbacks(pageTimeout);
        String t = text == null ? "" : text.trim();
        if (t.isEmpty()) { if (speaking == 0) relisten(200); return; }
        say(t);
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
        if (!on || rec == null) return;
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "th-TH");
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "th-TH");
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.getPackageName());
        try {
            rec.startListening(i);
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
        try { if (rec != null) rec.cancel(); } catch (Exception ignored) {}
        ev.state("speaking", "กำลังพูด…");
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
        if (!on) return;
        errorsInRow = 0;
        ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        String text = list == null || list.isEmpty() ? "" : list.get(0).trim();
        if (text.isEmpty()) { relisten(200); return; }
        ev.heard(text);
        if (echo) {
            say(text); // round 1: say back exactly what was heard
        } else {
            // The page decides at once what to say (its quick bot, or "one moment" while the AI works) and calls
            // answer(). If it does not, listen again after a few seconds rather than staying deaf.
            thinking = true;
            main.removeCallbacks(pageTimeout);
            main.postDelayed(pageTimeout, 4000);
        }
    }

    @Override
    public void onPartialResults(Bundle partial) {
        ArrayList<String> list = partial.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (list != null && !list.isEmpty() && !list.get(0).trim().isEmpty()) ev.partial(list.get(0).trim());
    }

    @Override
    public void onError(int error) {
        if (!on) return;
        if (speaking > 0) return; // listening was cancelled on purpose so the app can speak
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
    @Override public void onRmsChanged(float rmsdB) {}
    @Override public void onBufferReceived(byte[] buffer) {}
    @Override public void onEndOfSpeech() {}
    @Override public void onEvent(int eventType, Bundle params) {}
}
