package com.norrawitro.nassistant;

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

/**
 * Arrive / leave events from GPS-Tracker (same signing key, signature permission). Keeps where the phone is now,
 * and shows the place reminders the owner set in N-assistant, e.g. "ออกจากบ้าน → อย่าลืมเติมน้ำมันรถ".
 * Place rules are JSON: [{id, text, place, when: "enter"|"leave", on}], saved from the page with setPlaceRules.
 */
public class PlaceEvents extends BroadcastReceiver {
    static final String PREFS = "place_link";
    private static final String CHANNEL = "place_reminder_v1";

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static void saveRules(Context c, String json) { prefs(c).edit().putString("rules", json == null ? "[]" : json).apply(); }

    /** {place, at, lat, lng, type, places:[...], tracking} for the page and the quick bot. */
    static String where(Context c) {
        SharedPreferences p = prefs(c);
        try {
            JSONObject o = new JSONObject();
            o.put("place", p.getString("place", ""));
            o.put("at", p.getLong("at", 0));
            o.put("lat", Double.longBitsToDouble(p.getLong("lat", 0)));
            o.put("lng", Double.longBitsToDouble(p.getLong("lng", 0)));
            o.put("type", p.getString("type", ""));
            o.put("since", p.getLong("since", 0));
            o.put("places", new JSONArray(p.getString("places", "[]")));
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    @Override
    public void onReceive(Context c, Intent i) {
        String type = String.valueOf(i.getStringExtra("type"));
        String place = i.getStringExtra("place") == null ? "" : i.getStringExtra("place");
        long at = i.getLongExtra("at", System.currentTimeMillis());
        SharedPreferences.Editor e = prefs(c).edit()
                .putString("type", type).putLong("at", at)
                .putLong("lat", Double.doubleToRawLongBits(i.getDoubleExtra("lat", 0)))
                .putLong("lng", Double.doubleToRawLongBits(i.getDoubleExtra("lng", 0)));
        String names = i.getStringExtra("places");
        if (names != null) e.putString("places", names);
        String before = prefs(c).getString("place", "");
        if ("stopped".equals(type)) e.putString("place", "");
        else if ("enter".equals(type) || "leave".equals(type) || "fix".equals(type)) {
            String now = "leave".equals(type) ? "" : place;
            if (!now.equals(before)) e.putLong("since", at);
            e.putString("place", now);
        }
        e.apply();

        if ("enter".equals(type) || "leave".equals(type)) fire(c, type, place);
        MainActivity.placeEvent(where(c));
    }

    /** Shows every rule that matches this arrive / leave. Place names match ignoring case and spaces. */
    private static void fire(Context c, String when, String place) {
        try {
            JSONArray rules = new JSONArray(prefs(c).getString("rules", "[]"));
            for (int k = 0; k < rules.length(); k++) {
                JSONObject r = rules.getJSONObject(k);
                if (!r.optBoolean("on", true) || !when.equals(r.optString("when"))) continue;
                if (!norm(r.optString("place")).equals(norm(place))) continue;
                notify(c, r.optString("id"), ("leave".equals(when) ? "ออกจาก" : "ถึง") + place, r.optString("text"));
            }
        } catch (Exception ignored) {}
    }

    private static String norm(String s) { return String.valueOf(s).replaceAll("\\s+", "").toLowerCase(); }

    private static void notify(Context c, String id, String title, String text) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "เตือนตามสถานที่", NotificationManager.IMPORTANCE_HIGH));
        }
        PendingIntent open = PendingIntent.getActivity(c, 70 + Math.abs(id.hashCode() % 1000),
                new Intent(c, MainActivity.class).putExtra("tab", "remind").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setContentIntent(open)
                .build();
        try { nm.notify(5000 + Math.abs(id.hashCode() % 10000), n); } catch (SecurityException ignored) {}
    }
}
