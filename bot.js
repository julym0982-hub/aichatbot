require("dotenv").config();
const { Telegraf } = require("telegraf");
const { TelegramClient, utils } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram/tl");
const { NewMessage } = require("telegram/events");
const { MongoClient, ObjectId } = require("mongodb");
const http = require("http");
const https = require("https");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID    = parseInt(process.env.API_ID);
const API_HASH  = process.env.API_HASH;
const ADMIN_ID  = parseInt(process.env.ADMIN_ID);
const MONGO_URI = process.env.MONGO_URI;
const GROQ_URL  = "https://api.groq.com/openai/v1/chat/completions";

const DEFAULT_PROMPT =
  "သင်ဟာ Telegram group ထဲမှာ သူငယ်ချင်းတွေနဲ့ စကားပြောနေတဲ့ ရိုးရိုးလူတစ်ယောက်ပါ။ " +
  "တခြားသူပြောတဲ့ စကားကို ဖတ်ပြီး ပေါက်ပေါက်ရှာရှာ၊ တစ်ခါတလေ ဟာသနည်းနည်းနဲ့ သာမန်ပြောစကားလို ပြန်ပြောပါ။ " +
  "စာတိုတိုပဲ (၁–၂ ကြောင်း) ရေးပါ။ ပုဒ်မ (။) ကော comma ကော မသုံးပါနဲ့၊ လူတွေ chat ရိုက်သလို ရေးပါ။ " +
  "တစ်ခါတလေမှ emoji တစ်ခုလောက် သုံးပါ။ တခြားသူပြောတဲ့ ဘာသာစကားအတိုင်း ပြန်ပါ။ " +
  "ပြန်စာကိုပဲ ရေးပါ၊ နာမည်၊ ကိုးကား၊ ရှင်းပြချက် မထည့်ပါနဲ့။";

// Admin က ပြင်လို့ရတဲ့ ဂဏန်း/switch setting များ (account တစ်ခုချင်း override ရ၊ မပြင်ရင် global default သုံး)
const PARAMS = [
  { k: "replyChance",  label: "💬 Group စာပြန်ဖြစ်နိုင်ခြေ %",      def: 50,  min: 0,   max: 100 },
  { k: "quoteChance",  label: "↩️ Reply-quote သုံးဖြစ်နိုင်ခြေ %",  def: 70,  min: 0,   max: 100 },
  { k: "reactChance",  label: "😀 Emoji reaction ဖြစ်နိုင်ခြေ %",   def: 8,   min: 0,   max: 100 },
  { k: "delayMin",     label: "⏱ ပြန်ချိန် အနည်းဆုံး (စက္ကန့်)",      def: 5,   min: 1,   max: 600 },
  { k: "delayMax",     label: "⏱ ပြန်ချိန် အများဆုံး (စက္ကန့်)",      def: 8,   min: 1,   max: 600 },
  { k: "gapMin",       label: "🧘 ကိုယ့်စာနှစ်ခုကြား အနည်းဆုံး (စက္ကန့်)", def: 10, min: 0,  max: 3600 },
  { k: "gapMax",       label: "🧘 ကိုယ့်စာနှစ်ခုကြား အများဆုံး (စက္ကန့်)", def: 25, min: 0,  max: 3600 },
  { k: "maxPerHour",   label: "🚦 GP တစ်ခုမှာ တစ်နာရီ အများဆုံးစာ",   def: 40,  min: 1,   max: 500 },
  { k: "historySize",  label: "🧠 မှတ်ထားမယ့် စာအရေအတွက်",          def: 12,  min: 2,   max: 40 },
  { k: "dmDelayMin", label: "📩 DM ပြန်ချိန် အနည်းဆုံး (စက္ကန့်)",  def: 1,   min: 0,   max: 120 },
  { k: "dmDelayMax", label: "📩 DM ပြန်ချိန် အများဆုံး (စက္ကန့်)",  def: 3,   min: 0,   max: 120 },
  { k: "markRead",   label: "✔✔ စာဖတ်ပြီး (seen) အမှတ်ပြမယ်",      def: 1,   bool: true },
  { k: "dmChance",     label: "📩 DM စာပြန်ဖြစ်နိုင်ခြေ %",          def: 100, min: 0,   max: 100 },
  { k: "temperature",  label: "🌡 AI temperature (0–2)",            def: 0.9, min: 0,   max: 2, float: true },
  { k: "maxTokens",    label: "📏 ပြန်စာ အရှည်ဆုံး (token)",          def: 250, min: 20,  max: 600 },
  { k: "stripPunct",   label: "✂️ ပုဒ်မ (။ ၊ .) ဖယ်မယ်",             def: 1,   bool: true },
];
const PARAM_BY_KEY = Object.fromEntries(PARAMS.map((p) => [p.k, p]));
const REACTIONS = ["👍", "❤", "🔥", "😁", "🎉", "👏"];

// ─── STATE ────────────────────────────────────────────────────────────────────
let db;
const S = { prompt: "", model: "llama-3.3-70b-versatile", notifyOn: true, groqKeys: [], defaults: {} }; // settings cache
const accCache = {};            // name → account doc
const clientPool = {};          // name → TelegramClient
const ownIds = new Set();       // ကိုယ့် account တွေရဲ့ user id (အချင်းချင်း မပြောအောင်)
const monitor = {};             // accName → Map(chatId → { link, entity, title })
const monitorBuilt = {};        // accName → last build ms
const entityCache = {};
const chats = {};               // `${acc}|${chatId}` → { buf, lastOwn, sent[], pending, fails, ownMsgIds:Set }
const keyState = {};            // groq key → { until, dead }
const lastKeyAlert = { t: 0 };
let awaiting = null;
let draft = null;

const bot = new Telegraf(BOT_TOKEN || "0:x");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label = "timeout") => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms))]);
const rnd = (a, b) => a + Math.random() * Math.max(0, b - a);
const short = (s, n = 40) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const clip = (s) => (s.length > 3900 ? s.slice(0, 3890) + "\n…" : s);
const btn = (text, data) => ({ text, callback_data: data });
const notify = (text, extra) => bot.telegram.sendMessage(ADMIN_ID, clip(text), extra);
const maskKey = (k) => (k.length > 12 ? `${k.slice(0, 7)}…${k.slice(-4)}` : "…" + k.slice(-3));

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e?.message || e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e?.message || e));

// ─── MONGODB ──────────────────────────────────────────────────────────────────
async function connectDB() {
  const c = new MongoClient(MONGO_URI);
  await c.connect();
  db = c.db("aiuserbot");
  console.log("✅ MongoDB connected!");
}
async function loadSettings() {
  const s = (await db.collection("settings").findOne({ _id: "main" })) || {};
  Object.assign(S, { prompt: s.prompt || "", model: s.model || S.model, notifyOn: s.notifyOn !== false, groqKeys: s.groqKeys || [], defaults: s.defaults || {} });
}
async function saveSettings(data) {
  Object.assign(S, data);
  await db.collection("settings").updateOne({ _id: "main" }, { $set: data }, { upsert: true });
}
const getAccounts = () => db.collection("accounts").find({}).sort({ addedAt: 1 }).toArray();
async function refreshAcc(name) {
  const a = await db.collection("accounts").findOne({ name });
  if (a) accCache[name] = a; else delete accCache[name];
  return a;
}
async function saveAccount(name, data) {
  await db.collection("accounts").updateOne({ name }, { $set: data }, { upsert: true });
  if ("gpLinks" in data) { delete monitor[name]; monitorBuilt[name] = 0; }
  const a = await refreshAcc(name);
  if (a && "gpLinks" in data && clientPool[name]) buildMonitor(name).catch(() => {});
  return a;
}
async function getAccById(id) {
  if (!ObjectId.isValid(id)) return null;
  const a = await db.collection("accounts").findOne({ _id: new ObjectId(id) });
  if (a) accCache[a.name] = a;
  return a;
}
const incStat = (name, field) => { try { db.collection("accounts").updateOne({ name }, { $inc: { [`stats.${field}`]: 1 } }).catch(() => {}); } catch (_) {} };

// ─── PARAMS ───────────────────────────────────────────────────────────────────
function P(acc, k) {
  const v = acc?.params?.[k] ?? S.defaults?.[k] ?? PARAM_BY_KEY[k].def;
  return v;
}
const fmtParam = (p, v) => (p.bool ? (v ? "🟢 ဖွင့်" : "⚪ ပိတ်") : String(v));

// ─── GROQ + KEY ROTATION ──────────────────────────────────────────────────────
function keyCandidates(acc) {
  const all = [...new Set([...(acc?.groqKeys || []), ...(S.groqKeys || [])])];
  const now = Date.now();
  return all.filter((k) => { const st = keyState[k]; return !st || (!st.dead && (st.until || 0) <= now); });
}
function keyStatus(k) {
  const st = keyState[k];
  if (!st) return "🟢";
  if (st.dead) return "❌ invalid";
  if ((st.until || 0) > Date.now()) return `⏳ ${Math.ceil((st.until - Date.now()) / 60000)}မိနစ်`;
  return "🟢";
}

// OpenAI-compatible chat completion; key တစ်ခု limit/ပျက်ရင် နောက်တစ်ခုကို အလိုအလျောက် ကူး
async function callGroq(acc, messages) {
  const cands = keyCandidates(acc);
  if (!cands.length) {
    if (Date.now() - lastKeyAlert.t > 10 * 60 * 1000) {
      lastKeyAlert.t = Date.now();
      notify(`⚠️ [${acc?.name}] သုံးလို့ရတဲ့ Groq API key မကျန်တော့ဘူး (အကုန် limit/invalid) — key အသစ်ထည့်ပါ`).catch(() => {});
    }
    return { error: "NO_KEY" };
  }
  let lastErr = "unknown";
  for (const key of cands) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: S.model, messages, temperature: Number(P(acc, "temperature")), max_tokens: Number(P(acc, "maxTokens")) }),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const j = await res.json();
        const text = j?.choices?.[0]?.message?.content;
        if (typeof text === "string") return { text, key };
        lastErr = "empty response"; continue;
      }
      let body = ""; try { body = await res.text(); } catch (_) {}
      lastErr = `${res.status} ${short(body, 120)}`;
      if (res.status === 429) {
        const ra = parseFloat(res.headers.get("retry-after"));
        const perDay = /per day|TPD|RPD/i.test(body);
        let ms = Number.isFinite(ra) ? ra * 1000 : perDay ? 3600e3 : 60e3;
        keyState[key] = { until: Date.now() + Math.min(Math.max(ms, 5000), 24 * 3600e3) };
        console.log(`groq: key ${maskKey(key)} limit (${perDay ? "daily" : "rate"}) → နောက် key ကူးမယ်`);
        continue;
      }
      if (res.status === 401 || res.status === 403) { keyState[key] = { dead: true }; console.log(`groq: key ${maskKey(key)} invalid`); continue; }
      if (res.status >= 500) { keyState[key] = { until: Date.now() + 10e3 }; continue; }
      return { error: lastErr }; // 400 (model/params မှား) — key ပြောင်းလည်း အလကား
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === "AbortError" ? "timeout" : e.message;
      keyState[key] = { until: Date.now() + 5e3 };
    }
  }
  return { error: lastErr };
}

// ─── REPLY CLEANUP & PROMPT BUILD ─────────────────────────────────────────────
function cleanReply(raw, strip, names = []) {
  let t = String(raw || "").trim();
  t = t.replace(/^["“”'`«]+|["“”'`»]+$/g, "").trim();
  for (const n of names.filter(Boolean)) {
    const re = new RegExp("^" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*[:：]\\s*", "i");
    t = t.replace(re, "");
  }
  if (strip) {
    t = t.replace(/[။၊]+/g, " ").replace(/\.{1,}(?=\s|$)/g, "").replace(/[ \t]{2,}/g, " ");
  }
  return t.trim();
}
const isSkip = (t) => /^\s*skip[.!]?\s*$/i.test(t || "");

const META_GROUP = (myName, direct) =>
  `\n\n[Rules] You are chatting as "${myName}" in a Telegram group. Output ONLY the message text you would send — no name prefix, no quotes, no explanations. ` +
  `Keep it short and natural like a real person typing. ` +
  (direct ? "Someone is talking directly to you, so you must answer (never output SKIP)." : "If there is nothing natural to say, output exactly: SKIP");
const META_DM = (myName) =>
  `\n\n[Rules] You are chatting privately as "${myName}". Output ONLY the message text you would send — no name prefix, no quotes. Keep it short and natural like a real person typing. The other person may send several short messages in a row: reply naturally to the newest message and do not repeat what you already said.`;

function systemPrompt(acc) { return (acc?.customPrompt || S.prompt || DEFAULT_PROMPT); }

function buildGroupMessages(acc, st, title, target, direct, myName) {
  const n = Number(P(acc, "historySize"));
  const transcript = st.buf.slice(-n).map((e) => `${e.own ? `${myName} (me)` : e.name}: ${e.text}`).join("\n");
  const user =
    `Group: ${title}\nRecent chat:\n${transcript}\n\n` +
    `Now reply to ${target.name}'s message: "${short(target.text, 300)}"\nWrite only your reply message.`;
  return [{ role: "system", content: systemPrompt(acc) + META_GROUP(myName, direct) }, { role: "user", content: user }];
}
function buildDmMessages(acc, st, myName, target) {
  const n = Number(P(acc, "historySize"));
  // ဒီ target စာအထိပဲ ယူ — နောက်ဆုံးစာက အမြဲ user ဖြစ်ရမယ် (မဟုတ်ရင် AI က ဗလာပြန်တတ်)
  let upto = st.buf;
  if (target?.id) { const idx = st.buf.findIndex((e) => !e.own && e.id === target.id); if (idx >= 0) upto = st.buf.slice(0, idx + 1); }
  const hist = upto.slice(-n).map((e) => ({ role: e.own ? "assistant" : "user", content: e.text }));
  if (!hist.length || hist[hist.length - 1].role !== "user") hist.push({ role: "user", content: target?.text || "..." });
  return [{ role: "system", content: systemPrompt(acc) + META_DM(myName) }, ...hist];
}

// ─── TELEGRAM CLIENTS ─────────────────────────────────────────────────────────
function parseLink(raw) {
  const s = String(raw).trim();
  let m = s.match(/(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)([\w-]+)/i);
  if (m) return { type: "invite", hash: m[1] };
  m = s.match(/(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,})/i);
  if (m) return { type: "public", username: m[1] };
  return null;
}
async function resolveEntity(accName, client, link) {
  const key = `${accName}|${link}`;
  if (entityCache[key]) return entityCache[key];
  const p = parseLink(link);
  if (!p) throw new Error("Link format မှားနေသည်");
  let entity;
  if (p.type === "invite") {
    const r = await client.invoke(new Api.messages.CheckChatInvite({ hash: p.hash }));
    if (r.className === "ChatInviteAlready" || r.className === "ChatInvitePeek") entity = r.chat;
    else throw new Error("ဒီ account က GP ထဲ join မလုပ်ရသေးပါ");
  } else entity = await client.getEntity(p.username);
  entityCache[key] = entity;
  return entity;
}
async function joinGroup(client, link) {
  const p = parseLink(link);
  if (!p) throw new Error("Link format မှားနေသည်");
  if (p.type === "invite") await client.invoke(new Api.messages.ImportChatInvite({ hash: p.hash }));
  else { const e = await client.getEntity(p.username); await client.invoke(new Api.channels.JoinChannel({ channel: e })); }
}
async function buildMonitor(accName) {
  const acc = accCache[accName], client = clientPool[accName];
  const map = new Map();
  monitorBuilt[accName] = Date.now();
  if (acc && client) {
    for (const link of acc.gpLinks || []) {
      try {
        const entity = await resolveEntity(accName, client, link);
        map.set(utils.getPeerId(entity).toString(), { link, entity, title: entity.title || link });
      } catch (_) {}
    }
  }
  monitor[accName] = map;
  console.log(`monitor[${accName}]: GP ${map.size}/${(acc?.gpLinks || []).length} resolve လုပ်နိုင်ပြီး`);
}

async function buildClient(sessionString, accName) {
  const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, {
    connectionRetries: 10, retryDelay: 2000, autoReconnect: true, requestRetries: 5,
    useWSS: process.env.TG_USE_WSS === "1", // port 443 WebSocket — TIMEOUT များရင် Render env မှာ TG_USE_WSS=1 ထည့်ကြည့်
  });
  await client.connect();
  let me;
  try { me = await client.getMe(); } catch (e) { try { await client.disconnect(); } catch (_) {} throw e; }
  if (me?.id) ownIds.add(me.id.toString());
  client._me = { id: me.id?.toString(), username: me.username || "", name: [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || "me" };
  try { await client.getDialogs({ limit: 200 }); } catch (e) { console.error(`getDialogs[${accName}]:`, e.message); }
  client.addEventHandler((event) => {
    onMessage(accName, event).catch((e) => console.error(`msg[${accName}]:`, e.message));
  }, new NewMessage({}));
  return client;
}
async function initAllClients() {
  for (const acc of await getAccounts()) {
    accCache[acc.name] = acc;
    if (clientPool[acc.name]) continue;
    try {
      clientPool[acc.name] = await buildClient(acc.sessionString, acc.name);
      console.log(`✅ Connected: ${acc.name}`);
      buildMonitor(acc.name).catch(() => {});
    } catch (e) { console.error(`❌ Failed: ${acc.name} — ${e.message}`); }
  }
}
async function reconnectAccount(acc) {
  if (clientPool[acc.name]) { try { await withTimeout(clientPool[acc.name].disconnect(), 10000, "DISCONNECT_TIMEOUT"); } catch (_) {} delete clientPool[acc.name]; }
  clientPool[acc.name] = await buildClient(acc.sessionString, acc.name);
  delete monitor[acc.name];
  buildMonitor(acc.name).catch(() => {});
}
const lastGroqAlert = {};
const pingFails = {};
function startHealthCheck() {
  setInterval(async () => {
    for (const acc of await getAccounts()) {
      const client = clientPool[acc.name];
      if (!client) continue;
      let alive = !!client.connected;
      if (alive) {
        try { await withTimeout(client.getMe(), 25000, "PING_TIMEOUT"); }
        catch (e) { alive = false; console.log(`healthcheck[${acc.name}]: ping မအောင်မြင် (${e.message})`); }
      }
      if (alive) { pingFails[acc.name] = 0; continue; }
      pingFails[acc.name] = (pingFails[acc.name] || 0) + 1;
      if (pingFails[acc.name] < 2) continue; // တစ်ခါလောက် နှေးတာနဲ့ reconnect မလုပ် — ဆက်တိုက် ၂ ကြိမ်မှ
      console.log(`healthcheck[${acc.name}]: reconnect လုပ်နေသည်`);
      try { await withTimeout(reconnectAccount(acc), 60000, "RECONNECT_TIMEOUT"); pingFails[acc.name] = 0; console.log(`healthcheck[${acc.name}]: reconnect အောင်မြင်`); }
      catch (e) { console.error(`healthcheck[${acc.name}]: ${e.message}`); }
    }
  }, 60 * 1000);
}

// ─── CHAT ENGINE ──────────────────────────────────────────────────────────────
const PERMANENT_ERR = /USER_BANNED_IN_CHANNEL|CHAT_WRITE_FORBIDDEN|CHANNEL_PRIVATE|USER_KICKED|CHAT_SEND_PLAIN_FORBIDDEN|CHAT_RESTRICTED|CHAT_GUEST_SEND_FORBIDDEN|USER_NOT_PARTICIPANT/;
const chatState = (accName, chatId) => (chats[`${accName}|${chatId}`] ||= { buf: [], lastOwn: 0, sent: [], pending: null, fails: 0, busyUntil: 0, ownMsgIds: new Set(), blockedUntil: 0, dmQueue: Promise.resolve() });
const displayName = (s) => (s ? ([s.firstName, s.lastName].filter(Boolean).join(" ") || s.title || s.username || "user") : "user");

function pushBuf(st, entry, accN) {
  st.buf.push(entry);
  const cap = Math.max(40, accN * 3);
  if (st.buf.length > cap) st.buf.splice(0, st.buf.length - cap);
}

async function onMessage(accName, event) {
  const acc = accCache[accName];
  const msg = event?.message;
  if (!acc || !msg || msg.out) return;
  let chatId; try { chatId = msg.chatId?.toString(); } catch (_) {}
  if (!chatId) return;
  const senderId = (() => { try { return msg.senderId?.toString(); } catch (_) { return null; } })();
  if (senderId && ownIds.has(senderId)) return;           // ကိုယ့် account တွေချင်း မပြောဘူး
  if (msg.date && Date.now() / 1000 - msg.date > 120) return;
  const text = (msg.message || "").trim();
  if (!text) return;

  let isPrivate = !!msg.isPrivate;
  try { if (!isPrivate && msg.peerId?.className === "PeerUser") isPrivate = true; } catch (_) {}
  let mon = null;
  if (!isPrivate) {
    if (msg.post) return; // channel broadcast
    if (!monitor[accName] || (!monitor[accName].get(chatId) && Date.now() - (monitorBuilt[accName] || 0) > 60000)) await buildMonitor(accName);
    mon = monitor[accName]?.get(chatId);
    if (!mon) return;
    if ((acc.blocked || []).includes(mon.link)) return;
  } else if (acc.dmOn === false) { console.log(`dm[${accName}]: DM ပိတ်ထား — ကျော်`); return; }

  let sender; try { sender = await msg.getSender(); } catch (_) {}
  if (sender?.bot) return;
  if (isPrivate && sender?.id?.toString() === "777000") return;
  const name = displayName(sender);
  const me = clientPool[accName]?._me || { username: "", name: "me" };

  const st = chatState(accName, chatId);
  const replyToId = msg.replyTo?.replyToMsgId;
  pushBuf(st, { id: msg.id, name, text: short(text, 500), own: false, ts: Date.now() }, Number(P(acc, "historySize")));
  if (isPrivate) console.log(`dm[${accName}]: 📨 ${short(name, 20)} — ${acc.active ? "ပြန်ဖို့ တန်းစီ" : "Stop ထားလို့ မပြန်"}`);
  if (!acc.active) return; // Stop ထားရင် မှတ်ပဲမှတ်၊ မပြောဘူး
  if (isPrivate && Number(P(acc, "markRead"))) markRead(accName, msg, 300 + Math.random() * 700); // ✔✔ seen

  const direct = isPrivate || (replyToId && st.ownMsgIds.has(replyToId)) ||
    (me.username && text.toLowerCase().includes("@" + me.username.toLowerCase()));
  const chance = isPrivate ? Number(P(acc, "dmChance")) : direct ? 100 : Number(P(acc, "replyChance"));

  let peer = mon?.entity;
  if (isPrivate) { try { peer = await msg.getInputChat(); } catch (_) { peer = msg.peerId; } }
  if (!peer) return;
  const target = { id: msg.id, name, text };
  const info = { accName, chatId, peer, title: mon?.title || name, isDm: isPrivate, link: mon?.link, target, direct: !!direct };

  if (Math.random() * 100 >= chance) {
    if (!isPrivate && Math.random() * 100 < Number(P(acc, "reactChance"))) scheduleReaction(info);
    return;
  }
  if (isPrivate) { // DM: စာတစ်ခုချင်းစီကို အမြဲပြန် (coalesce မလုပ်)၊ တစ်ခုပြီးမှ တစ်ခု အစဉ်လိုက်
    st.dmQueue = st.dmQueue.then(async () => {
      if (!accCache[accName]?.active) return;
      await sleep(rnd(Number(P(acc, "dmDelayMin")), Number(P(acc, "dmDelayMax"))) * 1000);
      await withTimeout(respond(info), 60000, "RESPOND_TIMEOUT");
    }).catch((e) => console.error(`dm[${accName}]:`, e.message));
    return;
  }
  schedule(info);
}

// စာဖတ်ပြီး (✔✔ seen) အမှတ်ပြ
function markRead(accName, msg, afterMs = 0) {
  setTimeout(async () => {
    try {
      const client = clientPool[accName];
      if (!client) return;
      const peer = await msg.getInputChat();
      await client.markAsRead(peer, msg.id, { clearMentions: true });
    } catch (e) { console.log(`markRead[${accName}]: ${e.message}`); }
  }, afterMs);
}

function schedule(info) {
  const acc = accCache[info.accName];
  const st = chatState(info.accName, info.chatId);
  if (st.pending) { // စောင့်နေတဲ့ ပြန်စာ ရှိပြီးသား — direct ဖြစ်လာရင်ပဲ target ကို အစားထိုး
    if (info.direct && !st.pending.info.direct) st.pending.info = info;
    return;
  }
  const now = Date.now();
  let delay = rnd(Number(P(acc, "delayMin")), Number(P(acc, "delayMax"))) * 1000;
  const gapWait = st.lastOwn + rnd(Number(P(acc, "gapMin")), Number(P(acc, "gapMax"))) * 1000 - now;
  if (!info.direct && gapWait > delay) delay = gapWait;
  if (st.blockedUntil > now + delay) delay = st.blockedUntil - now;
  const timer = setTimeout(() => { const p = st.pending; st.pending = null; if (p) respond(p.info).catch((e) => console.error(`respond[${info.accName}]:`, e.message)); }, delay);
  st.pending = { timer, info };
}
function clearPending(accName) {
  for (const [k, st] of Object.entries(chats)) if (k.startsWith(accName + "|") && st.pending) { clearTimeout(st.pending.timer); st.pending = null; }
}

function scheduleReaction(info) {
  const client = clientPool[info.accName];
  if (!client) return;
  setTimeout(async () => {
    try {
      const emoticon = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
      await client.invoke(new Api.messages.SendReaction({ peer: info.peer, msgId: info.target.id, reaction: [new Api.ReactionEmoji({ emoticon })] }));
      incStat(info.accName, "reacted");
    } catch (_) {}
  }, rnd(2000, 6000));
}

async function respond(info) {
  const { accName, chatId } = info;
  const acc = accCache[accName], client = clientPool[accName];
  if (!acc || !acc.active || !client) return;
  const st = chatState(accName, chatId);
  const me = client._me || { name: "me", username: "" };

  // hourly cap (DM မှာ မသက်ရောက်)
  const now = Date.now();
  st.sent = st.sent.filter((t) => now - t < 3600e3);
  if (!info.isDm && Number(P(acc, "markRead")) && info.target?.id) { try { await client.markAsRead(info.peer, info.target.id, { clearMentions: true }); } catch (_) {} }
  if (!info.isDm && st.sent.length >= Number(P(acc, "maxPerHour"))) { console.log(`engine[${accName}]: ${short(info.title, 20)} နာရီကန့်သတ်ပြည့် — ကျော်`); return; }

  const tStart = Date.now();
  console.log(`engine[${accName}]: ${info.isDm ? "DM" : short(info.title, 20)} — Groq ကို မေးနေသည် (key ${keyCandidates(acc).length} ခု)`);
  const messages = info.isDm ? buildDmMessages(acc, st, me.name, info.target) : buildGroupMessages(acc, st, info.title, info.target, info.direct, me.name);
  let r = await callGroq(acc, messages);
  if (!r.error && !String(r.text || "").trim() && info.isDm) { // ဗလာပြန်ရင် တစ်ခါ ထပ်မေး
    console.log(`engine[${accName}]: Groq ဗလာပြန် — ထပ်မေးမယ်`);
    r = await callGroq(acc, [...messages, { role: "user", content: "(Please reply to my last message now, in a short natural way.)" }]);
  }
  if (r.error) {
    console.error(`groq[${accName}]: ${r.error}`);
    if (r.error !== "NO_KEY") {
      incStat(accName, "failed");
      if (Date.now() - (lastGroqAlert[accName] || 0) > 60000) { // admin ကို တစ်မိနစ်တစ်ခါပဲ သိစေ
        lastGroqAlert[accName] = Date.now();
        notify(`⚠️ [${accName}] Groq က မဖြေနိုင်ဘူး — ${short(r.error, 150)}\n(🩺 Diagnose နှိပ်ပြီး စစ်ကြည့်ပါ)`).catch(() => {});
      }
    }
    return;
  }
  console.log(`engine[${accName}]: Groq ဖြေပြီး ${Date.now() - tStart}ms — ${short(r.text, 60)}`);
  if (!info.isDm && !info.direct && isSkip(r.text)) { console.log(`engine[${accName}]: AI က SKIP ရွေး`); return; }
  const reply = cleanReply(r.text, !!Number(P(acc, "stripPunct")), [me.name, "Me", "me"]);
  if (!reply || isSkip(reply)) { console.log(`engine[${accName}]: ပြန်စာ ဗလာ/SKIP ဖြစ်နေလို့ မပို့`); return; }

  try { await client.invoke(new Api.messages.SetTyping({ peer: info.peer, action: new Api.SendMessageTypingAction() })); } catch (_) {}
  await sleep(info.isDm ? Math.min(900, 200 + reply.length * 15) : Math.min(3500, 400 + reply.length * 45));

  const quote = !info.isDm && (info.direct || Math.random() * 100 < Number(P(acc, "quoteChance")));
  try {
    const sent = await withTimeout(client.sendMessage(info.peer, { message: reply, ...(quote ? { replyTo: info.target.id } : {}) }), 30000, "SEND_TIMEOUT");
    console.log(`engine[${accName}]: ✅ ပို့ပြီး (${short(reply, 40)})`);
    st.fails = 0; st.lastOwn = Date.now(); st.sent.push(Date.now());
    if (sent?.id) st.ownMsgIds.add(sent.id);
    pushBuf(st, { id: sent?.id, name: me.name, text: reply, own: true, ts: Date.now() }, Number(P(acc, "historySize")));
    incStat(accName, "sent");
    if (S.notifyOn && acc.notifyOn !== false) {
      notify(`💬 [${accName}] ${short(info.title, 30)}\n${info.target.name}: ${short(info.target.text, 80)}\n↳ ${short(reply, 160)}`).catch(() => {});
    }
  } catch (e) {
    incStat(accName, "failed");
    const msgE = e.message || String(e);
    console.error(`send[${accName}]: ${msgE}`);
    const fw = msgE.match(/wait of (\d+) seconds/i) || (e.seconds ? [0, e.seconds] : null);
    if (fw) { st.blockedUntil = Date.now() + (parseInt(fw[1]) + 5) * 1000; if (S.notifyOn) notify(`⏳ [${accName}] FloodWait ${fw[1]}s — ${short(info.title, 30)} မှာ ခဏစောင့်မယ်`).catch(() => {}); return; }
    if (PERMANENT_ERR.test(msgE) && !info.isDm) {
      st.fails++;
      if (st.fails >= 3) {
        await saveAccount(accName, { blocked: [...new Set([...(acc.blocked || []), info.link])] });
        notify(`🚫 [${accName}] ${short(info.link, 50)} မှာ ဆက်တိုက် ၃ ကြိမ်ပို့မရ (${short(msgE, 60)})\n→ ဒီ GP ကို ရပ်လိုက်ပြီ။ Account menu မှာ ♻️ နဲ့ ပြန်ဖွင့်နိုင်`).catch(() => {});
      }
    }
  }
}

// ─── ADMIN UI ─────────────────────────────────────────────────────────────────
bot.use((ctx, next) => (ctx.from?.id === ADMIN_ID ? next() : undefined));

async function render(ctx, text, rows) {
  const extra = { reply_markup: { inline_keyboard: rows } };
  if (ctx.callbackQuery) {
    try { return await ctx.editMessageText(clip(text), extra); }
    catch (e) { if (/not modified/i.test(e.message || "")) return; }
  }
  return ctx.reply(clip(text), extra);
}
const setAwait = (type, data = {}) => { awaiting = { type, ...data }; };
const cancelRows = [[btn("❌ ပယ်ဖျက်", "cancel")]];

async function showHome(ctx, note) {
  const accs = await getAccounts();
  const on = accs.filter((a) => a.active).length;
  const keys = (S.groqKeys || []).length;
  let t = `🤖 AI Userbot Panel\n`;
  if (note) t += `\n${note}\n`;
  t += `\n👤 Accounts: ${accs.length} (🟢 chat ဖွင့် ${on})`;
  t += `\n🔑 Global Groq keys: ${keys}`;
  t += `\n🧠 Model: ${S.model}`;
  t += `\n🔔 Noti: ${S.notifyOn ? "🟢 ဖွင့်" : "🔕 ပိတ်"}`;
  const rows = [
    [btn("👤 Accounts", "accs"), btn("➕ Account ထည့်", "addacc")],
    [btn("🔑 Global Keys", "g:keys"), btn("✏️ Global Prompt", "g:prompt")],
    [btn("⚙️ Default Settings", "g:params"), btn("🧠 Model", "g:model")],
    [btn(S.notifyOn ? "🔔 Noti ပိတ်မယ်" : "🔕 Noti ဖွင့်မယ်", "g:noti")],
    [btn("▶️ အကုန် Start", "g:startall"), btn("⏹ အကုန် Stop", "g:stopall")],
    [btn("🩺 Diagnose (စစ်ဆေး)", "g:diag")],
  ];
  return render(ctx, t, rows);
}

async function showAccounts(ctx) {
  const accs = await getAccounts();
  const rows = accs.map((a) => [btn(`${clientPool[a.name] ? (a.active ? "🟢" : "⚪") : "🔴"} ${a.name} · GP ${(a.gpLinks || []).length} · 🔑${(a.groqKeys || []).length}`, `a:${a._id}`)]);
  rows.push([btn("➕ Account ထည့်", "addacc")], [btn("⬅️ Home", "home")]);
  return render(ctx, accs.length ? `👤 Accounts (${accs.length})\n🟢 chat ဖွင့် · ⚪ ရပ်ထား · 🔴 မချိတ်` : "👤 Account မရှိသေးပါ", rows);
}

async function showAccount(ctx, acc, note) {
  acc = (await getAccById(String(acc._id))) || acc;
  const id = String(acc._id);
  const st = acc.stats || {};
  let t = `👤 ${acc.name}\n${clientPool[acc.name] ? "🟢 Connected" : "🔴 Disconnected (🔄 Reconnect နှိပ်ပါ)"} · ${acc.active ? "💬 Chat ဖွင့်ထား" : "⏹ ရပ်ထား"}\n`;
  if (note) t += `\n${note}\n`;
  t += `\n🔑 Account keys: ${(acc.groqKeys || []).length} (+ global ${(S.groqKeys || []).length})`;
  t += `\n✏️ Prompt: ${acc.customPrompt ? "custom (ဒီ account သီးသန့်)" : S.prompt ? "global" : "default"}`;
  t += `\n📩 DM: ${acc.dmOn === false ? "⚪ ပိတ်" : "🟢 ဖွင့်"} · 🔔 Noti: ${acc.notifyOn === false ? "🔕 ပိတ်" : "🟢 ဖွင့်"}`;
  t += `\n🔗 GP: ${(acc.gpLinks || []).length} ခု${monitor[acc.name] ? ` (monitor ${monitor[acc.name].size})` : ""}`;
  (acc.gpLinks || []).slice(0, 25).forEach((l, i) => { t += `\n${i + 1}. ${short(l, 40)}${(acc.blocked || []).includes(l) ? " 🚫" : ""}`; });
  t += `\n📊 ပို့ပြီး ${st.sent || 0} · reaction ${st.reacted || 0} · မအောင် ${st.failed || 0}`;
  const rows = [
    [btn(acc.active ? "⏹ Stop (chat ရပ်)" : "▶️ Start (chat စ)", `a:${id}:tog`)],
    [btn("➕ GP ထည့်", `a:${id}:gadd`), btn("🗑 GP ဖျက်", `a:${id}:grm`), btn("🧹 အကုန်ဖျက်", `a:${id}:gclr`)],
    [btn("🤝 Join GP များ", `a:${id}:join`)],
    [btn("🔑 Groq Keys", `a:${id}:keys`), btn("✏️ Prompt", `a:${id}:prompt`)],
    [btn("⚙️ Settings", `a:${id}:params`), btn("🧪 AI Test", `a:${id}:test`)],
    [btn(acc.dmOn === false ? "📩 DM ဖွင့်မယ်" : "📩 DM ပိတ်မယ်", `a:${id}:dm`), btn(acc.notifyOn === false ? "🔔 Noti ဖွင့်" : "🔕 Noti ပိတ်", `a:${id}:noti`)],
  ];
  if ((acc.blocked || []).length) rows.push([btn(`♻️ Blocked GP ${(acc.blocked || []).length} ခု ပြန်ဖွင့်`, `a:${id}:unb`)]);
  rows.push([btn("🔄 Reconnect", `a:${id}:rc`), btn("🗑 Account ဖျက်", `a:${id}:del`)], [btn("⬅️ Accounts", "accs")]);
  return render(ctx, t, rows);
}

async function showKeys(ctx, acc) { // acc === null → global
  const keys = acc ? acc.groqKeys || [] : S.groqKeys || [];
  const base = acc ? `a:${acc._id}` : "g";
  let t = `🔑 ${acc ? `[${acc.name}] Groq Keys` : "Global Groq Keys (account key မကျန်ရင် ဒါတွေ သုံး)"}\n\nKey တစ်ခု limit/invalid ဖြစ်ရင် နောက် key ကို အလိုအလျောက် ကူးသုံးမယ်\n`;
  keys.forEach((k, i) => { t += `\n${i + 1}. ${maskKey(k)}  ${keyStatus(k)}`; });
  if (!keys.length) t += "\n(မရှိသေးပါ)";
  const rows = [[btn("➕ Key ထည့် (များစွာ တစ်ခါတည်းရ)", `${base}:kadd`)]];
  keys.forEach((k, i) => rows.push([btn(`🗑 #${i + 1} ${maskKey(k)}`, `${base}:krm:${i}`)]));
  rows.push([btn("🔁 Status ပြန်သုတ် (cooldown/invalid ဖျက်)", `${base}:kreset`)]);
  rows.push([btn("⬅️ နောက်သို့", acc ? `a:${acc._id}` : "home")]);
  return render(ctx, t, rows);
}

async function showParams(ctx, acc) {
  const base = acc ? `a:${acc._id}` : "g";
  let t = acc ? `⚙️ [${acc.name}] Settings\n(မပြင်ထားတာတွေက Global Default ကို သုံး)\n` : "⚙️ Global Default Settings\n";
  const rows = [];
  for (const p of PARAMS) {
    const own = acc?.params?.[p.k];
    const v = acc ? P(acc, p.k) : (S.defaults?.[p.k] ?? p.def);
    const mark = acc && own === undefined ? " (default)" : "";
    rows.push([btn(`${p.label}: ${fmtParam(p, v)}${mark}`, `${base}:ps:${p.k}`)]);
  }
  rows.push([btn("🧽 အကုန် default ပြန်", `${base}:preset`)], [btn("⬅️ နောက်သို့", acc ? `a:${acc._id}` : "home")]);
  return render(ctx, t, rows);
}

async function showPrompt(ctx, acc) {
  const cur = acc ? acc.customPrompt || S.prompt || DEFAULT_PROMPT : S.prompt || DEFAULT_PROMPT;
  const base = acc ? `a:${acc._id}` : "g";
  const src = acc ? (acc.customPrompt ? "custom (ဒီ account)" : S.prompt ? "global" : "default") : S.prompt ? "global (ပြင်ထား)" : "default";
  const t = `✏️ ${acc ? `[${acc.name}] ` : "Global "}Prompt — ${src}\n\n${cur}\n\n` +
    `ℹ️ ဒီ prompt ကို AI ရဲ့ "စရိုက်/ပြောပုံ" အဖြစ် Groq ကို ပေးတယ်။ (စာကို တိုတိုရေး၊ SKIP ပြောခွင့်၊ နာမည်မထည့် စတဲ့ အခြေခံစည်းမျဉ်းတွေကို bot က အလိုအလျောက် ထပ်ဖြည့်ပေးတယ်)`;
  return render(ctx, t, [
    [btn("✏️ ပြင်မယ်", `${base}:pset`), btn("🧽 Default ပြန်", `${base}:pclr`)],
    [btn("⬅️ နောက်သို့", acc ? `a:${acc._id}` : "home")],
  ]);
}

bot.start(async (ctx) => { awaiting = null; draft = null; return showHome(ctx); });
bot.command("cancel", async (ctx) => { awaiting = null; draft = null; return showHome(ctx, "❌ ပယ်ဖျက်ပြီး"); });

async function doStartAll(on) {
  for (const a of await getAccounts()) { await saveAccount(a.name, { active: on }); if (!on) clearPending(a.name); }
}

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data || "";
  await ctx.answerCbQuery().catch(() => {});
  try {
    if (data === "home") { awaiting = null; return showHome(ctx); }
    if (data === "cancel") { awaiting = null; draft = null; return showHome(ctx, "❌ ပယ်ဖျက်ပြီး"); }
    if (data === "accs") return showAccounts(ctx);
    if (data === "addacc") { setAwait("addacc_name"); return render(ctx, "➕ Account အသစ်\n\nနာမည်တစ်ခု ရိုက်ပို့ပါ (ဥပမာ acc1)", cancelRows); }
    if (data.startsWith("g:")) return globalRoute(ctx, data.split(":").slice(1));
    if (data.startsWith("a:")) return accRoute(ctx, data.split(":").slice(1));
  } catch (e) {
    console.error("callback:", e.message);
    ctx.reply(`❌ ${e.message}`).catch(() => {});
  }
});

async function globalRoute(ctx, [act, arg, arg2]) {
  switch (act) {
    case "diag": {
      await render(ctx, "🩺 စစ်ဆေးနေသည်… (၁ မိနစ်ခန့်ကြာနိုင်)", []);
      let t = `🩺 Diagnose\n🧠 Model: ${S.model}\n`;
      for (const a of await getAccounts()) {
        t += `\n👤 ${a.name} — ${a.active ? "💬 chat ဖွင့်" : "⏹ ရပ်ထား"}`;
        const c = clientPool[a.name];
        if (!c) { t += "\n  🔴 Telegram မချိတ်ဘူး (Reconnect နှိပ်ပါ)"; continue; }
        let t0 = Date.now();
        try { await withTimeout(c.getMe(), 15000, "timeout"); t += `\n  🟢 Telegram ဖြေ ${Date.now() - t0}ms`; } catch (e) { t += `\n  🔴 Telegram မဖြေ (${e.message})`; }
        const cands = keyCandidates(a);
        t += `\n  🔑 သုံးလို့ရတဲ့ key ${cands.length} ခု`;
        if (cands.length) {
          t0 = Date.now();
          const r = await callGroq(a, [{ role: "user", content: "Say hi in one short word." }]);
          t += r.error ? `\n  🔴 Groq error: ${short(r.error, 160)}` : `\n  🟢 Groq ဖြေ ${Date.now() - t0}ms — "${short(r.text, 30)}"`;
        }
      }
      return render(ctx, t, [[btn("🔁 ထပ်စစ်", "g:diag")], [btn("⬅️ Home", "home")]]);
    }
    case "noti": await saveSettings({ notifyOn: !S.notifyOn }); return showHome(ctx);
    case "startall": await doStartAll(true); return showHome(ctx, "▶️ အကုန် Start လုပ်ပြီး");
    case "stopall": await doStartAll(false); return showHome(ctx, "⏹ အကုန် Stop လုပ်ပြီး");
    case "keys": return showKeys(ctx, null);
    case "kadd": setAwait("key_add", { scope: "g" }); return render(ctx, "🔑 Global Groq API key(s) ပို့ပါ\n(တစ်ကြောင်းကို key တစ်ခု၊ များစွာ တစ်ခါတည်း paste လို့ရ)", cancelRows);
    case "krm": { const k = [...S.groqKeys]; k.splice(parseInt(arg), 1); await saveSettings({ groqKeys: k }); return showKeys(ctx, null); }
    case "kreset": for (const k of Object.keys(keyState)) delete keyState[k]; return showKeys(ctx, null);
    case "params": return showParams(ctx, null);
    case "ps": { const p = PARAM_BY_KEY[arg]; if (!p) return; if (p.bool) { await saveSettings({ defaults: { ...S.defaults, [p.k]: S.defaults?.[p.k] === undefined ? (p.def ? 0 : 1) : (S.defaults[p.k] ? 0 : 1) } }); return showParams(ctx, null); } setAwait("param_set", { scope: "g", k: p.k }); return render(ctx, `${p.label}\nတန်ဖိုး (${p.min}–${p.max}) ရိုက်ပို့ပါ`, cancelRows); }
    case "preset": await saveSettings({ defaults: {} }); return showParams(ctx, null);
    case "prompt": return showPrompt(ctx, null);
    case "pset": setAwait("prompt_set", { scope: "g" }); return render(ctx, "✏️ Global Prompt အသစ် ရိုက်ပို့ပါ (AI ဘယ်လိုပြောရမလဲ)", cancelRows);
    case "pclr": await saveSettings({ prompt: "" }); return showPrompt(ctx, null);
    case "model": setAwait("model_set"); return render(ctx, `🧠 Groq model နာမည် ရိုက်ပို့ပါ\nလက်ရှိ: ${S.model}\nဥပမာ: llama-3.3-70b-versatile · llama-3.1-8b-instant`, cancelRows);
  }
}

async function accRoute(ctx, [id, action, arg]) {
  const acc = await getAccById(id);
  if (!acc) return render(ctx, "❌ Account မတွေ့ပါ", [[btn("⬅️ Accounts", "accs")]]);
  if (!action) return showAccount(ctx, acc);
  const back = [[btn("⬅️ နောက်သို့", `a:${id}`)]];
  switch (action) {
    case "tog": {
      const on = !acc.active;
      if (on && !clientPool[acc.name]) return showAccount(ctx, acc, "❌ Account မချိတ်ရသေးပါ — 🔄 Reconnect အရင်နှိပ်ပါ");
      if (on && !keyCandidates(acc).length) return showAccount(ctx, acc, "⚠️ Groq API key မရှိပါ — 🔑 Groq Keys ကနေ အရင်ထည့်ပါ");
      await saveAccount(acc.name, { active: on }); if (!on) clearPending(acc.name);
      return showAccount(ctx, acc, on ? "▶️ Chat စတင်ပြီး" : "⏹ Chat ရပ်ပြီး");
    }
    case "dm": await saveAccount(acc.name, { dmOn: acc.dmOn === false }); return showAccount(ctx, acc);
    case "noti": await saveAccount(acc.name, { notifyOn: acc.notifyOn === false }); return showAccount(ctx, acc);
    case "unb": await saveAccount(acc.name, { blocked: [] }); return showAccount(ctx, acc, "♻️ ပြန်ဖွင့်ပြီး");
    case "gadd": setAwait("gp_add", { id }); return render(ctx, `➕ [${acc.name}] GP link(s) ပို့ပါ (တစ်ကြောင်းတစ်ခု)\nဥပမာ https://t.me/xxxx`, cancelRows);
    case "gclr": await saveAccount(acc.name, { gpLinks: [], blocked: [] }); return showAccount(ctx, acc, "🧹 GP အကုန်ဖျက်ပြီး");
    case "grm": {
      if (arg === undefined) {
        const gps = acc.gpLinks || [];
        if (!gps.length) return showAccount(ctx, acc, "GP မရှိပါ");
        return render(ctx, "🗑 ဖျက်မယ့် GP ရွေးပါ", [...gps.slice(0, 40).map((l, i) => [btn(`${i + 1}. ${short(l, 40)}`, `a:${id}:grm:${i}`)]), ...back]);
      }
      const gps = [...(acc.gpLinks || [])]; const [rm] = gps.splice(parseInt(arg), 1);
      await saveAccount(acc.name, { gpLinks: gps, blocked: (acc.blocked || []).filter((l) => l !== rm) });
      return showAccount(ctx, acc, `🗑 ဖျက်ပြီး: ${short(rm || "", 40)}`);
    }
    case "join": {
      const client = clientPool[acc.name];
      if (!client) return showAccount(ctx, acc, "❌ Account မချိတ်ရသေးပါ");
      const gps = acc.gpLinks || [];
      if (!gps.length) return showAccount(ctx, acc, "GP မရှိပါ");
      await render(ctx, `🤝 Join လုပ်နေသည်… (${gps.length} ခု)`, []);
      const out = [];
      for (const l of gps) {
        try { await joinGroup(client, l); out.push(`✅ ${short(l, 36)}`); }
        catch (e) { out.push(/ALREADY|USER_ALREADY_PARTICIPANT/i.test(e.message) ? `✅ ${short(l, 36)} (ဝင်ပြီးသား)` : `❌ ${short(l, 36)} — ${short(e.message, 40)}`); }
        await sleep(3000);
      }
      delete monitor[acc.name]; await buildMonitor(acc.name).catch(() => {});
      return showAccount(ctx, acc, out.join("\n"));
    }
    case "keys": return showKeys(ctx, acc);
    case "kadd": setAwait("key_add", { scope: "a", id }); return render(ctx, `🔑 [${acc.name}] Groq API key(s) ပို့ပါ\n(တစ်ကြောင်းကို key တစ်ခု၊ များစွာ တစ်ခါတည်း paste လို့ရ)`, cancelRows);
    case "krm": { const k = [...(acc.groqKeys || [])]; k.splice(parseInt(arg), 1); await saveAccount(acc.name, { groqKeys: k }); return showKeys(ctx, await getAccById(id)); }
    case "kreset": for (const k of Object.keys(keyState)) delete keyState[k]; return showKeys(ctx, acc);
    case "params": return showParams(ctx, acc);
    case "ps": {
      const p = PARAM_BY_KEY[arg]; if (!p) return;
      if (p.bool) { await saveAccount(acc.name, { params: { ...(acc.params || {}), [p.k]: P(acc, p.k) ? 0 : 1 } }); return showParams(ctx, await getAccById(id)); }
      setAwait("param_set", { scope: "a", id, k: p.k });
      return render(ctx, `${p.label}\nတန်ဖိုး (${p.min}–${p.max}) ရိုက်ပို့ပါ\nလက်ရှိ: ${P(acc, p.k)}`, cancelRows);
    }
    case "preset": await saveAccount(acc.name, { params: {} }); return showParams(ctx, await getAccById(id));
    case "prompt": return showPrompt(ctx, acc);
    case "pset": setAwait("prompt_set", { scope: "a", id }); return render(ctx, `✏️ [${acc.name}] Prompt အသစ် ရိုက်ပို့ပါ (AI ဘယ်လိုပြောရမလဲ)`, cancelRows);
    case "pclr": await saveAccount(acc.name, { customPrompt: "" }); return showPrompt(ctx, await getAccById(id));
    case "test": setAwait("test", { id }); return render(ctx, `🧪 [${acc.name}] စမ်းမယ့်စာ ရိုက်ပို့ပါ — တခြားသူပြောတယ်လို့ သဘောထားပြီး AI ဘယ်လိုပြန်မလဲ ပြမယ်`, cancelRows);
    case "rc":
      await render(ctx, "🔄 Reconnect လုပ်နေသည်…", []);
      try { await reconnectAccount(acc); return showAccount(ctx, acc, "✅ Reconnect အောင်မြင်"); }
      catch (e) { return showAccount(ctx, acc, `❌ ${e.message}`); }
    case "del":
      if (arg !== "y") return render(ctx, `🗑 [${acc.name}] ကို ဖျက်မှာ သေချာလား?`, [[btn("✅ ဖျက်မယ်", `a:${id}:del:y`)], ...back]);
      clearPending(acc.name);
      if (clientPool[acc.name]) { try { await clientPool[acc.name].disconnect(); } catch (_) {} delete clientPool[acc.name]; }
      await db.collection("accounts").deleteOne({ name: acc.name }); delete accCache[acc.name];
      return showAccounts(ctx);
  }
}

// text input (awaiting state)
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;
  if (!awaiting) return ctx.reply("🏠 Panel ဖွင့်ရန် /start ကိုနှိပ်ပါ");
  const aw = awaiting;
  try {
    switch (aw.type) {
      case "addacc_name": {
        if (await db.collection("accounts").findOne({ name: text })) return ctx.reply("⚠️ ဒီနာမည် ရှိပြီးသား၊ တခြားနာမည်ပေးပါ");
        setAwait("addacc_sess", { name: text });
        return ctx.reply(`🔑 [${text}] ရဲ့ Session String ကို paste လုပ်ပါ\n(get-session.js နဲ့ ထုတ်ထားတာ)`, { reply_markup: { inline_keyboard: cancelRows } });
      }
      case "addacc_sess": {
        ctx.deleteMessage().catch(() => {}); // session string ကို chat ထဲက ဖျက်
        const wait = await ctx.reply("⏳ ချိတ်ဆက်နေသည်…");
        try {
          const client = await buildClient(text, aw.name);
          clientPool[aw.name] = client;
          await db.collection("accounts").insertOne({ name: aw.name, sessionString: text, active: false, gpLinks: [], groqKeys: [], customPrompt: "", params: {}, stats: {}, addedAt: new Date() });
          await refreshAcc(aw.name);
          awaiting = null;
          const a = accCache[aw.name];
          await bot.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, `✅ ${aw.name} (${client._me.name}) ချိတ်ပြီး\n\nGP, Groq key ထည့်ပြီး ▶️ Start နှိပ်ပါ`, { reply_markup: { inline_keyboard: [[btn("👤 Account ဖွင့်", `a:${a._id}`)]] } });
        } catch (e) {
          awaiting = null;
          await bot.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, `❌ ချိတ်မရ: ${e.message}`, { reply_markup: { inline_keyboard: [[btn("⬅️ Home", "home")]] } });
        }
        return;
      }
      case "gp_add": {
        const acc = await getAccById(aw.id); awaiting = null;
        const links = text.split(/\s+/).filter((l) => parseLink(l));
        if (!links.length) return ctx.reply("❌ t.me link မတွေ့ပါ", { reply_markup: { inline_keyboard: [[btn("⬅️ Account", `a:${aw.id}`)]] } });
        const merged = [...new Set([...(acc.gpLinks || []), ...links])];
        await saveAccount(acc.name, { gpLinks: merged });
        return ctx.reply(`✅ GP ${links.length} ခု ထည့်ပြီး (စုစုပေါင်း ${merged.length})\n⚠️ Account က GP ထဲ join ပြီးသားဖြစ်ရမယ် — မဝင်ရသေးရင် 🤝 Join နှိပ်ပါ`, { reply_markup: { inline_keyboard: [[btn("⬅️ Account", `a:${aw.id}`)]] } });
      }
      case "key_add": {
        ctx.deleteMessage().catch(() => {});
        const keys = text.split(/\s+/).filter((k) => k.length >= 20);
        awaiting = null;
        if (!keys.length) return ctx.reply("❌ Key မမှန်ပါ", { reply_markup: { inline_keyboard: [[btn("⬅️ Home", "home")]] } });
        if (aw.scope === "g") { await saveSettings({ groqKeys: [...new Set([...(S.groqKeys || []), ...keys])] }); return ctx.reply(`✅ Global key ${keys.length} ခု ထည့်ပြီး`, { reply_markup: { inline_keyboard: [[btn("🔑 Keys", "g:keys")]] } }); }
        const acc = await getAccById(aw.id);
        await saveAccount(acc.name, { groqKeys: [...new Set([...(acc.groqKeys || []), ...keys])] });
        return ctx.reply(`✅ [${acc.name}] key ${keys.length} ခု ထည့်ပြီး`, { reply_markup: { inline_keyboard: [[btn("🔑 Keys", `a:${aw.id}:keys`)]] } });
      }
      case "prompt_set": {
        awaiting = null;
        if (aw.scope === "g") { await saveSettings({ prompt: text }); return ctx.reply("✅ Global prompt သိမ်းပြီး", { reply_markup: { inline_keyboard: [[btn("✏️ ကြည့်", "g:prompt")]] } }); }
        const acc = await getAccById(aw.id); await saveAccount(acc.name, { customPrompt: text });
        return ctx.reply("✅ Prompt သိမ်းပြီး", { reply_markup: { inline_keyboard: [[btn("✏️ ကြည့်", `a:${aw.id}:prompt`)]] } });
      }
      case "param_set": {
        const p = PARAM_BY_KEY[aw.k]; const n = p.float ? parseFloat(text) : parseInt(text);
        if (!Number.isFinite(n) || n < p.min || n > p.max) return ctx.reply(`❌ ${p.min}–${p.max} ကြားဂဏန်း ရိုက်ပါ`);
        awaiting = null;
        if (aw.scope === "g") { await saveSettings({ defaults: { ...S.defaults, [p.k]: n } }); return ctx.reply("✅ သိမ်းပြီး", { reply_markup: { inline_keyboard: [[btn("⚙️ Settings", "g:params")]] } }); }
        const acc = await getAccById(aw.id); await saveAccount(acc.name, { params: { ...(acc.params || {}), [p.k]: n } });
        return ctx.reply("✅ သိမ်းပြီး", { reply_markup: { inline_keyboard: [[btn("⚙️ Settings", `a:${aw.id}:params`)]] } });
      }
      case "model_set": awaiting = null; await saveSettings({ model: text }); return ctx.reply(`✅ Model: ${text}`, { reply_markup: { inline_keyboard: [[btn("🏠 Home", "home")]] } });
      case "test": {
        const acc = await getAccById(aw.id);
        const st = { buf: [{ name: "Test User", text, own: false }] };
        const r = await callGroq(acc, buildGroupMessages(acc, st, "Test Group", { name: "Test User", text }, true, "me"));
        if (r.error) return ctx.reply(`❌ ${r.error}`);
        return ctx.reply(`🧪 AI ပြန်စာ:\n\n${cleanReply(r.text, !!Number(P(acc, "stripPunct")), ["me"])}\n\n(🔑 ${maskKey(r.key)} · ${S.model}) — နောက်တစ်ခု စမ်းချင်ရင် ထပ်ရိုက်ပို့ပါ`, { reply_markup: { inline_keyboard: [[btn("⬅️ Account", `a:${aw.id}`)]] } });
      }
    }
  } catch (e) { console.error("text:", e.message); ctx.reply(`❌ ${e.message}`).catch(() => {}); }
});

bot.catch((err) => console.error("Bot error:", err));

// ─── KEEP ALIVE + MAIN ────────────────────────────────────────────────────────
async function main() {
  for (const [k, v] of Object.entries({ BOT_TOKEN, API_ID, API_HASH, ADMIN_ID, MONGO_URI })) {
    if (!v) { console.error(`❌ Environment ထဲမှာ ${k} မရှိပါ (.env.example ကိုကြည့်ပါ)`); process.exit(1); }
  }
  const PORT = process.env.PORT || 3000;
  http.createServer((req, res) => { res.writeHead(200); res.end("AI Userbot OK"); }).listen(PORT, () => console.log(`🌐 Port ${PORT}`));
  setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    (url.startsWith("https:") ? https : http).get(url, (r) => { r.resume(); }).on("error", (e) => console.error("keepalive:", e.message));
  }, 14 * 60 * 1000);

  await connectDB();
  await loadSettings();
  await initAllClients();
  startHealthCheck();
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });

  let launched = false, retry = 0;
  while (!launched) {
    try {
      await new Promise((resolve, reject) => { bot.launch({ dropPendingUpdates: true }, resolve).catch(reject); setTimeout(resolve, 8000); });
      launched = true; console.log("✅ Bot started!");
    } catch (err) {
      if (err.response?.error_code === 409) { retry++; console.log(`⚠️ 409 conflict — retry ${retry} in 5s...`); await sleep(5000); await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {}); }
      else throw err;
    }
  }
  await notify("✅ AI Userbot အသင့်ဖြစ်ပြီ!", { reply_markup: { inline_keyboard: [[btn("🏠 Panel ဖွင့်", "home")]] } }).catch(() => {});
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { onMessage, accCache, clientPool, monitor, chats, ownIds, cleanReply, isSkip, callGroq, keyCandidates, keyState, S, buildGroupMessages, buildDmMessages, parseLink, P, PARAMS };
