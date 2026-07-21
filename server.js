const express = require('express');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT, OAuth2Client } = require('google-auth-library');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

const GOOGLE_CLIENT_ID = '329337408769-4omaa4c4877335iv5thus8npk64bjbag.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));

// API 頻率限制（防刷單）
const grabLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: "⚠️ 請求過於頻繁，請稍微等待後再試！" }
});

const MEMBER_SPREADSHEET_ID = '1j-KMHvmPIuIziymLE_85G6gCbrZyHzj9CgQeevjels0';
const SIGNUP_SPREADSHEET_ID = '1Mr87l1_sfIYkcArtj2ev9PkTYjN-zthzB44v1guH2cI';

const sessions = [
  { id: "tue", name: "週二匹克球團", day: 2, limit: 40, waitlistLimit: 20 },
  { id: "thu", name: "週四匹克球團", day: 4, limit: 40, waitlistLimit: 20 },
  { id: "sat", name: "週六匹克球團", day: 6, limit: 40, waitlistLimit: 20 }
];

const seatsCache = { tue: 40, thu: 40, sat: 40 };
const waitlistCache = { tue: 0, thu: 0, sat: 0 };
const registeredEmails = { tue: new Set(), thu: new Set(), sat: new Set() };

async function getGoogleDoc(spreadsheetId) {
  let creds;
  if (process.env.GOOGLE_JSON_KEY) {
    creds = JSON.parse(process.env.GOOGLE_JSON_KEY);
  } else {
    creds = require('./google-key.json');
  }

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

// 🔍 搜尋會員資料庫：檢查是否為會員
async function checkMemberStatus(userEmail) {
  try {
    const doc = await getGoogleDoc(MEMBER_SPREADSHEET_ID);
    const memberSheet = doc.sheetsByTitle['會員名單'] || doc.sheetsByIndex[0];
    
    const rows = await memberSheet.getRows();
    const found = rows.find(row => {
      const emailInSheet = row.get('Gmail 帳號') || row.get('Email') || '';
      return emailInSheet.trim().toLowerCase() === userEmail.trim().toLowerCase();
    });

    if (found) {
      return {
        isMember: true,
        name: found.get('姓名') || found.get('姓名/暱稱') || '已登記會員'
      };
    } else {
      return {
        isMember: false,
        name: '非會員 / 未登記'
      };
    }
  } catch (err) {
    console.error('❌ 查詢會員資料庫失敗：', err.message);
    return { isMember: false, name: '查無姓名' };
  }
}

async function saveToGoogleSheet(dateStr, userEmail, userName, status) {
  try {
    const doc = await getGoogleDoc(SIGNUP_SPREADSHEET_ID);
    
    let sheet = doc.sheetsByTitle[dateStr];
    if (!sheet) {
      sheet = await doc.addSheet({ 
        title: dateStr, 
        headerValues: ['報名時間', '姓名/暱稱', 'Gmail 帳號', '報名狀態'] 
      });
    }

    const nowStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    await sheet.addRow({
      '報名時間': nowStr,
      '姓名/暱稱': userName,
      'Gmail 帳號': userEmail,
      '報名狀態': status
    });

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

const writeQueue = [];
let isProcessingQueue = false;

async function processQueue() {
  if (isProcessingQueue || writeQueue.length === 0) return;
  isProcessingQueue = true;

  const task = writeQueue.shift();
  try {
    await saveToGoogleSheet(task.dateStr, task.cleanEmail, task.userName, task.statusText);
  } catch (err) {
    console.error('❌ 寫入佇列處理失敗：', err.message);
  }

  setTimeout(() => {
    isProcessingQueue = false;
    processQueue();
  }, 300);
}

function getSessionTargetDateObj(dayOfWeekTarget) {
  const today = new Date();
  const dayOfWeek = today.getDay();
  let daysUntil = (dayOfWeekTarget - dayOfWeek + 7) % 7;
  if (daysUntil === 0) daysUntil = 7;
  
  const nextDate = new Date(today);
  nextDate.setDate(today.getDate() + daysUntil);
  return nextDate;
}

function formatDateStr(dateObj) {
  return `${dateObj.getFullYear()}-${dateObj.getMonth() + 1}-${dateObj.getDate()}`;
}

// API: 取得當前場次與動態時間解鎖狀態
app.get('/api/sessions', (req, res) => {
  const now = new Date();

  const result = sessions.map(s => {
    const targetDateObj = getSessionTargetDateObj(s.day);
    const dateStr = formatDateStr(targetDateObj);
    const displayDate = `${targetDateObj.getMonth() + 1}/${targetDateObj.getDate()}`;

    // 💡 設定會員開放時間：球敘前一天的 18:00 (晚上 6 點)
    const memberOpenTime = new Date(targetDateObj);
    memberOpenTime.setDate(targetDateObj.getDate() - 1);
    memberOpenTime.setHours(18, 0, 0, 0);

    // 只要到了 18:00 就對外解鎖（因為會員可以點擊了）
    const isOpen = now >= memberOpenTime;

    const openMonth = memberOpenTime.getMonth() + 1;
    const openDay = memberOpenTime.getDate();
    const openTimeStr = `${openMonth}/${openDay} 18:00`;

    return {
      ...s,
      dateStr: dateStr,
      displayDate: displayDate,
      isOpen: isOpen,
      openTimeStr: openTimeStr,
      remainingSeats: seatsCache[s.id],
      waitlistCount: waitlistCache[s.id]
    };
  });
  res.json(result);
});

// API: 搶位與候補接口（含階梯式時間權限驗證）
app.post('/api/grab', grabLimiter, async (req, res) => {
  const { sessionId, token } = req.body;

  if (!sessionId || !token) {
    return res.status(400).json({ success: false, message: "無效的請求參數！" });
  }

  // 1. 驗證 Google Token
  let userEmail = '';
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    userEmail = payload.email;
  } catch (err) {
    return res.status(401).json({ success: false, message: "❌ 會員身份驗證失敗，請重新登入！" });
  }

  const cleanEmail = userEmail.trim().toLowerCase();
  const targetSession = sessions.find(s => s.id === sessionId);

  if (!targetSession) {
    return res.status(400).json({ success: false, message: "❌ 找不到指定場次！" });
  }

  const targetDateObj = getSessionTargetDateObj(targetSession.day);
  const dateStr = formatDateStr(targetDateObj);

  // ⏰ 2. 計算關鍵時間點
  const now = new Date();

  // 會員開放時間：前一天 18:00
  const memberOpenTime = new Date(targetDateObj);
  memberOpenTime.setDate(targetDateObj.getDate() - 1);
  memberOpenTime.setHours(18, 0, 0, 0);

  // 非會員開放時間：前一天 22:00
  const nonMemberOpenTime = new Date(targetDateObj);
  nonMemberOpenTime.setDate(targetDateObj.getDate() - 1);
  nonMemberOpenTime.setHours(22, 0, 0, 0);

  // 檢查是否已到會員開放時間
  if (now < memberOpenTime) {
    return res.json({ success: false, message: "🔒 此場次尚未開放報名！" });
  }

  // 檢查會員資格
  const memberStatus = await checkMemberStatus(cleanEmail);

  // 如果時間在「18:00 ~ 22:00 之間」且「不是會員」，則拒絕
  if (now < nonMemberOpenTime && !memberStatus.isMember) {
    return res.json({ 
      success: false, 
      message: `🔒 18:00 ~ 22:00 為會員專屬報名時段！非會員請於晚上 22:00 後再試。` 
    });
  }

  // 3. 防重複報名檢查
  if (registeredEmails[sessionId] && registeredEmails[sessionId].has(cleanEmail)) {
    return res.json({ success: false, message: "❌ 您已經報名過此場次囉！請勿重複送出。" });
  }

  let statusText = '';
  let isSuccess = false;
  let resMessage = '';

  // 4. 正取 / 候補邏輯
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

  // 5. 非同步排隊寫入 Google Sheet
  writeQueue.push({ dateStr, cleanEmail, userName: memberStatus.name, statusText });
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