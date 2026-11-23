// 앱 내장 EPCIS 2.0 저장소 REST API — 설치 없이 맥 앱 · 윈도우 앱 · npm start에서 바로 동작 (웹 버전은 브라우저 메모리 저장소 · js/epcis.js)
// 화면(js/main.js)이 시리얼 서비스 이벤트를 5초마다 묶어 /capture로 올리고, 품질 추적 「EPCIS 저장소에서 조회」가 /events · /trace로 읽는다.
//   POST /api/epcis/v1/capture                EPCISDocument → 202 { captureID, accepted, duplicate, errors } (eventID 중복은 한 번만)
//   GET  /api/epcis/v1/capture/{id}           캡처 작업 결과
//   GET  /api/epcis/v1/events?…               EPCIS 질의 (MATCH_anyEPC · EQ_bizStep · EQ_action · EQ_readPoint · eventType · GE/LT_eventTime · EQ_mf:… · perPage · nextPageToken)
//   GET  /api/epcis/v1/trace?epc=…            시리얼·SSCC 추적 사슬 (발행 → 적재 → 팔레트 묶음 → 출하 …)
//   GET  /api/epcis/v1/shipment?truck=…       트럭 → 팔레트 SSCC → 시리얼 (리콜 범위)
//   POST /api/epcis/v1/serial-reserve         제품 식별 번호 범위 예약 { ymd, need: { 'ser:DT': 40, pal: 10, ship: 6 } } → { ranges: { 'ser:DT': { from, to }, … } } (화면이 여럿이어도 겹치지 않음 · js/serialalloc.js)
//   GET  /api/epcis/v1/status                 저장 건수 · 파일 · 외부 전송 상태
//   GET/POST /api/epcis/v1/config             외부 저장소 전송 설정 { url, enabled, apiKey } — apiKey는 돌려주지 않는다(설정 여부만)
//   POST /api/epcis/v1/forward/test           외부 저장소 연결 시험
// 보관: 데이터 폴더/epcis/events.jsonl (한 줄 = 이벤트 하나, 최근 20만 건 · 파일 200MB 넘으면 최근 것만 남기고 정리)
// 외부 전송(선택): OpenEPCIS · 사내 · 고객사 EPCIS 2.0 저장소 POST {url}/capture — 최대 100건씩(413이면 줄임) · 실패하면 간격을 늘려 다시 (보낸 위치를 파일에 기억해 앱을 다시 켜도 이어서)
//   처음 연결할 때 확장 필드(mf:) 스키마를 {url}/userExtension/jsonSchema에 등록한다 (OpenEPCIS 방식 — 없는 저장소면 건너뜀)
//   캡처는 비동기 — GS1-Capture-Error-Behaviour: proceed로 보내고 202 Location의 캡처 작업 결과를 확인: 중복은 정상, 거부된 건은 건수·사유 기록 (실제 OpenEPCIS CE stable로 확인)
import fs from 'node:fs';
import path from 'node:path';
import { EpcisStore, epcisDocument, MF_NS } from '../js/epcis.js';
import { configFile } from './secrets.mjs';
import { loadJsonl } from './jsonl.mjs';

const MAX_EVENTS = 200000, MAX_FILE = 200 * 1024 * 1024, BATCH = 100;   // 한 번에 보낼 이벤트 — 저장소가 413(본문 너무 큼)이면 절반씩 줄인다
const MF_SCHEMA = { $schema: 'http://json-schema.org/draft-07/schema#', title: 'Jin-3D EPCIS extension (mf:)', type: 'object', additionalProperties: true,
  properties: { wip: { type: 'string' }, product: { type: 'string' }, gtin: { type: 'string' }, symbol: { type: 'string' }, verifyGrade: { type: 'string' }, markTries: { type: 'integer' }, sscc: { type: 'string' }, truck: { type: 'string' }, quantity: { type: 'integer' }, lot: { type: 'string' }, productionDate: { type: 'string' }, reason: { type: 'string' }, result: { type: 'string' }, note: { type: 'string' } } };

export function makeEpcisApi({ dir, fetchImpl = globalThis.fetch, interval = 5000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl'), cfgFile = path.join(dir, 'forward.json');
  let out = null, writeError = null;   // 이어 쓰기 스트림 · 마지막 파일 쓰기 오류 (상태에 표시)
  const store = new EpcisStore({ max: MAX_EVENTS, onAdd: (rec) => {
    if (!out) { out = fs.createWriteStream(file, { flags: 'a' }); out.on('error', (e) => { writeError = { at: new Date().toISOString(), error: e.message }; out = null; }); }
    out.write(JSON.stringify(rec) + '\n');
  } });
  // 다시 켤 때 파일에서 불러오기 — 깨진 줄은 건너뛰고, 끝의 반쯤 쓰인 줄은 잘라 둔다(server/jsonl.mjs): 그대로 두면 새 이벤트가 그 조각에 붙어 다음 재시작에 사라진다
  let recovery = null;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_FILE) compact();
    if (fs.existsSync(file)) {
      const L = loadJsonl(file);
      for (const r of L.items) if (r) { store.add(r); store.seq = Math.max(store.seq, r._seq ?? 0); }
      if (L.bad || L.torn) recovery = { at: new Date().toISOString(), bad: L.bad, torn: L.torn && path.basename(L.torn) };
    }
  } catch { /* 첫 실행 */ }
  function compact() { const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, lines.slice(-MAX_EVENTS).join('\n') + '\n'); fs.renameSync(tmp, file); }

  // ── 외부 저장소 전송 ─────────────────
  // 설정 파일 — 키(apiKey)는 앱에서 safeStorage로 암호화해 쓴다 (server/secrets.mjs)
  const conf = configFile(cfgFile, { url: '', enabled: false, apiKey: '', cursor: 0 }, ['apiKey']), cfg = conf.cfg;
  const fw = { batch: BATCH, sent: 0, failed: 0, lastOk: null, lastError: null, busy: false, nextAt: 0, backoff: interval, registered: null, lastJob: null, gen: 0 };   // gen: 전송 세대 — 「처음부터 다시」·주소 변경 때 올린다 (그 전에 시작한 응답이 새 커서를 덮어쓰지 못하게)
  const saveCfg = () => { try { conf.save(); } catch { /* 무시 */ } };
  const base = () => String(cfg.url ?? '').replace(/\/+$/, '').replace(/\/capture$/, '');
  // EPCIS 2.0 REST: 본문은 JSON-LD · 응답 형식은 넓게 받는다 (OpenEPCIS는 Accept가 application/json뿐이면 406)
  // key: 이번 요청에 붙일 키 — 저장한 키는 저장한 주소(base)로 갈 때만 붙인다 (다른 호스트로 키가 새지 않게)
  const headers = (json = true, key = cfg.apiKey) => ({ ...(json ? { 'Content-Type': 'application/ld+json' } : {}), Accept: 'application/ld+json, application/json;q=0.9, */*;q=0.8', ...(key ? { Authorization: `Bearer ${key}` } : {}) });
  const sameOrigin = (u) => { try { return new URL(u).origin === new URL(base()).origin; } catch { return false; } };
  const pending = () => store.events.filter((e) => e._seq > (cfg.cursor ?? 0));
  // 확장 필드(mf:) 스키마 등록 — OpenEPCIS는 등록 안 된 네임스페이스가 든 문서를 통째로 거부한다. 등록 기능이 없는 저장소(404·405)는 건너뜀
  async function register() {
    if (fw.registered === base()) return;
    const r = await fetchImpl(`${base()}/userExtension/jsonSchema?namespace=${encodeURIComponent(MF_NS)}&defaultPrefix=mf`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json', Accept: '*/*' }, body: JSON.stringify(MF_SCHEMA), signal: AbortSignal.timeout(8000) });
    const already = !r.ok && /already/i.test(await r.text().catch(() => ''));   // 이미 등록됨 (OpenEPCIS는 500 "namespace and default prefix already mapped")
    if (!r.ok && !already && ![404, 405, 409].includes(r.status)) throw new Error(`확장 필드(mf:) 스키마 등록 실패 — HTTP ${r.status}`);
    fw.registered = base();
  }
  // 캡처는 비동기 (EPCIS 2.0): 202 + Location의 캡처 작업이 끝날 때까지 확인 — 검증에 실패하면 보낸 것으로 치지 않는다
  //   끝난 결과를 받기 전에는 보낸 위치(커서)를 옮기지 않는다: 아직 처리 중이면 null → 다음 주기에 같은 작업을 다시 확인 (접수 202 ≠ 저장 완료)
  const JOB_WAIT = 10 * 60 * 1000;   // 처리 중으로 이만큼 남으면 같은 묶음을 다시 보낸다 — eventID가 같아 저장소는 중복으로 처리
  async function job(loc, tries = 20) {
    const u = /^https?:/.test(loc) ? loc : `${new URL(base()).origin}${loc.startsWith('/') ? '' : '/'}${loc}`;
    for (let i = 0; i < tries; i++) {   // 최대 약 10초 — 중복이 섞인 작업은 OpenEPCIS가 running으로 오래 남겨 둔다
      await new Promise((r) => setTimeout(r, i ? 500 : 200));
      const r = await fetchImpl(u, { headers: headers(false, sameOrigin(u) ? cfg.apiKey : ''), signal: AbortSignal.timeout(8000) }); if (!r.ok) continue;   // 캡처 작업 주소가 다른 호스트면 키를 붙이지 않는다
      const j = await r.json().catch(() => null); if (!j || j.running) continue;
      return j;
    }
    return null;
  }
  // 끝난 캡처 작업 결과 반영 → 커서를 그 묶음 끝으로 (보낸 뒤 세대가 바뀌었으면 버린다)
  function settle(J, last, n, gen) {
    if (gen !== fw.gen) return;
    let note = null;
    if (J) {
      const errs = (J.errors ?? []).filter((x) => !/duplicate/i.test(`${x.detail ?? ''} ${x.title ?? ''}`));
      fw.lastJob = { id: J.captureID ?? null, success: J.success, errors: (J.errors ?? []).length, duplicates: (J.errors ?? []).length - errs.length };
      if (errs.length) { fw.rejected = (fw.rejected ?? 0) + errs.length; note = `저장소가 ${errs.length}건 거부 — ${errs[0].detail ?? errs[0].title ?? ''}`.trim(); }
    }
    cfg.cursor = last; saveCfg(); fw.sent += n; fw.lastOk = new Date().toISOString(); fw.lastError = note; fw.backoff = interval; fw.nextAt = 0;
  }
  async function pump() {
    if (!cfg.enabled || !base() || fw.busy || Date.now() < fw.nextAt) return;
    const batch = pending().slice(0, fw.batch); if (!batch.length) return;
    fw.busy = true;
    const gen = fw.gen;
    try {
      if (fw.job) {   // 지난 주기에 보낸 캡처 작업이 아직 처리 중 — 결과를 먼저 확인
        const J = fw.job.base === base() ? await job(fw.job.loc, 1) : null;
        if (J) { const { last, n } = fw.job ?? {}; if (gen === fw.gen) fw.job = null; settle(J, last, n, gen); return; }
        if (gen !== fw.gen) return;   // 확인하는 동안 「처음부터 다시」 — 새 커서로 다음 주기에
        if (fw.job.base === base() && Date.now() - fw.job.at < JOB_WAIT) { fw.nextAt = Date.now() + interval; return; }
        fw.job = null;   // 오래 처리 중이거나 주소가 바뀜 → 같은 묶음을 다시 보낸다
      }
      await register();
      const r = await fetchImpl(`${base()}/capture`, { method: 'POST', headers: { ...headers(), 'GS1-Capture-Error-Behaviour': 'proceed' }, body: JSON.stringify(epcisDocument(batch.map(({ _seq, recordTime, ...e }) => e), new Date().toISOString())), signal: AbortSignal.timeout(20000) });
      if (r.status === 413 && fw.batch > 5) { fw.batch = Math.max(5, Math.floor(fw.batch / 2)); fw.nextAt = 0; return; }   // 바로 더 작게 다시
      if (!r.ok) throw new Error(`HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''}`);
      const loc = r.headers.get('location'), last = batch.at(-1)._seq;
      // proceed: 문제가 있는 이벤트만 건너뛰고 나머지는 저장 — 중복(이미 보낸 것)은 정상, 검증 실패는 건수·사유만 남기고 다음으로 (한 건 때문에 전송이 멈추지 않게)
      if (!loc) { settle(null, last, batch.length, gen); return; }   // 작업 주소 없이 바로 끝난 저장소
      const J = await job(loc);
      if (J) { settle(J, last, batch.length, gen); return; }
      if (gen !== fw.gen) return;
      fw.job = { loc, base: base(), last, n: batch.length, at: Date.now() };
      fw.lastError = '저장소가 아직 처리 중 — 끝나면 보낸 것으로 확정 (다음 주기에 다시 확인)'; fw.nextAt = Date.now() + interval;
    } catch (e) { fw.failed++; fw.lastError = /^(HTTP|저장소|확장)/.test(e.message) ? e.message : why(e); fw.backoff = Math.min(60000, fw.backoff * 2); fw.nextAt = Date.now() + fw.backoff; }
    finally { fw.busy = false; }
  }
  const timer = setInterval(() => { pump().catch(() => {}); }, interval); timer.unref?.();
  // 연결 실패 사유를 사람이 읽을 말로 (Node fetch는 원인을 cause · cause.errors에 담는다)
  function why(e) {
    if (/bad port/i.test(e.cause?.message ?? '')) return '사용할 수 없는 포트 (브라우저·Node 표준에서 막힌 포트)';
    const c = e.cause?.code ?? e.cause?.errors?.[0]?.code ?? e.name;
    return { ECONNREFUSED: '연결 거부 — 저장소가 꺼져 있거나 주소·포트가 다릅니다', ENOTFOUND: '주소를 찾을 수 없습니다 (호스트 이름 확인)', ETIMEDOUT: '응답 없음 (시간 초과)', TimeoutError: '응답 없음 (시간 초과)', ECONNRESET: '연결이 끊겼습니다', CERT_HAS_EXPIRED: 'HTTPS 인증서가 만료되었습니다', DEPTH_ZERO_SELF_SIGNED_CERT: '자체 서명 HTTPS 인증서 — 신뢰할 수 없음' }[c] ?? `${e.message}${c && c !== 'Error' ? ` (${c})` : ''}`;
  }
  // 시험할 때 키: 넘겨받은 키 → 없으면 저장한 주소와 같은 출처일 때만 저장한 키
  async function test(url = base(), key = null) {
    const u = String(url).replace(/\/+$/, '').replace(/\/capture$/, '');
    if (!/^https?:\/\//.test(u)) return { ok: false, error: 'http:// 또는 https:// 주소를 넣으세요' };
    try { const r = await fetchImpl(`${u}/events?perPage=1`, { headers: headers(false, key || (sameOrigin(u) ? cfg.apiKey : '')), signal: AbortSignal.timeout(8000) }); return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, error: `HTTP ${r.status}` }; }
    catch (e) { return { ok: false, error: why(e) }; }
  }
  // ── 제품 식별 번호 범위 예약 ─────────────────
  // 화면(탭 · 앱 여러 개)이 각자 세면 같은 시리얼 · SSCC · 출하 ID를 낸다 — 여기서 범위를 떼어 주고 「어디까지 내줬는지」를 파일(serial-alloc.json)에 남긴다.
  //   · 시작 번호 = max(파일에 남은 마지막 예약 번호, 저장소 이벤트에 실제로 쓰인 마지막 번호) + 1 → 앱을 다시 켜도 · 예약만 하고 이벤트를 못 올린 번호도 다시 나가지 않는다
  //   · 같은 데이터 폴더를 쓰는 앱 서버가 둘이어도(맥 앱 두 개) 겹치지 않게 잠금 파일을 잡고 파일을 다시 읽은 뒤 쓴다 · 기록에 실패하면 범위를 주지 않는다(오류 응답 → 화면이 다시 요청)
  const allocFile = path.join(dir, 'serial-alloc.json'), lockFile = `${allocFile}.lock`, digits = (v) => String(v ?? '').replace(/\D/g, '');
  const scanned = new Map();   // ymd → 저장소 이벤트에 쓰인 마지막 번호 (한 번만 훑는다 — 그 뒤로 들어오는 이벤트는 여기서 예약한 범위 안의 번호)
  function usedMax(ymdIn) {
    const ymd = digits(ymdIn), base = {}, re = new RegExp(`\\.([A-Z]{2})-${ymd}-(\\d{6})$`);
    for (const e of store.events) if (e.bizStep === 'commissioning') for (const x of e.epcList ?? []) { const m = re.exec(x); if (m) base[m[1]] = Math.max(base[m[1]] ?? 0, Number(m[2])); }
    // 팔레트 SSCC 일련번호(날짜 없음 — 저장소 전체 최댓값) · 오늘 출하 ID(SHP-ymd-N) — 앱을 다시 켜도 같은 SSCC·출하 ID를 다시 쓰지 않는다
    let pal = 0, ship = 0; const reS = new RegExp(`^SHP-${ymd}-(\\d+)$`);
    for (const e of store.events) { if (/^\d{18}$/.test(e['mf:sscc'] ?? '')) pal = Math.max(pal, Number(e['mf:sscc'].slice(8, 17))); const m = reS.exec(e['mf:shipment'] ?? ''); if (m) ship = Math.max(ship, Number(m[1])); }
    return { base, pal, ship };
  }
  async function locked(fn) {
    for (let i = 0; ; i++) {
      try { fs.closeSync(fs.openSync(lockFile, 'wx')); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(lockFile).mtimeMs > 5000) { fs.rmSync(lockFile, { force: true }); continue; } } catch { continue; }   // 잠근 채 죽은 서버가 남긴 잠금
        if (i > 150) throw new Error('번호 예약 잠금을 얻지 못했습니다 (다른 앱 서버가 사용 중)');
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    try { return fn(); } finally { fs.rmSync(lockFile, { force: true }); }
  }
  async function reserve(b) {
    const ymd = digits(b?.ymd), need = b?.need, bad = (m) => Object.assign(new Error(m), { code: 400 });
    if (ymd.length !== 6) throw bad('ymd(YYMMDD)가 필요합니다');
    if (!need || typeof need !== 'object' || !Object.keys(need).length) throw bad('need가 필요합니다');
    for (const [k, n] of Object.entries(need)) if (!/^(ser:[A-Z]{2}|pal|ship)$/.test(k) || !Number.isInteger(n) || n < 1 || n > 1000) throw bad(`need 형식 오류 (${k})`);
    if (!scanned.has(ymd)) { if (scanned.size > 3) scanned.clear(); scanned.set(ymd, usedMax(ymd)); }
    const U = scanned.get(ymd);
    return locked(() => {   // 잠근 동안은 동기 처리 — 읽기 → 계산 → 쓰기 사이에 다른 요청이 끼지 못한다
      let A = { ser: {}, pal: 0, ship: {} };
      if (fs.existsSync(allocFile)) { const j = JSON.parse(fs.readFileSync(allocFile, 'utf8')); A = { ser: j.ser ?? {}, pal: Number(j.pal) || 0, ship: j.ship ?? {} }; }   // 파일이 깨졌으면 던진다 — 어디까지 내줬는지 모르는 채로 주지 않는다
      const ranges = {}, take = (hi, n, max) => { if (hi + n > max) throw Object.assign(new Error('번호가 다 찼습니다'), { code: 409 }); return { from: hi + 1, to: hi + n }; };
      for (const [k, n] of Object.entries(need)) {
        if (k === 'pal') { ranges[k] = take(Math.max(A.pal, U.pal), n, 999999999); A.pal = ranges[k].to; }
        else if (k === 'ship') { ranges[k] = take(Math.max(Number(A.ship[ymd]) || 0, U.ship), n, 99999); A.ship[ymd] = ranges[k].to; }
        else { const c = k.slice(4), S = (A.ser[ymd] ??= {}); ranges[k] = take(Math.max(Number(S[c]) || 0, U.base[c] ?? 0), n, 999999); S[c] = ranges[k].to; }
      }
      for (const o of [A.ser, A.ship]) for (const d of Object.keys(o).sort().slice(0, -7)) delete o[d];   // 지난 날짜 기록은 최근 7일만
      const tmp = `${allocFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(A)); fs.renameSync(tmp, allocFile);
      return { ymd, ranges };
    });
  }
  const status = () => ({ events: store.count, file: fs.existsSync(file) ? fs.statSync(file).size : 0, stats: store.stats, recovery, writeError,
    forward: { url: cfg.url, enabled: !!cfg.enabled, apiKey: !!cfg.apiKey, pending: pending().length, sent: fw.sent, failed: fw.failed, lastOk: fw.lastOk, lastError: fw.lastError, lastJob: fw.lastJob, processing: fw.job ? { since: new Date(fw.job.at).toISOString(), events: fw.job.n } : null, batch: fw.batch, rejected: fw.rejected ?? 0, nextRetryMs: fw.nextAt ? Math.max(0, fw.nextAt - Date.now()) : 0 } });

  const route = async (method, pathname, query, bodyText) => {
    const p = pathname.replace(/^\/api\/epcis\/v1\/?/, '');
    if (p === '' || p === 'status') return { code: 200, body: status() };
    if (p === 'capture' && method === 'POST') {
      let doc; try { doc = JSON.parse(bodyText || '{}'); } catch { return { code: 400, body: { error: 'JSON이 아닙니다' } }; }
      try { const job = store.capture(doc); return { code: 202, body: { ...job, location: `/api/epcis/v1/capture/${job.captureID}` } }; } catch (e) { return { code: 400, body: { error: e.message } }; }
    }
    if (p.startsWith('capture/') && method === 'GET') { const j = store.get(p.slice(8)); return j ? { code: 200, body: j } : { code: 404, body: { error: '없는 캡처 작업' } }; }
    if (p === 'events' && method === 'GET') return { code: 200, body: store.query(query) };
    if (p === 'trace' && method === 'GET') { const id = query.get('epc'); return id ? { code: 200, body: { epc: id, events: store.trace(id) } } : { code: 400, body: { error: 'epc가 필요합니다' } }; }
    // 시리얼 발행 이어 받기: 오늘(ymd) 이미 저장소에 있는 제품코드별 마지막 번호 (조회만 — 번호를 받아 쓰려면 아래 serial-reserve)
    if (p === 'serial-base' && method === 'GET') { const ymd = query.get('ymd') ?? ''; return { code: 200, body: { ymd, ...usedMax(ymd) } }; }
    if (p === 'serial-reserve' && method === 'POST') {
      let b; try { b = JSON.parse(bodyText || '{}'); } catch { return { code: 400, body: { error: 'JSON이 아닙니다' } }; }
      try { return { code: 200, body: await reserve(b) }; } catch (e) { return { code: e.code ?? 503, body: { error: e.message } }; }
    }
    if (p === 'shipment' && method === 'GET') { const t = query.get('id') ?? query.get('truck'); return t ? { code: 200, body: store.shipmentOf(t) } : { code: 400, body: { error: 'id(출하 ID)가 필요합니다' } }; }   // truck= 은 예전 기록(트럭 이름 = 출하 ID)
    if (p === 'config') {
      if (method === 'POST') {
        let b; try { b = JSON.parse(bodyText || '{}'); } catch { return { code: 400, body: { error: 'JSON이 아닙니다' } }; }
        const urlBefore = cfg.url;
        if (b.url != null) { const u = String(b.url).trim(); if (u && !/^https?:\/\//.test(u)) return { code: 400, body: { error: 'http:// 또는 https:// 주소를 넣으세요' } }; if (u !== cfg.url) { cfg.url = u; fw.registered = null; if (b.apiKey == null) conf.forget('apiKey'); } }   // 주소를 바꾸면 저장한 키는 버린다 — 새 주소의 키를 다시 넣어야 보낸다
        if (b.apiKey != null) { conf.forget('apiKey'); cfg.apiKey = String(b.apiKey); }
        if (b.enabled != null) cfg.enabled = !!b.enabled;
        if (b.fromStart) cfg.cursor = 0;   // 처음부터 다시 보내기
        if (b.fromStart || cfg.url !== urlBefore) { fw.gen++; fw.job = null; }   // 처리 중이던 작업·진행 중인 응답은 새 커서에 반영하지 않는다
        fw.nextAt = 0; fw.backoff = interval; saveCfg();
      }
      return { code: 200, body: status().forward };
    }
    if (p === 'forward/test' && method === 'POST') { let b = {}; try { b = JSON.parse(bodyText || '{}'); } catch { /* 빈 본문 */ } return { code: 200, body: await test(b.url ?? base(), b.apiKey ? String(b.apiKey) : null) }; }
    return null;
  };
  return { route, status, store, pump, close: () => { clearInterval(timer); out?.end(); } };
}
