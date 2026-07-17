// api/gemini.js — Vercel Serverless Function
// Gemini 프록시. 요청 시 cache:true를 명시한 경우에만 Upstash Redis로 응답을 캐싱한다.
//   - Call 1(언어 감지 / 한글 표기 생성)은 같은 이름이면 결과가 바뀌지 않으므로 캐싱 적용
//   - Call 2(개인화 시 생성)는 호출할 때마다 새로 지어야 하므로 캐싱하지 않음 (cache 미전달)

import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";

const redis = Redis.fromEnv();
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30일

// TODO: 필요한 금칙어를 채워 넣을 것 (대소문자 무시하고 부분 일치로 검사)
const BLOCKLIST = [];

const SAFE_FALLBACKS = [
  "이름에 깃든 기운이 한글의 결을 따라 흐릅니다.",
  "고요한 마음이 한글의 여백 속에 머뭅니다.",
  "이름의 뜻이 한글의 선을 따라 조용히 피어납니다."
];

function violatesContentSafety(text) {
  if (!text) return false;
  if (/[<>]/.test(text)) return true;
  const lower = text.toLowerCase();
  return BLOCKLIST.some((word) => word && lower.includes(word.toLowerCase()));
}

function pickSafeFallback() {
  return SAFE_FALLBACKS[Math.floor(Math.random() * SAFE_FALLBACKS.length)];
}

// ── 형식 검증 (숫자만/문자 없음/1자 이하, index.html과 동일한 검사) ──
function isInvalidNameFormat(name) {
  const trimmed = String(name || "").trim();
  if (trimmed.length <= 1) return true;
  if (/^[0-9]+$/.test(trimmed)) return true;
  if (!/[a-zA-Z가-힣]/.test(trimmed)) return true;
  return false;
}

// ── 부적절 입력 필터 (영문 이름 입력이 기본이지만, 한글을 그대로 붙여넣는 경우까지 방어. index.html과 동일한 검사를 서버에서도 이중 방어) ──
const ENGLISH_PROFANITY_LIST = [
  "fuck", "shit", "bitch", "asshole", "bastard", "cunt", "dick", "pussy", "whore", "slut", "cock", "douchebag", "motherfucker"
];
const KOREAN_PROFANITY_ROMANIZED_LIST = [
  "sibal", "shibal", "ssibal", "sibalnom", "sibalnyeon", "gaesaekki", "byeongshin", "byungshin", "jokka", "saekki"
];
const KOREAN_PROFANITY_LIST = [
  "씨발", "시발", "씨발놈", "씨발년", "개새끼", "병신", "좆까", "새끼", "미친놈", "좆"
];

function normalizeForProfanityCheck(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
}

function containsProfanity(name) {
  const normalized = normalizeForProfanityCheck(name);
  if (!normalized) return false;
  return ENGLISH_PROFANITY_LIST.some((w) => normalized.includes(w))
      || KOREAN_PROFANITY_ROMANIZED_LIST.some((w) => normalized.includes(w))
      || KOREAN_PROFANITY_LIST.some((w) => normalized.includes(w));
}

// 프롬프트에 박혀 있는 `이름 "..."` / `이름: "..."` 패턴에서 사용자가 입력한 이름을 최대한 복원한다.
// (Call 1/Call 2 프롬프트 둘 다 이 형태로 이름을 담고 있음. 못 찾아도 클라이언트가 curName으로 폴백하므로 안전함)
function extractNameFromPrompt(prompt) {
  const m = /이름[:\s]*"([^"]+)"/.exec(prompt || "");
  return m ? m[1] : "";
}

// 안전 필터에 걸렸을 때, 각 호출이 기대하는 JSON 스키마 그대로 안전한 값을 채워 반환한다.
// (파싱 에러를 유발해 기존 재시도/alert 로직으로 새지 않도록, 정상 응답과 동일한 모양을 유지)
function buildSafeFallbackJson(type, prompt) {
  if (type === "poem") {
    return { poem: pickSafeFallback() };
  }
  if (type === "detect") {
    const name = extractNameFromPrompt(prompt);
    return {
      options: [
        {
          lang: "알 수 없음",
          nativeLabel: "알 수 없음",
          native: name,
          korean: "이름",
          note: "안전한 기본값으로 대체되었습니다."
        }
      ]
    };
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not set" });

  const { prompt, cache, type } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  // 클라이언트 필터를 우회해 API를 직접 호출하는 경우에 대비한 서버단 이중 방어.
  // 걸리면 Gemini를 호출하지 않고 바로 안전한 대체 콘텐츠를 반환한다.
  const extractedName = extractNameFromPrompt(prompt);
  if (isInvalidNameFormat(extractedName) || containsProfanity(extractedName)) {
    console.error("[gemini input validation] blocked before calling Gemini");
    const safeJson = buildSafeFallbackJson(type, prompt);
    return res.status(200).json({ text: JSON.stringify(safeJson || { poem: pickSafeFallback() }) });
  }

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

    let text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (violatesContentSafety(text)) {
      console.error("[gemini content safety] blocked response, using fallback");
      const safeJson = buildSafeFallbackJson(type, prompt);
      text = JSON.stringify(safeJson || { poem: pickSafeFallback() });
    }
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
