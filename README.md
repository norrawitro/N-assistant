# N-assistant

แอป Android ผู้ช่วยประจำวัน ปลุกตอนเช้า ให้ Claude ช่วยวางแผนวัน ถามอัปเดตตอนเย็น บันทึกข้อมูลไว้ในเครื่อง และส่งออกเป็นไฟล์ได้

## ทำอะไรได้บ้าง

- **ปลุกตอนเช้าและตอนเย็น** ด้วยระบบนาฬิกาปลุกของ Android ดังแม้ปิดแอปหรือล็อกจออยู่ เปิดเครื่องใหม่ก็ยังตั้งไว้ให้
- **Morning Beep** กรอกงานวันนี้ เรื่องที่กังวล และระดับพลังงาน แล้ว Claude จะสรุปเป้าหลัก งานที่ต้องทำ สิ่งที่ควรระวัง และแผนตามเวลา โดยดูงานค้างจากวันก่อน ๆ ด้วย
- **อัปเดตตอนเย็น** ติ๊กงานที่ทำเสร็จ บันทึกเรื่องที่เกิดขึ้น อารมณ์ และงานที่ยกไปพรุ่งนี้ แล้วขอสรุปสั้น ๆ จาก Claude
- **ส่งออกไฟล์** เป็น CSV (Excel/Google Sheets), Markdown หรือ JSON เลือกโฟลเดอร์เก็บได้ และนำเข้าไฟล์ JSON กลับมาได้
- **อัปเดต OTA** แอปตรวจหาเวอร์ชันใหม่จาก GitHub Releases ของรีโปนี้วันละครั้ง กดอัปเดตแล้วติดตั้งทับได้เลย ข้อมูลเดิมยังอยู่

## ตั้งค่าครั้งแรก (ทำครั้งเดียว)

Android จะยอมให้อัปเดตทับได้เฉพาะ APK ที่เซ็นด้วยกุญแจเดียวกันทุกครั้ง กุญแจนี้ต้องเก็บเป็นความลับ จึงเก็บไว้ใน GitHub Secrets ไม่ได้อยู่ในโค้ด

ไปที่ **Settings > Secrets and variables > Actions > New repository secret** ของรีโปนี้ แล้วเพิ่ม 2 ค่า

| ชื่อ | ค่า |
|---|---|
| `SIGNING_KEYSTORE_BASE64` | ไฟล์ keystore ที่แปลงเป็น base64 |
| `SIGNING_STORE_PASSWORD` | รหัสผ่านของ keystore |

ถ้าจะสร้างกุญแจเอง ใช้คำสั่งนี้ (alias ต้องเป็น `nassistant`)

```bash
keytool -genkeypair -keystore release.keystore -alias nassistant -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 release.keystore   # คัดลอกผลลัพธ์ไปใส่ SIGNING_KEYSTORE_BASE64
```

เก็บไฟล์ keystore และรหัสผ่านสำรองไว้ที่ปลอดภัย ถ้าหาย จะออกอัปเดตทับแอปเดิมไม่ได้อีก ต้องถอนแอปแล้วติดตั้งใหม่

## ติดตั้งบนมือถือ

1. เปิดหน้า [Releases](https://github.com/norrawitro/n-assistant/releases/latest) บนมือถือ แล้วดาวน์โหลดไฟล์ `.apk`
2. เปิดไฟล์ ถ้า Android ถาม ให้อนุญาต "ติดตั้งแอปที่ไม่รู้จัก" สำหรับเบราว์เซอร์
3. เปิดแอป ไปที่แท็บ **ตั้งค่า** แล้วใส่
   - เวลาปลุกเช้าและเย็น
   - Claude API key (สร้างที่ [console.anthropic.com](https://console.anthropic.com)) ค่าใช้จ่ายคิดตามการใช้งานจริงในบัญชี API
4. อนุญาตการแจ้งเตือนเมื่อแอปขอ ไม่อย่างนั้นเสียงปลุกจะไม่ดัง

## ออกเวอร์ชันใหม่

ทุกครั้งที่มีการ push หรือ merge เข้า `main` GitHub Actions จะ build APK แล้วสร้าง Release ชื่อ `v1.0.<เลขรอบ>` ให้อัตโนมัติ แอปที่ติดตั้งอยู่จะเห็นเวอร์ชันใหม่และขึ้นแถบให้อัปเดต

Pull request จะ build APK ไว้ทดสอบด้วย (ดาวน์โหลดได้จากหน้า Actions ส่วน Artifacts) แต่ไม่สร้าง Release ถ้ายังไม่ได้ใส่ secrets ไฟล์ทดสอบจะเซ็นด้วยกุญแจชั่วคราว ติดตั้งได้แต่อัปเดตทับกันไม่ได้

## โครงสร้าง

- `app/src/main/assets/www/` หน้าตาแอป (HTML/CSS/JS) ที่แสดงใน WebView
- `app/src/main/java/.../MainActivity.java` WebView และสะพานเชื่อมให้หน้าเว็บเรียกฟังก์ชันของเครื่อง
- `AlarmScheduler.java`, `AlarmReceiver.java`, `BootReceiver.java` ระบบนาฬิกาปลุก
- `Updater.java` ตรวจและดาวน์โหลดเวอร์ชันใหม่จาก GitHub Releases
- `.github/workflows/android.yml` build APK และออก Release
