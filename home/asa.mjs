// 家のカメラ係：毎朝1回、家のMacで動く。福ちゃんが夢を見終えてから、庭を1枚撮って朝の会話を始める。
//   node home/asa.mjs            きょうの分がまだなら動く
//   node home/asa.mjs --force    きょうの分があっても、夢も朝ももう一度動く
//   node home/asa.mjs --yume-only  夢だけ見る（確かめる時用）
// 鍵は ~/.config/manekineko/.env、カメラは ~/.config/manekineko/camera.env から読む。
// どちらの中身もログや画面に出さない。写真は ~/.local/share/manekineko/photos に置く（リポジトリには入らない）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic, { toFile } from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.join(os.homedir(), ".config/manekineko");
const photoDir = path.join(os.homedir(), ".local/share/manekineko/photos");
const indexPath = path.join(photoDir, "index.json");
const UPLOADS = "/mnt/session/uploads";
const BUDGET = { type: "limit", max_list_cost: { amount: "100", currency: "USD" } }; // 1会話1ドル
const MAX_JPEG = 3_500_000; // 手帳で写真を返す時の上限（Vercel 4.5MB）の内側
const DAY = 24 * 60 * 60 * 1000;
const YUME_TIMEOUT = 5 * 60 * 1000;
const YUME_POLL = 5000;

const force = process.argv.includes("--force");
const yumeOnly = process.argv.includes("--yume-only");
const now = new Date();
const dateOf = (d) => d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }); // YYYY-MM-DD
const today = dateOf(now);

function readEnv(file, name) {
  const m = fs.readFileSync(path.join(configDir, file), "utf8").match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("写真の台帳が読めないので、控えに移して作り直します");
      fs.renameSync(indexPath, `${indexPath}.broken`);
    }
    return { shots: [] };
  }
}
const writeIndex = (index) => fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");

// ffmpeg のエラーからカメラの住所と番号を伏せて、1行にする
function redact(text, url) {
  return text.split(url).join("[カメラ]")
    .replace(/rtsps?:\/\/\S+/gi, "[カメラ]")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "[住所]")
    .trim().split("\n").pop().slice(0, 160);
}

function grab(url, out, quality) {
  return new Promise((resolve, reject) => {
    const longSide1600 = "scale='if(gt(iw,ih),min(1600,iw),-2)':'if(gt(iw,ih),-2,min(1600,ih))'";
    const p = spawn("ffmpeg", [
      "-y", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", url,
      "-frames:v", "1", "-vf", longSide1600, "-q:v", String(quality), "-update", "1", out,
    ], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` }, // 定時起動では PATH が短い
    });
    let err = "";
    p.stderr.on("data", (c) => { err += c; });
    const timer = setTimeout(() => p.kill("SIGKILL"), 40_000);
    p.on("error", () => { clearTimeout(timer); reject(new Error("ffmpeg を起動できません")); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 終了 ${code ?? "時間切れ"}: ${redact(err, url)}`));
    });
  });
}

// 撮る。失敗したら null を返す（止まらない）
async function shoot() {
  try {
    const url = readEnv("camera.env", "NIWA_CAMERA_RTSP");
    if (!url) throw new Error("カメラの設定がありません");
    const tmp = path.join(photoDir, `.${today}.tmp.jpg`);
    try {
      await grab(url, tmp, 3);
      if (fs.statSync(tmp).size > MAX_JPEG) await grab(url, tmp, 8);
      const bytes = fs.readFileSync(tmp);
      if (bytes.length < 1000 || bytes.length > MAX_JPEG || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("写真の大きさが想定外です");
      const file = path.join(photoDir, `${today}.jpg`);
      fs.renameSync(tmp, file);
      return bytes;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  } catch (e) {
    console.error(`カメラ失敗: ${e.message}`);
    return null;
  }
}

// 比べる写真：7日前にいちばん近い過去の1枚。--force の時だけ、きょう先に撮った分も過去に数える
function pickEarlier(shots) {
  const target = now.getTime() - 7 * DAY;
  const past = shots.filter((s) => s.file_id && (s.date < today || (force && s.at < now.toISOString())));
  past.sort((a, b) => Math.abs(new Date(a.at) - target) - Math.abs(new Date(b.at) - target) || b.at.localeCompare(a.at));
  return past[0] || null;
}

function cue(todayFile, earlier) {
  const lines = [fs.readFileSync(path.join(here, "../agent/morning.md"), "utf8").trim(), "", `## 今朝の写真（きょうは ${today}）`];
  if (todayFile) {
    lines.push(`今朝の写真はこの合図に添えてあります。同じものが ${UPLOADS}/kyou.jpg にもあります。`);
    if (earlier) lines.push(`前の写真は ${UPLOADS}/mae.jpg です（${dateOf(new Date(earlier.at))} ${new Date(earlier.at).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "numeric", minute: "2-digit" })} 撮影）。読んで今朝の写真と比べてください。`);
    else lines.push("前の写真はありません。今朝が最初の一枚です。");
  } else {
    lines.push("今朝はカメラが撮れず、写真がありません。庭の様子は書かず、写真が撮れなかったことを短く伝えてください。");
  }
  return lines.join("\n");
}

const shelf = (ids) => ({
  type: "memory_store",
  memory_store_id: ids.store,
  access: "read_write",
  instructions: "庭の記憶の棚。始める前に読み、覚えることはここに書く。",
});

// 夢が終わるまで待つ。時間切れや確認待ちなら止めて先へ進む
async function waitForDream(client, sessionId) {
  const deadline = Date.now() + YUME_TIMEOUT;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, YUME_POLL));
    let stop = null;
    try {
      const page = await client.beta.sessions.events.list(sessionId, { types: ["session.status_idle", "session.status_terminated"], order: "desc", limit: 1 });
      const last = page.data[0];
      if (last) stop = last.type === "session.status_terminated" ? "terminated" : last.stop_reason?.type;
    } catch {
      continue; // 通信の揺れは、時間切れまで待ち直す
    }
    if (stop === "requires_action") break;
    if (stop) return stop;
  }
  await client.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] }).catch(() => {});
  return "timeout";
}

// 夢を見る。何があっても朝は止めない
async function dream(client, ids, index) {
  try {
    const session = await client.beta.sessions.create({
      agent: ids.agent,
      environment_id: ids.environment,
      budget: BUDGET,
      title: `夢 ${today}`,
      metadata: { kind: "yume", date: today },
      resources: [shelf(ids)],
      initial_events: [{
        type: "user.message",
        content: [{ type: "text", text: `${fs.readFileSync(path.join(here, "../agent/yume.md"), "utf8").trim()}\n\nきょうは ${today} です。` }],
      }],
    });
    index.dreams.push({ date: today, at: new Date().toISOString(), session: session.id });
    writeIndex(index);
    const stop = await waitForDream(client, session.id);
    if (stop !== "end_turn") console.error(`夢が途中で終わりました: ${stop}`);
    console.log(JSON.stringify({ yume: session.id, stop }));
  } catch (e) {
    console.error(`夢を見られませんでした: ${e.status ?? e.message}`);
  }
}

async function main() {
  fs.mkdirSync(photoDir, { recursive: true, mode: 0o700 });
  const index = readIndex();
  index.dreams ||= [];
  if (!yumeOnly && !force && index.shots.some((s) => s.date === today && s.session)) {
    console.log(`${today} の朝はもう済んでいます（やり直すなら --force）`);
    return;
  }

  const apiKey = readEnv(".env", "ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("鍵が見つかりません");
  const client = new Anthropic({ apiKey });
  const ids = JSON.parse(fs.readFileSync(path.join(here, "../agent/ids.json"), "utf8"));

  if (force || !index.dreams.some((d) => d.date === today)) await dream(client, ids, index);
  if (yumeOnly) return;

  const bytes = await shoot();
  let fileId = null;
  if (bytes) {
    try {
      const uploaded = await client.beta.files.upload({ file: await toFile(bytes, `${today}.jpg`, { type: "image/jpeg" }) });
      fileId = uploaded.id;
    } catch (e) {
      console.error(`写真を上げられません: ${e.status ?? e.message}`);
    }
  }
  const earlier = fileId ? pickEarlier(index.shots) : null;

  const shot = { date: today, at: now.toISOString(), file_id: fileId, session: null };
  index.shots.push(shot);
  writeIndex(index);

  const startSession = (withEarlier) => {
    const resources = [shelf(ids)];
    if (fileId) resources.push({ type: "file", file_id: fileId, mount_path: `${UPLOADS}/kyou.jpg` });
    if (withEarlier) resources.push({ type: "file", file_id: withEarlier.file_id, mount_path: `${UPLOADS}/mae.jpg` });

    const content = [];
    // 写真は合図にも添える：福ちゃんが必ず見られる。上げたファイルは後から取り出せない決まりなので、
    // 手帳はこの会話の履歴から写真を読む（api/techo/index.js の photo）
    if (bytes && fileId) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: bytes.toString("base64") } });
    content.push({ type: "text", text: cue(Boolean(fileId), withEarlier) });

    const metadata = { kind: "asa", date: today };
    if (fileId) metadata.photo_file_id = fileId;
    return client.beta.sessions.create({
      agent: ids.agent,
      environment_id: ids.environment,
      budget: BUDGET,
      title: `朝 ${today}`,
      metadata,
      resources,
      initial_events: [{ type: "user.message", content }],
    });
  };

  let session;
  try {
    session = await startSession(earlier);
  } catch (e) {
    if (!earlier) throw e;
    console.error(`前の写真をつけられません: ${e.status ?? e.message}`); // 消えた写真など。前の写真なしでやり直す
    session = await startSession(null);
  }
  shot.session = session.id;
  writeIndex(index);
  console.log(JSON.stringify({ date: today, session: session.id, photo: Boolean(fileId), earlier: earlier?.at ?? null, photoBytes: bytes?.length ?? 0 }));
}

main().catch((e) => {
  console.error(`朝の係が止まりました: ${e.status ?? ""} ${e.message}`);
  process.exitCode = 1;
});
