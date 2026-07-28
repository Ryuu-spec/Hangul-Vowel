// api/cron/sync-kcisa-names.js — Vercel Cron Job(매주 1회) + 자체 체이닝
//
// KCISA/국립국어원 "외래어·로마자 용례" API(korean.go.kr/kornorms/exampleReqList.do)에서
// s_foreign_gubun=0001(인명)만 전수 수집해(총 19,519건 확인, 2026-07-28 기준)
// Upstash Redis에 이름별 인덱스로 저장한다.
//
// [왜 체이닝 방식인가]
// upstream API가 매우 느리다 — 실측 결과 numOfRows=500 기준 페이지당 약 8초,
// 1000은 약 15.6초, 5000은 60초를 넘겨 타임아웃. 19,519건 전체를 한 번의
// 서버리스 함수 호출 안에서 순차로 다 받아오는 건 불가능하다(Vercel Hobby
// 플랜은 함수 최대 실행시간이 짧음). 그래서 한 번 호출당 "딱 한 페이지"만
// 처리하고, 끝나면 @vercel/functions의 waitUntil()로 다음 페이지 호출을
// 발사한 뒤 응답을 반환한다. Vercel Cron은 매주 1회 pageNo=1만 트리거하고,
// 그 뒤로는 이 함수가 스스로를 체인 호출해 전체 페이지(약 40페이지)를
// 순회한다. 각 호출은 개별적으로 짧게(약 8~10초) 끝나므로 실행시간 제한에
// 걸리지 않는다.
//
// [저장 구조] Upstash Redis
//   kcisa:name:<정규화된 srclang_mark>  → LIST(RPUSH), 항목별 JSON 문자열
//   kcisa:names:keyset                  → SET, 현재 채워진 모든 이름 키
//     (다음 주 재동기화 시작 시 이 목록으로 이전 데이터를 깨끗이 지움)
//   kcisa:sync:meta                     → HASH, 진행 상태
//     (status/currentPage/totalPages/processedCount/totalCount/
//      startedAt/finishedAt/lastError)
//
// [보안] Vercel이 vercel.json의 crons 경로를 호출할 때 CRON_SECRET
// 환경변수가 설정되어 있으면 자동으로 `Authorization: Bearer <CRON_SECRET>`
// 헤더를 붙인다. 이 함수도 같은 헤더를 검사해서 외부에서 이 엔드포인트를
// 함부로 호출해 국립국어원 서버·Redis에 부하를 주는 일을 막는다. 체인
// 호출(다음 페이지 트리거) 시에도 같은 헤더를 우리가 직접 실어 보낸다.
// → Vercel 프로젝트 환경변수에 CRON_SECRET을 반드시 설정해야 동작한다.
//
// [아직 미연결] 이 인덱스는 index.html의 callKCSIA() 검색 로직과 아직
// 연결되지 않았다. 이번 단계는 동기화 파이프라인 구축까지만.

import { Redis } from '@upstash/redis';
import { waitUntil } from '@vercel/functions';

const redis = Redis.fromEnv();

const ENDPOINT = 'https://korean.go.kr/kornorms/exampleReqList.do';
const NUM_OF_ROWS = 500; // 실측: 500=~8초, 1000=~15.6초, 5000=60초+ 타임아웃
const FOREIGN_GUBUN_PERSON = '0001';

function normalizeKey(srclangMark) {
  return String(srclangMark || '').trim().toUpperCase();
}

// API가 korean_mark/lang_nm/guk_nm/mean/source에 앞뒤 공백을 그대로 붙여
// 반환하는 경우가 있어(실측 확인, 예: " 영어 ") 저장 전 정리한다.
function trimField(v) {
  return typeof v === 'string' ? v.trim() : v;
}

async function fetchPage(serviceKey, pageNo) {
  const params = new URLSearchParams({
    serviceKey,
    numOfRows: String(NUM_OF_ROWS),
    pageNo: String(pageNo),
    resultType: 'json',
    s_foreign_gubun: FOREIGN_GUBUN_PERSON,
  });
  const url = `${ENDPOINT}?${params.toString()}`;
  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) throw new Error(`KCISA API 오류 (${r.status}): ${text.slice(0, 300)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`KCISA API 응답 파싱 실패: ${text.slice(0, 300)}`);
  }
  if (json?.response?.resultcode !== 0) {
    throw new Error(`KCISA API 결과 코드 오류: ${json?.response?.resultmsg}`);
  }
  return json.response;
}

// 이전 회차의 인덱스를 깨끗이 지운다 (매주 전체 재구축이므로, 이번 주
// 새 데이터가 지난 주 데이터와 섞이지 않도록 pageNo=1에서 한 번만 실행).
async function clearPreviousIndex() {
  const oldKeys = await redis.smembers('kcisa:names:keyset');
  if (oldKeys.length) {
    const pipeline = redis.pipeline();
    for (const k of oldKeys) pipeline.del(`kcisa:name:${k}`);
    pipeline.del('kcisa:names:keyset');
    await pipeline.exec();
  }
}

function selfUrl(req, pageNo) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/cron/sync-kcisa-names?pageNo=${pageNo}`;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'CRON_SECRET 환경변수가 설정되지 않았습니다.' });
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const serviceKey = process.env.KCISA_SERVICE_KEY;
  if (!serviceKey) {
    return res.status(500).json({ error: 'KCISA_SERVICE_KEY 환경변수가 설정되지 않았습니다.' });
  }

  const pageNo = parseInt(req.query?.pageNo, 10) || 1;

  try {
    if (pageNo === 1) {
      await clearPreviousIndex();
      await redis.hset('kcisa:sync:meta', {
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: '',
        currentPage: 1,
        totalPages: '',
        processedCount: 0,
        totalCount: '',
        lastError: '',
      });
    }

    const response = await fetchPage(serviceKey, pageNo);
    const items = response.items || [];
    const totalCount = response.totalcount || 0;
    const totalPages = Math.max(1, Math.ceil(totalCount / NUM_OF_ROWS));

    // 페이지 안의 항목을 이름별로 묶어 파이프라인 한 번에 기록 (Redis
    // 왕복 횟수를 페이지당 1회로 줄임 — read-modify-write 대신 RPUSH로
    // 항상 append만 하므로 순서 상관없이 안전)
    if (items.length) {
      const pipeline = redis.pipeline();
      const seenKeys = new Set();
      for (const item of items) {
        const key = normalizeKey(item.srclang_mark);
        if (!key) continue;
        pipeline.rpush(`kcisa:name:${key}`, JSON.stringify({
          korean_mark: trimField(item.korean_mark),
          lang_nm: trimField(item.lang_nm),
          guk_nm: trimField(item.guk_nm),
          mean: trimField(item.mean),
          source: trimField(item.source),
          example_no: item.example_no,
        }));
        if (!seenKeys.has(key)) {
          pipeline.sadd('kcisa:names:keyset', key);
          seenKeys.add(key);
        }
      }
      await pipeline.exec();
    }

    const meta = await redis.hgetall('kcisa:sync:meta');
    const processedCount = (Number(meta?.processedCount) || 0) + items.length;
    const isDone = pageNo >= totalPages;

    await redis.hset('kcisa:sync:meta', {
      currentPage: pageNo,
      totalPages,
      totalCount,
      processedCount,
      status: isDone ? 'done' : 'running',
      finishedAt: isDone ? new Date().toISOString() : '',
    });

    if (!isDone) {
      const nextUrl = selfUrl(req, pageNo + 1);
      waitUntil(
        fetch(nextUrl, { headers: { Authorization: `Bearer ${secret}` } }).catch(() => {})
      );
    }

    return res.status(200).json({ pageNo, totalPages, totalCount, processedCount, done: isDone });

  } catch (err) {
    await redis.hset('kcisa:sync:meta', {
      status: 'error',
      lastError: err.message,
      finishedAt: new Date().toISOString(),
    }).catch(() => {});
    console.error('[kcisa sync error]', err);
    return res.status(500).json({ error: err.message, pageNo });
  }
}
