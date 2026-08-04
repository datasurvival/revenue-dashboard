/**
 * config.js
 * -------------------------------------------------------------------------
 * ตั้งค่าการเชื่อมต่อของแดชบอร์ด — ไม่มี Google API Key และไม่มี Drive API
 * ฝั่ง Client อยู่ในไฟล์นี้เลย ปลอดภัยสำหรับ deploy ขึ้น GitHub Pages (public repo)
 * -------------------------------------------------------------------------
 */
const CONFIG = {
  // วาง URL ของ Google Apps Script Web App ที่ deploy แล้ว (ลงท้ายด้วย /exec)
  // ดูวิธีสร้างที่ README.md หัวข้อ "Deploy Apps Script"
  // ตัวอย่าง: "https://script.google.com/macros/s/AKfycbxXXXXXXXXXXXXXXXXXXXXXXXXXXXX/exec"
  API_URL: "https://script.google.com/macros/s/AKfycbybr_hu_SKbx0jqJB-ohe6fdKPsbY9T_kMkp6C7DRskNnOTljMlse768BGYQdXP5m_DlA/exec",

  // ความถี่ในการรีเฟรชข้อมูลอัตโนมัติจาก Google Drive (หน่วยเป็นนาที)
  AUTO_REFRESH_MINUTES: 15,

  // เปิด/ปิดแท็บ "อัปโหลดไฟล์สำรอง" (ทดสอบข้อมูลเพิ่มเติมด้วยตนเอง ไม่บันทึกถาวร)
  ENABLE_MANUAL_UPLOAD: true
};
