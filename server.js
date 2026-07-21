const express = require('express');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT, OAuth2Client } = require('google-auth-library');
const rateLimit = require('express-rate-limit');

// 💡 強制指定 Node.js 環境時區為 Asia/Taipei (UTC+8)
process.env.TZ = 'Asia/Taipei';

const app = express();
const PORT = process.env.PORT || 3000;

const GOOGLE_CLIENT_ID = '329337408769-4omaa4c4877335iv5thus8npk64bjbag.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

app.use(express.json());
app.use(express.static(path.join(__dirname, '/')));

// API 頻率限制
const grabLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: "⚠️ 請求過於頻繁，請稍微等待後再試！" }
});

const MEMBER_SPREADSHEET_ID = '1j-KMHvmPIuIziymLE_85G6gCbrZyHzj9CgQeevjels0';
const SIGNUP_SPREADSHEET_ID = '1Mr87l1_sfIYkcArtj2ev9PkTYjN-zthzB44v1guH2cI';

const sessions = [
  { id: "tue", name: "週二匹克球團", day: 2, limit: 36, waitlistLimit: 30 },
  { id: "wed", name: "週三匹克球團", day: 3, limit: 2, waitlistLimit: 4 },
  { id: "thu", name: "週四匹克球團", day: 4, limit: 36, waitlistLimit: 30 },
  { id: "sat", name: "週六匹克球團", day: 6, limit: 36, waitlistLimit: 30 }
];

const seatsCache = { tue: 36, wed: 2, thu: 36, sat: 36 };
const waitlistCache = { tue: 0, wed: 0, thu: 0, sat: 0 };
const registeredEmails = { tue: new Set(), wed: new Set(), thu: new Set(), sat: new Set() };

// ⚡ 快取機制
let memberListCache = [];
let lastMemberFetchTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 快取有效時間：10 分鐘

// 🛠️ 精準計算 UTC+8 當前時間
function getAsiaTaipeiNow() {
  const now = new Date();
  const utc8Time = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  return utc8Time;
}

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

async function getMemberList() {
  const now = Date.now();
  if (memberListCache.length > 0 && (now - lastMemberFetchTime < CACHE_TTL)) {
    return memberListCache;
  }

  try {
    console.log("🔄 向 Google Sheets 更新會員名單中...");
    const doc = await getGoogleDoc(MEMBER_SPREADSHEET_ID);
    const memberSheet = doc.sheetsByTitle['會員名單'] || doc.sheetsByIndex[0];
    const rows = await memberSheet.getRows();

    memberListCache = rows.map(row => ({
      email: (row.get('Gmail 帳號') || row.get('Email') || '').trim().toLowerCase(),
      name: row.get('姓名') || row.get('姓名/暱稱') || '已登記會員'
    }));

    lastMemberFetchTime = now;
    console.log(`✅ 會員名單更新成功，共 ${memberListCache.length} 筆會員。`);
    return memberListCache;
  } catch (err) {
    console.error('❌ 讀取會員資料庫失敗：', err.message);
    return memberListCache;
  }
}

async function checkMemberStatus(userEmail) {
  const cleanEmail = userEmail.trim().toLowerCase();
  const members = await getMemberList();
  
  const found = members.find(m => m.email === cleanEmail);

  if (found) {
    return { isMember: true, name: found.name };
  } else {
    return { isMember: false, name: '非會員 / 未登記' };
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
  const today = getAsiaTaipeiNow();
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

// API: 取得當前場次
app.get('/api/sessions', async (req, res) => {
  const now = getAsiaTaipeiNow();
  const token = req.query.token;

  let isMember = false;

  if (token) {
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: token,
        audience: GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      const memberStatus = await checkMemberStatus(payload.email);
      isMember = memberStatus.isMember;
    } catch (e) {
      isMember = false;
    }
  }

  const result = sessions.map(s => {
    const targetDateObj = getSessionTargetDateObj(s.day);
    const dateStr = formatDateStr(targetDateObj);
    const displayDate = `${targetDateObj.getMonth() + 1}/${targetDateObj.getDate()}`;

    // 開放日期：前一天
    const openDate = new Date(targetDateObj);
    openDate.setDate(targetDateObj.getDate() - 1);

    // 強制以 UTC+8 建立 18:00 與 22:00 物件
    const memberOpenTime = new Date(openDate.getFullYear(), openDate.getMonth(), openDate.getDate(), 18, 0, 0);
    const nonMemberOpenTime = new Date(openDate.getFullYear(), openDate.getMonth(), openDate.getDate(), 22, 0, 0);

    const userOpenTime = isMember ? memberOpenTime : nonMemberOpenTime;
    
    // 比對精準毫秒時間戳
    const isOpen = now.getTime() >= userOpenTime.getTime();

    const openMonth = openDate.getMonth() + 1;
    const openDay = openDate.getDate();
    const openHour = isMember ? "18:00" : "22:00";
    const openTimeStr = `${openMonth}/${openDay} ${openHour}`;

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

// API: 搶位與候補接口
app.post('/api/grab', grabLimiter, async (req, res) => {
  const { sessionId, token } = req.body;

  if (!sessionId || !token) {
    return res.status(400).json({ success: false, message: "無效的請求參數！" });
  }

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

  const now = getAsiaTaipeiNow();

  const openDate = new Date(targetDateObj);
  openDate.setDate(targetDateObj.getDate() - 1);

  const memberOpenTime = new Date(openDate.getFullYear(), openDate.getMonth(), openDate.getDate(), 18, 0, 0);
  const nonMemberOpenTime = new Date(openDate.getFullYear(), openDate.getMonth(), openDate.getDate(), 22, 0, 0);

  if (now.getTime() < memberOpenTime.getTime()) {
    return res.json({ success: false, message: "🔒 此場次尚未開放報名！" });
  }

  const memberStatus = await checkMemberStatus(cleanEmail);

  if (now.getTime() < nonMemberOpenTime.getTime() && !memberStatus.isMember) {
    return res.json({ 
      success: false, 
      message: `🔒 18:00 ~ 22:00 為會員專屬報名時段！非會員請於晚上 22:00 後再試。` 
    });
  }

  if (registeredEmails[sessionId] && registeredEmails[sessionId].has(cleanEmail)) {
    return res.json({ success: false, message: "❌ 您已經報名過此場次囉！請勿重複送出。" });
  }

  let statusText = '';
  let isSuccess = false;
  let resMessage = '';

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
  getMemberList();
});