// ================================================================
//  MLBB Matchmaking & Betting — server.js  (v5)
//  New in v3:
//    • Deposit system (KBZ / Wave Pay) with admin notifications
//    • schedule_time on matches
//    • is_banned / ban_reason on users
//    • transactions table
//    • Result-upload conversational state machine (screenshot→video→serial)
//    • Admin: /admin → web_app button → Telegram ID verify (like TikTok)
//    • Admin REST API: deposits, users, match resolution
//    • Match state machine: pending→active→verifying→done / cancelled
// ================================================================

"use strict";

require("dotenv").config();

const express     = require("express");
const cors        = require("cors");
const initSqlJs   = require("sql.js");
const fs          = require("fs");
const path        = require("path");
const crypto      = require("crypto");
const TelegramBot = require("node-telegram-bot-api");
const { nanoid }  = require("nanoid");

// ─── Config ──────────────────────────────────────────────────
const PORT         = process.env.PORT         || 3000;
const BOT_TOKEN    = process.env.BOT_TOKEN    || "";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://mlbbfrontend.vercel.app";
// ADMIN_URL kept for reference but button now uses FRONTEND_URL/admin.html to avoid routing issues
const ADMIN_URL    = process.env.ADMIN_URL    || `${FRONTEND_URL}/admin.html`;
const NODE_ENV     = process.env.NODE_ENV     || "development";
const DB_PATH      = path.join(__dirname, "mlbb.db");
const ADMIN_ID     = process.env.ADMIN_ID     || "";          // Admin Telegram user ID

if (!BOT_TOKEN) { console.error("[FATAL] BOT_TOKEN not set"); process.exit(1); }
if (!ADMIN_ID)  { console.warn("[WARN] ADMIN_ID not set — admin commands will not work"); }

// ─── Telegram Bot ─────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: NODE_ENV !== "production" });

// ─── Admin auth: Telegram ID verified against ADMIN_ID env var ─

// ─── Conversational Upload State Machine ─────────────────────
// Map<telegram_id, { step, screenshot_file_id, video_file_id }>
const uploadStates = new Map();

// ─── sql.js DB ────────────────────────────────────────────────
let db;

function saveDb() {
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
  catch (e) { console.error("[DB] Save error:", e.message); }
}

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
    console.log("[DB] Loaded from disk.");
  } else {
    db = new SQL.Database();
    console.log("[DB] Fresh database created.");
  }

  // ── Schema ──
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id  TEXT PRIMARY KEY,
      username     TEXT,
      balance      INTEGER NOT NULL DEFAULT 0,
      is_banned    INTEGER NOT NULL DEFAULT 0,
      ban_reason   TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS matches (
      id            TEXT PRIMARY KEY,
      serial_id     TEXT UNIQUE NOT NULL,
      creator_id    TEXT NOT NULL,
      joiner_id     TEXT,
      game_id       TEXT NOT NULL,
      game_name     TEXT NOT NULL,
      bet_amount    INTEGER NOT NULL,
      reward_amount INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      winner_id     TEXT,
      schedule_time TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id               TEXT PRIMARY KEY,
      telegram_id      TEXT NOT NULL,
      username         TEXT,
      method           TEXT NOT NULL,
      amount           INTEGER NOT NULL,
      sender_name      TEXT,
      sender_phone     TEXT,
      transaction_id   TEXT,
      transfer_time    TEXT,
      status           TEXT NOT NULL DEFAULT 'pending',
      reject_reason    TEXT,
      created_at       TEXT DEFAULT (datetime('now')),
      updated_at       TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Migrate existing DBs: add new columns if missing ──
  const alterCmds = [
    "ALTER TABLE users   ADD COLUMN is_banned  INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users   ADD COLUMN ban_reason TEXT",
    "ALTER TABLE matches ADD COLUMN schedule_time TEXT",
  ];
  for (const cmd of alterCmds) {
    try { db.run(cmd); } catch (_) { /* column already exists */ }
  }

  saveDb();
  console.log("[DB] Schema ready.");
}

// ─── DB Helpers ───────────────────────────────────────────────
function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function dbGet(sql, params = []) {
  const rows = dbAll(sql, params);
  return rows[0] || null;
}
function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// ─── Helpers ──────────────────────────────────────────────────
function generateSerial() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 8 }, () => c[Math.floor(Math.random() * c.length)]).join("");
}

async function broadcastToAll(message) {
  const users = dbAll("SELECT telegram_id FROM users WHERE is_banned = 0");
  const res   = await Promise.allSettled(
    users.map(u => bot.sendMessage(u.telegram_id, message, { parse_mode: "HTML" }))
  );
  console.log(`[Broadcast] ${res.filter(r => r.status === "fulfilled").length}/${users.length} delivered.`);
}

function isAdmin(req, res, next) {
  const aid = parseInt(req.headers["x-admin-id"] || req.query.adminId);
  const adminIdNum = parseInt(ADMIN_ID);
  if (!aid || isNaN(adminIdNum) || aid !== adminIdNum) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (next) return next();
  return true;
}

// ─── Express ──────────────────────────────────────────────────
const app = express();
app.use(cors({
  origin: "*", // lock down in production if needed
  methods: ["GET","POST","PUT","DELETE"],
}));
app.use(express.json());

// ================================================================
//  PUBLIC ROUTES
// ================================================================

app.get("/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// ── Admin identity verification (called by admin.html on load) ──
app.post("/api/admin/verify", (req, res) => {
  try {
    const { telegramId } = req.body;
    if (!telegramId) return res.status(400).json({ error: "telegramId required" });
    const tid = parseInt(telegramId);
    const adminIdNum = parseInt(ADMIN_ID);
    if (!ADMIN_ID || isNaN(adminIdNum) || tid !== adminIdNum) {
      return res.status(403).json({ error: "Admin မဟုတ်ပါ" });
    }
    res.json({ ok: true, adminId: tid });
  } catch(e) { res.status(500).json({ error: "Server error" }); }
});

// ── POST /api/users/register ───────────────────────────────────
app.post("/api/users/register", (req, res) => {
  const { telegram_id, username } = req.body;
  if (!telegram_id) return res.status(400).json({ error: "telegram_id required" });
  const tid = String(telegram_id);

  const existing = dbGet("SELECT * FROM users WHERE telegram_id = ?", [tid]);
  if (existing) {
    dbRun("UPDATE users SET username = ? WHERE telegram_id = ?", [username || "unknown", tid]);
    if (existing.is_banned) {
      return res.status(403).json({ error: "banned", ban_reason: existing.ban_reason });
    }
  } else {
    dbRun("INSERT INTO users (telegram_id, username, balance) VALUES (?, ?, 0)", [tid, username || "unknown"]);
  }

  const user = dbGet("SELECT * FROM users WHERE telegram_id = ?", [tid]);
  res.json({ success: true, user });
});

// ── GET /api/users/:telegram_id ────────────────────────────────
app.get("/api/users/:telegram_id", (req, res) => {
  const user = dbGet("SELECT * FROM users WHERE telegram_id = ?", [req.params.telegram_id]);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user });
});

// ── GET /api/matches ───────────────────────────────────────────
app.get("/api/matches", (_req, res) => {
  const matches = dbAll(`
    SELECT m.*, u.username AS creator_username
    FROM   matches m JOIN users u ON u.telegram_id = m.creator_id
    WHERE  m.status = 'pending'
    ORDER  BY m.created_at DESC
  `);
  res.json({ matches });
});

// ── GET /api/matches/history/:telegram_id ─────────────────────
app.get("/api/matches/history/:telegram_id", (req, res) => {
  const matches = dbAll(`
    SELECT m.*, 
           uc.username AS creator_username,
           uj.username AS joiner_username
    FROM   matches m
    LEFT JOIN users uc ON uc.telegram_id = m.creator_id
    LEFT JOIN users uj ON uj.telegram_id = m.joiner_id
    WHERE  m.creator_id = ? OR m.joiner_id = ?
    ORDER  BY m.created_at DESC LIMIT 50
  `, [req.params.telegram_id, req.params.telegram_id]);
  res.json({ matches });
});

// ── POST /api/matches/create ───────────────────────────────────
app.post("/api/matches/create", (req, res) => {
  const { telegram_id, game_id, game_name, bet_amount, schedule_time } = req.body;
  if (!telegram_id || !game_id || !game_name || !bet_amount)
    return res.status(400).json({ error: "Missing required fields" });

  const betAmt = parseInt(bet_amount, 10);
  if (isNaN(betAmt) || betAmt <= 0)   return res.status(400).json({ error: "Invalid bet amount" });
  if (!/^\d+$/.test(String(game_id))) return res.status(400).json({ error: "Game ID must be numeric" });

  const tid  = String(telegram_id);
  const user = dbGet("SELECT * FROM users WHERE telegram_id = ?", [tid]);
  if (!user)           return res.status(404).json({ error: "User not found" });
  if (user.is_banned)  return res.status(403).json({ error: "Your account is banned" });
  if (user.balance < betAmt)
    return res.status(400).json({ error: "Insufficient balance", balance: user.balance, required: betAmt });

  const rewardAmount = Math.floor(betAmt * 2 * 0.9);
  const matchId      = nanoid(16);
  const serialId     = generateSerial();

  try {
    dbRun("UPDATE users SET balance = balance - ? WHERE telegram_id = ? AND balance >= ?",
          [betAmt, tid, betAmt]);
    dbRun(`INSERT INTO matches (id, serial_id, creator_id, game_id, game_name, bet_amount, reward_amount, schedule_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [matchId, serialId, tid, String(game_id), String(game_name), betAmt, rewardAmount, schedule_time || null]);
  } catch (err) {
    console.error("[create match]", err);
    return res.status(500).json({ error: "Failed to create match" });
  }

  const schedText = schedule_time ? `\n⏰ ကစားမည့်အချိန် : ${schedule_time}` : "";
  broadcastToAll(
    `🎮 <b>Match အသစ် ဖန်တီးပြီ!</b>\n\n` +
    `🎯 Game ID   : <code>${game_id}</code>\n` +
    `📛 Game Name : ${game_name}\n` +
    `🆔 Serial    : <code>${serialId}</code>\n` +
    `💰 ကြေး      : ${betAmt.toLocaleString()} ကျပ်\n` +
    `🏆 ရရှိမည့်ငွေ : ${rewardAmount.toLocaleString()} ကျပ်${schedText}\n\n` +
    `👉 App ဖွင့်ပြီး ဝင်ကစားနိုင်ပါသည်!`
  ).catch(console.error);

  const updatedUser = dbGet("SELECT * FROM users WHERE telegram_id = ?", [tid]);
  res.json({
    success: true,
    match: { id: matchId, serial_id: serialId, bet_amount: betAmt, reward_amount: rewardAmount },
    new_balance: updatedUser.balance,
  });
});

// ── POST /api/matches/join ─────────────────────────────────────
app.post("/api/matches/join", (req, res) => {
  const { telegram_id, match_id } = req.body;
  if (!telegram_id || !match_id) return res.status(400).json({ error: "Missing fields" });

  const tid   = String(telegram_id);
  const user  = dbGet("SELECT * FROM users WHERE telegram_id = ?", [tid]);
  if (!user)          return res.status(404).json({ error: "User not found" });
  if (user.is_banned) return res.status(403).json({ error: "Your account is banned" });

  const match = dbGet("SELECT * FROM matches WHERE id = ?", [match_id]);
  if (!match)                     return res.status(404).json({ error: "Match not found" });
  if (match.status !== "pending") return res.status(400).json({ error: "Match is no longer available" });
  if (match.creator_id === tid)   return res.status(400).json({ error: "You cannot join your own match" });
  if (user.balance < match.bet_amount)
    return res.status(400).json({ error: "Insufficient balance to join", balance: user.balance });

  try {
    dbRun("UPDATE users SET balance = balance - ? WHERE telegram_id = ? AND balance >= ?",
          [match.bet_amount, tid, match.bet_amount]);
    dbRun(`UPDATE matches SET joiner_id = ?, status = 'active', updated_at = datetime('now')
           WHERE id = ? AND status = 'pending'`, [tid, match_id]);
  } catch (err) {
    console.error("[join match]", err);
    return res.status(500).json({ error: "Failed to join match" });
  }

  const joinerName = user.username || "someone";
  bot.sendMessage(match.creator_id,
    `⚔️ <b>Match ဝင်ပြီ!</b>\n🆔 ${match.serial_id}\n👤 @${joinerName} ဝင်ကစားပြီ!\n\n` +
    `🎮 ကစားပြီးဆုံးပါက Bot ထဲမှ Result Upload လုပ်ပါ။`,
    { parse_mode: "HTML" }
  ).catch(console.error);

  const updatedUser  = dbGet("SELECT * FROM users WHERE telegram_id = ?", [tid]);
  const updatedMatch = dbGet("SELECT * FROM matches WHERE id = ?", [match_id]);
  res.json({ success: true, match: updatedMatch, new_balance: updatedUser.balance });
});

// ── POST /api/matches/hide ─────────────────────────────────────
app.post("/api/matches/hide", (req, res) => {
  const { telegram_id, match_id } = req.body;
  if (!telegram_id || !match_id) return res.status(400).json({ error: "Missing fields" });

  const tid   = String(telegram_id);
  const match = dbGet("SELECT * FROM matches WHERE id = ?", [match_id]);
  if (!match)                     return res.status(404).json({ error: "Match not found" });
  if (match.creator_id !== tid)   return res.status(403).json({ error: "Not your match" });
  if (match.status !== "pending") return res.status(400).json({ error: "Only pending matches can be cancelled" });

  try {
    dbRun("UPDATE users SET balance = balance + ? WHERE telegram_id = ?", [match.bet_amount, tid]);
    dbRun(`UPDATE matches SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`, [match_id]);
  } catch (err) {
    return res.status(500).json({ error: "Failed to cancel match" });
  }

  const updatedUser = dbGet("SELECT * FROM users WHERE telegram_id = ?", [tid]);
  res.json({ success: true, new_balance: updatedUser.balance });
});

// ── POST /api/deposit ──────────────────────────────────────────
// User submits a deposit request
app.post("/api/deposit", (req, res) => {
  const { telegram_id, username, method, amount, sender_name,
          sender_phone, transaction_id, transfer_time } = req.body;

  if (!telegram_id || !method || !amount || !sender_name || !sender_phone || !transaction_id || !transfer_time)
    return res.status(400).json({ error: "All deposit fields are required" });

  const amt = parseInt(amount, 10);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: "Invalid amount" });

  const user = dbGet("SELECT * FROM users WHERE telegram_id = ?", [String(telegram_id)]);
  if (!user)          return res.status(404).json({ error: "User not found" });
  if (user.is_banned) return res.status(403).json({ error: "Banned" });

  const txId = nanoid(16);
  try {
    dbRun(`INSERT INTO transactions
           (id, telegram_id, username, method, amount, sender_name, sender_phone, transaction_id, transfer_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [txId, String(telegram_id), username || user.username, method, amt,
       sender_name, sender_phone, transaction_id, transfer_time]);
  } catch (err) {
    console.error("[deposit]", err);
    return res.status(500).json({ error: "Failed to save deposit" });
  }

  // Notify admin
  if (ADMIN_ID) {
    bot.sendMessage(ADMIN_ID,
      `💳 <b>Deposit Request</b>\n\n` +
      `👤 User     : @${username || user.username} (<code>${telegram_id}</code>)\n` +
      `🏦 Method   : ${method}\n` +
      `💰 Amount   : ${amt.toLocaleString()} ကျပ်\n` +
      `👤 Sender   : ${sender_name}\n` +
      `📱 Phone    : ${sender_phone}\n` +
      `🔖 TxID     : <code>${transaction_id}</code>\n` +
      `⏰ Time     : ${transfer_time}\n` +
      `🆔 Req ID   : <code>${txId}</code>\n\n` +
      `Admin Panel မှ Confirm/Reject လုပ်ပါ။`,
      { parse_mode: "HTML" }
    ).catch(console.error);
  }

  res.json({ success: true, tx_id: txId });
});

// ================================================================
//  ADMIN ROUTES  (require X-Admin-Secret header)
// ================================================================

// ── GET /api/admin/deposits ────────────────────────────────────
app.get("/api/admin/deposits", (req, res) => {
  if (!isAdmin(req, res)) return;
  const { status } = req.query;
  const where = status ? "WHERE t.status = ?" : "";
  const params = status ? [status] : [];
  const rows = dbAll(`SELECT * FROM transactions ${where} ORDER BY created_at DESC`, params);
  res.json({ deposits: rows });
});

// ── POST /api/admin/deposits/confirm ──────────────────────────
app.post("/api/admin/deposits/confirm", (req, res) => {
  if (!isAdmin(req, res)) return;
  const { tx_id } = req.body;
  const tx = dbGet("SELECT * FROM transactions WHERE id = ?", [tx_id]);
  if (!tx) return res.status(404).json({ error: "Transaction not found" });
  if (tx.status !== "pending") return res.status(400).json({ error: "Already processed" });

  try {
    dbRun("UPDATE transactions SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?", [tx_id]);
    dbRun("UPDATE users SET balance = balance + ? WHERE telegram_id = ?", [tx.amount, tx.telegram_id]);
  } catch (err) {
    return res.status(500).json({ error: "DB error" });
  }

  const updated = dbGet("SELECT * FROM users WHERE telegram_id = ?", [tx.telegram_id]);
  bot.sendMessage(tx.telegram_id,
    `✅ <b>Deposit အတည်ပြုပြီ!</b>\n\n` +
    `💰 ${tx.amount.toLocaleString()} ကျပ် ထည့်သွင်းပြီး\n` +
    `💼 လက်ကျန် : ${updated.balance.toLocaleString()} ကျပ်`,
    { parse_mode: "HTML" }
  ).catch(console.error);

  res.json({ success: true, new_balance: updated.balance });
});

// ── POST /api/admin/deposits/reject ───────────────────────────
app.post("/api/admin/deposits/reject", (req, res) => {
  if (!isAdmin(req, res)) return;
  const { tx_id, reason } = req.body;
  if (!reason) return res.status(400).json({ error: "Reason required" });

  const tx = dbGet("SELECT * FROM transactions WHERE id = ?", [tx_id]);
  if (!tx) return res.status(404).json({ error: "Transaction not found" });
  if (tx.status !== "pending") return res.status(400).json({ error: "Already processed" });

  dbRun("UPDATE transactions SET status = 'rejected', reject_reason = ?, updated_at = datetime('now') WHERE id = ?",
        [reason, tx_id]);

  bot.sendMessage(tx.telegram_id,
    `❌ <b>Deposit ငြင်းပယ်ခံရသည်</b>\n\n` +
    `💰 Amount : ${tx.amount.toLocaleString()} ကျပ်\n` +
    `📝 အကြောင်းပြချက် : ${reason}`,
    { parse_mode: "HTML" }
  ).catch(console.error);

  res.json({ success: true });
});

// ── GET /api/admin/users ───────────────────────────────────────
app.get("/api/admin/users", (req, res) => {
  if (!isAdmin(req, res)) return;
  const { q } = req.query;
  const users = q
    ? dbAll("SELECT * FROM users WHERE telegram_id LIKE ? OR username LIKE ? ORDER BY created_at DESC LIMIT 50",
            [`%${q}%`, `%${q}%`])
    : dbAll("SELECT * FROM users ORDER BY created_at DESC LIMIT 100");
  res.json({ users });
});

// ── POST /api/admin/users/balance ─────────────────────────────
app.post("/api/admin/users/balance", (req, res) => {
  if (!isAdmin(req, res)) return;
  const { telegram_id, amount, action } = req.body; // action: 'add' | 'deduct'
  const amt = parseInt(amount, 10);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: "Invalid amount" });

  const user = dbGet("SELECT * FROM users WHERE telegram_id = ?", [String(telegram_id)]);
  if (!user) return res.status(404).json({ error: "User not found" });

  if (action === "deduct") {
    if (user.balance < amt) return res.status(400).json({ error: "Insufficient balance to deduct" });
    dbRun("UPDATE users SET balance = balance - ? WHERE telegram_id = ?", [amt, String(telegram_id)]);
  } else {
    dbRun("UPDATE users SET balance = balance + ? WHERE telegram_id = ?", [amt, String(telegram_id)]);
  }

  const updated = dbGet("SELECT * FROM users WHERE telegram_id = ?", [String(telegram_id)]);
  const verb = action === "deduct" ? "နုတ်ပြီး" : "ထည့်ပြီး";
  bot.sendMessage(telegram_id,
    `💼 <b>Admin မှ Balance ${verb}:</b>\n` +
    `${action === "deduct" ? "−" : "+"}${amt.toLocaleString()} ကျပ်\n` +
    `လက်ကျန် : ${updated.balance.toLocaleString()} ကျပ်`,
    { parse_mode: "HTML" }
  ).catch(console.error);

  res.json({ success: true, new_balance: updated.balance });
});

// ── POST /api/admin/users/ban ──────────────────────────────────
app.post("/api/admin/users/ban", (req, res) => {
  if (!isAdmin(req, res)) return;
  const { telegram_id, reason } = req.body;
  if (!reason) return res.status(400).json({ error: "Ban reason required" });

  const user = dbGet("SELECT * FROM users WHERE telegram_id = ?", [String(telegram_id)]);
  if (!user) return res.status(404).json({ error: "User not found" });

  dbRun("UPDATE users SET is_banned = 1, ban_reason = ? WHERE telegram_id = ?",
        [reason, String(telegram_id)]);

  bot.sendMessage(telegram_id,
    `🚫 <b>သင်၏ Account ပိတ်ဆို့ခံရသည်</b>\n📝 အကြောင်းပြချက် : ${reason}`,
    { parse_mode: "HTML" }
  ).catch(console.error);

  res.json({ success: true });
});

// ── POST /api/admin/users/unban ────────────────────────────────
app.post("/api/admin/users/unban", (req, res) => {
  if (!isAdmin(req, res)) return;
  const { telegram_id } = req.body;

  dbRun("UPDATE users SET is_banned = 0, ban_reason = NULL WHERE telegram_id = ?", [String(telegram_id)]);

  bot.sendMessage(telegram_id,
    `✅ <b>သင်၏ Account ပြန်ဖွင့်ပေးပြီ</b>\nဆက်လက်ကစားနိုင်ပါပြီ!`,
    { parse_mode: "HTML" }
  ).catch(console.error);

  res.json({ success: true });
});

// ── GET /api/admin/matches ─────────────────────────────────────
app.get("/api/admin/matches", (req, res) => {
  if (!isAdmin(req, res)) return;
  const { status } = req.query;
  const where = status ? "WHERE m.status = ?" : "";
  const params = status ? [status] : [];
  const matches = dbAll(`
    SELECT m.*,
           uc.username AS creator_username,
           uj.username AS joiner_username
    FROM   matches m
    LEFT JOIN users uc ON uc.telegram_id = m.creator_id
    LEFT JOIN users uj ON uj.telegram_id = m.joiner_id
    ${where}
    ORDER BY m.created_at DESC LIMIT 100
  `, params);
  res.json({ matches });
});

// ── POST /api/admin/matches/resolve ───────────────────────────
app.post("/api/admin/matches/resolve", (req, res) => {
  if (!isAdmin(req, res)) return;
  const { serial_id, winner_telegram_id } = req.body;
  if (!serial_id || !winner_telegram_id)
    return res.status(400).json({ error: "serial_id and winner_telegram_id required" });

  const match = dbGet("SELECT * FROM matches WHERE serial_id = ?", [serial_id]);
  if (!match) return res.status(404).json({ error: "Match not found" });
  if (!["active","verifying"].includes(match.status))
    return res.status(400).json({ error: "Match cannot be resolved in current state: " + match.status });

  const wid = String(winner_telegram_id);
  if (wid !== match.creator_id && wid !== match.joiner_id)
    return res.status(400).json({ error: "Winner must be creator or joiner" });

  try {
    dbRun("UPDATE users SET balance = balance + ? WHERE telegram_id = ?",
          [match.reward_amount, wid]);
    dbRun(`UPDATE matches SET status = 'done', winner_id = ?, updated_at = datetime('now')
           WHERE id = ?`, [wid, match.id]);
  } catch (err) {
    return res.status(500).json({ error: "DB error during resolution" });
  }

  const winner = dbGet("SELECT * FROM users WHERE telegram_id = ?", [wid]);
  const loserId = wid === match.creator_id ? match.joiner_id : match.creator_id;

  bot.sendMessage(wid,
    `🏆 <b>ကိုယ်တော် နိုင်သည်!</b>\n\n` +
    `🆔 Match : <code>${match.serial_id}</code>\n` +
    `🏆 ရရှိငွေ : ${match.reward_amount.toLocaleString()} ကျပ် ထည့်ပြီး\n` +
    `💼 လက်ကျန် : ${winner.balance.toLocaleString()} ကျပ်`,
    { parse_mode: "HTML" }
  ).catch(console.error);

  if (loserId) {
    bot.sendMessage(loserId,
      `💔 <b>ဤပွဲ ရှုံးပါသည်</b>\n🆔 Match : <code>${match.serial_id}</code>\n\nပြန်ကစားရန် App ကိုဖွင့်ပါ။`,
      { parse_mode: "HTML" }
    ).catch(console.error);
  }

  res.json({ success: true, reward_sent: match.reward_amount, to: wid });
});

// ================================================================
//  TELEGRAM BOT HANDLERS
// ================================================================

// ── /start ──────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId   = msg.chat.id;
  const userId   = String(msg.from.id);
  const username = msg.from.username || msg.from.first_name || "Player";

  const existing = dbGet("SELECT * FROM users WHERE telegram_id = ?", [userId]);
  if (existing) {
    if (existing.is_banned) {
      return bot.sendMessage(chatId,
        `🚫 သင်၏ Account ပိတ်ဆို့ခံရသည်\nအကြောင်းပြချက် : ${existing.ban_reason || "—"}`,
        { parse_mode: "HTML" }
      ).catch(console.error);
    }
    dbRun("UPDATE users SET username = ? WHERE telegram_id = ?", [username, userId]);
  } else {
    dbRun("INSERT INTO users (telegram_id, username, balance) VALUES (?, ?, 0)", [userId, username]);
  }

  try {
    await bot.sendMessage(chatId,
      `👋 မင်္ဂလာပါ <b>${username}</b>!\n\n🎮 <b>MLBB Matchmaking System</b>\n💰 Match ဖန်တီးပြီး ကြေးဆိုင်ကစားနိုင်သည်။\n📤 ပွဲပြီးဆုံးပါက /upload မှ Result တင်ပါ။`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🎮 ဂိမ်းကစားရန်", web_app: { url: FRONTEND_URL } },
          ]],
        },
      }
    );
  } catch (err) {
    console.error("[/start]", err.message);
  }
});

// ── /admin ───────────────────────────────────────────────────────
// Exact match only: /admin (not text containing "admin")
bot.onText(/^\/admin(@\w+)?$/, async (msg) => {
  const userId = msg.from.id;
  const adminIdNum = parseInt(ADMIN_ID);

  // Admin ID စစ်ဆေး — Admin မဟုတ်ရင် တိတ်ဆိတ်စွာ ignore
  if (!ADMIN_ID || isNaN(adminIdNum) || userId !== adminIdNum) {
    return; // Non-admin users get no response (no hint panel exists)
  }

  try {
    await bot.sendMessage(
      msg.chat.id,
      `🛡️ <b>Admin Panel</b>\n\nမင်္ဂလာပါ Admin!\n\nAdmin Panel သို့ဝင်ရောက်ရန် ↓`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🛡️ Admin Panel သို့ဝင်ရန်", web_app: { url: `${FRONTEND_URL}/admin.html` } }]
          ]
        }
      }
    );
  } catch (err) {
    console.error("[/admin]", err.message);
  }
});

// ── /upload — start result upload flow ──────────────────────────
bot.onText(/\/upload/, async (msg) => {
  const userId = String(msg.from.id);
  const user   = dbGet("SELECT * FROM users WHERE telegram_id = ?", [userId]);
  if (!user || user.is_banned) return;

  // Check if user has any active/verifying matches
  const activeMatch = dbGet(
    "SELECT * FROM matches WHERE (creator_id = ? OR joiner_id = ?) AND status = 'active' LIMIT 1",
    [userId, userId]
  );
  if (!activeMatch) {
    return bot.sendMessage(msg.chat.id,
      "ℹ️ လက်ရှိ Active Match မရှိပါ။\nMatch ကစားပြီးမှ /upload လုပ်ပါ။"
    ).catch(console.error);
  }

  uploadStates.set(userId, { step: "screenshot" });
  bot.sendMessage(msg.chat.id,
    `📸 <b>Result Upload</b>\n\nကျေးဇူးပြု၍ ပွဲပြီးဆုံးကြောင်း (နိုင်/ရှုံး) ပြသထားသော <b>Screenshot</b> ကို ပေးပို့ပါ။`,
    { parse_mode: "HTML" }
  ).catch(console.error);
});

// ── /cancel_upload ───────────────────────────────────────────────
bot.onText(/\/cancel_upload/, async (msg) => {
  uploadStates.delete(String(msg.from.id));
  bot.sendMessage(msg.chat.id, "❌ Upload ဖျက်သိမ်းပြီ").catch(console.error);
});

// ── Message handler (handles upload state machine + photo/video) ─
bot.on("message", async (msg) => {
  const userId = String(msg.from.id);
  const text   = msg.text || "";

  // Ignore commands — handled above
  if (text.startsWith("/")) return;

  const state = uploadStates.get(userId);

  // ── Upload state machine ──────────────────────────────────────
  if (state) {
    // STEP 1: Waiting for screenshot (photo)
    if (state.step === "screenshot") {
      if (!msg.photo && !msg.document) {
        return bot.sendMessage(msg.chat.id,
          "📸 Screenshot (ဓာတ်ပုံ) ပေးပို့ပါ။ (/cancel_upload နှိပ်ပြီး ဖျက်နိုင်သည်)"
        ).catch(console.error);
      }
      const fileId = msg.photo
        ? msg.photo[msg.photo.length - 1].file_id
        : msg.document.file_id;
      state.screenshot_file_id = fileId;
      state.step = "video";
      uploadStates.set(userId, state);
      return bot.sendMessage(msg.chat.id,
        `🎥 <b>Screen Recording</b>\n\nScreenshot အတုများကို ကာကွယ်ရန်အတွက်၊ Game ထဲမှ\n<b>Profile → History</b> သို့ဝင်ပြထားသော <b>(၁၀) စက္ကန့်စာ Screen Record Video</b> ကို ပေးပို့ပေးပါ။`,
        { parse_mode: "HTML" }
      ).catch(console.error);
    }

    // STEP 2: Waiting for video
    if (state.step === "video") {
      if (!msg.video && !msg.document) {
        return bot.sendMessage(msg.chat.id,
          "🎥 Video ဖိုင်ပေးပို့ပါ။ (/cancel_upload နှိပ်ပြီး ဖျက်နိုင်သည်)"
        ).catch(console.error);
      }
      const fileId = msg.video ? msg.video.file_id : msg.document.file_id;
      state.video_file_id = fileId;
      state.step = "serial";
      uploadStates.set(userId, state);
      return bot.sendMessage(msg.chat.id,
        `🔢 ကျေးဇူးပြု၍ သင်ကစားခဲ့သော Match ၏ <b>အမှတ်စဉ် (Serial ID)</b> ကို ရိုက်ထည့်ပါ။\n\nဥပမာ: <code>Ab3xY9Kq</code>`,
        { parse_mode: "HTML" }
      ).catch(console.error);
    }

    // STEP 3: Waiting for serial ID (text)
    if (state.step === "serial") {
      if (!text || text.length < 6) {
        return bot.sendMessage(msg.chat.id,
          "🔢 Serial ID ကို မှန်မှန်ကန်ကန် ရိုက်ထည့်ပါ။"
        ).catch(console.error);
      }

      const serialId = text.trim();
      const match    = dbGet("SELECT * FROM matches WHERE serial_id = ?", [serialId]);

      if (!match) {
        return bot.sendMessage(msg.chat.id,
          `❌ Serial ID <code>${serialId}</code> နှင့် Match မတွေ့ပါ။ ထပ်ကြိုးစားပါ။`,
          { parse_mode: "HTML" }
        ).catch(console.error);
      }

      if (match.creator_id !== userId && match.joiner_id !== userId) {
        return bot.sendMessage(msg.chat.id,
          "❌ သင် ဤ Match ၏ Player မဟုတ်ပါ။"
        ).catch(console.error);
      }

      // Update match to verifying
      try {
        dbRun(`UPDATE matches SET status = 'verifying', updated_at = datetime('now') WHERE id = ?`, [match.id]);
      } catch (err) {
        console.error("[upload serial]", err);
      }

      // Forward everything to admin
      if (ADMIN_ID) {
        const user = dbGet("SELECT * FROM users WHERE telegram_id = ?", [userId]);
        await bot.sendMessage(ADMIN_ID,
          `📥 <b>Result Upload</b>\n\n` +
          `👤 User     : @${user?.username || "unknown"} (<code>${userId}</code>)\n` +
          `🆔 Serial   : <code>${serialId}</code>\n` +
          `💰 ကြေး     : ${match.bet_amount.toLocaleString()} ကျပ်\n` +
          `🏆 ရရှိမည့်ငွေ : ${match.reward_amount.toLocaleString()} ကျပ်`,
          { parse_mode: "HTML" }
        ).catch(console.error);

        await bot.sendPhoto(ADMIN_ID, state.screenshot_file_id,
          { caption: `📸 Screenshot — Serial: ${serialId}` }
        ).catch(console.error);

        await bot.sendVideo(ADMIN_ID, state.video_file_id,
          { caption: `🎥 Screen Recording — Serial: ${serialId}` }
        ).catch(console.error);
      }

      uploadStates.delete(userId);

      return bot.sendMessage(msg.chat.id,
        `✅ <b>Result တင်ပြီ!</b>\n\n🆔 Match : <code>${serialId}</code>\n\nAdmin မှ စစ်ဆေးပြီး မကြာမီ ငွေထုတ်ပေးမည်ဖြစ်သည်။`,
        { parse_mode: "HTML" }
      ).catch(console.error);
    }
  }

  // Default fallback
  bot.sendMessage(msg.chat.id,
    `🎮 /start — App ဖွင့်ရန်\n📤 /upload — Result တင်ရန်\n❌ /cancel_upload — Upload ဖျက်ရန်`
  ).catch(console.error);
});

// ── Photo handler (catches photos sent outside of command flow) ──
bot.on("photo", (msg) => {
  // Handled inside message handler above via msg.photo check
});

// ================================================================
//  WEBHOOK (Production)
// ================================================================
if (NODE_ENV === "production") {
  const WEBHOOK_BASE = process.env.RENDER_EXTERNAL_URL || "https://mlbbbackend.onrender.com";
  app.post(`/bot${BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  bot.setWebHook(`${WEBHOOK_BASE}/bot${BOT_TOKEN}`)
    .then(() => console.log("[Bot] Webhook set ✓"))
    .catch(e => console.error("[Bot] Webhook error:", e.message));
}

// ================================================================
//  BOOT
// ================================================================
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════╗
  ║  MLBB Backend v3  —  port ${PORT}           ║
  ║  Mode   : ${NODE_ENV.padEnd(30)}║
  ║  Admin  : ${(ADMIN_ID || "NOT SET").padEnd(30)}║
  ╚══════════════════════════════════════════╝`);
  });
}).catch(err => {
  console.error("[FATAL] initDb failed:", err);
  process.exit(1);
});
