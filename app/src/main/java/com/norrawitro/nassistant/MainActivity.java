package com.norrawitro.nassistant;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
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
    private static final int REQ_NOTIF = 7002;
    private static final String START_URL = "https://appassets.androidplatform.net/assets/www/index.html";

    private WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private String pendingRing;
    private String pendingSave;
    private File downloadedApk;
    private boolean pageReady;
    private String pendingTab;
    /** The activity while it is on screen, so background AI results can go straight to the page. */
    private static volatile MainActivity visible;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        AlarmReceiver.ensureChannel(this);
        pendingRing = getIntent().getStringExtra("ring");
        pendingTab = getIntent().getStringExtra("tab");

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
        deliverRing();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
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
    }

    /** Hands a finished AI job to the page if the app is on screen. Returns false when nobody is looking. */
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

    /** Calls window.__native(event, payload) in the page. payload must already be valid JS. */
    private void emit(String event, String payloadJs) {
        main.post(() -> web.evaluateJavascript(
                "window.__native&&window.__native(" + JSONObject.quote(event) + "," + payloadJs + ")", null));
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
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
