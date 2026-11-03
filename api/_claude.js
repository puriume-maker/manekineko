// サーバー側の共通部分。鍵はサーバー側の環境変数 ANTHROPIC_API_KEY だけに置き、画面には渡さない。
import Anthropic from "@anthropic-ai/sdk";

export const client = new Anthropic();

export function shopOK(req) {
  const code = process.env.SHOP_CODE;
  if (!code) return false; // 未設定なら閉じる（費用がかかるため）
  return req.headers["x-shop-code"] === code;
}
