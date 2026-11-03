package com.norrawitro.nassistant;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;

/** Fires at the alarm time: shows a ringing full-screen notification and schedules tomorrow's alarm. */
public class AlarmReceiver extends BroadcastReceiver {
    public static final String CHANNEL = "alarm_ring_v1";
    public static final int NOTIF_ID = 4242;

    @Override
    public void onReceive(Context c, Intent intent) {
        String kind = intent.getStringExtra("kind");
        if (kind == null) kind = AlarmScheduler.KIND_MORNING;
        if (AlarmScheduler.KIND_PREP.equals(kind)) {
            AiService.startPrep(c);
            AlarmScheduler.rescheduleAll(c);
            return;
        }
        ring(c, kind);
        AlarmScheduler.rescheduleAll(c);
    }

    public static void ensureChannel(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "นาฬิกาปลุก", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("เสียงปลุกตอนเช้าและการถามอัปเดตตอนเย็น");
        Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (sound == null) sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        ch.setSound(sound, new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        ch.enableVibration(true);
        ch.setVibrationPattern(new long[]{0, 600, 400, 600, 400});
        ch.setBypassDnd(true);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
    }

    public static void ring(Context c, String kind) {
        ensureChannel(c);
        boolean evening = AlarmScheduler.KIND_EVENING.equals(kind);
        Intent open = new Intent(c, MainActivity.class)
                .putExtra("ring", kind)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(c, evening ? 22 : 21, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stopPi = PendingIntent.getBroadcast(c, 30, new Intent(c, StopAlarmReceiver.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = new Notification.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle(evening ? "เย็นแล้ว วันนี้เป็นยังไงบ้าง" : "อรุณสวัสดิ์ ได้เวลาวางแผนวันนี้")
                .setContentText(evening ? "แตะเพื่อบันทึกอัปเดตวันนี้"
                        : AiService.preparedToday(c) ? "แผนวันนี้เตรียมไว้ให้แล้ว แตะเพื่อดู" : "แตะเพื่อดู Morning Beep ของวันนี้")
                .setCategory(Notification.CATEGORY_ALARM)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(true)
                .setContentIntent(openPi)
                .setFullScreenIntent(openPi, true)
                .setTimeoutAfter(3 * 60 * 1000)
                .addAction(new Notification.Action.Builder(null, "หยุด", stopPi).build());
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT; // keep repeating the sound until stopped
        try {
            c.getSystemService(NotificationManager.class).notify(NOTIF_ID, n);
        } catch (SecurityException ignored) {
            // Notifications permission was denied; nothing else we can show while the app is closed.
        }
    }

    public static void stop(Context c) {
        c.getSystemService(NotificationManager.class).cancel(NOTIF_ID);
    }
}
