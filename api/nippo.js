// 店じまい：その日の記録から、責めない日報と、次の日のための「店番ノート」（記憶）を書く。
// 記録はページ（iPad）から毎回送ってもらい、サーバーには何も残さない
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client, MODEL, NEKO, shopOK } from "./_claude.js";

const Nippo = z.object({
  nippo: z.string().describe("店主に向けた今日の日報。やわらかい秋田弁で、責めない言い方。3〜5文、200字くらいまで。数字は渡されたものだけを使う"),
  note: z.string().describe("次の日からの店番に役立つ『店番ノート』の全文。前のノートを土台に、今日わかったことを足して、古くなったことは消す。事実だけの短い箇条書きで、全部で300字まで"),
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!shopOK(req)) return res.status(403).json({ error: "shop code" });

  const { date, items = [], sales = [], tapTotal = 0, boxTotal = null, note = "" } = req.body || {};
  const record = {
    日付: date,
    並べた品: items.map((it) => ({ 名前: it.name, 値段: it.price, 朝の数: it.startStock, 残り: it.stock, 単位: it.unit })),
    売れた記録: sales.map((s) => ({ 時刻: s.time, 品: s.items.map((b) => `${b.name}×${b.n}`).join("、"), 合計: s.total })),
    タップの合計: tapTotal,
    店主が数えた箱のお金: boxTotal,
    これまでの店番ノート: note || "（まだない）",
  };

  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: "medium", format: zodOutputFormat(Nippo) },
      system: NEKO + `

今は店じまいの時間です。店主に今日の店番の報告をします。
- 人は責めない。でも、お金のずれは店主にとって大事な情報なので、隠さず事実としてはっきり書く（例：「今日は50円足りながった」）。
- 一回きりの小さいずれは、数え間違いのこともあるので騒がない。だれも疑わない。
- 店番ノートを見て、ずれが続いている・大きい・特定の時間帯に多い時は、その傾向を事実で伝え、払いやすくする工夫をひとつだけ添える（例：箱を猫の見える所に置く、値札を大きくする、おつりの小銭を用意する）。犯人さがしはしない。
- 売れなかった日も、店主を励ます。押しつけがましくしない。
- 店番ノートには、時間帯ごとの売れ方、よく売れた品、売れ残った品、お金のずれの日付と額など、次に役立つ事実だけを書く。お客さんの見た目や個人のことは書かない。`,
      messages: [{ role: "user", content: `今日の記録:\n${JSON.stringify(record, null, 1)}` }],
    });
    if (!response.parsed_output) return res.status(200).json({ nippo: null, note });
    return res.status(200).json(response.parsed_output);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "claude" });
  }
}
