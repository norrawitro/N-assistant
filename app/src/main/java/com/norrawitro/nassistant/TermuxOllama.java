package com.norrawitro.nassistant;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;

/**
 * Starts "ollama serve" inside Termux through Termux's RUN_COMMAND intent, so the person does not have to open Termux
 * by hand before using the AI on this phone.
 *
 * One-time setup the person must do (the app shows these steps in Thai):
 *  1. Termux from F-Droid or GitHub (the Play Store build is old and does not support this).
 *  2. In Termux: pkg install ollama, then ollama pull a model.
 *  3. In Termux: allow-external-apps=true in ~/.termux/termux.properties, then termux-reload-settings.
 *  4. Grant this app the "Run commands in Termux environment" permission.
 */
final class TermuxOllama {
    static final String PKG = "com.termux";
    static final String PERMISSION = "com.termux.permission.RUN_COMMAND";
    private static final String PREFIX = "/data/data/com.termux/files/usr";
    private static final String HOME = "/data/data/com.termux/files/home";

    private TermuxOllama() {}

    static boolean installed(Context c) {
        try {
            c.getPackageManager().getPackageInfo(PKG, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    /**
     * Whether the installed Termux offers the RUN_COMMAND permission to other apps at all. Some builds (for example the
     * Play Store one) do not; then Android never shows a prompt and the permission is missing from the app's settings.
     */
    static boolean supportsRunCommand(Context c) {
        try {
            c.getPackageManager().getPermissionInfo(PERMISSION, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    static boolean permitted(Context c) {
        return c.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Asks Termux to start Ollama in the background if it is not already running.
     * Returns "started", "no_termux", "no_permission" or "error: ...".
     * Termux refuses silently when allow-external-apps is off; the page notices because Ollama then never answers.
     */
    static String start(Context c) {
        if (!installed(c)) return "no_termux";
        if (!permitted(c)) return "no_permission";
        Intent i = new Intent()
                .setComponent(new ComponentName(PKG, "com.termux.app.RunCommandService"))
                .setAction("com.termux.RUN_COMMAND")
                .putExtra("com.termux.RUN_COMMAND_PATH", PREFIX + "/bin/bash")
                .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"-c",
                        // Keep the phone awake for Termux, and start the server only if it is not running yet.
                        "termux-wake-lock 2>/dev/null; pgrep -x ollama >/dev/null || nohup ollama serve >\"$HOME/ollama.log\" 2>&1 &"})
                .putExtra("com.termux.RUN_COMMAND_WORKDIR", HOME)
                .putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
                .putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0");
        try {
            c.startService(i);
            return "started";
        } catch (SecurityException e) {
            return "no_permission";
        } catch (Exception e) {
            return "error: " + e.getMessage();
        }
    }
}
