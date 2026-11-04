// お店の手帳の裏側：助手（Managed Agents）との今の会話、写メ、記憶の棚。
//   GET  /api/techo?do=talk[&session=sesn_…]  今の会話（なければ新しく始める）
//   POST /api/techo?do=say   {text, photo, reply}  発言を送る（photo は JPEG の base64。reply は {post, about}：どの投稿への返事か）
//   GET  /api/techo?do=diary[&except=sesn_…&skip=N]  今の会話より前の日記と返事（新しい会話から順に数回分）
//   GET  /api/techo?do=shelf                  記憶の棚の中身
//   GET  /api/techo?do=mornings               朝の一覧（最近7日、写真の番号とひとこと）
//   GET  /api/techo?do=photo&file=file_…      カメラの係の写真（朝の一覧に載っているものだけ）
//   GET  /api/techo?do=photo&session=…&event=…  日記の写真（この福ちゃんの会話にあるものだけ）
//   GET  /api/techo?do=mise                   店先の猫が読む札とセリフ（棚の mise.json を検証して返す）
// 費用がかかるので、SHOP_CODE が未設定なら閉じる（ここだけ既存の猫のAPIより厳しい）。
import fs from "node:fs";
import { client, shopOK } from "../_claude.js";

const BUDGET = { type: "limit", max_list_cost: { amount: "100", currency: "USD" } }; // 1会話1ドル
const DATE_MARK = "【今日】"; // 今日の日付を助手に伝える文。画面には出さない
const PHOTO_MARK = "【写真】"; // 写真が届いたことを助手に伝える文。画面には文章として出さない
const BACKSTAGE_MARK = "【裏方】"; // 朝の起動など、店主の発言ではない合図。画面に出さない
const PHOTO_ONLY_MARK = "【写真だけ】"; // カメラの係が朝の後から写真だけ渡す合図。これへの返答も画面に出さない
const REPLY_MARK = "【返事先:"; // どの投稿への返事かを助手に伝える文。保存場所は作らず、画面はこの印で投稿ごとにまとめる。文面は出さない
const REPLY_END = "への返事です。";
const FIRST_DAY_CUE = `${BACKSTAGE_MARK}店主がはじめて手帳を開きました。棚は空です。短いあいさつのあとで、初日の聞き取りの最初の一つだけを聞いてください。店主に見せる言葉は日本語で、作業の話はしないでください。`;
const NOT_NOTES = new Set(["/yume.md", "/mise_kiroku.md"]); // 福ちゃんと猫が書くもの。これだけなら棚はまだ空とみなす
const DIARY_SESSIONS = 10; // 一度に読む過去の会話の数
const DIARY_SCAN = 200;
const MAX_PHOTO_BASE64 = 4_200_000; // Vercel の本文上限 4.5MB の内側
const MAX_TEXT = 8000;
const MAX_ABOUT = 240;
const MAX_MORNINGS = 7;
const MORNING_SCAN = 200; // 朝を探して見る会話の数の上限
const MISE_PATH = "/mise.json";
const EMPTY_MISE = { date: null, items: [], lines: { greet: [], bye: [], chat: [] } };

let idsFile; // agent/ids.json は一度だけ読む
function ids() {
  if (idsFile === undefined) {
    try {
      idsFile = JSON.parse(fs.readFileSync(new URL("../../agent/ids.json", import.meta.url), "utf8"));
    } catch {
      idsFile = {};
    }
  }
  const agent = process.env.MANEKI_AGENT_ID || idsFile.agent;
  const environment = process.env.MANEKI_ENVIRONMENT_ID || idsFile.environment;
  const store = process.env.MANEKI_STORE_ID || idsFile.store;
  if (!agent || !environment || !store) throw new Error("助手の設定が見つかりません");
  return { agent, environment, store };
}

// 朝と夢の会話には、定時起動（クラウド）でもカメラの係（家のMac）でも metadata.kind が付いている
const dateOf = (s) => s.metadata?.date || new Date(s.created_at).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

async function shelfIsEmpty(store) {
  for await (const m of client.beta.memoryStores.memories.list(store)) {
    if (m.type === "memory" && !NOT_NOTES.has(m.path)) return false;
  }
  return true;
}

// 棚が空なら、はじめの聞き取りから始める
async function startSession({ agent, environment, store }) {
  const firstDay = await shelfIsEmpty(store);
  return client.beta.sessions.create({
    agent,
    environment_id: environment,
    budget: BUDGET,
    title: "お店の手帳",
    resources: [{
      type: "memory_store",
      memory_store_id: store,
      access: "read_write",
      instructions: "店主のノート。始める前に読み、覚えることはここに書く。",
    }],
    ...(firstDay ? { initial_events: [{ type: "user.message", content: [{ type: "text", text: FIRST_DAY_CUE }] }] } : {}),
  });
}

async function currentSession(c) {
  // 会話は作った時の助手の指示のまま動くので、助手を更新したら新しい会話へ移る（覚えたことは棚に残っている）
  const latest = (await client.beta.agents.retrieve(c.agent)).version;
  for await (const s of client.beta.sessions.list({
    agent_id: c.agent,
    memory_store_id: c.store, // 棚がつながっていない試しの会話は拾わない
    statuses: ["idle", "running", "rescheduling"],
    order: "desc",
    limit: 10,
  })) {
    if (s.metadata?.kind === "yume") continue; // 夢は店主と話す場所ではない
    return s.agent?.version === latest ? s : startSession(c);
  }
  return startSession(c);
}

// 待たれている道具の確認に答える。店主には道具の話を聞かないので、確認が要るものは断り、
// 手帳では動かせない道具にも「使えない」と返す。答えないと会話が止まったままになる。
async function settlePending(sessionId, events) {
  const answered = new Set();
  for (const e of events) {
    if (e.type === "user.tool_confirmation") answered.add(e.tool_use_id);
    if (e.type === "user.custom_tool_result") answered.add(e.custom_tool_use_id);
  }
  const replies = [];
  for (const e of events) {
    if (answered.has(e.id)) continue;
    if ((e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use") && e.evaluated_permission === "ask") {
      replies.push({ type: "user.tool_confirmation", tool_use_id: e.id, result: "deny", deny_message: "店主に確認できないため使えません。" });
    } else if (e.type === "agent.custom_tool_use") {
      replies.push({ type: "user.custom_tool_result", custom_tool_use_id: e.id, is_error: true, content: [{ type: "text", text: "この画面からは使えない道具です。" }] });
    }
  }
  if (replies.length) await client.beta.sessions.events.send(sessionId, { events: replies }).catch((e) => console.error("settle", e.status));
}

// 「【返事先:番号】説明への返事です。」を番号と説明に分ける
function readReplyMark(texts) {
  const t = texts.find((x) => x.startsWith(REPLY_MARK));
  const m = t && /^【返事先:([\w-]+)】([\s\S]*)$/.exec(t);
  if (!m) return null;
  return { post: m[1], about: m[2].endsWith(REPLY_END) ? m[2].slice(0, -REPLY_END.length) : m[2] };
}

// 出来事の列を、画面に出す会話へまとめる。
// 発言にはそれぞれ post（属する投稿の番号）を付ける。印のない店主の発言はそれ自体が新しい投稿で、
// 福ちゃんの言葉は直前の店主の発言と同じ投稿に入る（裏方の促しのあとの返事も、促しの前の発言の投稿に入る）
function readTalk(events) {
  const messages = [];
  let thread = null;
  let morning = null;
  let ownerSpoke = false;
  let busy = false;
  let paused = false;
  let failed = false;
  let silent = false; // 写真だけの合図への返答は店主に見せない
  for (const e of events) {
    if (e.type === "user.message") {
      busy = true;
      paused = failed = false;
      const texts = e.content.filter((b) => b.type === "text").map((b) => b.text);
      silent = texts.some((t) => t.startsWith(BACKSTAGE_MARK + PHOTO_ONLY_MARK));
      if (texts.some((t) => t.startsWith(BACKSTAGE_MARK) || t.startsWith("【朝の定時起動"))) continue; // 後ろは印を付ける前の朝の合図
      ownerSpoke = true;
      const reply = readReplyMark(texts);
      thread = reply ? reply.post : e.id;
      messages.push({
        id: e.id,
        who: "owner",
        post: thread,
        ...(reply ? { comment: true, about: reply.about } : {}),
        text: texts.filter((t) => !t.startsWith(PHOTO_MARK) && !t.startsWith(DATE_MARK) && !t.startsWith(REPLY_MARK)).join("\n"),
        photo: texts.some((t) => t.startsWith(PHOTO_MARK)),
        at: e.processed_at,
      });
    } else if (e.type === "agent.message") {
      const text = e.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      if (!text || silent) continue;
      if (!ownerSpoke && !morning) {
        morning = { id: e.id, text, at: e.processed_at };
        thread = e.id;
      } else messages.push({ id: e.id, who: "helper", post: thread, text, at: e.processed_at });
    } else if (e.type === "session.status_idle") {
      const stop = e.stop_reason?.type;
      if (stop === "requires_action") continue;
      busy = false;
      paused = stop === "budget_reached";
      failed = stop === "retries_exhausted";
    } else if (e.type === "session.status_terminated") {
      busy = false;
      failed = true;
    }
  }
  return { messages, morning, thread, busy, paused, failed };
}

async function talk(req, res) {
  const asked = String(req.query.session || "");
  const sessionId = /^sesn_\w+$/.test(asked) ? asked : (await currentSession(ids())).id;
  const events = [];
  for await (const e of client.beta.sessions.events.list(sessionId, { limit: 1000 })) events.push(e);
  await settlePending(sessionId, events);
  const nudged = await nudgeIfSilent(sessionId, events);
  const talked = readTalk(events);
  return res.status(200).json({ session: sessionId, ...talked, busy: talked.busy || nudged });
}

// 棚に書いただけで返事を出さずに終わることがある。店主の発言のあとに言葉が無いまま止まったら、一度だけ促す。
// 促しは裏方の発言なので、次に見た時は「最後の発言が店主」ではなくなり、二度は送らない。
async function nudgeIfSilent(sessionId, events) {
  const last = (type) => events.findLastIndex((e) => e.type === type);
  const said = events.findLastIndex((e) => e.type === "user.message");
  if (said < 0) return false;
  const texts = events[said].content.filter((b) => b.type === "text").map((b) => b.text);
  if (texts.some((t) => t.startsWith(BACKSTAGE_MARK) || t.startsWith("【朝の定時起動"))) return false;
  const replied = events.slice(said).some(
    (e) => e.type === "agent.message" && e.content.some((b) => b.type === "text" && b.text.trim()),
  );
  const idle = last("session.status_idle");
  if (replied || idle < said || events[idle].stop_reason?.type !== "end_turn") return false;
  if (last("session.status_running") > idle) return false;
  await client.beta.sessions.events
    .send(sessionId, {
      events: [{ type: "user.message", content: [{ type: "text", text: `${BACKSTAGE_MARK}店主への返事が出ていません。店主の言葉にひとこと日本語で答えてください。作業の話はしないでください。` }] }],
    })
    .catch((e) => console.error("nudge", e.status));
  return true;
}

async function say(req, res) {
  const text = String(req.body?.text || "").trim().slice(0, MAX_TEXT);
  const photo = typeof req.body?.photo === "string" ? req.body.photo : "";
  if (!text && !photo) return res.status(400).json({ error: "empty" });
  if (photo.length > MAX_PHOTO_BASE64) return res.status(413).json({ error: "photo too large" });
  const replyPost = req.body?.reply ? String(req.body.reply.post || "") : "";
  if (req.body?.reply && !/^[\w-]{1,100}$/.test(replyPost)) return res.status(400).json({ error: "bad reply" });
  // 説明は画面から届く文なので、印のかっこと改行を落としてから助手に渡す
  const about = String(req.body?.reply?.about || "この投稿").replace(/[【】\p{Cc}]/gu, " ").trim().slice(0, MAX_ABOUT);

  if (photo) {
    const bytes = Buffer.from(photo, "base64");
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return res.status(400).json({ error: "not a jpeg" });
  }

  const c = ids();
  const deliver = async (sessionId) => {
    const today = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "long" });
    const content = [{ type: "text", text: `${DATE_MARK}${today}` }];
    if (photo) {
      // 写真は発言に直接添える。福ちゃんが必ず見られて、手帳はこの履歴から写真を読み返せる
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: photo } });
      content.push({ type: "text", text: `${PHOTO_MARK}店主から写真が届きました。添えてある写真を見てください。` });
    }
    if (replyPost) content.push({ type: "text", text: `${REPLY_MARK}${replyPost}】${about}${REPLY_END}` });
    if (text) content.push({ type: "text", text });
    const sent = await client.beta.sessions.events.send(sessionId, { events: [{ type: "user.message", content }] });
    return { session: sessionId, eventId: sent.data?.[0]?.id ?? null };
  };

  let sessionId = (await currentSession(c)).id;
  try {
    return res.status(200).json(await deliver(sessionId));
  } catch (e) {
    // 1会話の上限に達したら、新しい会話を始めて言い直す（記憶の棚は次の会話にも残る）
    if (e.status !== 400 || !/budget/i.test(e.message || "")) throw e;
    sessionId = (await startSession(c)).id;
    return res.status(200).json({ ...(await deliver(sessionId)), renewed: true });
  }
}

// 今の会話より前の日記。会話ごとに読むので、写真の多い人でも一度に読むのは数回分だけ
async function diary(req, res) {
  const c = ids();
  const except = String(req.query.except || "");
  const skip = Math.max(0, Number(req.query.skip) || 0);
  const picked = [];
  let seen = 0;
  let scanned = 0;
  let more = false;
  for await (const s of client.beta.sessions.list({ agent_id: c.agent, memory_store_id: c.store, order: "desc", limit: 50 })) {
    if (++scanned > DIARY_SCAN) break;
    if (s.id === except || s.metadata?.kind === "yume") continue;
    if (seen++ < skip) continue;
    if (picked.length === DIARY_SESSIONS) { more = true; break; }
    picked.push(s);
  }
  const sessions = await Promise.all(picked.map(async (s) => {
    const events = [];
    for await (const e of client.beta.sessions.events.list(s.id, { limit: 1000 })) events.push(e);
    const { messages, morning } = readTalk(events);
    return { session: s.id, messages, morning };
  }));
  return res.status(200).json({ sessions, next: more ? skip + picked.length : null });
}

async function shelf(req, res) {
  const notes = [];
  for await (const m of client.beta.memoryStores.memories.list(ids().store, { view: "full" })) {
    if (m.type === "memory") notes.push({ path: m.path, content: m.content ?? "" });
  }
  notes.sort((a, b) => a.path.localeCompare(b.path, "ja"));
  return res.status(200).json({ notes });
}

// 朝の会話を新しい順に集める。同じ日に複数あれば（やり直し）新しい方だけ
async function morningSessions() {
  const found = new Map();
  let seen = 0;
  for await (const s of client.beta.sessions.list({ agent_id: ids().agent, order: "desc", limit: 50 })) {
    if (s.metadata?.kind === "asa" && !found.has(dateOf(s))) found.set(dateOf(s), s);
    if (found.size >= MAX_MORNINGS || ++seen >= MORNING_SCAN) break;
  }
  return [...found.values()];
}

async function firstWord(sessionId) {
  const page = await client.beta.sessions.events.list(sessionId, { types: ["agent.message"], limit: 5 });
  for (const e of page.data) {
    const text = e.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (text) return { id: e.id, text, at: e.processed_at };
  }
  return null;
}

async function mornings(req, res) {
  const sessions = await morningSessions();
  const list = await Promise.all(sessions.map(async (s) => {
    const first = await firstWord(s.id);
    return {
      date: dateOf(s),
      fileId: s.metadata?.photo_file_id || null,
      id: first?.id ?? null, // 朝の一言も一つの投稿。返事はこの番号へ
      at: first?.at ?? null,
      word: first?.text ?? null,
      looking: s.status === "running" || s.status === "rescheduling",
    };
  }));
  return res.status(200).json({ mornings: list });
}

// 上げたファイルは Files API から取り出せない（生成物だけが取り出せる決まり）ので、
// 発言に添えた写真を、その会話の履歴から読む。
//   file：カメラの係の写真。朝の一覧にある番号しか受けつけない
//   session と event：日記の写真。この福ちゃんの会話にあるものしか受けつけない
async function photo(req, res) {
  const file = String(req.query.file || "");
  const asked = String(req.query.session || "");
  const eventId = String(req.query.event || "");
  let sessionId;
  if (file) {
    sessionId = (await morningSessions()).find((s) => s.metadata?.photo_file_id === file)?.id;
    if (!sessionId) return res.status(404).json({ error: "not a morning photo" });
  } else {
    if (!/^sesn_\w+$/.test(asked) || !eventId) return res.status(400).json({ error: "bad photo" });
    const s = await client.beta.sessions.retrieve(asked);
    if (s.agent?.id !== ids().agent) return res.status(404).json({ error: "not ours" });
    sessionId = asked;
  }
  let image = null;
  for await (const e of client.beta.sessions.events.list(sessionId, { types: ["user.message"], limit: 100 })) {
    const texts = e.content.filter((b) => b.type === "text").map((b) => b.text);
    const match = file ? texts.some((t) => t.startsWith(BACKSTAGE_MARK)) : e.id === eventId;
    image = match ? e.content.find((b) => b.type === "image" && b.source?.type === "base64") : null;
    if (image) break;
  }
  if (!image) return res.status(404).json({ error: "no photo" });
  res.setHeader("content-type", image.source.media_type);
  res.setHeader("cache-control", "private, max-age=604800, immutable");
  return res.status(200).end(Buffer.from(image.source.data, "base64"));
}

async function findNote(store, notePath) {
  for await (const m of client.beta.memoryStores.memories.list(store)) {
    if (m.type === "memory" && m.path === notePath) return m;
  }
  return null;
}

const shortText = (v, max) => typeof v === "string" && v.trim() && v.length <= max && !/[\u0000-\u001f<>]/.test(v);
const whole = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
const realDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00+09:00`));

// 棚の mise.json は福ちゃんの手書きなので、形が合う時だけ猫に渡す。壊れていれば空
function checkMise(text) {
  let d;
  try { d = JSON.parse(text); } catch { return EMPTY_MISE; }
  if (!d || !realDate(d.date) || !Array.isArray(d.items) || !d.lines) return EMPTY_MISE;
  const lines = (a, most = 5) => (Array.isArray(a) ? a.filter((t) => shortText(t, 60)).slice(0, most) : []);
  const items = [];
  for (const it of d.items.slice(0, 12)) {
    if (!it || !shortText(it.name, 40) || !whole(it.price, 1_000_000)) return EMPTY_MISE;
    const item = { name: it.name, price: it.price };
    items.push(item);
  }
  return { date: d.date, items, lines: { greet: lines(d.lines.greet), bye: lines(d.lines.bye), chat: lines(d.lines.chat, 8) } };
}

async function mise(req, res) {
  const store = ids().store;
  const note = await findNote(store, MISE_PATH);
  if (!note) return res.status(200).json(EMPTY_MISE);
  const full = await client.beta.memoryStores.memories.retrieve(note.id, { memory_store_id: store });
  return res.status(200).json(checkMise(full.content ?? ""));
}

// 文字は受け取らない：棚に書くのは検証した日付と数だけ。同じ日は一行にまとめる（数は多い方を残す）
export default async function handler(req, res) {
  if (!process.env.SHOP_CODE || !shopOK(req)) return res.status(403).json({ error: "shop code" });
  const action = req.query.do;
  try {
    if (action === "talk" && req.method === "GET") return await talk(req, res);
    if (action === "say" && req.method === "POST") return await say(req, res);
    if (action === "diary" && req.method === "GET") return await diary(req, res);
    if (action === "shelf" && req.method === "GET") return await shelf(req, res);
    if (action === "mornings" && req.method === "GET") return await mornings(req, res);
    if (action === "photo" && req.method === "GET") return await photo(req, res);
    if (action === "mise" && req.method === "GET") return await mise(req, res);
    return res.status(404).json({ error: "unknown" });
  } catch (e) {
    console.error("techo", action, e.status, e.message); // 鍵は載らない（状態コードと文面だけ）
    return res.status(502).json({ error: "upstream" });
  }
}
