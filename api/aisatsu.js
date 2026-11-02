// いらっしゃい：その場の様子（時間・残り数・さっきのセリフ）から、毎回ちがうひとこと
import { client, MODEL, NEKO, shopOK, textOf } from "./_claude.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!shopOK(req)) return res.status(403).json({ error: "shop code" });

  const { scene = "greet", now, items = [], recent = [], cart = null, note = "" } = req.body || {};
  const situation = {
    店番ノート: note || undefined, // これまでの日にわかったこと（記憶）
    場面: { greet: "お客さんが近づいてきた", thanks: "お客さんがお金を入れてくれた（金額や品名には触れず、どの買い物にも合うお礼にする）" }[scene] || scene,
    いまの時刻: now,
    きょうの品: items.map((it) => ({ 名前: it.name, 値段: it.price, 残り: `${it.stock}${it.unit}` })),
    お会計: cart,
    さっき言ったセリフ: recent.slice(-3),
  };

  try {
    const message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: NEKO,
      messages: [{
        role: "user",
        content: `いまの様子:\n${JSON.stringify(situation, null, 1)}\n\n招き猫として、ひとことだけ返してください。さっき言ったセリフとは違う言い方にしてください。店番ノートにあることを、ときどき自然に一言まぜてもかまいません（毎回でなくてよい）。セリフだけを書いてください。`,
      }],
    });
    if (message.stop_reason === "refusal") return res.status(200).json({ line: null });
    return res.status(200).json({ line: textOf(message) });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ line: null }); // 失敗したらページ側の決まり文句にまかせる
  }
}
