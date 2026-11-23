// RCA 전담 서버 (더미) 처리 로직 — 앱 서버(server/rca-api.mjs, 실제 HTTP)와 화면 시뮬레이션(js/qcomm.js, 웹·공유 페이지)이 같은 코드를 쓴다.
// 받는 것: 메인 서버(FacOS 품질 모듈)가 올린 불량 판정 리포트 (POST /api/rca/v1/reports)
// 하는 일: ① 접수(티켓 발급 · 스키마 확인) → ② 분석(재발 횟수 · 원인 확정/재검토 · 우선순위 · 기한) → ③ 조치안(봉쇄 · 8D 대책 후보) → ④ 종결(8D 요약 수신)
// 분석은 현장 엣지의 계보 분석(rca.causes)을 받아 서버 쪽 근거(같은 원인 재발 · 봉쇄 범위 · 유출 여부)로 확정하거나 사람 재검토로 돌린다 — 더미라 학습 모델은 없다.
export const RCA_SCHEMA = 'metafactory/quality-defect-report/1.0';
export const RCA_ENGINE = 'Jin-3D dummy RCA server 1.0';
const DUE_H = { P1: 1, P2: 4, P3: 24 };   // 우선순위별 대책 기한 (시간)
const ACTION = {
  health: { d5: '예지정비 착수 건강도 상향 · 해당 셀 즉시 점검', owner: '정비' },
  drift: { d5: '재보정 시작 Cpk 상향 · 해당 셀 즉시 재보정', owner: '공정 기술' },
  base: { d5: '지그·그리퍼·작업 조건 검토 (공정 고유 산포)', owner: '공정 기술' },
  amr: { d5: '운반 AMR 적재부·주행 충격 점검', owner: '물류' },
  lot: { d5: '원자재 로트 격리 · 수입검사 샘플링 강화', owner: '구매·품질' },
  env: { d5: '환경 인터록(기준 이탈 시 공정 보상) · 공조·출입 관리', owner: '설비·환경' },
};

export class RcaCore {
  constructor() { this.reports = new Map(); this.seq = 0; this.day = null; }
  // ① 접수: 필수 항목 확인 → 티켓. 같은 실행의 같은 사례를 다시 보내면 같은 티켓 (멱등) — 다른 실행의 같은 사례 번호는 새 티켓
  receive(rep, nowIso) {
    const miss = ['caseId', 'serial', 'detectedAt', 'inspection'].filter((k) => rep?.[k] == null);
    if (miss.length) return { code: 422, body: { error: `필수 항목 없음: ${miss.join(', ')}`, schema: RCA_SCHEMA } };
    for (const r of this.reports.values()) if (r.report.caseId === rep.caseId && (r.report.runId ?? null) === (rep.runId ?? null)) return { code: 200, body: this.view(r, true) };
    const d = (nowIso ?? new Date().toISOString()).slice(0, 10).replace(/-/g, '');
    if (d !== this.day) { this.day = d; this.seq = 0; }
    const ticket = `RCA-${d}-${String(++this.seq).padStart(4, '0')}`;
    const r = { ticket, status: 'received', receivedAt: nowIso, report: rep, result: null, closure: null, history: [{ t: nowIso, status: 'received' }] };
    this.reports.set(ticket, r);
    return { code: 202, body: this.view(r, true) };
  }
  // ② 분석: 재발(같은 셀·요인 최근 리포트) · 신뢰도 · 봉쇄 범위 · 유출 → 우선순위 · 원인 확정 또는 재검토 · ③ 조치안
  analyze(ticket, nowIso) {
    const r = this.reports.get(ticket); if (!r || r.result) return r ? this.view(r) : null;
    const rep = r.report, causes = rep.rca?.causes ?? [], top = causes[0] ?? null, second = causes[1] ?? null;
    const key = top ? `${top.station ?? '-'}:${top.factor}` : null;
    const same = [...this.reports.values()].filter((x) => x !== r && x.report.rca?.causes?.[0] && `${x.report.rca.causes[0].station ?? '-'}:${x.report.rca.causes[0].factor}` === key);
    const conf = rep.rca?.confidence ?? (top ? top.score : 0), suspects = rep.suspects?.length ?? 0, escaped = !!rep.escaped;
    const recurrence = same.length + 1;
    const priority = escaped || recurrence >= 3 ? 'P1' : suspects >= 10 || conf < 0.5 ? 'P2' : 'P3';
    const review = conf < 0.5;   // 1·2순위가 비슷하면 사람이 확인 (원인 확정 보류)
    const fk = top ? (/^(temp|rh|vib|pm|lux|noise)$/.test(top.factor) ? 'env' : top.factor) : 'base';
    const A = ACTION[fk] ?? ACTION.base;
    const pareto = {};
    for (const x of this.reports.values()) { const c = x.report.rca?.causes?.[0]; if (c) { const k = c.label ?? `${c.station}:${c.factor}`; pareto[k] = (pareto[k] ?? 0) + 1; } }
    r.result = {
      ticket, caseId: rep.caseId, serial: rep.serial, engine: RCA_ENGINE, analyzedAt: nowIso, priority, review,
      rootCause: top ? { station: top.station, factor: top.factor, label: top.label, score: top.score, confidence: conf, status: review ? '재검토 필요' : '확정' } : null,
      alternative: review && second ? { station: second.station, factor: second.factor, label: second.label, score: second.score } : null,
      recurrence, related: same.slice(-5).map((x) => x.ticket),
      containment: [`의심 제품 ${suspects}개 출하 보류 · 재검`, ...(top?.station ? [`${top.station} ${fk === 'drift' ? '재보정' : fk === 'health' ? '점검' : '작업 확인'} 후 재가동`] : []), ...(escaped ? ['출하분 추적·회수 검토'] : [])],
      actions: [{ d: 'D5', text: A.d5, owner: A.owner, due: due(nowIso, DUE_H[priority]) }, { d: 'D7', text: '재발 방지 표준화 — FMEA 발생도 갱신 · 관리계획 반영', owner: '품질', due: due(nowIso, DUE_H[priority] * 3) }],
      pareto: Object.entries(pareto).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, n]) => ({ label, n })),
    };
    r.status = 'analyzed'; r.history.push({ t: nowIso, status: 'analyzed', priority });
    return this.view(r);
  }
  // 조치 지시가 현장에 전달됨(메인 서버가 알림) · ④ 종결 (8D 요약)
  action(ticket, nowIso, info = {}) { const r = this.reports.get(ticket); if (!r) return null; r.status = 'actioned'; r.history.push({ t: nowIso, status: 'actioned', ...info }); return this.view(r); }
  close(ticket, summary, nowIso) {
    const r = this.reports.get(ticket); if (!r) return { code: 404, body: { error: '티켓 없음' } };
    r.closure = { ...summary, closedAt: nowIso }; r.status = 'closed'; r.history.push({ t: nowIso, status: 'closed' });
    return { code: 200, body: this.view(r) };
  }
  view(r, brief = false) {
    const links = { self: `/api/rca/v1/reports/${r.ticket}`, close: `/api/rca/v1/reports/${r.ticket}/close` };
    return brief ? { ticket: r.ticket, caseId: r.report.caseId, status: r.status, receivedAt: r.receivedAt, links }
      : { ticket: r.ticket, caseId: r.report.caseId, serial: r.report.serial, status: r.status, receivedAt: r.receivedAt, result: r.result, closure: r.closure, history: r.history, links };
  }
  list(limit = 100) { return [...this.reports.values()].slice(-limit).reverse().map((r) => ({ ticket: r.ticket, caseId: r.report.caseId, serial: r.report.serial, status: r.status, priority: r.result?.priority ?? null, rootCause: r.result?.rootCause?.label ?? null, receivedAt: r.receivedAt })); }
  stats() {
    const by = {}; for (const r of this.reports.values()) by[r.status] = (by[r.status] ?? 0) + 1;
    const pr = {}; for (const r of this.reports.values()) if (r.result) pr[r.result.priority] = (pr[r.result.priority] ?? 0) + 1;
    return { engine: RCA_ENGINE, schema: RCA_SCHEMA, reports: this.reports.size, byStatus: by, byPriority: pr };
  }
}
function due(iso, h) { const t = Date.parse(iso ?? new Date().toISOString()); return new Date((Number.isFinite(t) ? t : Date.now()) + h * 3600e3).toISOString(); }
