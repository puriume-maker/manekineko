// お店の手帳の裏側：助手（Managed Agents）との今の会話、写メ、記憶の棚。
//   GET  /api/techo?do=talk[&session=sesn_…]  今の会話（なければ新しく始める）
//   POST /api/techo?do=say   {text, photos, reply}  発言を送る（photos は JPEG の base64 の並び、最大4枚。reply は {post, about}：どの投稿への返事か）
//   GET  /api/techo?do=diary[&except=sesn_…&skip=N]  今の会話より前の記録と返事（新しい会話から順に数回分）
//   GET  /api/techo?do=shelf                  記憶の棚の中身
//   GET  /api/techo?do=mornings               朝の一覧（最近7日、写真の番号とひとこと）
//   GET  /api/techo?do=photo&file=file_…      カメラの係の写真（朝の一覧に載っているものだけ）
//   GET  /api/techo?do=photo&session=…&event=…[&n=0]  記録の写真（この福ちゃんの会話にあるものだけ。n は何枚目か）
//   GET  /api/techo?do=mise                   店先の猫が読む札とセリフと写真の一覧（棚の mise.json を検証して返す）★
//   GET  /api/techo?do=shashin&id=p_…         店先に出す写真（「ええよ」済みのものだけ。メタデータを落として返す）★
//   GET  /api/techo?do=misekey                店先の鍵（手帳の「店先の猫をひらく」と、開店の合言葉の引き換えに使う）
//   POST /api/techo?do=eeyo    {session, event, n, on}  写真を店先に出してよいかを切り替える
//   POST /api/techo?do=delete  {session, post}  投稿を消す
//   GET  /api/techo?do=deletejob&job=sesn_…   福ちゃんのノートの片付けが済んだか
// ★だけは店先の鍵でも読める。それ以外は合言葉が要る。
// 費用がかかるので、SHOP_CODE が未設定なら閉じる（ここだけ既存の猫のAPIより厳しい）。
import crypto from "node:crypto";
import fs from "node:fs";
import { client, miseKey, miseOK, shopOK } from "../_claude.js";

const BUDGET = { type: "limit", max_list_cost: { amount: "100", currency: "USD" } }; // 1会話1ドル
const DATE_MARK = "【今日】"; // 今日の日付を助手に伝える文。画面には出さない
const PHOTO_MARK = "【写真】"; // 写真が届いたことを助手に伝える文。画面には文章として出さない
const BACKSTAGE_MARK = "【裏方】"; // 朝の起動など、店主の発言ではない合図。画面に出さない
const PHOTO_ONLY_MARK = "【写真だけ】"; // カメラの係が朝の後から写真だけ渡す合図。これへの返答も画面に出さない
const REPLY_MARK = "【返事先:"; // どの投稿への返事かを助手に伝える文。保存場所は作らず、画面はこの印で投稿ごとにまとめる。文面は出さない
const REPLY_END = "への返事です。";
const FIRST_DAY_CUE = `${BACKSTAGE_MARK}店主がはじめて手帳を開きました。棚は空です。短いあいさつのあとで、初日の聞き取りの最初の一つだけを聞いてください。店主に見せる言葉は日本語で、作業の話はしないでください。`;
const INTERVIEW_ANSWERS = 3; // 初日の聞き取りの問いの数。この数だけ答えるまで、手帳は記録欄を開いておく
const NOT_NOTES = new Set(["/yume.md", "/mise_kiroku.md", "/mise_shashin.md"]); // 福ちゃんと猫が書くもの。これだけなら棚はまだ空とみなす
const DIARY_SESSIONS = 10; // 一度に読む過去の会話の数
const DIARY_SCAN = 200;
const MAX_PHOTO_BASE64 = 4_200_000; // 全部の写真の合計。Vercel の本文上限 4.5MB の内側
const MAX_PHOTOS = 4;
const MAX_TEXT = 8000;
const MAX_ABOUT = 240;
const MAX_MORNINGS = 7;
const MORNING_SCAN = 200; // 朝を探して見る会話の数の上限
const MISE_PATH = "/mise.json";
const EMPTY_MISE = { date: null, items: [], lines: { greet: [], bye: [], chat: [] }, photos: [] };
const SHASHIN_PATH = "/mise_shashin.md"; // 「ええよ」の一覧。手帳が書き、福ちゃんは読むだけ。本当の印は会話の metadata にある（福ちゃんには触れない）
const SHASHIN_HEAD = "# 店先に出してよい写真（店主が「ええよ」を押したもの。手帳が書くノートなので書き換えない）";
const MAX_FRONT_PHOTOS = 8;
const META_KEYS = 5; // 印ひと種類に使う metadata の数。合計で16個の上限の内側に収める
const META_LEN = 500; // metadata の値の上限 512 の内側
const KESHI_SWEEP_AFTER = 10 * 60 * 1000; // 手帳が見届けなかった片付けを、後始末するまでの時間

let idsFile; // agent/ids.json は一度だけ読む
function ids() {
  if (idsFile === undefined) {
    try {
      idsFile = JSON.parse(process.env.MANEKI_IDS_FILE
        ? fs.readFileSync(process.env.MANEKI_IDS_FILE, "utf8") // 試験用の別の棚（agent/setup.mjs、home/asa.mjs と同じ）
        : fs.readFileSync(new URL("../../agent/ids.json", import.meta.url), "utf8"));
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

// 会話の metadata に、番号の並びを分けて置く（値は一つ512字まで）
function unpack(meta, prefix) {
  const all = [];
  for (let i = 0; i < META_KEYS; i++) all.push(...(meta?.[`${prefix}${i}`] || "").split(" ").filter(Boolean));
  return all;
}
function pack(prefix, list) {
  const out = {};
  let at = 0;
  let row = "";
  const flush = () => { out[`${prefix}${at++}`] = row || null; row = ""; };
  for (const item of list) {
    if (row.length + item.length + 1 > META_LEN) flush();
    row = row ? `${row} ${item}` : item;
  }
  flush();
  if (at > META_KEYS) throw Object.assign(new Error("metadata full"), { full: true });
  while (at < META_KEYS) out[`${prefix}${at++}`] = null;
  return out;
}
const goneOf = (s) => new Set(unpack(s?.metadata, "gone")); // 消した投稿の番号
const isHidden = (s) => s.metadata?.kind === "yume" || s.metadata?.kind === "keshi"; // 夢と片付けは店主と話す場所ではない

async function ourSession(sessionId) {
  if (!/^sesn_\w+$/.test(sessionId)) return null;
  const s = await client.beta.sessions.retrieve(sessionId).catch((e) => { if (e.status === 404) return null; throw e; });
  return s && s.agent?.id === ids().agent ? s : null;
}

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
    if (isHidden(s)) continue;
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

const isOwnImage = (b) => b.type === "image" && b.source?.type === "base64";

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
// 返事の頭に作業の報告を英語で付けることがある。日本語が一字もない段落が頭にあれば、店主には見せない
function dropForeword(text) {
  const rows = text.split(/\n\s*\n/);
  const jp = /[\u3040-\u30ff\u4e00-\u9fff]/;
  while (rows.length > 1 && !jp.test(rows[0])) rows.shift();
  return rows.join("\n\n");
}

function readTalk(events, session) {
  const messages = [];
  let thread = null;
  let firstDay = false; // 初日の聞き取りの会話か
  let ownerSaid = 0;
  let turnText = "";
  let morning = null;
  let ownerSpoke = false;
  let busy = false;
  let paused = false;
  let failed = false;
  let silent = false; // 写真だけの合図への返答は店主に見せない
  for (const e of events) {
    if (e.type === "user.message") {
      turnText = "";
      busy = true;
      paused = failed = false;
      const texts = e.content.filter((b) => b.type === "text").map((b) => b.text);
      silent = texts.some((t) => t.startsWith(BACKSTAGE_MARK + PHOTO_ONLY_MARK));
      if (texts.includes(FIRST_DAY_CUE)) firstDay = true;
      if (texts.some((t) => t.startsWith(BACKSTAGE_MARK) || t.startsWith("【朝の定時起動"))) continue; // 後ろは印を付ける前の朝の合図
      ownerSpoke = true;
      ownerSaid++;
      const reply = readReplyMark(texts);
      const hasPhoto = texts.some((t) => t.startsWith(PHOTO_MARK));
      thread = reply ? reply.post : e.id;
      messages.push({
        id: e.id,
        who: "owner",
        post: thread,
        ...(reply ? { comment: true, about: reply.about } : {}),
        text: texts.filter((t) => !t.startsWith(PHOTO_MARK) && !t.startsWith(DATE_MARK) && !t.startsWith(REPLY_MARK)).join("\n"),
        photo: hasPhoto,
        photos: hasPhoto ? Math.max(1, e.content.filter(isOwnImage).length) : 0, // 前の作りの写真は履歴に絵が無いが、一枚として扱う
        at: e.processed_at,
      });
    } else if (e.type === "agent.message") {
      const text = dropForeword(e.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim());
      if (!text || silent || text === turnText) continue; // 棚に書いたあとに同じ言葉を言い直すことがあるので、一度だけ出す
      turnText = text;
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
  const gone = goneOf(session);
  const eeyo = unpack(session?.metadata, "ee");
  for (const m of messages) {
    const ok = eeyo.filter((x) => x.startsWith(`${m.id}:`)).map((x) => Number(x.split(":")[1]));
    if (ok.length) m.eeyo = ok;
  }
  return {
    messages: messages.filter((m) => !gone.has(m.post)),
    morning: morning && gone.has(morning.id) ? null : morning,
    thread, interview: firstDay && ownerSaid < INTERVIEW_ANSWERS, busy, paused, failed,
  };
}

async function talk(req, res) {
  const asked = String(req.query.session || "");
  const isAsked = /^sesn_\w+$/.test(asked);
  if (!isAsked) await sweepKeshi();
  const session = isAsked ? await client.beta.sessions.retrieve(asked) : await currentSession(ids());
  const sessionId = session.id;
  const events = [];
  for await (const e of client.beta.sessions.events.list(sessionId, { limit: 1000 })) events.push(e);
  await settlePending(sessionId, events);
  const nudged = await nudgeIfSilent(sessionId, events);
  const talked = readTalk(events, session);
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
  // photo（一枚）は、開いたままの前の画面から届く時のため
  const photos = Array.isArray(req.body?.photos) ? req.body.photos : req.body?.photo ? [req.body.photo] : [];
  if (photos.some((p) => typeof p !== "string" || !p)) return res.status(400).json({ error: "bad photo" });
  if (!text && !photos.length) return res.status(400).json({ error: "empty" });
  if (photos.length > MAX_PHOTOS) return res.status(400).json({ error: "too many photos" });
  if (photos.reduce((sum, p) => sum + p.length, 0) > MAX_PHOTO_BASE64) return res.status(413).json({ error: "photo too large" });
  const replyPost = req.body?.reply ? String(req.body.reply.post || "") : "";
  if (req.body?.reply && !/^[\w-]{1,100}$/.test(replyPost)) return res.status(400).json({ error: "bad reply" });
  // 説明は画面から届く文なので、印のかっこと改行を落としてから助手に渡す
  const about = String(req.body?.reply?.about || "この投稿").replace(/[【】\p{Cc}]/gu, " ").trim().slice(0, MAX_ABOUT);

  for (const p of photos) {
    const bytes = Buffer.from(p, "base64");
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return res.status(400).json({ error: "not a jpeg" });
  }

  const c = ids();
  const deliver = async (sessionId) => {
    const today = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "long" });
    const content = [{ type: "text", text: `${DATE_MARK}${today}` }];
    if (photos.length) {
      // 写真は一つの発言に全部添える。福ちゃんが必ず全部見られて、手帳はこの履歴から写真を読み返せる
      for (const p of photos) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: p } });
      content.push({
        type: "text",
        text: photos.length === 1
          ? `${PHOTO_MARK}店主から写真が届きました。添えてある写真を見てください。`
          : `${PHOTO_MARK}店主から写真が${photos.length}枚届きました。添えてある写真を全部見てください。`,
      });
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

// 今の会話より前の記録。会話ごとに読むので、写真の多い人でも一度に読むのは数回分だけ
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
    if (s.id === except || isHidden(s)) continue;
    if (seen++ < skip) continue;
    if (picked.length === DIARY_SESSIONS) { more = true; break; }
    picked.push(s);
  }
  const sessions = await Promise.all(picked.map(async (s) => {
    const events = [];
    for await (const e of client.beta.sessions.events.list(s.id, { limit: 1000 })) events.push(e);
    const { messages, morning } = readTalk(events, s);
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
    if (first && goneOf(s).has(first.id)) return null; // 消した朝
    return {
      session: s.id,
      date: dateOf(s),
      fileId: s.metadata?.photo_file_id || null,
      id: first?.id ?? null, // 朝の一言も一つの投稿。返事はこの番号へ
      at: first?.at ?? null,
      word: first?.text ?? null,
      looking: s.status === "running" || s.status === "rescheduling",
    };
  }));
  return res.status(200).json({ mornings: list.filter(Boolean) });
}

// 上げたファイルは Files API から取り出せない（生成物だけが取り出せる決まり）ので、
// 発言に添えた写真を、その会話の履歴から読む。
//   file：カメラの係の写真。朝の一覧にある番号しか受けつけない
//   session と event（と n）：記録の写真。この福ちゃんの会話にあるものしか受けつけない
async function photo(req, res) {
  const file = String(req.query.file || "");
  const asked = String(req.query.session || "");
  const eventId = String(req.query.event || "");
  const nth = Math.max(0, Number(req.query.n) || 0);
  let session;
  if (file) {
    session = (await morningSessions()).find((s) => s.metadata?.photo_file_id === file);
    if (!session) return res.status(404).json({ error: "not a morning photo" });
    const first = await firstWord(session.id);
    if (first && goneOf(session).has(first.id)) return res.status(404).json({ error: "no photo" });
  } else {
    if (!/^sesn_\w+$/.test(asked) || !eventId) return res.status(400).json({ error: "bad photo" });
    session = await ourSession(asked);
    if (!session) return res.status(404).json({ error: "not ours" });
  }
  const gone = goneOf(session);
  let image = null;
  for await (const e of client.beta.sessions.events.list(session.id, { types: ["user.message"], limit: 100 })) {
    const texts = e.content.filter((b) => b.type === "text").map((b) => b.text);
    const match = file ? texts.some((t) => t.startsWith(BACKSTAGE_MARK)) : e.id === eventId;
    if (match && (gone.has(e.id) || gone.has(readReplyMark(texts)?.post))) break;
    image = match ? e.content.filter(isOwnImage)[file ? 0 : nth] : null;
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

const PHOTO_ID = /^p_[0-9a-f]{12}$/;
const photoIdOf = (sessionId, event, n) => `p_${crypto.createHash("sha256").update(`${sessionId}|${event}|${n}`).digest("hex").slice(0, 12)}`;
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
  // 写真は福ちゃんが選んだ番号とひとこと。番号は「ええよ」の一覧と照らすまで信じない（frontPhotos）
  const photos = (Array.isArray(d.photos) ? d.photos : [])
    .filter((p) => p && PHOTO_ID.test(p.id) && shortText(p.say, 60))
    .map((p) => ({ id: p.id, say: p.say }));
  return { date: d.date, items, lines: { greet: lines(d.lines.greet), bye: lines(d.lines.bye), chat: lines(d.lines.chat, 8) }, photos };
}

// 「ええよ」が押されている写真の一覧。印は会話の metadata なので、福ちゃんが棚を書き換えても増えない
async function approvedPhotos() {
  const c = ids();
  const found = [];
  let scanned = 0;
  for await (const s of client.beta.sessions.list({ agent_id: c.agent, memory_store_id: c.store, order: "desc", limit: 50 })) {
    if (++scanned > DIARY_SCAN) break;
    if (isHidden(s)) continue;
    const gone = goneOf(s);
    for (const x of unpack(s.metadata, "ee")) {
      const [event, n, minute] = x.split(":");
      if (gone.has(event)) continue;
      found.push({ id: photoIdOf(s.id, event, Number(n)), session: s.id, event, n: Number(n), at: parseInt(minute, 36) * 60_000 });
    }
  }
  return found;
}

// 店先に出す写真：福ちゃんが選んだもののうち「ええよ」が今も押されているものと、
// 福ちゃんが最後に選んだ後で「ええよ」が押されたもの（say は null。次の朝に福ちゃんが選び直す）
async function frontPhotos(chosen, pickedAt) {
  const approved = await approvedPhotos();
  const byId = new Map(approved.map((p) => [p.id, p]));
  const out = [];
  const seen = new Set();
  for (const p of chosen) {
    if (byId.has(p.id) && !seen.has(p.id)) { seen.add(p.id); out.push({ id: p.id, say: p.say }); }
  }
  for (const p of approved) {
    if (!seen.has(p.id) && p.at > pickedAt) { seen.add(p.id); out.push({ id: p.id, say: null }); }
  }
  return out.slice(0, MAX_FRONT_PHOTOS);
}

async function mise(req, res) {
  const store = ids().store;
  const note = await findNote(store, MISE_PATH);
  const full = note && await client.beta.memoryStores.memories.retrieve(note.id, { memory_store_id: store });
  const data = full ? checkMise(full.content ?? "") : EMPTY_MISE;
  const photos = await frontPhotos(data.photos, full ? Date.parse(full.updated_at) : 0);
  res.setHeader("cache-control", "no-store");
  return res.status(200).json({ ...data, photos });
}

// 位置情報などを落とす：JPEG の中の APP（EXIF、XMP、ICC など）とコメント、終わりの後ろのデータを捨てて、絵だけを残す
function stripJpeg(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error("not a jpeg");
  const parts = [b.subarray(0, 2)];
  let i = 2;
  for (;;) {
    if (b[i] !== 0xff) throw new Error("broken jpeg");
    while (b[i + 1] === 0xff) i++; // 詰め物
    const m = b[i + 1];
    if (m === 0xd9) { parts.push(Buffer.from([0xff, 0xd9])); return Buffer.concat(parts); }
    const end = i + 2 + b.readUInt16BE(i + 2);
    if (end > b.length) throw new Error("broken jpeg");
    const tag = (s) => b.subarray(i + 4, i + 4 + s.length).toString("latin1") === s;
    const drop = m === 0xfe || (m >= 0xe0 && m <= 0xef && !(m === 0xe0 && tag("JFIF")) && !(m === 0xee && tag("Adobe")));
    if (!drop) parts.push(b.subarray(i, end));
    i = end;
    if (m === 0xda) { // 絵の本体：次の印まで写す
      let j = i;
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0x00 && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++;
      if (j + 1 >= b.length) throw new Error("broken jpeg");
      parts.push(b.subarray(i, j));
      i = j;
    }
  }
}

// 店先の写真。「ええよ」の一覧にある番号しか受けつけない。会話や投稿の番号はお客さんの側に出さない
async function shashin(req, res) {
  const id = String(req.query.id || "");
  const none = () => res.status(404).json({ error: "no photo" });
  if (!PHOTO_ID.test(id)) return none();
  const p = (await approvedPhotos()).find((x) => x.id === id);
  if (!p) return none();
  let image = null;
  for await (const e of client.beta.sessions.events.list(p.session, { types: ["user.message"], limit: 100 })) {
    if (e.id === p.event) { image = e.content.filter(isOwnImage)[p.n]; break; }
  }
  if (!image) return none();
  res.setHeader("content-type", "image/jpeg");
  res.setHeader("cache-control", "no-store");
  return res.status(200).end(stripJpeg(Buffer.from(image.source.data, "base64")));
}

// 福ちゃんが読む「ええよ」の一覧を直す。remove の行を消し、add の行を足す
async function editShashinNote(store, remove, add) {
  const note = await findNote(store, SHASHIN_PATH);
  const full = note && await client.beta.memoryStores.memories.retrieve(note.id, { memory_store_id: store });
  const rows = (full?.content ?? "").split("\n").filter((l) => l.startsWith("- ") && !remove.some((id) => l.startsWith(`- ${id} `)));
  rows.push(...add);
  if (!rows.length) {
    if (note) await client.beta.memoryStores.memories.delete(note.id, { memory_store_id: store });
    return;
  }
  const content = `${SHASHIN_HEAD}\n\n${rows.join("\n")}\n`;
  if (note) await client.beta.memoryStores.memories.update(note.id, { memory_store_id: store, content });
  else await client.beta.memoryStores.memories.create(store, { path: SHASHIN_PATH, content });
}

// 手帳の「ええよ」。押すと店先に出す候補になり、もう一度押すと取り消す
async function eeyo(req, res) {
  const { session: sessionId, event, n, on } = req.body || {};
  if (typeof event !== "string" || !Number.isInteger(n) || n < 0 || typeof on !== "boolean") return res.status(400).json({ error: "bad" });
  const session = await ourSession(String(sessionId));
  if (!session) return res.status(404).json({ error: "no photo" });
  let found = null;
  for await (const e of client.beta.sessions.events.list(session.id, { types: ["user.message"], limit: 100 })) {
    if (e.id === event) { found = e; break; }
  }
  const texts = (found?.content ?? []).filter((b) => b.type === "text").map((b) => b.text);
  const backstage = texts.some((t) => t.startsWith(BACKSTAGE_MARK));
  if (!found || backstage || !found.content.filter(isOwnImage)[n] || goneOf(session).has(event)) return res.status(404).json({ error: "no photo" });

  const key = `${event}:${n}`;
  const list = unpack(session.metadata, "ee").filter((x) => !x.startsWith(`${key}:`));
  if (on) list.push(`${key}:${Math.floor(Date.now() / 60_000).toString(36)}`);
  try {
    await client.beta.sessions.update(session.id, { metadata: pack("ee", list) });
  } catch (e) {
    if (e.full) return res.status(507).json({ error: "full" });
    throw e;
  }
  const id = photoIdOf(session.id, event, n);
  const words = texts.filter((t) => !t.startsWith(PHOTO_MARK) && !t.startsWith(DATE_MARK) && !t.startsWith(REPLY_MARK)).join(" ").replace(/\s+/g, " ").slice(0, 120);
  const when = found.processed_at ? new Date(found.processed_at).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }) : "";
  await editShashinNote(ids().store, [id], on ? [`- ${id} / ${when} / ${n + 1}枚目 / 店主の言葉「${words || "写真だけ"}」`] : []);
  return res.status(200).json({ on });
}

// ---------- 投稿を消す ----------
// 会話の履歴の出来事は一つずつ消せない。だから：
//   1. その投稿を含む会話に「消した」の印を付けて、手帳と店先に二度と出さない（印は metadata、福ちゃんは触れない）
//   2. 投稿しか残っていない会話は、会話ごと本当に消す（写真の実体も消える）
//   3. 福ちゃんが覚えたままにならないよう、新しい会話に移る
//   4. 片付けの会話を起こして、棚から投稿に由来する行を消してもらう。済んだら棚の古い版も消し、片付けの会話も消す
function keshiCue(parts, photoIds, dateText) {
  const body = parts.map((m) => `${m.who === "owner" ? "店主" : "福ちゃん"}: ${m.text || "（写真だけ）"}${m.photos ? `（写真${m.photos}枚）` : ""}`).join("\n");
  return [
    `${BACKSTAGE_MARK}店主が手帳の投稿を一つ消しました。店主は、この投稿を福ちゃんの記憶からも消すことを望んでいます。店主はいません。`,
    "棚の全ノートを読み、下の投稿に由来する記述だけを取り除いて書き直してください。",
    "- 「古くなったことは消さない」の決まりより、この依頼を優先します",
    "- 消すもの：投稿の言葉、投稿の写真について書いた行、投稿からだけ生まれた推測・提案・計画・夢の行、mise.json のセリフや品や photos のうちこの投稿だけを根拠にしたもの",
    "- 他の投稿にも根拠があることは残す。関係のない行は一字も変えない",
    "- 「消した」という記録やメモは残さない。中身がなくなったノートはファイルごと消す。mise.json を書き直す時は JSON として正しく保つ",
    "- mise_shashin.md は書き換えない",
    ...(photoIds.length ? [`- mise.json の photos に次の番号があれば外す：${photoIds.join(" ")}`] : []),
    "- 店主に見せる言葉はいりません。終わったら「済みました」とだけ書いてください",
    "",
    `## 消す投稿（${dateText}）`,
    body,
  ].join("\n");
}

async function removePost(req, res) {
  const c = ids();
  const post = String(req.body?.post || "");
  const head = await ourSession(String(req.body?.session || ""));
  if (!/^[\w-]{1,100}$/.test(post) || !head) return res.status(404).json({ error: "no post" });

  // 返事は後の会話にもあるので、投稿のある会話から今までを見る
  const sessions = [];
  for await (const s of client.beta.sessions.list({ agent_id: c.agent, memory_store_id: c.store, order: "desc", limit: 50 })) {
    if (s.created_at < head.created_at || sessions.length >= DIARY_SCAN) break;
    if (!isHidden(s)) sessions.push(s);
  }
  if (sessions.some((s) => s.status === "running" || s.status === "rescheduling")) return res.status(409).json({ error: "busy" });

  const touched = [];
  await Promise.all(sessions.map(async (s) => {
    const events = [];
    for await (const e of client.beta.sessions.events.list(s.id, { limit: 1000 })) events.push(e);
    const talked = readTalk(events, s);
    const parts = talked.messages.filter((m) => m.post === post);
    const morning = talked.morning?.id === post ? talked.morning : null;
    if (parts.length || morning) touched.push({ s, parts: [...(morning ? [{ ...morning, who: "helper" }] : []), ...parts], talked });
  }));
  if (!touched.length) return res.status(404).json({ error: "no post" });
  touched.sort((a, b) => a.s.created_at.localeCompare(b.s.created_at));

  const removedPhotos = [];
  for (const { s, parts, talked } of touched) {
    const eventIds = new Set(parts.map((m) => m.id));
    const ee = unpack(s.metadata, "ee");
    for (const x of ee) {
      const [event, n] = x.split(":");
      if (eventIds.has(event)) removedPhotos.push(photoIdOf(s.id, event, Number(n)));
    }
    await client.beta.sessions.update(s.id, { metadata: {
      ...pack("gone", [...goneOf(s), post]),
      ...pack("ee", ee.filter((x) => !eventIds.has(x.split(":")[0]))),
    } });
    // 他に何も残らない会話は、会話ごと消す（写真の実体もここで消える）
    const left = talked.messages.filter((m) => m.post !== post).length + (talked.morning && talked.morning.id !== post ? 1 : 0);
    if (!left) {
      await client.beta.sessions.delete(s.id).catch((e) => console.error("session delete", e.status));
      if (s.metadata?.photo_file_id) await client.beta.files.delete(s.metadata.photo_file_id).catch((e) => console.error("file delete", e.status));
    }
  }
  if (removedPhotos.length) await editShashinNote(c.store, removedPhotos, []);

  const parts = touched.flatMap((t) => t.parts);
  const since = parts.map((m) => m.at).filter(Boolean).sort()[0] || head.created_at;
  const job = await client.beta.sessions.create({
    agent: c.agent,
    environment_id: c.environment,
    budget: BUDGET,
    title: "ノートの片付け",
    metadata: { kind: "keshi", since },
    resources: [{ type: "memory_store", memory_store_id: c.store, access: "read_write", instructions: "店主のノート。" }],
    initial_events: [{ type: "user.message", content: [{ type: "text", text: keshiCue(parts, removedPhotos, new Date(since).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" })) }] }],
  });
  await startSession(c); // 消した投稿を覚えている会話には戻らない
  return res.status(200).json({ job: job.id });
}

// 片付けの仕上げ：棚に店主の言葉がそのまま残っていないかを確かめ、棚の古い版を消し、片付けの会話も消す
async function finishKeshi(s) {
  const { store } = ids();
  const events = [];
  for await (const e of client.beta.sessions.events.list(s.id, { limit: 200 })) events.push(e);
  const cue = events.find((e) => e.type === "user.message")?.content.find((b) => b.type === "text")?.text ?? "";
  const said = cue.split("\n").filter((l) => l.startsWith("店主: ")).join(" ").slice(4);
  const pieces = said.split(/[。、！？!?,.\s（）「」]+/).filter((t) => t.length >= 6);

  const left = [];
  const current = new Set();
  for await (const m of client.beta.memoryStores.memories.list(store, { view: "full" })) {
    if (m.type !== "memory") continue;
    current.add(m.memory_version_id);
    if (m.path !== SHASHIN_PATH && pieces.some((t) => (m.content ?? "").includes(t))) left.push(m.path);
  }
  let redacted = 0;
  for await (const v of client.beta.memoryStores.memoryVersions.list(store, { "created_at[gte]": s.metadata.since })) {
    if (current.has(v.id) || v.redacted_at) continue;
    await client.beta.memoryStores.memoryVersions.redact(v.id, { memory_store_id: store }).then(() => redacted++).catch((e) => console.error("redact", e.status));
  }
  await client.beta.sessions.delete(s.id).catch((e) => console.error("keshi delete", e.status));
  return { left, redacted };
}

// 作られた直後の会話も idle に見えることがあるので、働き終えた印を見る
async function keshiEnded(s) {
  if (s.status === "terminated") return true;
  if (s.status !== "idle") return false;
  const page = await client.beta.sessions.events.list(s.id, { types: ["session.status_idle"], order: "desc", limit: 1 });
  const stop = page.data[0]?.stop_reason?.type;
  return Boolean(stop) && stop !== "requires_action";
}

async function deleteJob(req, res) {
  const s = await ourSession(String(req.query.job || ""));
  if (!s || s.metadata?.kind !== "keshi") return res.status(200).json({ done: true, left: [] }); // もう後始末されている
  if (!(await keshiEnded(s))) return res.status(200).json({ done: false });
  const { left } = await finishKeshi(s);
  return res.status(200).json({ done: true, left });
}

// 手帳が途中で閉じられて見届けられなかった片付けの後始末。手帳を開いた時に一度だけ見る
async function sweepKeshi() {
  try {
    const c = ids();
    let seen = 0;
    for await (const s of client.beta.sessions.list({ agent_id: c.agent, memory_store_id: c.store, order: "desc", limit: 20 })) {
      if (++seen > 20) break;
      if (s.metadata?.kind === "keshi" && Date.now() - Date.parse(s.created_at) > KESHI_SWEEP_AFTER && (await keshiEnded(s))) await finishKeshi(s);
    }
  } catch (e) {
    console.error("sweep", e.status);
  }
}

// 文字は受け取らない：棚に書くのは検証した日付と数だけ。同じ日は一行にまとめる（数は多い方を残す）
export default async function handler(req, res) {
  const action = req.query.do;
  const forFront = action === "mise" || action === "shashin"; // お客さんの面から読めるのはここだけ
  if (!process.env.SHOP_CODE || !(shopOK(req) || (forFront && miseOK(req)))) return res.status(403).json({ error: "shop code" });
  try {
    if (action === "talk" && req.method === "GET") return await talk(req, res);
    if (action === "say" && req.method === "POST") return await say(req, res);
    if (action === "diary" && req.method === "GET") return await diary(req, res);
    if (action === "shelf" && req.method === "GET") return await shelf(req, res);
    if (action === "mornings" && req.method === "GET") return await mornings(req, res);
    if (action === "photo" && req.method === "GET") return await photo(req, res);
    if (action === "mise" && req.method === "GET") return await mise(req, res);
    if (action === "shashin" && req.method === "GET") return await shashin(req, res);
    if (action === "misekey" && req.method === "GET") { res.setHeader("cache-control", "no-store"); return res.status(200).json({ key: miseKey() }); }
    if (action === "eeyo" && req.method === "POST") return await eeyo(req, res);
    if (action === "delete" && req.method === "POST") return await removePost(req, res);
    if (action === "deletejob" && req.method === "GET") return await deleteJob(req, res);
    return res.status(404).json({ error: "unknown" });
  } catch (e) {
    console.error("techo", action, e.status, e.message); // 鍵は載らない（状態コードと文面だけ）
    return res.status(502).json({ error: "upstream" });
  }
}
