/**
 * rainfall-alarm-proxy — Cloudflare Worker
 *
 * KMA API를 서울 PoP(인천) 경유로 중계하여 한국 IP 요구사항 충족.
 *
 * 라우팅:
 *   /kma-public/*     → https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/*
 *   /kma-aws1mi/*     → https://apis.data.go.kr/1360000/Aws1miInfoService/*
 *   /kma-apihub/*     → https://apihub.kma.go.kr/api/typ01/cgi-bin/url/*
 *   /kma-basicinfo/*  → https://apis.data.go.kr/1360000/WethrBasicInfoService/* (Step 3)
 *
 * 인증: X-Proxy-Token 헤더 (wrangler secret으로 설정)
 */

const KMA_PUBLIC_BASE     = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
const KMA_AWS1MI_BASE     = 'https://apis.data.go.kr/1360000/Aws1miInfoService';
const KMA_APIHUB_BASE     = 'https://apihub.kma.go.kr/api/typ01/cgi-bin/url';
const KMA_APIHUB_TYP02_BASE = 'https://apihub.kma.go.kr/api/typ02/openApi/AwsYearlyInfoService';
const KMA_BASICINFO_BASE  = 'https://apis.data.go.kr/1360000/WethrBasicInfoService';

export default {
  async fetch(request, env) {
    if (env.PROXY_TOKEN) {
      const token = request.headers.get('X-Proxy-Token');
      if (token !== env.PROXY_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    const url = new URL(request.url);
    const path = url.pathname;

    let targetBase, prefix;

    if (path.startsWith('/kma-public/')) {
      targetBase = KMA_PUBLIC_BASE;
      prefix     = '/kma-public/';
    } else if (path.startsWith('/kma-aws1mi/')) {
      targetBase = KMA_AWS1MI_BASE;
      prefix     = '/kma-aws1mi/';
    } else if (path.startsWith('/kma-apihub/')) {
      targetBase = KMA_APIHUB_BASE;
      prefix     = '/kma-apihub/';
    } else if (path.startsWith('/kma-apihub-typ02/')) {
      targetBase = KMA_APIHUB_TYP02_BASE;
      prefix     = '/kma-apihub-typ02/';
    } else if (path.startsWith('/kma-basicinfo/')) {
      targetBase = KMA_BASICINFO_BASE;
      prefix     = '/kma-basicinfo/';
    } else {
      return new Response('Not Found', { status: 404 });
    }

    const operation = path.slice(prefix.length);
    const targetUrl = `${targetBase}/${operation}${url.search}`;

    try {
      const upstream = await fetch(targetUrl, {
        headers: { 'User-Agent': 'RainfallAlarmKR/1.0' },
      });

      const contentType = upstream.headers.get('Content-Type') ?? 'application/octet-stream';
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { 'Content-Type': contentType },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
