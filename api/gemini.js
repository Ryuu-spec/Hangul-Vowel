// api/gemini.js — Vercel Serverless Function
// Gemini 프록시. 요청 시 cache:true를 명시한 경우에만 Upstash Redis로 응답을 캐싱한다.
//   - Call 1(언어 감지 / 한글 표기 생성)은 같은 이름이면 결과가 바뀌지 않으므로 캐싱 적용
//   - Call 2(개인화 시 생성)는 호출할 때마다 새로 지어야 하므로 캐싱하지 않음 (cache 미전달)

import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";

const redis = Redis.fromEnv();
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30일

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not set" });

  const { prompt, cache } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  const useCache = cache === true;
  const cacheKey = useCache ? `gemini:${createHash("sha256").update(prompt).digest("hex")}` : null;

  if (useCache) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        return res.status(200).json(cached);
      }
    } catch (err) {
      console.error("[gemini redis get error]", err);
    }
  }
  res.setHeader("X-Cache", useCache ? "MISS" : "BYPASS");

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
            temperature: 0
          }
        })
      }
    );

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: JSON.stringify(data) });

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const result = { text };

    if (useCache) {
      try {
        await redis.set(cacheKey, result, { ex: CACHE_TTL_SECONDS });
      } catch (err) {
        console.error("[gemini redis set error]", err);
      }
    }

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
