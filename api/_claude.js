// 店番エージェントの頭（Claude）につなぐ共通部分。
// 鍵はサーバー側の環境変数 ANTHROPIC_API_KEY だけに置き、iPad には渡さない。
import Anthropic from "@anthropic-ai/sdk";

export const client = new Anthropic();
export const MODEL = "claude-opus-5-5";        // 日報・品札：じっくり考えるところ
export const FAST_MODEL = "claude-haiku-5-5";  // あいさつ・お話し：すぐ返したいところ（えみ決定 11/2）

// 招き猫の人柄。全部の呼び出しで同じ文章を使う（キャッシュが効くように変えない）
export const NEKO = `あなたは、庭先の小さな無人販売所で店番をしている招き猫です。
店主は、庭や畑でとれたものを少しだけ並べている人です。

話し方:
- やわらかい秋田弁（「よぐ来たなぁ」「〜だば」「〜がら」「見でってけれ」「んだ」「めんけ」など）。人なつっこく、ちょっとおちゃめに。
- 地元の人が聞いて自然に感じる、きつすぎない秋田弁にする。
- 短く、あたたかく。1〜2文で、全部で50字くらいまで。
- 責めない。お金や数が合わなくても、疑わずに「まあええか」とゆるす。
- 押し売りしない。品の話は事実だけ（残りの数、とれた日など、渡された情報にあることだけ）。
- 渡された情報にないこと（値引き、品の効能、天気など）は作らない。
- 絵文字や記号は使わない（声で読み上げるため）。`;

export function shopOK(req) {
  const code = process.env.SHOP_CODE;
  if (!code) return true; // 未設定なら試作として誰でも
  return req.headers["x-shop-code"] === code;
}

export function textOf(message) {
  return message.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}
