const express = require('express');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT, OAuth2Client } = require('google-auth-library');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// 設定 Google OAuth 驗證客戶端
const GOOGLE_CLIENT_ID = '329337408769-4omaa4c4877335iv5thus8npk64bjbag.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));

// API 頻率限制：防範惡意腳本與自動刷單（限制每個 IP 1 分鐘內最多 10 次搶位）
const grabLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: "⚠️ 請求過於頻繁，請稍微等待後再試！" }
});

// 💡 1. 設定兩個獨立的 Google 試算表 ID
const MEMBER_SPREADSHEET_ID = '1j-KMHvmPIuIziymLE_85G6gCbrZyHzj9CgQeevjels0'; // 只用來讀取姓名
const SIGNUP_SPREADSHEET_ID = '1Mr87l1_sfIYkcArtj2ev9PkTYjN-zthzB44v1guH2cI'; // 用來建立日期分頁與寫入報名

// 💡 2. 球敘場次設定
const sessions = [
  { id: "tue", name: "週二匹克球團", day: 2, limit: 36, waitlistLimit: 30 },
  { id: "thu", name: "週四匹克球團", day: 4, limit: 36, waitlistLimit: 30 },
  { id: "sat", name: "週六匹克球團", day: 6, limit: 36, waitlistLimit: 30 }
];

// 記憶體快取名額與候補
const seatsCache = { tue: 36, thu: 36, sat: 36 };
const waitlistCache = { tue: 0, thu: 0, sat: 0 };
const registeredEmails = { tue: new Set(), thu: new Set(), sat: new Set() };

// 🔑 取得指定的 Google 試算表物件
async function getGoogleDoc(spreadsheetId) {
  let creds;
  if (process.env.GOOGLE_JSON_KEY) {
    console.log("✅ 成功讀取 Render 環境變數 GOOGLE_JSON_KEY");
    creds = JSON.parse(process.env.GOOGLE_JSON_KEY);
  } else {
    creds = require('./google-key.json');
  }

  // 處理 private_key 裡面的換行符號
  const privateKey = creds.private_key.replace(/\\n/g, '\n');

  const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);
  await doc.loadInfo();
  return doc;
}

// 🔍 輔助函式：從【會員資料庫試算表】搜尋姓名
async function findNameByEmail(userEmail) {
  try {
    const doc = await getGoogleDoc(MEMBER_SPREADSHEET_ID);
    const memberSheet = doc.sheetsByTitle['會員名單'] || doc.sheetsByIndex[0]; // 預設拿第一個分頁
    
    const rows = await memberSheet.getRows();
    const found = rows.find(row => {
      const emailInSheet = row.get('Gmail 帳號') || row.get('Email') || '';
      return emailInSheet.trim().toLowerCase() === userEmail.trim().toLowerCase();
    });

    if (found) {
      return found.get('姓名') || found.get('姓名/暱稱') || '已登記會員';
    } else {
      return '非會員 / 未登記';
    }
  } catch (err) {
    console.error('❌ 查詢會員資料庫失敗：', err.message);
    return '查無姓名';
  }
}

// 📊 試算表寫入邏輯：自動新建日期分頁並寫入【球敘報名總表】
async function saveToGoogleSheet(dateStr, userEmail, status) {
  try {
    // 1. 先去第一個試算表查姓名
    const userName = await findNameByEmail(userEmail);

    // 2. 開啟第二個試算表（報名總表）
    const doc = await getGoogleDoc(SIGNUP_SPREADSHEET_ID);
    
    // 3. 檢查是否已有該日期的分頁，若無則新建
    let sheet = doc.sheetsByTitle[dateStr];
    if (!sheet) {
      sheet = await doc.addSheet({ 
        title: dateStr, 
        headerValues: ['報名時間', '姓名/暱稱', 'Gmail 帳號', '報名狀態'] 
      });
    }

    // 4. 寫入報名資料
    const nowStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    await sheet.addRow({
      '報名時間': nowStr,
      '姓名/暱稱': userName,
      'Gmail 帳號': userEmail,
      '報名狀態': status
    });

    // 5. 管理分頁：永遠只顯示「最新 2 次」的分頁，自動隱藏舊分頁
    const allSheets = doc.sheetsByIndex;
    const dateSheets = allSheets
      .filter(s => /^\d{4}-\d{1,2}-\d{1,2}$/.test(s.title))
      .sort((a, b) => new Date(b.title) - new Date(a.title));

    for (let i = 0; i < dateSheets.length; i++) {
      if (i >= 2) {
        await dateSheets[i].updateProperties({ hidden: true });
      } else {
        await dateSheets[i].updateProperties({ hidden: false });
      }
    }
  } catch (err) {
    console.error('❌ 寫入報名試算表失敗：', err.message);
  }
}

// ⏳ 高並發防護：非同步寫入佇列 (Queue)，防止觸發 Google API 寫入限制 (429 Too Many Requests)
const writeQueue = [];
let isProcessingQueue = false;

async function processQueue() {
  if (isProcessingQueue || writeQueue.length === 0) return;
  isProcessingQueue = true;

  const task = writeQueue.shift();
  try {
    await saveToGoogleSheet(task.dateStr, task.cleanEmail, task.statusText);
  } catch (err) {
    console.error('❌ 寫入佇列處理失敗：', err.message);
  }

  // 設定 300ms 間隔，防止並發寫入破壞 API 限額
  setTimeout(() => {
    isProcessingQueue = false;
    processQueue();
  }, 300);
}

// 計算活動日期的輔助函式
function getSessionTargetDate(dayOfWeekTarget) {
  const today = new Date();
  const dayOfWeek = today.getDay();
  let daysUntil = (dayOfWeekTarget - dayOfWeek + 7) % 7;
  if (daysUntil === 0) daysUntil = 7;
  
  const nextDate = new Date(today);
  nextDate.setDate(today.getDate() + daysUntil);
  return `${nextDate.getFullYear()}-${nextDate.getMonth() + 1}-${nextDate.getDate()}`;
}

// API: 取得當前場次與名額狀態
app.get('/api/sessions', (req, res) => {
  const result = sessions.map(s => {
    const dateStr = getSessionTargetDate(s.day);
    const dateParts = dateStr.split('-');
    const displayDate = `${dateParts[1]}/${dateParts[2]}`;

    return {
      ...s,
      dateStr: dateStr,
      displayDate: displayDate,
      isOpen: true,
      remainingSeats: seatsCache[s.id],
      waitlistCount: waitlistCache[s.id]
    };
  });
  res.json(result);
});

// API: 搶位與候補接口（加入 Rate Limit 與安全驗證）
app.post('/api/grab', grabLimiter, async (req, res) => {
  const { sessionId, token } = req.body;

  if (!sessionId || !token) {
    return res.status(400).json({ success: false, message: "無效的請求參數！" });
  }

  // 1. 安全優化：後端驗證 Google ID Token，防止前端偽造 Email
  let userEmail = '';
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    userEmail = payload.email;
  } catch (err) {
    return res.status(401).json({ success: false, message: "❌ 會員身份驗證失敗或過期，請重新登入！" });
  }

  const cleanEmail = userEmail.trim().toLowerCase();
  const targetSession = sessions.find(s => s.id === sessionId);

  if (!targetSession) {
    return res.status(400).json({ success: false, message: "❌ 找不到指定場次！" });
  }

  const dateStr = getSessionTargetDate(targetSession.day);

  // 2. 防重複報名檢查
  if (registeredEmails[sessionId] && registeredEmails[sessionId].has(cleanEmail)) {
    return res.json({ success: false, message: "❌ 您已經報名過此場次囉！請勿重複送出。" });
  }

  let statusText = '';
  let isSuccess = false;
  let resMessage = '';

  // 3. 判斷正取或候補
  if (seatsCache[sessionId] > 0) {
    seatsCache[sessionId] -= 1;
    registeredEmails[sessionId].add(cleanEmail);
    statusText = '正取';
    resMessage = "🎉 搶位成功！已為您保留正取名額！";
    isSuccess = true;
  } else if (waitlistCache[sessionId] < targetSession.waitlistLimit) {
    waitlistCache[sessionId] += 1;
    registeredEmails[sessionId].add(cleanEmail);
    statusText = `候補第 ${waitlistCache[sessionId]} 位`;
    resMessage = `⚠️ 正取已滿！已成功為您登記為【候補第 ${waitlistCache[sessionId]} 位】！`;
    isSuccess = true;
  } else {
    return res.json({ success: false, message: "❌ 額滿了！正取與候補名額皆已售罄！" });
  }

  // 4. 推入寫入佇列處理（非同步排隊寫入 Google Sheet）
  writeQueue.push({ dateStr, cleanEmail, statusText });
  processQueue();

  res.json({ 
    success: isSuccess, 
    message: resMessage,
    remainingSeats: seatsCache[sessionId],
    waitlistCount: waitlistCache[sessionId]
  });
});

app.listen(PORT, () => {
  console.log(`🚀 匹克球搶位伺服器已成功啟動！通訊埠：${PORT}`);
});