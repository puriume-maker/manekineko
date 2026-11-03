// 助手の本体（環境・エージェント・記憶の棚・止めてある定時起動）を一度だけ作る。
// 作ったものの番号は agent/ids.json に保存し、二回目以降はエージェントの更新だけをする。
// 実行: ANTHROPIC_API_KEY を渡して node agent/setup.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const idsPath = path.join(here, "ids.json");
const system = fs.readFileSync(path.join(here, "system.md"), "utf8");
const morningPrompt = fs.readFileSync(path.join(here, "morning.md"), "utf8");

const client = new Anthropic();
const ids = fs.existsSync(idsPath) ? JSON.parse(fs.readFileSync(idsPath, "utf8")) : {};

const agentConfig = {
  name: "福ちゃん",
  model: "claude-opus-5-5",
  system,
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
    name: "niwa",
    description: "この庭の土地、植えたもの、失敗、計画、店主のことを書きためるノート。",
  });
  ids.store = store.id;
}

const deploymentConfig = {
  name: "朝のひとこと",
  agent: ids.agent,
  environment_id: ids.environment,
  resources: [
    {
      type: "memory_store",
      memory_store_id: ids.store,
      access: "read_write",
      instructions: "庭の記憶の棚。始める前に読み、覚えることはここに書く。",
    },
  ],
  initial_events: [
    { type: "user.message", content: [{ type: "text", text: morningPrompt }] },
  ],
  schedule: { type: "cron", expression: "30 6 * * *", timezone: "Asia/Tokyo" },
  budget: { type: "limit", max_list_cost: { amount: "100", currency: "USD" } },
};

if (ids.deployment) {
  await client.beta.deployments.update(ids.deployment, deploymentConfig);
} else {
  const deployment = await client.beta.deployments.create(deploymentConfig);
  ids.deployment = deployment.id;
}

// 朝は家のカメラ係（home/asa.mjs）が写真つきで起こす。二重に起きないよう、定時起動は止めておく
const deployment = await client.beta.deployments.retrieve(ids.deployment);
if (!deployment.paused_reason) await client.beta.deployments.pause(ids.deployment);

fs.writeFileSync(idsPath, JSON.stringify(ids, null, 2) + "\n");
console.log(JSON.stringify(ids, null, 2));
