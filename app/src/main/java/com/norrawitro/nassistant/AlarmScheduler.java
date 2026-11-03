package com.norrawitro.nassistant;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import java.util.Calendar;

/** Keeps the morning and evening alarms scheduled with the system AlarmManager. */
public final class AlarmScheduler {
    public static final String KIND_MORNING = "morning";
    public static final String KIND_EVENING = "evening";
    private static final String PREFS = "alarms";

    private AlarmScheduler() {}

    public static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Saves the settings and (re)schedules both alarms. Times are "HH:MM"; empty or disabled clears. */
    public static void save(Context c, String morning, boolean morningOn, String evening, boolean eveningOn) {
        prefs(c).edit()
                .putString("morning", morning).putBoolean("morningOn", morningOn)
                .putString("evening", evening).putBoolean("eveningOn", eveningOn)
                .apply();
        rescheduleAll(c);
    }

    public static void rescheduleAll(Context c) {
        SharedPreferences p = prefs(c);
        schedule(c, KIND_MORNING, p.getString("morning", "06:30"), p.getBoolean("morningOn", false));
        schedule(c, KIND_EVENING, p.getString("evening", "19:30"), p.getBoolean("eveningOn", false));
    }

    /** Next trigger time in millis for an "HH:MM" string, or -1 if it cannot be parsed. */
    public static long nextTrigger(String hhmm) {
        if (hhmm == null) return -1;
        String[] parts = hhmm.split(":");
        if (parts.length != 2) return -1;
        int h, m;
        try {
            h = Integer.parseInt(parts[0].trim());
            m = Integer.parseInt(parts[1].trim());
        } catch (NumberFormatException e) {
            return -1;
        }
        if (h < 0 || h > 23 || m < 0 || m > 59) return -1;
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, h);
        cal.set(Calendar.MINUTE, m);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        if (cal.getTimeInMillis() <= System.currentTimeMillis() + 1000) cal.add(Calendar.DAY_OF_YEAR, 1);
        return cal.getTimeInMillis();
    }

    private static PendingIntent firePending(Context c, String kind) {
        Intent i = new Intent(c, AlarmReceiver.class).setAction("com.norrawitro.nassistant.ALARM." + kind)
                .putExtra("kind", kind);
        return PendingIntent.getBroadcast(c, KIND_MORNING.equals(kind) ? 1 : 2, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void schedule(Context c, String kind, String hhmm, boolean on) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        PendingIntent op = firePending(c, kind);
        am.cancel(op);
        long at = on ? nextTrigger(hhmm) : -1;
        if (at < 0) return;
        Intent show = new Intent(c, MainActivity.class).putExtra("ring", kind);
        PendingIntent showPi = PendingIntent.getActivity(c, 10, show,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, op);
            } else {
                am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, showPi), op);
            }
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, op);
        }
    }

    public static boolean canExact(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        return am.canScheduleExactAlarms();
    }
}
