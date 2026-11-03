package com.norrawitro.nassistant;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * Reminders the person sets in the app. Each one is JSON:
 * {id, text, time: "HH:MM", date: "YYYY-MM-DD", repeat: "once"|"daily"|"weekdays"|"weekly", on: bool}.
 * "weekly" repeats on the weekday of `date`.
 */
public class Reminders extends BroadcastReceiver {
    private static final String PREFS = "reminders";
    private static final String CHANNEL = "reminder_v1";
    private static final String ACTION_FIRE = "com.norrawitro.nassistant.REMINDER";
    private static final String ACTION_SNOOZE = "com.norrawitro.nassistant.REMINDER_SNOOZE";
    private static final String ACTION_DONE = "com.norrawitro.nassistant.REMINDER_DONE";
    private static final int SNOOZE_MINUTES = 10;

    public static void save(Context c, String json) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String old = p.getString("list", "[]");
        try {
            JSONArray prev = new JSONArray(old);
            for (int i = 0; i < prev.length(); i++) cancel(c, prev.getJSONObject(i).optString("id"));
        } catch (Exception ignored) {}
        p.edit().putString("list", json).apply();
        rescheduleAll(c);
    }

    public static void rescheduleAll(Context c) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            JSONArray arr = new JSONArray(p.getString("list", "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject r = arr.getJSONObject(i);
                cancel(c, r.optString("id"));
                if (!r.optBoolean("on", true)) continue;
                long at = next(r, System.currentTimeMillis());
                if (at > 0) schedule(c, r.optString("id"), r.optString("text"), at, code(r.optString("id")), false);
            }
        } catch (Exception ignored) {}
    }

    private static JSONObject find(Context c, String id) {
        try {
            JSONArray arr = new JSONArray(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("list", "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject r = arr.getJSONObject(i);
                if (id.equals(r.optString("id"))) return r;
            }
        } catch (Exception ignored) {}
        return null;
    }

    private static int code(String id) {
        return 100000 + (id.hashCode() & 0x3fffffff) % 800000;
    }

    /** Next time this reminder should fire after `now`, or -1 if it never will again. */
    static long next(JSONObject r, long now) {
        String[] t = r.optString("time", "").split(":");
        if (t.length != 2) return -1;
        int h, m;
        try { h = Integer.parseInt(t[0]); m = Integer.parseInt(t[1]); } catch (NumberFormatException e) { return -1; }
        String repeat = r.optString("repeat", "once");
        Calendar cal = Calendar.getInstance();
        String date = r.optString("date", "");
        String[] d = date.split("-");
        if ("once".equals(repeat) || "weekly".equals(repeat)) {
            if (d.length != 3) return -1;
            try {
                cal.set(Integer.parseInt(d[0]), Integer.parseInt(d[1]) - 1, Integer.parseInt(d[2]), h, m, 0);
            } catch (NumberFormatException e) { return -1; }
            cal.set(Calendar.MILLISECOND, 0);
            if ("once".equals(repeat)) return cal.getTimeInMillis() > now ? cal.getTimeInMillis() : -1;
            int dow = cal.get(Calendar.DAY_OF_WEEK);
            cal.setTimeInMillis(now);
            cal.set(Calendar.HOUR_OF_DAY, h); cal.set(Calendar.MINUTE, m); cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0);
            for (int i = 0; i < 8; i++) {
                if (cal.get(Calendar.DAY_OF_WEEK) == dow && cal.getTimeInMillis() > now) return cal.getTimeInMillis();
                cal.add(Calendar.DAY_OF_YEAR, 1);
            }
            return -1;
        }
        cal.setTimeInMillis(now);
        cal.set(Calendar.HOUR_OF_DAY, h); cal.set(Calendar.MINUTE, m); cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0);
        for (int i = 0; i < 8; i++) {
            int dow = cal.get(Calendar.DAY_OF_WEEK);
            boolean dayOk = !"weekdays".equals(repeat) || (dow != Calendar.SATURDAY && dow != Calendar.SUNDAY);
            if (dayOk && cal.getTimeInMillis() > now) return cal.getTimeInMillis();
            cal.add(Calendar.DAY_OF_YEAR, 1);
        }
        return -1;
    }

    private static PendingIntent firePi(Context c, String id, String text, int reqCode, boolean snooze) {
        Intent i = new Intent(c, Reminders.class).setAction(ACTION_FIRE + "." + reqCode)
                .putExtra("id", id).putExtra("text", text).putExtra("snooze", snooze);
        return PendingIntent.getBroadcast(c, reqCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void schedule(Context c, String id, String text, long at, int reqCode, boolean snooze) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = firePi(c, id, text, reqCode, snooze);
        try {
            if (AlarmScheduler.canExact(c)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
    }

    private static void cancel(Context c, String id) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        int rc = code(id);
        am.cancel(firePi(c, id, "", rc, false));
        am.cancel(firePi(c, id, "", rc + 1, true));
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        String action = intent.getAction() == null ? "" : intent.getAction();
        String id = intent.getStringExtra("id");
        String text = intent.getStringExtra("text");
        if (id == null) return;
        int rc = code(id);
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (action.startsWith(ACTION_SNOOZE)) {
            nm.cancel(rc);
            schedule(c, id, text, System.currentTimeMillis() + SNOOZE_MINUTES * 60_000L, rc + 1, true);
            return;
        }
        if (action.startsWith(ACTION_DONE)) {
            nm.cancel(rc);
            return;
        }
        // Fire: use the stored text in case it was edited, then set up the next repeat.
        JSONObject r = find(c, id);
        if (r == null && !intent.getBooleanExtra("snooze", false)) return; // deleted
        if (r != null) text = r.optString("text", text);
        show(c, id, text, rc);
        if (r != null && !intent.getBooleanExtra("snooze", false)) {
            long at = next(r, System.currentTimeMillis() + 1000);
            if (at > 0) schedule(c, id, r.optString("text"), at, rc, false);
        }
    }

    private static void show(Context c, String id, String text, int rc) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "การเตือนความจำ", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("การเตือนที่ตั้งไว้ในแอป");
            ch.enableVibration(true);
            nm.createNotificationChannel(ch);
        }
        PendingIntent snooze = PendingIntent.getBroadcast(c, rc + 2,
                new Intent(c, Reminders.class).setAction(ACTION_SNOOZE + "." + rc).putExtra("id", id).putExtra("text", text),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent done = PendingIntent.getBroadcast(c, rc + 3,
                new Intent(c, Reminders.class).setAction(ACTION_DONE + "." + rc).putExtra("id", id),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle("เตือนความจำ")
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setCategory(Notification.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setContentIntent(AiService.openApp(c, "remind"))
                .addAction(new Notification.Action.Builder(null, "เลื่อน " + SNOOZE_MINUTES + " นาที", snooze).build())
                .addAction(new Notification.Action.Builder(null, "เสร็จแล้ว", done).build())
                .build();
        try { nm.notify(rc, n); } catch (SecurityException ignored) {}
    }
}
