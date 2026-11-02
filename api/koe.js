// 声：招き猫のセリフを Gemini TTS（Laomedeia）で読み上げて WAV で返す。
// 鍵はサーバー側の環境変数 GEMINI_API_KEY だけ。無ければ 204 を返し、ページは iPad の声で代わりに読む
import { shopOK } from "./_claude.js";

const MODEL = "gemini-3.8-flash-tts";
const VOICE = "Laomedeia";
// 演技指示は英語で、台本と分けて書く（混ぜると指示まで読み上げてしまう）
const DIRECTION = "# DIRECTOR'S NOTES\nStyle: friendly, cheerful and a little playful, like a cute shop cat greeting a neighbor, in a soft rural Akita dialect.\n\n# TRANSCRIPT\n";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!shopOK(req)) return res.status(403).json({ error: "shop code" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(204).end();

  const text = String((req.body || {}).text || "").replace(/<[^>]+>/g, "").slice(0, 200).trim();
  if (!text) return res.status(400).json({ error: "text" });

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: DIRECTION + text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        },
      }),
    });
    if (!r.ok) { console.error("gemini", r.status, await r.text()); return res.status(204).end(); }
    const d = await r.json();
    const part = d?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part) return res.status(204).end();
    const audio = Buffer.from(part.inlineData.data, "base64");
    res.setHeader("Content-Type", part.inlineData.mimeType || "audio/wav");
    return res.status(200).send(audio);
  } catch (e) {
    console.error(e);
    return res.status(204).end();
  }
}
