const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000; // 支援 Render 環境變數的 PORT

app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));

// 💡 1. Google Sheet ID (後續連動套件時使用)
const SPREADSHEET_ID = '1j-KMHvmPIuIziymLE_85G6gCbrZyHzj9CgQeevjels0';

// 💡 2. 球敘場次設定 (2: 週二, 4: 週四, 6: 週六)
const sessions = [
  { id: "tue", name: "週二匹克球團", day: 2, limit: 40, waitlistLimit: 20 },
  { id: "thu", name: "週四匹克球團", day: 4, limit: 40, waitlistLimit: 20 },
  { id: "sat", name: "週六匹克球團", day: 6, limit: 40, waitlistLimit: 20 }
];

// 記憶體暫存剩餘名額 (40位正取)
const seatsCache = {
  tue: 40,
  thu: 40,
  sat: 40
};

// 記憶體暫存候補序號 (預設從 0 開始累加)
const waitlistCache = {
  tue: 0,
  thu: 0,
  sat: 0
};

// 防重紀錄：記錄各場次已報名的 Email (結構如: { tue: Set(['a@gmail.com']), thu: Set() })
const registeredEmails = {
  tue: new Set(),
  thu: new Set(),
  sat: new Set()
};

// 報名成功紀錄表 (存放正取與候補的完整名冊)
const registrations = [];

// 檢查場次是否已開放 (活動前一天 18:00 後開放)
function checkIsOpen(targetDateStr) {
  const now = new Date();
  const eventDate = new Date(targetDateStr);
  const openTime = new Date(eventDate);
  openTime.setDate(eventDate.getDate() - 1);
  openTime.setHours(18, 0, 0, 0);

  return {
    isOpen: true, // 👈 測試模式：強制開放全場次
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
      remainingSeats: seatsCache[s.id],
      waitlistCount: waitlistCache[s.id]
    };
  });

  res.json(result);
});

// API: 高併發搶位與候補接口
app.post('/api/grab', (req, res) => {
  const { sessionId, userEmail } = req.body;

  if (!sessionId || !userEmail) {
    return res.status(400).json({ success: false, message: "缺少必要參數！" });
  }

  // 整理 Email 格式（轉小寫與去空格，避免重複報名漏網之魚）
  const cleanEmail = userEmail.trim().toLowerCase();

  // 1. 防重檢查：同一個 Gmail 在同一個場次只能填寫一次
  if (registeredEmails[sessionId] && registeredEmails[sessionId].has(cleanEmail)) {
    return res.json({ 
      success: false, 
      message: "❌ 您已經報名過此場次囉！請勿重複送出。" 
    });
  }

  const targetSession = sessions.find(s => s.id === sessionId);

  // 2. 判斷是否還有正取名額
  if (seatsCache[sessionId] > 0) {
    // 扣減正取名額
    seatsCache[sessionId] -= 1;
    
    // 標記該 Email 已經報名
    registeredEmails[sessionId].add(cleanEmail);

    // 寫入報名紀錄
    registrations.push({
      sessionId,
      userEmail: cleanEmail,
      type: '正取',
      timestamp: new Date().toISOString()
    });

    console.log(`🎉 搶位成功(正取)！會員: ${cleanEmail}, 剩餘正取: ${seatsCache[sessionId]}`);

    return res.json({
      success: true,
      status: 'REGULAR',
      message: "🎉 搶位成功！已為您保留正取名額！",
      remainingSeats: seatsCache[sessionId]
    });
  } 
  
  // 3. 正取已滿，判斷是否還能候補
  else if (waitlistCache[sessionId] < targetSession.waitlistLimit) {
    // 增加候補序號
    waitlistCache[sessionId] += 1;
    const waitlistNo = waitlistCache[sessionId];

    // 標記該 Email 已經報名
    registeredEmails[sessionId].add(cleanEmail);

    // 寫入報名紀錄
    registrations.push({
      sessionId,
      userEmail: cleanEmail,
      type: `候補第 ${waitlistNo} 位`,
      timestamp: new Date().toISOString()
    });

    console.log(`⚠️ 正取已滿，轉候補！會員: ${cleanEmail}, 候補順序: ${waitlistNo}`);

    return res.json({
      success: true,
      status: 'WAITLIST',
      message: `⚠️ 正取已滿！已成功為您登記為【候補第 ${waitlistNo} 位】！`,
      waitlistNo: waitlistNo
    });
  } 
  
  // 4. 正取與候補皆已滿額
  else {
    return res.json({ 
      success: false, 
      message: "❌ 額滿了！正取與候補名額皆已售罄，下週請早！" 
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 匹克球搶位伺服器已成功啟動！`);
  console.log(`🔗 伺服器通訊埠：${PORT}`);
});