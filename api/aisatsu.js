// いらっしゃい：その場の様子（時間・残り数・さっきのセリフ）から、毎回ちがうひとこと
import { client, FAST_MODEL, NEKO, shopOK, textOf } from "./_claude.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!shopOK(req)) return res.status(403).json({ error: "shop code" });

  const { scene = "greet", now, items = [], recent = [], cart = null, note = "", heard = "", mode = "miseban" } = req.body || {};
  const situation = {
    店番ノート: note || undefined, // これまでの日にわかったこと（記憶）
    場面: { greet: "お客さんが近づいてきた", talk: "お客さんが話しかけてきたので答える。30字以内の一文で短く（聞き取りの文字は間違っていることがある。意味がわからなければ、やさしく聞き返す）", thanks: "お客さんがお金を入れてくれた（金額や品名には触れず、どの買い物にも合うお礼にする）" }[scene] || scene,
    いまの時刻: now,
    きょうの品: items.map((it) => ({ 名前: it.name, 値段: it.price, 残り: `${it.stock}${it.unit}` })),
    お会計: cart,
    お客さんが話しかけた言葉: heard ? String(heard).slice(0, 200) : undefined,
    お店のやり方: mode === "reji" ? "お客さんが画面で品をタップして合計を出す" : "お客さんは画面をさわらず、品を取ってお代を箱に入れる",
    さっき言ったセリフ: recent.slice(-3),
  };

  try {
    const message = await client.messages.create({
      model: FAST_MODEL,
      max_tokens: 1000,
      output_config: { effort: "low" },
      system: NEKO,
      messages: [{
        role: "user",
        content: `いまの様子:\n${JSON.stringify(situation, null, 1)}\n\n招き猫として、ひとことだけ返してください。さっき言ったセリフとは違う言い方にしてください。店番ノートにあることを、ときどき自然に一言まぜてもかまいません（毎回でなくてよい）。守ること：
- 「いまの様子」に書いてあることだけを話す。とれた日・味・産地・効能など、書いていないことは言わない。
- お金の計算や値引きの約束はしない（値段は品の値段のとおり）。あと払い（ツケ）やおつりなど、店主が決めることは勝手に約束せず「店主さんさ伝えでおぐね」と言う。
- 「まあええが」などで、お代を払わなくてよいと受け取れる言い方はしない。
セリフだけを書いてください。`,
      }],
    });
    if (message.stop_reason === "refusal") return res.status(200).json({ line: null });
    return res.status(200).json({ line: textOf(message) });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ line: null }); // 失敗したらページ側の決まり文句にまかせる
  }
}
