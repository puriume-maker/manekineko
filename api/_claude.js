// サーバー側の共通部分。鍵はサーバー側の環境変数 ANTHROPIC_API_KEY だけに置き、画面には渡さない。
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

export const client = new Anthropic();

export function shopOK(req) {
  const code = process.env.SHOP_CODE;
  if (!code) return false; // 未設定なら閉じる（費用がかかるため）
  return req.headers["x-shop-code"] === code;
}

// 店先の鍵：合言葉から作る、店先専用の鍵。店先の札と「ええよ」済みの写真、声にしか使えない。
// 店先の端末には合言葉を置かず、これだけを置く。合言葉を変えると、この鍵も変わる。
export function miseKey() {
  const code = process.env.SHOP_CODE;
  return code ? crypto.createHmac("sha256", code).update("mise-front").digest("base64url") : null;
}

export function miseOK(req) {
  const key = miseKey();
  return Boolean(key) && req.headers["x-mise-key"] === key;
}
