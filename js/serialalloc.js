// 제품 식별 번호 배정기 (앱 — 서버 있음) — 시리얼 · 팔레트 SSCC · 출하 ID 번호를 서버가 예약해 준 범위 안에서만 쓴다
//   왜: 화면이 자기 카운터로 세면 ① 서버의 「오늘 마지막 번호」 응답이 오기 전에 1번부터 발행하고 ② 화면이 둘(탭 · 앱 두 개)이면 같은 번호를 낸다.
//   서버(server/epcis-api.mjs POST /api/epcis/v1/serial-reserve)가 한 번에 한 요청씩 범위를 떼어 주고 파일에 남긴다 — 범위는 겹치지 않고, 앱을 다시 켜도 다시 나가지 않는다.
//   · 범위가 없으면 next()는 null — 시리얼 서비스(js/serial.js)가 발행을 보류했다가 범위를 받으면 이어서 발행한다 (1번부터 조용히 발행하지 않음)
//   · 남은 번호가 절반 아래면 미리 다음 범위를 받는다 · 받기 전에 다 쓰면(보류 발생) 다음 범위를 두 배로 (최대 MAX_SIZE)
//   · 요청 실패(서버 꺼짐 · HTTP 오류 · 형식 오류)는 간격을 늘려 계속 다시 — 상태는 화면(데이터 연동 창 EPCIS 칸 · 품질 추적 창)에 보인다
//   · 쓰지 않고 남은 번호(앱 종료 · 날짜 바뀜)는 버린다 — 번호가 건너뛸 수는 있어도 두 번 쓰이지는 않는다
// 렌더링 · 시뮬레이션과 분리 — reserve(요청) 함수와 시계를 넘겨받아 헤드리스 시험에서도 같은 경로.
export const ALLOC_SIZE = { ser: 40, pal: 10, ship: 6 }, ALLOC_MAX = 400;

export class SerialAllocator {
  // reserve({ ymd, need: { 'ser:DT': 40, pal: 10, ship: 6 } }) → { ranges: { 'ser:DT': { from, to }, … } } (실패는 던진다)
  constructor(reserve, { now = () => Date.now(), sizes = ALLOC_SIZE } = {}) {
    this.reserve = reserve; this.now = now; this.sizes = { ...sizes };
    this.ymd = null; this.pools = new Map();   // 'ser:DT' · 'pal' · 'ship' → { ranges: [{ from, to }], left, size, dry }
    this.busy = false; this.fails = 0; this.retryAt = 0; this.lastError = null; this.lastOk = null;
    this.stats = { requests: 0, failed: 0, reserved: 0, used: 0, blocked: 0, discarded: 0 };
  }
  key(kind, code) { return kind === 'ser' ? `ser:${code}` : kind; }
  pool(k) { let P = this.pools.get(k); if (!P) { P = { ranges: [], left: 0, size: this.sizes[k.split(':')[0]] ?? 10, dry: false }; this.pools.set(k, P); } return P; }
  // 생산일(YYMMDD) — 시리얼 · 출하 ID는 날짜별 번호라 날짜가 바뀌면 받아 둔 범위를 버린다 (팔레트 SSCC는 날짜 없음 — 그대로)
  setYmd(ymd) {
    if (ymd === this.ymd) return;
    if (this.ymd != null) for (const [k, P] of this.pools) if (k !== 'pal') { this.stats.discarded += P.left; P.ranges = []; P.left = 0; }
    this.ymd = ymd;
  }
  // 쓸 번호 종류를 미리 알려 첫 제품이 나오기 전에 범위를 받아 둔다
  prime(keys) { for (const k of keys) this.pool(k); this.pump(); }
  left(kind, code) { return this.pools.get(this.key(kind, code))?.left ?? 0; }
  // 번호 하나 — 범위가 없으면 null (발행 보류)
  next(kind, code) {
    const P = this.pool(this.key(kind, code));
    if (!P.left) { this.stats.blocked++; P.dry = true; this.pump(); return null; }
    const r = P.ranges[0], n = r.from++; if (r.from > r.to) P.ranges.shift();
    P.left--; this.stats.used++;
    if (P.left * 2 <= P.size) this.pump();
    return n;
  }
  // 모자란 종류의 다음 범위 요청 — 한 번에 하나 · 실패하면 0.5초부터 15초까지 간격을 늘려 다시 (시리얼 서비스가 매 갱신마다 부른다)
  async pump() {
    if (this.busy || this.ymd == null || this.now() < this.retryAt) return;
    const need = {};
    for (const [k, P] of this.pools) if (P.left * 2 <= P.size) { if (P.dry) { P.size = Math.min(ALLOC_MAX, P.size * 2); P.dry = false; } need[k] = P.size; }
    if (!Object.keys(need).length) return;
    this.busy = true; this.stats.requests++;
    const ymd = this.ymd;
    try {
      const j = await this.reserve({ ymd, need }), R = j?.ranges ?? {};
      for (const [k, n] of Object.entries(need)) { const r = R[k]; if (!r || !Number.isInteger(r.from) || !Number.isInteger(r.to) || r.from < 1 || r.to < r.from || r.to - r.from + 1 > n) throw new Error(`번호 범위 응답 형식 오류 (${k})`); }
      for (const k of Object.keys(need)) {
        const r = R[k], n = r.to - r.from + 1;
        if (ymd !== this.ymd && k !== 'pal') { this.stats.discarded += n; continue; }   // 기다리는 사이 날짜가 바뀜 — 지난 날짜 범위는 쓰지 않는다
        const P = this.pool(k); P.ranges.push({ from: r.from, to: r.to }); P.left += n; this.stats.reserved += n;
      }
      this.fails = 0; this.lastError = null; this.lastOk = this.now(); this.retryAt = 0;
    } catch (e) { this.fails++; this.stats.failed++; this.lastError = e?.message ?? String(e); this.retryAt = this.now() + Math.min(15000, 500 * 2 ** Math.min(this.fails - 1, 5)); }
    finally { this.busy = false; }
  }
  // 화면 표시용 — state: ok(번호 있음) · wait(첫 범위를 기다리는 중) · retry(요청 실패 — 다시 시도 중)
  status() {
    const left = Object.fromEntries([...this.pools].map(([k, P]) => [k, P.left])), dry = Object.keys(left).filter((k) => !left[k]);
    return { state: this.fails ? 'retry' : dry.length || this.lastOk == null ? 'wait' : 'ok', left, dry, fails: this.fails, lastError: this.lastError, retryInMs: this.fails ? Math.max(0, this.retryAt - this.now()) : 0, ...this.stats };
  }
}
// 화면에서 쓰는 요청 함수 — HTTP 오류(r.ok === false)와 JSON 오류 응답({ error })도 실패로 던진다
export const reserveVia = (fetchImpl, url = '/api/epcis/v1/serial-reserve') => async (body) => {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* JSON이 아닌 응답 */ }
  if (!r.ok || !j || j.error) throw new Error(j?.error ? String(j.error) : `HTTP ${r.status}`);
  return j;
};
