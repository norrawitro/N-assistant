package com.norrawitro.nassistant;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.File;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int REQ_SAVE = 7001;
    private static final int REQ_FILE = 7005;
    private static final int REQ_WAKE_MIC = 7006;
    private String pendingWakeWord;
    /** The page's file input waiting for the system file picker. */
    private ValueCallback<Uri[]> fileCallback;
    private static final int REQ_NOTIF = 7002;
    private static final int REQ_MIC = 7003;
    private static final int REQ_TERMUX = 7004;
    private static final String START_URL = "https://appassets.androidplatform.net/assets/www/index.html";

    private WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private String pendingRing;
    private String pendingSave;
    private File downloadedApk;
    private boolean pageReady;
    private String pendingTab;
    private String pendingWake;
    private LiveVoice live;
    private boolean liveEcho = true;
    /** The activity while it is on screen, so background AI results can go straight to the page. */
    private static volatile MainActivity visible;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        AlarmReceiver.ensureChannel(this);
        pendingRing = getIntent().getStringExtra("ring");
        pendingTab = getIntent().getStringExtra("tab");
        pendingWake = getIntent().getStringExtra("wake");

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "Android");
        // Without this, confirm() and alert() in the page return at once and show nothing (the clear button did nothing).
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("ตกลง", (d, w) -> result.confirm())
                        .setNegativeButton("ยกเลิก", (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("ตกลง", (d, w) -> result.confirm())
                        .setOnCancelListener(d -> result.confirm())
                        .show();
                return true;
            }

            /** Opens the system file picker for the page's file inputs (knowledge files, JSON backup import). */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(i, REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                deliverRing();
            }
        });
        setContentView(web);
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String r = intent.getStringExtra("ring");
        if (r != null) pendingRing = r;
        String t = intent.getStringExtra("tab");
        if (t != null) pendingTab = t;
        String w = intent.getStringExtra("wake");
        if (w != null) pendingWake = w;
        deliverRing();
    }

    @Override
    public void onBackPressed() {
        // The page handles Back first: close the menu, or go back to the Live home screen.
        web.evaluateJavascript("window.__back?window.__back():false", handled -> {
            if ("true".equals(handled)) return;
            if (web.canGoBack()) web.goBack();
            else super.onBackPressed();
        });
    }

    private void deliverRing() {
        if (!pageReady) return;
        if (pendingRing != null) {
            emit("ring", JSONObject.quote(pendingRing));
            pendingRing = null;
        }
        if (pendingTab != null) {
            emit("tab", JSONObject.quote(pendingTab));
            pendingTab = null;
        }
        if (pendingWake != null) {
            emit("wake", JSONObject.quote(pendingWake));
            pendingWake = null;
        }
    }

    /** True while the app is on screen with Live listening, so the wake-word listener leaves the microphone alone. */
    static boolean liveActive() {
        MainActivity a = visible;
        return a != null && a.live != null && a.live.isOn();
    }

    /** The wake word was heard: hand the rest of the sentence to the page if it is on screen. */
    static boolean deliverWake(String rest) {
        MainActivity a = visible;
        if (a == null || !a.pageReady) return false;
        a.emit("wake", JSONObject.quote(rest == null ? "" : rest));
        return true;
    }

    /** Hands a finished AI job to the page if the app is on screen. Returns false when nobody is looking. */
    /** Read-aloud progress for the page, if it is on screen: {state, index, total, message}. */
    static void readEvent(String state, int index, int total, String message) {
        MainActivity a = visible;
        if (a == null || !a.pageReady) return;
        a.emit("read", "{\"state\":" + JSONObject.quote(state) + ",\"index\":" + index + ",\"total\":" + total
                + ",\"message\":" + JSONObject.quote(message == null ? "" : message) + "}");
    }

    /** Where the phone is, from GPS-Tracker, for the page if it is on screen. */
    static void placeEvent(String whereJson) {
        MainActivity a = visible;
        if (a != null && a.pageReady) a.emit("place", whereJson);
    }

    static boolean deliver(JSONObject res) {
        MainActivity a = visible;
        if (a == null || !a.pageReady) return false;
        a.emit("job", res.toString());
        return true;
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (visible == this) visible = null;
    }

    @Override
    protected void onStop() {
        super.onStop();
        // Round 1: Live works only while the app is on screen, so the microphone is never left open in the background.
        if (live != null && live.isOn()) live.stop();
    }

    @Override
    protected void onDestroy() {
        if (live != null) live.stop();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_WAKE_MIC) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) WakeWordService.start(this, pendingWakeWord);
            emit("wakeState", "{\"on\":" + WakeWordService.enabled(this) + ",\"running\":" + WakeWordService.running
                    + ",\"word\":" + JSONObject.quote(WakeWordService.word(this)) + "}");
            return;
        }
        if (requestCode == REQ_TERMUX) {
            emit("termuxPerm", String.valueOf(TermuxOllama.permitted(this)));
            return;
        }
        if (requestCode != REQ_MIC) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) startLive();
        else emitLive("error", "ต้องอนุญาตไมโครโฟนก่อนจึงจะใช้ Live ได้", false);
    }

    private void startLive() {
        if (live == null) {
            live = new LiveVoice(this, new LiveVoice.Events() {
                @Override public void state(String state, String message) { emitLive(state, message, live != null && live.isOn()); }
                @Override public void heard(String text) { emit("liveHeard", JSONObject.quote(text)); }
                @Override public void spoke(String text) { emit("liveSpoke", JSONObject.quote(text)); }
                @Override public void partial(String text) { emit("livePartial", JSONObject.quote(text)); }
            });
        }
        live.setEcho(liveEcho);
        live.start();
    }

    private void emitLive(String state, String message, boolean on) {
        emit("live", "{\"state\":" + JSONObject.quote(state) + ",\"message\":" + JSONObject.quote(message == null ? "" : message) + ",\"on\":" + on + "}");
    }

    /** Calls window.__native(event, payload) in the page. payload must already be valid JS. */
    private void emit(String event, String payloadJs) {
        main.post(() -> web.evaluateJavascript(
                "window.__native&&window.__native(" + JSONObject.quote(event) + "," + payloadJs + ")", null));
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE) {
            ValueCallback<Uri[]> cb = fileCallback;
            fileCallback = null;
            if (cb == null) return;
            Uri[] picked = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    picked = new Uri[data.getClipData().getItemCount()];
                    for (int k = 0; k < picked.length; k++) picked[k] = data.getClipData().getItemAt(k).getUri();
                } else if (data.getData() != null) {
                    picked = new Uri[]{data.getData()};
                }
            }
            cb.onReceiveValue(picked);
            return;
        }
        if (requestCode != REQ_SAVE) return;
        String content = pendingSave;
        pendingSave = null;
        if (resultCode != RESULT_OK || data == null || data.getData() == null || content == null) {
            emit("saved", "{\"ok\":false,\"message\":\"ยกเลิกการบันทึกไฟล์\"}");
            return;
        }
        Uri uri = data.getData();
        io.execute(() -> {
            try (OutputStream os = getContentResolver().openOutputStream(uri, "wt")) {
                if (os == null) throw new Exception("เปิดไฟล์ไม่ได้");
                os.write(content.getBytes(StandardCharsets.UTF_8));
                emit("saved", "{\"ok\":true,\"message\":\"บันทึกไฟล์แล้ว\"}");
            } catch (Exception e) {
                emit("saved", "{\"ok\":false,\"message\":" + JSONObject.quote("บันทึกไม่สำเร็จ: " + e.getMessage()) + "}");
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = this;
        // Wake word was on but its service is gone (force close or update): start it again while on screen.
        if (WakeWordService.enabled(this) && !WakeWordService.running
                && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            try { WakeWordService.start(this, WakeWordService.word(this)); } catch (Exception ignored) {}
        }
        // Coming back from the "install unknown apps" setting: continue the install if allowed now.
        if (downloadedApk != null && Updater.ensureInstallAllowedSilently(this)) {
            File apk = downloadedApk;
            downloadedApk = null;
            Updater.install(this, apk);
        }
        if (pageReady) emit("resume", "null");
    }

    /** Methods the page can call as window.Android.* */
    private class Bridge {
        @JavascriptInterface
        public String info() {
            try {
                JSONObject o = new JSONObject();
                o.put("version", BuildConfig.VERSION_NAME);
                o.put("versionCode", BuildConfig.VERSION_CODE);
                o.put("exactAlarms", AlarmScheduler.canExact(MainActivity.this));
                o.put("notifications", Build.VERSION.SDK_INT < 33 ||
                        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
                android.content.SharedPreferences p = AlarmScheduler.prefs(MainActivity.this);
                o.put("morning", p.getString("morning", "06:30"));
                o.put("morningOn", p.getBoolean("morningOn", false));
                o.put("evening", p.getString("evening", "19:30"));
                o.put("eveningOn", p.getBoolean("eveningOn", false));
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void setAlarms(String morning, boolean morningOn, String evening, boolean eveningOn) {
            AlarmScheduler.save(MainActivity.this, morning, morningOn, evening, eveningOn);
            if ((morningOn || eveningOn) && Build.VERSION.SDK_INT >= 33 &&
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                main.post(() -> requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF));
            }
        }

        @JavascriptInterface
        public void openAlarmPermission() {
            main.post(() -> {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                                Uri.parse("package:" + getPackageName())));
                    }
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void openNotificationSettings() {
            main.post(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
                } catch (Exception ignored) {}
            });
        }

        /** Starts an AI job in the background service. The answer arrives as the "job" event or via takeResults(). */
        @JavascriptInterface
        public void runJob(String jobJson) {
            AiService.start(MainActivity.this, jobJson);
        }

        @JavascriptInterface
        public String takeResults() {
            return AiService.takeResults(MainActivity.this);
        }

        @JavascriptInterface
        public void ackResult(String id) {
            AiService.ack(MainActivity.this, id);
        }

        /** Jobs keyed by date ("YYYY-MM-DD") to run before that morning's alarm. */
        @JavascriptInterface
        public void setPrepJobs(String jobsJson, int minutesBefore) {
            AiService.prefs(MainActivity.this).edit().putString("prepJobs", jobsJson).apply();
            AlarmScheduler.setPrepMinutes(MainActivity.this, minutesBefore);
        }

        @JavascriptInterface
        public void setReminders(String json) {
            Reminders.save(MainActivity.this, json);
        }

        @JavascriptInterface
        public void testRing() {
            AlarmReceiver.ring(MainActivity.this, AlarmScheduler.KIND_MORNING);
        }

        @JavascriptInterface
        public void stopRing() {
            AlarmReceiver.stop(MainActivity.this);
        }

        @JavascriptInterface
        public void saveFile(String filename, String mime, String content) {
            main.post(() -> {
                pendingSave = content;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType(mime)
                        .putExtra(Intent.EXTRA_TITLE, filename);
                try {
                    startActivityForResult(i, REQ_SAVE);
                } catch (Exception e) {
                    pendingSave = null;
                    emit("saved", "{\"ok\":false,\"message\":\"เครื่องนี้เปิดหน้าบันทึกไฟล์ไม่ได้\"}");
                }
            });
        }

        @JavascriptInterface
        public void shareText(String title, String content) {
            main.post(() -> {
                Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain")
                        .putExtra(Intent.EXTRA_SUBJECT, title).putExtra(Intent.EXTRA_TEXT, content);
                startActivity(Intent.createChooser(send, title));
            });
        }

        @JavascriptInterface
        public void liveStart() {
            main.post(() -> {
                ReadAloudService.stop(MainActivity.this); // one voice at a time
                WakeWordService.pause(MainActivity.this); // Live takes the microphone
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                } else {
                    startLive();
                }
            });
        }

        /** "ai": the page answers through liveSay(); "echo": say back what was heard. */
        @JavascriptInterface
        public void liveMode(String mode) {
            main.post(() -> {
                boolean echo = !"ai".equals(mode);
                liveEcho = echo;
                if (live != null) live.setEcho(echo);
            });
        }

        /** Speaks the AI's answer (or a message about what went wrong), then Live listens again. */
        @JavascriptInterface
        public void liveSay(String text) {
            main.post(() -> { if (live != null) live.answer(text); });
        }

        /** {installed, permitted} for the Termux setup steps. */
        @JavascriptInterface
        public String termuxStatus() {
            return "{\"installed\":" + TermuxOllama.installed(MainActivity.this)
                    + ",\"supported\":" + TermuxOllama.supportsRunCommand(MainActivity.this)
                    + ",\"permitted\":" + TermuxOllama.permitted(MainActivity.this) + "}";
        }

        /** Asks Termux to start "ollama serve". Returns started, no_termux, no_permission or error: ... */
        @JavascriptInterface
        public String termuxStart() {
            return TermuxOllama.start(MainActivity.this);
        }

        @JavascriptInterface
        public void askTermuxPermission() {
            main.post(() -> {
                if (TermuxOllama.permitted(MainActivity.this)) emit("termuxPerm", "true");
                else if (!TermuxOllama.supportsRunCommand(MainActivity.this)) emit("termuxPerm", "\"unsupported\"");
                else requestPermissions(new String[]{TermuxOllama.PERMISSION}, REQ_TERMUX);
            });
        }

        @JavascriptInterface
        public void openTermux() {
            main.post(() -> {
                Intent i = getPackageManager().getLaunchIntentForPackage(TermuxOllama.PKG);
                if (i != null) startActivity(i);
            });
        }

        // ---------- wake word ----------

        @JavascriptInterface
        public void wakeStart(String word) {
            main.post(() -> {
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    pendingWakeWord = word;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_WAKE_MIC);
                    return;
                }
                WakeWordService.start(MainActivity.this, word);
                emit("wakeState", wakeStatus());
            });
        }

        @JavascriptInterface
        public void wakeStop() {
            main.post(() -> { WakeWordService.stop(MainActivity.this); emit("wakeState", wakeStatus()); });
        }

        @JavascriptInterface
        public String wakeStatus() {
            return "{\"on\":" + WakeWordService.enabled(MainActivity.this) + ",\"running\":" + WakeWordService.running
                    + ",\"word\":" + JSONObject.quote(WakeWordService.word(MainActivity.this)) + "}";
        }

        // ---------- GPS-Tracker link ----------

        @JavascriptInterface
        public void setPlaceRules(String json) { PlaceEvents.saveRules(MainActivity.this, json); }

        @JavascriptInterface
        public String whereNow() { return PlaceEvents.where(MainActivity.this); }

        /** Whether GPS-Tracker is installed. */
        @JavascriptInterface
        public boolean gpsTrackerInstalled() {
            try { getPackageManager().getPackageInfo("com.norrawitro.gpstracker", 0); return true; }
            catch (Exception e) { return false; }
        }

        // ---------- read aloud ----------

        /** Starts reading the sentences (a JSON array of strings) from `from`, at `rate` (1, 1.5, 2, 3). */
        @JavascriptInterface
        public void readStart(String sentencesJson, int from, float rate) {
            main.post(() -> {
                try {
                    if (live != null && live.isOn()) live.stop(); // one voice at a time
                    ReadAloudService.start(MainActivity.this, new org.json.JSONArray(sentencesJson), from, rate);
                } catch (Exception e) {
                    readEvent("error", -1, 0, "เริ่มอ่านไม่ได้: " + e.getMessage());
                }
            });
        }

        @JavascriptInterface
        public void readStop() {
            main.post(() -> ReadAloudService.stop(MainActivity.this));
        }

        /** {playing, index, total} so the page can show where reading is after coming back. */
        @JavascriptInterface
        public String readStatus() {
            return "{\"playing\":" + ReadAloudService.playing + ",\"index\":" + ReadAloudService.index + ",\"total\":" + ReadAloudService.total + "}";
        }

        /** Text on the clipboard, read by Android (the WebView cannot always read it itself). */
        @JavascriptInterface
        public String clipboardText() {
            try {
                android.content.ClipboardManager cm = getSystemService(android.content.ClipboardManager.class);
                if (cm == null || !cm.hasPrimaryClip() || cm.getPrimaryClip().getItemCount() == 0) return "";
                CharSequence t = cm.getPrimaryClip().getItemAt(0).coerceToText(MainActivity.this);
                return t == null ? "" : t.toString();
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void liveStop() {
            main.post(() -> { if (live != null) live.stop(); else emitLive("off", "", false); });
        }

        @JavascriptInterface
        public void checkUpdate() {
            io.execute(() -> {
                try {
                    emit("update", Updater.check().toString());
                } catch (Exception e) {
                    emit("update", "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
                }
            });
        }

        @JavascriptInterface
        public void installUpdate(String url) {
            io.execute(() -> {
                try {
                    File apk = Updater.download(MainActivity.this, url, pct -> emit("updateProgress", String.valueOf(pct)));
                    emit("updateProgress", "100");
                    main.post(() -> {
                        if (Updater.ensureInstallAllowed(MainActivity.this)) Updater.install(MainActivity.this, apk);
                        else downloadedApk = apk;
                    });
                } catch (Exception e) {
                    emit("update", "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
                }
            });
        }

        /**
         * HTTP request to an AI server on this phone (Ollama in Termux). Only localhost is allowed.
         * Answers through window.__native("local", {id, ok, status, body}).
         */
        @JavascriptInterface
        public void localRequest(String id, String method, String url, String body) {
            io.execute(() -> {
                JSONObject out = new JSONObject();
                try {
                    out.put("id", id);
                    Uri u = Uri.parse(url);
                    String host = u.getHost();
                    if (!"http".equals(u.getScheme()) || !("127.0.0.1".equals(host) || "localhost".equals(host))) {
                        throw new Exception("ใช้ได้เฉพาะเซิร์ฟเวอร์ในเครื่อง (http://127.0.0.1)");
                    }
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                    c.setConnectTimeout(5000);
                    c.setReadTimeout(10 * 60 * 1000); // small phones can take minutes to answer
                    c.setRequestMethod(method);
                    if (body != null && !body.isEmpty()) {
                        c.setDoOutput(true);
                        c.setRequestProperty("Content-Type", "application/json");
                        try (OutputStream os = c.getOutputStream()) {
                            os.write(body.getBytes(StandardCharsets.UTF_8));
                        }
                    }
                    int status = c.getResponseCode();
                    java.io.InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    String text = "";
                    if (in != null) {
                        try (java.io.InputStream s = in) {
                            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                            byte[] buf = new byte[8192];
                            int n;
                            while ((n = s.read(buf)) > 0) bo.write(buf, 0, n);
                            text = bo.toString(StandardCharsets.UTF_8.name());
                        }
                    }
                    out.put("ok", status < 400);
                    out.put("status", status);
                    out.put("body", text);
                } catch (java.net.ConnectException e) {
                    try { out.put("ok", false); out.put("status", 0); out.put("error", "offline"); } catch (Exception ignored) {}
                } catch (Exception e) {
                    try { out.put("ok", false); out.put("status", 0); out.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) {}
                }
                emit("local", out.toString());
            });
        }

        @JavascriptInterface
        public void openUrl(String url) {
            main.post(() -> {
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) {}
            });
        }
    }
}
