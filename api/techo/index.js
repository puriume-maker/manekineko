// お店の手帳の裏側：助手（Managed Agents）との今の会話、写メ、記憶の棚。
//   GET  /api/techo?do=talk[&session=sesn_…]  今の会話（なければ新しく始める）
//   POST /api/techo?do=say   {text, photo}    発言を送る（photo は JPEG の base64）
//   GET  /api/techo?do=shelf                  記憶の棚の中身
//   GET  /api/techo?do=mornings               朝の一覧（最近7日、写真の番号とひとこと）
//   GET  /api/techo?do=photo&file=file_…      朝の写真（朝の一覧に載っているものだけ）
//   GET  /api/techo?do=mise                   店先の猫が読む札とセリフ（棚の mise.json を検証して返す）
//   POST /api/techo?do=report {date, count}   猫が数えた立ち止まりの人数を棚に残す（会話は起こさない）
// 費用がかかるので、SHOP_CODE が未設定なら閉じる（ここだけ既存の猫のAPIより厳しい）。
import fs from "node:fs";
import { toFile } from "@anthropic-ai/sdk";
import { client, shopOK } from "../_claude.js";

const BUDGET = { type: "limit", max_list_cost: { amount: "100", currency: "USD" } }; // 1会話1ドル
const PHOTO_MARK = "【写真】"; // 写真が届いたことを助手に伝える文。画面には文章として出さない
const BACKSTAGE_MARK = "【裏方】"; // 朝の起動など、店主の発言ではない合図。画面に出さない
const MAX_PHOTO_BASE64 = 4_200_000; // Vercel の本文上限 4.5MB の内側
const MAX_TEXT = 8000;
const MAX_MORNINGS = 7;
const MORNING_SCAN = 200; // 朝を探して見る会話の数の上限
const MISE_PATH = "/mise.json";
const KIROKU_PATH = "/mise_kiroku.md";
const KIROKU_HEAD = "# 猫からの記録（立ち止まった人数。カメラの動きからの目安）";
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

function startSession({ agent, environment, store }) {
  return client.beta.sessions.create({
    agent,
    environment_id: environment,
    budget: BUDGET,
    title: "お店の手帳",
    resources: [{
      type: "memory_store",
      memory_store_id: store,
      access: "read_write",
      instructions: "庭と店のノート。始める前に読み、覚えることはここに書く。",
    }],
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

// 出来事の列を、画面に出す会話へまとめる
function readTalk(events) {
  const messages = [];
  let morning = null;
  let ownerSpoke = false;
  let busy = false;
  let paused = false;
  let failed = false;
  for (const e of events) {
    if (e.type === "user.message") {
      busy = true;
      paused = failed = false;
      const texts = e.content.filter((b) => b.type === "text").map((b) => b.text);
      if (texts.some((t) => t.startsWith(BACKSTAGE_MARK) || t.startsWith("【朝の定時起動"))) continue; // 後ろは印を付ける前の朝の合図
      ownerSpoke = true;
      messages.push({
        id: e.id,
        who: "owner",
        text: texts.filter((t) => !t.startsWith(PHOTO_MARK)).join("\n"),
        photo: texts.some((t) => t.startsWith(PHOTO_MARK)),
        at: e.processed_at,
      });
    } else if (e.type === "agent.message") {
      const text = e.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      if (!text) continue;
      if (!ownerSpoke && !morning) morning = { id: e.id, text, at: e.processed_at };
      else messages.push({ id: e.id, who: "helper", text, at: e.processed_at });
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
  return { messages, morning, busy, paused, failed };
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

  let upload = null;
  if (photo) {
    const bytes = Buffer.from(photo, "base64");
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return res.status(400).json({ error: "not a jpeg" });
    const name = `shamei_${Date.now()}.jpg`;
    upload = {
      path: `/mnt/session/uploads/${name}`,
      file: await client.beta.files.upload({ file: await toFile(bytes, name, { type: "image/jpeg" }) }),
    };
  }

  const c = ids();
  const deliver = async (sessionId) => {
    const content = [];
    if (upload) {
      await client.beta.sessions.resources.add(sessionId, { type: "file", file_id: upload.file.id, mount_path: upload.path });
      content.push({ type: "text", text: `${PHOTO_MARK}店主から写真が届きました。${upload.path} を読んで、写っているものを見てください。ファイルの場所は店主に言わないでください。` });
    }
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
    if (s.metadata?.kind === "asa" && s.metadata.date && !found.has(s.metadata.date)) found.set(s.metadata.date, s);
    if (found.size >= MAX_MORNINGS || ++seen >= MORNING_SCAN) break;
  }
  return [...found.values()];
}

async function firstWord(sessionId) {
  const page = await client.beta.sessions.events.list(sessionId, { types: ["agent.message"], limit: 5 });
  for (const e of page.data) {
    const text = e.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (text) return text;
  }
  return null;
}

async function mornings(req, res) {
  const sessions = await morningSessions();
  const list = await Promise.all(sessions.map(async (s) => ({
    date: s.metadata.date,
    fileId: s.metadata.photo_file_id || null,
    word: await firstWord(s.id),
    looking: s.status === "running" || s.status === "rescheduling",
  })));
  return res.status(200).json({ mornings: list });
}

// 上げたファイルは Files API から取り出せない（生成物だけが取り出せる決まり）ので、
// 朝の合図に添えた写真を、その会話の履歴から読む。朝の一覧にある番号しか受けつけない。
async function photo(req, res) {
  const file = String(req.query.file || "");
  const session = (await morningSessions()).find((s) => s.metadata.photo_file_id && s.metadata.photo_file_id === file);
  if (!session) return res.status(404).json({ error: "not a morning photo" });
  const page = await client.beta.sessions.events.list(session.id, { types: ["user.message"], limit: 1 });
  const image = page.data[0]?.content.find((b) => b.type === "image" && b.source?.type === "base64");
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
    if (it.left !== undefined && it.left !== null) {
      if (!whole(it.left, 100_000)) return EMPTY_MISE;
      item.left = it.left;
    }
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
async function report(req, res) {
  const { date, count } = req.body || {};
  if (!realDate(date) || !whole(count, 100_000)) return res.status(400).json({ error: "bad report" });
  if (Math.abs(Date.parse(`${date}T12:00:00+09:00`) - Date.now()) > 3 * 86_400_000) return res.status(400).json({ error: "bad date" });

  const store = ids().store;
  const lineFor = (n) => `- ${date} 立ち止まった人：${n}人`;
  for (let attempt = 0; ; attempt++) {
    try {
      const found = await findNote(store, KIROKU_PATH);
      if (!found) {
        await client.beta.memoryStores.memories.create(store, { path: KIROKU_PATH, content: `${KIROKU_HEAD}\n${lineFor(count)}\n` });
        return res.status(200).json({ ok: true });
      }
      const note = await client.beta.memoryStores.memories.retrieve(found.id, { memory_store_id: store });
      const rows = (note.content ?? "").split("\n");
      const at = rows.findIndex((r) => r.startsWith(`- ${date} `));
      if (at >= 0) {
        const before = Number(rows[at].match(/：(\d+)人/)?.[1] ?? 0);
        rows[at] = lineFor(Math.max(before, count));
      } else {
        while (rows.length && !rows.at(-1)) rows.pop();
        rows.push(lineFor(count), "");
      }
      await client.beta.memoryStores.memories.update(found.id, {
        memory_store_id: store,
        content: rows.join("\n"),
        precondition: { type: "content_sha256", content_sha256: note.content_sha256 },
      });
      return res.status(200).json({ ok: true });
    } catch (e) {
      if (e.status !== 409 || attempt >= 1) throw e; // 福ちゃんと書くのが重なった時だけ、一度読み直す
    }
  }
}

export default async function handler(req, res) {
  if (!process.env.SHOP_CODE || !shopOK(req)) return res.status(403).json({ error: "shop code" });
  const action = req.query.do;
  try {
    if (action === "talk" && req.method === "GET") return await talk(req, res);
    if (action === "say" && req.method === "POST") return await say(req, res);
    if (action === "shelf" && req.method === "GET") return await shelf(req, res);
    if (action === "mornings" && req.method === "GET") return await mornings(req, res);
    if (action === "photo" && req.method === "GET") return await photo(req, res);
    if (action === "mise" && req.method === "GET") return await mise(req, res);
    if (action === "report" && req.method === "POST") return await report(req, res);
    return res.status(404).json({ error: "unknown" });
  } catch (e) {
    console.error("techo", action, e.status, e.message); // 鍵は載らない（状態コードと文面だけ）
    return res.status(502).json({ error: "upstream" });
  }
}
