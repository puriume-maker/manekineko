// 福ちゃんの本体（環境・エージェント・記憶の棚・朝と夜の定時起動）を一度だけ作る。
// 作ったものの番号は agent/ids.json に保存し、二回目以降は指示と定時の設定の更新だけをする。棚の中身には触らない。
//   ANTHROPIC_API_KEY を渡して node agent/setup.mjs           作る／更新する（定時が止まっていれば止まったまま）
//   node agent/setup.mjs --start                              定時起動を動かす（朝 7:30、夢 3:00）
//   node agent/setup.mjs --stop                               定時起動を止める
//   MANEKI_IDS_FILE=どこか.json を渡すと、別の棚と別の番号で作る（試験用）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const idsPath = process.env.MANEKI_IDS_FILE || path.join(here, "ids.json");
const read = (name) => fs.readFileSync(path.join(here, name), "utf8");
const start = process.argv.includes("--start");
const stop = process.argv.includes("--stop");

const client = new Anthropic();
const ids = fs.existsSync(idsPath) ? JSON.parse(fs.readFileSync(idsPath, "utf8")) : {};

const agentConfig = {
  name: "福ちゃん",
  model: "claude-opus-5-5",
  system: read("system.md"),
  tools: [
    {
      type: "agent_toolset_20260401",
      default_config: { enabled: true, permission_policy: { type: "auto" } },
      configs: [
        { name: "web_fetch", enabled: false },
        { name: "web_search", enabled: false },
      ],
    },
  ],
};

if (!ids.environment) {
  const environment = await client.beta.environments.create({
    name: "niwa-no-aibou",
    config: {
      type: "cloud",
      networking: { type: "limited", allowed_hosts: ["api.open-meteo.com"] },
    },
  });
  ids.environment = environment.id;
}

if (ids.agent) {
  const current = await client.beta.agents.retrieve(ids.agent);
  await client.beta.agents.update(ids.agent, { ...agentConfig, version: current.version });
} else {
  const agent = await client.beta.agents.create(agentConfig);
  ids.agent = agent.id;
}

if (!ids.store) {
  const store = await client.beta.memoryStores.create({
    name: "techo",
    description: "店主が作っているもの、場所、失敗、計画、好みを書きためるノート。",
  });
  ids.store = store.id;
}

const deploymentOf = (name, prompt, expression, kind) => ({
  name,
  agent: ids.agent, // 更新のたびに、その時の最新の指示に合わせ直す
  environment_id: ids.environment,
  metadata: { kind },
  resources: [
    {
      type: "memory_store",
      memory_store_id: ids.store,
      access: "read_write",
      instructions: "記憶の棚。始める前に読み、覚えることはここに書く。",
    },
  ],
  initial_events: [
    { type: "user.message", content: [{ type: "text", text: prompt }] },
  ],
  schedule: { type: "cron", expression, timezone: "Asia/Tokyo" },
  budget: { type: "limit", max_list_cost: { amount: "100", currency: "USD" } }, // 1会話1ドル
});

// 新しく作った定時起動は、--start まで止めておく。すでにあるものの動く／止まるは変えない
async function ensure(key, config) {
  if (ids[key]) return client.beta.deployments.update(ids[key], config);
  const made = await client.beta.deployments.create(config);
  ids[key] = made.id;
  return client.beta.deployments.pause(made.id);
}

const deployments = [
  ["deployment", await ensure("deployment", deploymentOf("朝のひとこと", read("morning.md"), "30 7 * * *", "asa"))],
  ["yume_deployment", await ensure("yume_deployment", deploymentOf("夜の夢", read("yume.md"), "0 3 * * *", "yume"))],
];
fs.writeFileSync(idsPath, JSON.stringify(ids, null, 2) + "\n"); // 途中で落ちても作った番号を失わない

for (const [key] of deployments) {
  const d = await client.beta.deployments.retrieve(ids[key]);
  if (start && d.paused_reason) await client.beta.deployments.unpause(ids[key]);
  if (stop && !d.paused_reason) await client.beta.deployments.pause(ids[key]);
  const now = await client.beta.deployments.retrieve(ids[key]);
  console.log(`${now.name}: ${now.status} / 次は ${now.schedule?.upcoming_runs_at?.[0] ?? "なし"}（UTC） / 指示の版 ${now.agent.version}`);
}
