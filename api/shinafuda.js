// 品札：店主さんの話しことば（「トマト5袋150円、大葉もちょっと」）を品札の案にする。
// 数字は店主さんが画面で確かめてから確定する（AIの読み違いをそのまま売り場に出さない）
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client, MODEL, shopOK } from "./_claude.js";

const Fuda = z.object({
  items: z.array(z.object({
    name: z.string().describe("品の名前。店主の言い方をそのまま、短く"),
    emoji: z.string().describe("品に合う絵文字1つ"),
    unit: z.string().describe("数え方（袋・束・本・個など）。わからなければ「個」"),
    price: z.number().nullable().describe("1つの値段（円）。言われていなければ null"),
    stock: z.number().nullable().describe("並べる数。言われていなければ null"),
  })),
  question: z.string().describe("値段や数が言われていない品があれば、それを店主に聞くやさしい一文（やわらかい秋田弁）。全部そろっていれば空文字"),
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!shopOK(req)) return res.status(403).json({ error: "shop code" });

  const { words = "" } = req.body || {};
  if (!words.trim()) return res.status(400).json({ error: "words" });

  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low", format: zodOutputFormat(Fuda) },
      system: "庭先の無人販売所の店主が、今日並べる品を話しことばで伝えます。言われたことだけを品札にしてください。言われていない値段や数は推測せず null にしてください。",
      messages: [{ role: "user", content: words }],
    });
    if (!response.parsed_output) return res.status(200).json({ items: [], question: "わりな、うまぐ聞き取れねがった。もう一回しゃべってけれ。" });
    return res.status(200).json(response.parsed_output);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "claude" });
  }
}
