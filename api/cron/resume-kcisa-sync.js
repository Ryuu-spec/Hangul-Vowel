// api/cron/resume-kcisa-sync.js — 워치독 (하루 1회 Vercel Cron)
//
// sync-kcisa-names.js의 페이지 체이닝(waitUntil)이 조용히 끊기는 경우가
// 실측 확인됨(약 6페이지 중 1번꼴, 첫 실행 2026-07-28). 그 안전망으로
// 하루 한 번 이 함수가 kcisa:sync:meta를 확인한다. status가 running/
// stalled인데 마지막 진행(lastProgressAt) 이후 STALL_THRESHOLD_MS 이상
// 지났으면, 멈춘 지점부터 sync-kcisa-names를 직접 "순차적으로, 응답을
// 기다리며" 여러 페이지 이어서 호출한다 — sync-kcisa-names 자체의
// waitUntil 체이닝에 다시 의존하지 않고, 이 함수가 스스로 각 페이지를
// awiat하며 밀어붙이는 방식(수동 복구 때 효과가 검증된 방식과 동일).
// 이 함수의 실행시간(maxDuration) 예산 안에서 갈 수 있는 만큼 가고,
// 못 끝내면 다음 날 워치독이 이어받는다.
//
// Vercel Hobby 플랜은 크론 실행 빈도 제한이 있어 이 워치독도 하루 1회만
// 돈다 — 체인이 자주 끊기면 완전 복구까지 며칠 걸릴 수 있지만, 최소한
// 다음 주 정기 동기화 전에는 대부분 따라잡는다.
//
// [보안] sync-kcisa-names.js와 동일하게 CRON_SECRET으로 보호.

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const STALL_THRESHOLD_MS = 20 * 60 * 1000; // 20분 이상 진행 없으면 멈춘 것으로 판단
const MAX_WALL_TIME_MS = 50 * 1000;        // 이 함수 자체의 시간 예산 (maxDuration=60 기준 여유 확보)

function selfSyncUrl(req, pageNo) {
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

  const meta = await redis.hgetall('kcisa:sync:meta');
  if (!meta || !meta.status) {
    return res.status(200).json({ action: 'none', reason: '동기화 이력 없음' });
  }

  const isActive = meta.status === 'running' || meta.status === 'stalled';
  if (!isActive) {
    return res.status(200).json({ action: 'none', reason: `status=${meta.status}` });
  }

  const lastProgressAt = meta.lastProgressAt ? new Date(meta.lastProgressAt).getTime() : 0;
  const elapsed = Date.now() - lastProgressAt;
  if (elapsed < STALL_THRESHOLD_MS) {
    return res.status(200).json({ action: 'none', reason: `아직 진행 중 (마지막 진행 ${Math.round(elapsed / 1000)}초 전)` });
  }

  const totalPagesAtStart = parseInt(meta.totalPages, 10) || 0;
  let currentPage = parseInt(meta.currentPage, 10) || 0;
  if (totalPagesAtStart && currentPage >= totalPagesAtStart) {
    return res.status(200).json({ action: 'none', reason: '이미 완료된 페이지 범위' });
  }

  const startedAt = Date.now();
  const resumedPages = [];

  while (Date.now() - startedAt < MAX_WALL_TIME_MS) {
    const nextPage = currentPage + 1;
    const url = selfSyncUrl(req, nextPage);
    let body;
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
      body = await r.json().catch(() => null);
      if (!r.ok || !body) {
        resumedPages.push({ page: nextPage, ok: false, status: r.status });
        break; // 한 페이지 자체가 실패하면(예: upstream 오류) 여기서 멈추고 다음 워치독에 맡김
      }
    } catch (err) {
      resumedPages.push({ page: nextPage, ok: false, error: err.message });
      break;
    }
    resumedPages.push({ page: nextPage, ok: true, processedCount: body.processedCount });
    currentPage = body.pageNo;
    if (body.done) break;
  }

  const finalMeta = await redis.hgetall('kcisa:sync:meta');
  return res.status(200).json({
    action: 'resumed',
    pagesProcessedThisRun: resumedPages.length,
    resumedPages,
    finalStatus: finalMeta?.status,
    finalProcessedCount: finalMeta?.processedCount,
    finalTotalCount: finalMeta?.totalCount,
  });
}
