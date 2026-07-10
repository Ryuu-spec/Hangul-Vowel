// api/kcisa.js — Vercel Serverless Function
// 국립국어원 "외래어·로마자 용례" 오픈 API 프록시 (Upstash Redis 캐싱 적용)
// 환경변수: KCISA_SERVICE_KEY (Vercel 대시보드에서 설정 — korean.go.kr에서 재발급받은 키를 등록)
//           KV_REST_API_URL, KV_REST_API_TOKEN (Vercel Storage 연동 시 자동 생성)
//
// 호출 원본: https://korean.go.kr/kornorms/exampleReqList.do
// 파라미터 : serviceKey, searchKeyword, searchCondition, searchEquals, s_foreign_gubun, resultType
// 응답 형식: JSON (resultType=json 명시)
//
// ※ 이전 api.kcisa.kr(getKRAG0401)은 keyword 파라미터를 서버에서 무시하고
//   전체 데이터셋 첫 페이지를 그대로 반환하는 결함이 확인되어(2026.7),
//   실제로 검색이 되는 korean.go.kr 정식 용례찾기 API로 교체함.

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30일

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const keyword = (req.query?.keyword || req.body?.keyword || "").trim();
  if (!keyword) {
    return res.status(400).json({ error: "keyword 파라미터가 필요합니다." });
  }

  const cacheKey = `korengo:${keyword.toLowerCase()}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(cached);
    }
  } catch (err) {
    console.error("[korengo redis get error]", err);
  }

  res.setHeader("X-Cache", "MISS");

  const serviceKey = process.env.KCISA_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: "KCISA_SERVICE_KEY 환경변수가 설정되지 않았습니다." });
  }

  const numOfRows = req.query?.numOfRows || "10";
  const pageNo    = req.query?.pageNo    || "1";

  const endpoint = "https://korean.go.kr/kornorms/exampleReqList.do";
  const params = new URLSearchParams({
    serviceKey,
    numOfRows,
    pageNo,
    resultType      : "json",
    searchCondition : "srclang_mark",   // 원어(로마자) 표기 기준 검색
    searchEquals    : "like",           // 포함 검색
    searchKeyword   : keyword,
    s_foreign_gubun : "0001"            // 인명만 필터링 (지명·일반용어 제외)
  });
  const url = `${endpoint}?${params.toString()}`;

  try {
    const upstream = await fetch(url, { method: "GET" });
    const rawText = await upstream.text();

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error : `국립국어원 API 오류 (${upstream.status})`,
        detail: rawText,
      });
    }

    let json;
    try {
      json = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ error: "국립국어원 API 응답 파싱 실패", raw: rawText.slice(0, 500) });
    }

    await redis.set(cacheKey, json, { ex: CACHE_TTL_SECONDS });
    return res.status(200).json(json);

  } catch (err) {
    console.error("[korengo proxy error]", err);
    return res.status(500).json({
      error : "국립국어원 API 호출 실패",
      detail: err.message,
    });
  }
}
