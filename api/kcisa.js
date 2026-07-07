// api/kcisa.js — Vercel Serverless Function
// KCISA 외래어 표기법 API 프록시 (Upstash Redis 캐싱 적용)
// 환경변수: KCISA_SERVICE_KEY (Vercel 대시보드에서 설정)
//           KV_REST_API_URL, KV_REST_API_TOKEN (Vercel Storage 연동 시 자동 생성)
//
// 호출 원본: https://api.kcisa.kr/openapi/service/rest/meta6/getKRAG0401
// 파라미터 : serviceKey, keyword, numOfRows, pageNo
// 응답 형식: JSON (Accept: application/json)

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30일

export default async function handler(req, res) {
  // CORS 허용 (같은 Vercel 도메인에서 호출)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // keyword 추출 (GET querystring 또는 POST body)
  const keyword =
    req.query?.keyword ||
    req.body?.keyword ||
    "";

  if (!keyword.trim()) {
    return res.status(400).json({ error: "keyword 파라미터가 필요합니다." });
  }

  const cacheKey = `kcisa:${keyword.toLowerCase()}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Content-Type", cached.contentType);
      if (cached.contentType === "text/xml") {
        return res.status(200).send(cached.body);
      }
      return res.status(200).json(cached.body);
    }
  } catch (err) {
    console.error("[kcisa redis get error]", err);
    // 캐시 조회 실패 시 원본 API 호출로 폴백
  }

  res.setHeader("X-Cache", "MISS");

  const serviceKey = process.env.KCISA_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: "KCISA_SERVICE_KEY 환경변수가 설정되지 않았습니다." });
  }

  const numOfRows = req.query?.numOfRows || "10";
  const pageNo    = req.query?.pageNo    || "1";

  const endpoint = "https://api.kcisa.kr/openapi/service/rest/meta6/getKRAG0401";
  const params   = new URLSearchParams({ serviceKey, keyword, numOfRows, pageNo });
  const url      = `${endpoint}?${params.toString()}`;

  try {
    const upstream = await fetch(url, {
      method : "GET",
      headers: { "accept": "application/json" },
    });

    const body = await upstream.text();

    // 상태 코드 그대로 전달 (200, 400, 500 등)
    res.setHeader("Content-Type", "application/json");

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error : `KCISA 서버 오류 (${upstream.status})`,
        detail: body,
      });
    }

    // JSON 파싱 시도 (실패 시 XML일 가능성 — 그대로 반환)
    try {
      const json = JSON.parse(body);
      await redis.set(cacheKey, { contentType: "application/json", body: json }, { ex: CACHE_TTL_SECONDS });
      return res.status(200).json(json);
    } catch {
      // XML 응답이 온 경우 그대로 전달 (프론트에서 처리)
      res.setHeader("Content-Type", "text/xml");
      await redis.set(cacheKey, { contentType: "text/xml", body }, { ex: CACHE_TTL_SECONDS });
      return res.status(200).send(body);
    }

  } catch (err) {
    console.error("[kcisa proxy error]", err);
    return res.status(500).json({
      error : "KCISA API 호출 실패",
      detail: err.message,
    });
  }
}
