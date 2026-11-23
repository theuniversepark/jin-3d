// RCA 전담 서버 (더미) REST API — 메인 서버(화면의 FacOS 품질 모듈 · js/qcomm.js)가 불량 판정 리포트를 올리면 접수 → 분석 → 결과 발행 → 종결을 처리한다.
// 처리 로직은 js/rcacore.js (화면 시뮬레이션과 같은 코드). 분석 결과는 MQTT(내장 브로커 · 앱 서버일 때) metafactory/quality/v1/rca/{사례}/result로도 발행한다.
//   POST /api/rca/v1/reports                  리포트 접수 → 202 { ticket, status: received } (같은 실행(runId)·caseId는 같은 티켓 · 필수 항목 없으면 422)
//   GET  /api/rca/v1/reports?limit=100        목록 (최근 순)
//   GET  /api/rca/v1/reports/{ticket}         상세 (분석 결과 · 이력 · 종결)
//   POST /api/rca/v1/reports/{ticket}/close   8D 종결 보고 → 200
//   GET  /api/rca/v1/status                   서버 상태 · 상태별·우선순위별 건수
// 단독 실행: npm run rca-server (기본 127.0.0.1:8775)
import { RcaCore } from '../js/rcacore.js';

const ANALYZE_MS = 1500;   // 접수 → 분석 완료 (더미 처리 시간)
export function makeRcaApi({ publish = null } = {}) {
  const core = new RcaCore(), now = () => new Date().toISOString();
  const route = (method, pathname, query, bodyText) => {
    const p = pathname.replace(/^\/api\/rca\/v1\/?/, '');
    if (p === '' || p === 'status') return { code: 200, body: { ...core.stats(), mqtt: !!publish } };
    if (p === 'reports' && method === 'POST') {
      let rep; try { rep = JSON.parse(bodyText || '{}'); } catch { return { code: 400, body: { error: 'JSON이 아닙니다' } }; }
      const R = core.receive(rep, now());
      if (R.code === 202) setTimeout(() => {
        const V = core.analyze(R.body.ticket, now());
        if (V?.result && publish) publish([{ topic: `metafactory/quality/v1/rca/${V.caseId}/result`, payload: JSON.stringify(V.result), retain: false }]);
      }, ANALYZE_MS);
      return R;
    }
    if (p === 'reports') return method === 'GET' ? { code: 200, body: { reports: core.list(Math.max(1, Math.min(1000, Number(query.get('limit')) || 100))) } } : { code: 405, body: { error: 'GET · POST만 받습니다' } };
    const m = p.match(/^reports\/(RCA-\d{8}-\d{4})(\/close)?$/);
    if (m && m[2]) {
      if (method !== 'POST') return { code: 405, body: { error: 'POST만 받습니다' } };
      let sum; try { sum = JSON.parse(bodyText || '{}'); } catch { return { code: 400, body: { error: 'JSON이 아닙니다' } }; }
      return core.close(m[1], sum, now());
    }
    if (m) { const r = core.reports.get(m[1]); return r ? { code: 200, body: core.view(r) } : { code: 404, body: { error: '티켓 없음' } }; }
    return null;
  };
  return { core, route };
}
