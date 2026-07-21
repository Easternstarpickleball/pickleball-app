const express = require('express');
const path = require('path');
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));

// 💡 1. 請把這裡替換成你的 Google Sheet ID
const SPREADSHEET_ID = '1j-KMHvmPIuIziymLE_85G6gCbrZyHzj9CgQeevjels0';

// 💡 2. 球敘場次設定 (2: 週二, 4: 週四, 6: 週六)
const sessions = [
  { id: "tue", name: "週二匹克球團", day: 2, limit: 40 },
  { id: "thu", name: "週四匹克球團", day: 4, limit: 40 },
  { id: "sat", name: "週六匹克球團", day: 6, limit: 40 }
];

// 記憶體暫存名額 (確保每秒處理 200 筆不超賣)
const seatsCache = {
  tue: 40,
  thu: 40,
  sat: 40
};

// 檢查場次是否已開放 (活動前一天 18:00 後開放)
function checkIsOpen(targetDateStr) {
  const now = new Date();
  const eventDate = new Date(targetDateStr);
  const openTime = new Date(eventDate);
  openTime.setDate(eventDate.getDate() - 1);
  openTime.setHours(18, 0, 0, 0);

  return {
    isOpen: true, // 👈 改成 true (測試模式：強制開放全場次)
    openTimeStr: `${openTime.getMonth() + 1}/${openTime.getDate()} 18:00`
  };
}

// API: 取得當前所有場次狀態
app.get('/api/sessions', (req, res) => {
  const today = new Date();
  
  const result = sessions.map(s => {
    const dayOfWeek = today.getDay();
    let daysUntil = (s.day - dayOfWeek + 7) % 7;
    if (daysUntil === 0) daysUntil = 7;
    
    const nextDate = new Date(today);
    nextDate.setDate(today.getDate() + daysUntil);
    const dateStr = `${nextDate.getFullYear()}-${nextDate.getMonth() + 1}-${nextDate.getDate()}`;
    const displayDate = `${nextDate.getMonth() + 1}/${nextDate.getDate()}`;

    const status = checkIsOpen(dateStr);

    return {
      ...s,
      dateStr: dateStr,
      displayDate: displayDate,
      isOpen: status.isOpen,
      openTimeStr: status.openTimeStr,
      remainingSeats: seatsCache[s.id]
    };
  });

  res.json(result);
});

// API: 高併發秒搶接口 (0.001 秒極速扣量)
app.post('/api/grab', (req, res) => {
  const { sessionId, userEmail } = req.body;

  if (!sessionId || !userEmail) {
    return res.status(400).json({ success: false, message: "缺少必要參數！" });
  }

  // 1. 檢查剩餘名額
  if (seatsCache[sessionId] <= 0) {
    return res.json({ success: false, message: "❌ 額滿了！下週請早！" });
  }

  // 2. 扣減名額 (記憶體原子操作，絕不超賣)
  seatsCache[sessionId] -= 1;

  console.log(`🎉 搶位成功！會員: ${userEmail}, 剩餘名額: ${seatsCache[sessionId]}`);

  // 3. 回傳成功狀態
  res.json({
    success: true,
    message: "🎉 搶位成功！已為您保留名額！",
    remainingSeats: seatsCache[sessionId]
  });
});

app.listen(PORT, () => {
  console.log(`🚀 匹克球搶位伺服器已成功啟動！`);
  console.log(`🔗 請在瀏覽器打開：http://127.0.0.1:${PORT}`);
});