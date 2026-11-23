// 정밀조립Zone 공정별 제어 흐름도 — STEP별 4레인 스윔레인으로 셀 단위 공정의 지시·허가(제어)와 회신·보고(이벤트), 예외 분기를 그린다.
// 표현 형식(STEP별 레인 구성, 레인 안 순서는 실선 · 레인을 건너는 흐름은 점선 · 예외는 빨간 점선 · 레인 아래 운영 원칙 메모)은
// 「적응가공존 Cell 시나리오(V.1.5)」 [부록] 플로우 차트 컨셉(안)을 참고했고, 단계·항목은 정밀조립Zone 공정
// (혼류 투입 → 부품 판별·분기 → AMMR 조립 → 체결 전수 판정 → 제품별 포장 → 구분 적재·출하)과 이 시뮬레이션의 실제 동작에 맞춰 새로 정리했다.
// 시뮬레이션 상태와 연결해 지금 진행 중인 상자를 강조하고, 판정·예외 상자에 누적 건수를 표시한다.
import { ST_LABEL } from './sim.js';

// 상자 id = 레인 글자 + 행 번호 (A: 공장 오케스트레이터 · O: 셀 컨트롤러 · C: 현장 제어(STEP마다 이름) · F: 설비·로봇·AMR)
export const SF_LANES = { A: '공장 오케스트레이터', O: '셀 컨트롤러', C: '현장 제어', F: '설비·로봇·AMR' };
// 연결 종류: s 레인 안 순서 · c 제어(지시·허가) · e 이벤트(회신·보고) · x 예외(정지·불량)
const LINK_CLASS = { c: 'control', e: 'event', x: 'exc', s: 'seq' };

const cellsOf = (sim, ids) => sim.stations.filter((st) => ids.includes(st.id));
const sum = (sts, f) => sts.reduce((a, st) => a + f(st), 0);

export const STEP_FLOWS = [
  {
    no: 1, title: '혼류 투입·AMR 배차', cells: ['SRC'], ctl: '투입 PLC·AMR 관제',
    box: {
      A0: ['생산 계획·혼류 비율 적용', '제품별 누적 투입 편차 계산'], A1: ['다음 투입 제품 결정', '뒤처진 제품 우선 (평준화)'],
      O2: ['투입 주기 도달 확인', '병목 셀 사이클 기준 간격'], O3: ['빈 AMR 호출', '투입구 대기 AMR 지정'],
      C3: ['AMR 배차 응답', '잔량·충전·대기열 점검'], C4: ['투입구 정위치 도킹', '갠트리 동작 인터록 해제'],
      F4: ['AS/RS 갠트리 로딩', '원자재 1개 → AMR 상판'], C5: ['적재 감지·AMR 출발', '대상물 번호 부여·추적 시작'],
      A5: ['투입 대기 대응', 'AMR 부족·원자재 고갈 조치'], O6: ['투입 실적 집계', '부품 판별 셀로 운반 시작'],
    },
    exc: ['A5'],
    links: [['A0', 'A1'], ['A1', 'O2', 'c'], ['O2', 'O3'], ['O3', 'C3', 'c'], ['C3', 'C4'], ['C4', 'F4', 'c'], ['F4', 'C5', 'e'], ['C5', 'O6', 'e'], ['C3', 'A5', 'x', '투입 불가', 'src']],
    note: { A: '누적 비율 편차가 가장 큰 제품부터 투입', C: '투입 정지·비상정지 시 갠트리 잠금' },
    live(sim, [src]) {
      const on = { BUSY: ['C4', 'F4', 'C5'], NOAMR: ['C3', 'A5'], STARVED: ['A5'], HOLD: ['A5'], ESTOP: ['C4'], PSTOP: ['C4'] }[src.state] ?? [];
      return { on, n: { F4: `투입 ${sim.stats.released}`, A5: src.c.starved + src.c.blocked > 0 ? `대기 누적 ${Math.round(src.c.starved + src.c.blocked)}초` : null } };
    },
  },
  {
    no: 2, title: '부품 판별·라인 분기', cells: ['SORT'], ctl: '분류셀 PLC·비전',
    box: {
      A0: ['라인별 배분 기준 유지', '혼류 비율 바뀌면 경로 갱신'], O0: ['도착 AMR 수신', '대상물 번호·제품 조회'],
      C1: ['셀 입구 진입 판정', '앞 AMR 이탈 거리 확인'], F2: ['AMR 셀 중심 정차', '작업 위치 정렬'], F3: ['부품 비전 판별', '키트 구성·피킹'],
      C4: ['판별 결과 검증', '두 출구 여유 확인 후 배출'], A4: ['분류셀 정지 대응', '정비 배정·투입 속도 조정'],
      O5: ['출구 경로 선택', '도어트림 · e-axle 라인'], O6: ['분류 실적 기록', '조립셀로 AMR 출발'],
    },
    exc: ['A4'],
    links: [['O0', 'C1', 'c'], ['C1', 'F2', 'c'], ['F2', 'F3'], ['F3', 'C4', 'e'], ['C4', 'O5', 'e'], ['O5', 'O6'], ['C4', 'A4', 'x', '셀 정지', 'src']],
    note: { A: '분기 결과로 제품별 라인 부하 균형', C: '두 출구가 모두 비어야 배출' },
    live(sim, [st]) {
      const on = { BUSY: ['F2', 'F3'], STARVED: ['O0'], BLOCKED: ['C4', 'O5'], DOWN: ['A4'], MAINT: ['A4'] }[st.state] ?? [];
      return { on, n: { F3: `판별 ${st.c.processed}`, O5: `도어트림 ${sim.releasedBy?.doortrim ?? 0} · e-axle ${sim.releasedBy?.eaxle ?? 0}`, A4: st.c.fails ? `고장 ${st.c.fails}` : null } };
    },
  },
  {
    no: 3, title: 'AMMR 조립·부품 선반 보충', cells: ['DT_ASSY', 'EA_ASSY'], ctl: '조립셀 PLC·Edge 진단',
    box: {
      O0: ['대상물 수신·조립 시작', '제품별 조립 레시피 선택'], C0: ['조립 시작 인터록', '정지 명령·안전 영역 확인'],
      F1: ['AMMR 선반 부품 피킹', '양팔 조립 (부품 한 세트)'], C2: ['조립 데이터 기록', '압입 하중·위치 편차 누적'],
      C3: ['편차 추세 판정', '공정능력(Cpk) 저하 감지'], A3: ['조립 품질 영향 평가', '불량 위험·라인 영향 비교'],
      A4: ['자율 재보정 승인', '진행 중 대상물 완료 후 적용'], O4: ['재보정 일정 반영', '새 대상물 받기 잠시 중지'],
      C5: ['재보정 조건 확인', '정지·감속 명령과 충돌 점검'], F5: ['로봇 비전·힘 센서 재보정', '편차 초기화 후 조립 재개'],
      C6: ['재보정 결과 확인', '편차 회복 → 상위 통보'], A6: ['재발 여부 판단', '반복 시 예지정비 전환'],
      O7: ['조립 완료·배출', '체결셀로 AMR 출발'], C7: ['선반 결품 감지', 'AMMR 선반 앞 대기'], O8: ['결품·고장 대응 모드', '새 대상물 받지 않음'],
      F8: ['휴머노이드 출동', '선반 보충 · 고장 수리'],
    },
    exc: ['C7', 'O8', 'F8'],
    links: [['O0', 'C0', 'c'], ['C0', 'F1', 'c'], ['F1', 'C2', 'e'], ['C2', 'C3'], ['C3', 'A3', 'e'], ['A3', 'A4'], ['A4', 'O4', 'c'], ['O4', 'C5', 'c'], ['C5', 'F5', 'c'],
      ['F5', 'C6', 'e'], ['C6', 'A6', 'e'], ['C6', 'O7', 'e'], ['F1', 'C7', 'x', '선반 재고 0'], ['C7', 'O8', 'x', '', 'src', [0, -9]], ['A6', 'O8', 'x', '예지정비'], ['O8', 'F8', 'x', '', null, [9, 9]]],
    note: { A: '재보정은 셀이 자율 처리, 결과만 상위 통보', C: '비상정지는 셀 PLC가 즉시 처리' },
    live(sim, sts) {
      const on = new Set();
      for (const st of sts) {
        if (st.state === 'BUSY') on.add('F1').add('C2');
        if (st.state === 'STARVED') on.add('O0');
        if (st.state === 'BLOCKED') on.add('O7');
        if (['DOWN', 'MAINT', 'NOPARTS', 'REFILL'].includes(st.state)) on.add('O8').add('F8');
        if (st.state === 'NOPARTS' || st.state === 'REFILL') on.add('C7');
        if (st.cmd && st.cmd.override !== 1) on.add('C5');
        if (sim.orch.find(`cal:${st.id}`)) ['C3', 'A3', 'A4', 'C5', 'F5'].forEach((b) => on.add(b));
      }
      const parts = sts.filter((st) => st.parts != null).map((st) => st.parts);
      return { on: [...on], n: { F1: `조립 ${sum(sts, (st) => st.c.processed)}${parts.length ? ` · 선반 ${parts.join('/')}` : ''}`, A4: sim.stats.cal ? `재보정 ${sim.stats.cal}` : null, O8: sum(sts, (st) => st.c.fails) ? `고장 ${sum(sts, (st) => st.c.fails)}` : null } };
    },
  },
  {
    no: 4, title: '체결·토크 전수 판정 (양품 / 불량 분기)', cells: ['DT_FAST', 'EA_FAST'], ctl: '체결 컨트롤러·판정',
    box: {
      O0: ['대상물 수신·체결 준비', '제품별 체결 사양 선택'], C1: ['체결 시작 인터록', '지그 고정·공구 준비 확인'],
      F1: ['너트러너·스크류 체결', '토크·각도 곡선 기록'], C2: ['체결 데이터 전송', '체결 수·누락 점검'],
      O2: ['판정 데이터 정리', '사양 한계와 비교 준비'], A3: ['전수 품질 판정', '토크·각도 한계로 양품/불량'],
      O3: ['양품: 다음 셀 지정', '포장셀 경로 확정'], C3: ['배출 인터록 해제', '출구 공간 확인'], F3: ['양품 AMR 출발', '포장셀로 이동'],
      A4: ['불량: 원인 공정 추적', '불량을 만든 셀 기록'], O5: ['불량 처리 지시 수신', '대상물 불량 표시'],
      C6: ['불량품 분리 동작', '배출함 슈트 개방'], F6: ['불량품 배출함 이송', '빈 AMR은 적재장 경유 귀환'],
    },
    exc: ['A4', 'O5', 'C6', 'F6'],
    links: [['O0', 'C1', 'c'], ['C1', 'F1', 'c'], ['F1', 'C2', 'e'], ['C2', 'O2', 'e'], ['O2', 'A3', 'e'], ['A3', 'O3', 'c', '양품'], ['O3', 'C3', 'c'], ['C3', 'F3', 'c'],
      ['A3', 'A4', 'x', '불량'], ['A4', 'O5', 'x'], ['O5', 'C6', 'x'], ['C6', 'F6', 'x']],
    note: { A: '불량은 만든 셀까지 역추적', C: '체결 데이터로 전수 판정 (별도 검사 없음)' },
    live(sim, sts) {
      const on = new Set();
      for (const st of sts) {
        if (st.state === 'BUSY') on.add('C1').add('F1');
        if (st.state === 'STARVED') on.add('O0');
        if (st.state === 'BLOCKED') on.add('C3');
      }
      const ng = sum(sts, (st) => st.c.defects), ok = sum(sts, (st) => st.c.processed) - ng;
      // 방금 불량이 나왔으면 불량 분기를 6초 동안 강조 (시뮬레이션마다 따로 기억)
      const m = (sim.sfMark ??= {});
      if (m.ng !== ng) { m.ng = ng; m.ngT = sim.time; }
      if (ng && sim.time - m.ngT < 6) ['A4', 'O5', 'C6', 'F6'].forEach((b) => on.add(b));
      return { on: [...on], n: { A3: `판정 ${ok + ng}`, O3: `양품 ${Math.max(0, ok)}`, A4: `불량 ${ng}` } };
    },
  },
  {
    no: 5, title: '제품별 포장', cells: ['PACK'], ctl: '포장셀 PLC·로봇 제어',
    box: {
      A0: ['제품별 포장 기준 유지', '혼류 순서대로 처리'], O0: ['대상물 수신', '도어트림·e-axle 박스 선택'],
      C1: ['로봇 작업 허가', 'AMR 정차·안전 영역 확인'], F2: ['로봇 박스 포장', '제품 라벨 부착'],
      F3: ['포장 상태 확인', '박스 닫힘·라벨 위치'], C4: ['배출 조건 판정', '적재 구역 여유 확인'],
      A4: ['적재 지연 대응', '출하 배차 앞당김 검토'], O5: ['포장 실적 기록', '적재장으로 AMR 출발'],
    },
    exc: ['A4'],
    links: [['O0', 'C1', 'c'], ['C1', 'F2', 'c'], ['F2', 'F3'], ['F3', 'C4', 'e'], ['C4', 'O5', 'e'], ['C4', 'A4', 'x', '적재 지연', 'src']],
    note: { A: '적재 구역 만재 = 출하 배차 신호', C: '보호정지 시 로봇 자세 유지' },
    live(sim, [st]) {
      const on = { BUSY: ['C1', 'F2'], STARVED: ['O0'], BLOCKED: ['C4', 'A4'], DOWN: ['A4'] }[st.state] ?? [];
      return { on, n: { F2: `포장 ${st.c.processed}`, A4: st.c.blocked > 1 ? `배출대기 ${Math.round(st.c.blocked)}초` : null } };
    },
  },
  {
    no: 6, title: '구분 적재·출하·실적', cells: ['SINK'], ctl: '적재 PLC·출하 관제',
    box: {
      A0: ['출하 배차 계획', '제품 구역 수량 → 트럭 배차'], O0: ['도착 AMR 판별', '양품 박스 / 빈 AMR 구분'],
      C1: ['적재 로봇 집기 허가', '빈 AMR은 집기 없이 통과'], F1: ['적재 로봇 박스 집기', '제품별 구역에 쌓기'],
      F2: ['AMR 귀환', '투입구 대기열·충전'], F3: ['지게차 상차·출하', '트럭 적재 후 출발'],
      C3: ['적재·상차 완료 신호', '구역 수량 갱신'], O4: ['완제품 재고 반영', '제품별 적재 수량'],
      O5: ['생산 실적 확정', '양품·유출 불량 집계'], A5: ['KPI 갱신', 'UPH·OEE·재공 산출'],
      A6: ['FAC 기록', '생산입고·출하 전표 생성'], O7: ['AMR 재배치', '다음 투입 사이클 준비'],
    },
    exc: [],
    links: [['O0', 'C1', 'c'], ['C1', 'F1', 'c'], ['F1', 'F2'], ['F2', 'F3'], ['F3', 'C3', 'e'], ['C3', 'O4', 'e'], ['O4', 'O5'], ['O5', 'A5', 'e'], ['A5', 'A6'], ['O5', 'O7']],
    note: { A: '만재 전에 출하해 라인 막힘 예방', C: '' },
    live(sim, [st]) {
      const on = { BUSY: ['C1', 'F1'], FULL: ['C1', 'A0'] }[st.state] ?? [];
      const q = sim.fac?.on ? sim.fac.seq : null;
      return { on, n: { F1: `적재 ${st.c.processed}`, F3: `출하 ${sim.stats.shipped}`, A6: q ? `생산입고 ${q.mrp} · 출하 ${q.out}` : null, C1: sim.stats.rejected ? `빈 AMR ${sim.stats.rejected}` : null } };
    },
  },
];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const LX = ['A', 'O', 'C', 'F'];
const LW = 232, LG = 18, BW = 208, BH = 38, RH = 50, TOP = 34;   // LG: 레인 사이 통로 (꺾은선이 지나는 길)
const laneX = (l) => 6 + LX.indexOf(l) * (LW + LG);
const pos = (id) => { const l = id[0], r = +id.slice(1); return { l, r, x: laneX(l) + (LW - BW) / 2, y: TOP + r * RH, cx: laneX(l) + LW / 2, cy: TOP + r * RH + BH / 2 }; };

// STEP 하나를 4레인 흐름도(SVG)로 — flt: all | control | event (제어 흐름 탭 필터와 같이 쓴다)
export function stepFlowSvg(step, sim, flt = 'all') {
  const sts = cellsOf(sim, step.cells);
  const L = sts.length ? step.live(sim, sts) : { on: [], n: {} };
  const on = new Set(L.on), K = sim.cmd;
  const rows = Math.max(...Object.keys(step.box).map((id) => +id.slice(1))) + 1;
  const W = laneX('F') + LW + 6, H = TOP + rows * RH + 30;
  const lock = K?.estopAll ? '비상정지 인터록' : K?.pstopAll ? '보호정지 인터록' : sts.some((st) => st.cmd?.estop) ? '셀 비상정지' : sts.some((st) => st.cmd?.hold) ? '셀 정지 명령' : '';
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" class="sf" role="img" aria-label="STEP ${step.no} ${esc(step.title)} 제어 흐름도">
    <defs>${['control', 'event', 'exc', 'seq'].map((k) => `<marker id="sfa-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="sfm-${k}"/></marker>`).join('')}</defs>`;
  for (const l of LX) {
    const x = laneX(l), title = l === 'C' ? step.ctl : SF_LANES[l];
    svg += `<rect x="${x}" y="28" width="${LW}" height="${H - 32}" rx="6" class="sf-lane"/>
      <rect x="${x}" y="0" width="${LW}" height="22" rx="5" class="sf-lh ${l === 'C' && lock ? 'lock' : ''}"/><text x="${x + LW / 2}" y="15" text-anchor="middle" class="sf-lt">${esc(title)}${l === 'C' && lock ? ` · ${lock}` : ''}</text>`;
    if (step.note[l]) svg += `<text x="${x + LW / 2}" y="${H - 10}" text-anchor="middle" class="sf-note">${esc(step.note[l])}</text>`;
  }
  // 연결선: 레인 안은 아래로 곧게, 레인을 건너면 꺾은선 (via=src: 출발 레인 옆 통로에서 꺾음, 기본은 도착 레인 옆 통로)
  let labels = '';
  // oy: [출발, 도착] 상자 가운데에서 위아래로 비켜 붙이기 (한 상자 같은 면에 선 두 개가 붙을 때)
  for (const [a, b, t = 's', label, via, oy = [0, 0]] of step.links) {
    const p = { ...pos(a) }, q = { ...pos(b) }; p.cy += oy[0]; q.cy += oy[1];
    const cls = LINK_CLASS[a[0] === b[0] ? 's' : t] ?? 'seq', klass = t === 'x' ? 'exc' : cls;
    const dim = flt !== 'all' && klass !== 'seq' && !(flt === 'control' && klass === 'control') && !(flt === 'event' && klass === 'event');
    let d;
    if (p.l === q.l) d = `M${p.cx},${p.y + BH} L${q.cx},${q.y}`;
    else {
      const dir = Math.sign(LX.indexOf(q.l) - LX.indexOf(p.l)), sx = dir > 0 ? p.x + BW : p.x, ex = dir > 0 ? q.x : q.x + BW;
      if (p.r === q.r) d = `M${sx},${p.cy} L${ex},${q.cy}`;
      else {
        // 통로 안에서 출발 레인 쪽 꺾음(src)과 도착 레인 쪽 꺾음(dst)을 다른 줄로 — 같은 통로를 지나는 선이 겹치지 않게
        const gap = (l, right) => (right ? laneX(l) + LW : laneX(l) - LG);
        const gx = via === 'src' ? gap(p.l, dir > 0) + (dir > 0 ? 5 : LG - 5) : gap(q.l, dir < 0) + (dir > 0 ? LG - 5 : 5);
        d = `M${sx},${p.cy} L${gx},${p.cy} L${gx},${q.cy} L${ex},${q.cy}`;
        if (label) {
          // 마지막 가로 구간이 길면 그 위에, 짧으면 세로 구간 옆(출발 쪽 빈 공간)에 글자를 둔다
          const long = Math.abs(ex - gx) > 80;
          labels += long ? `<text x="${(gx + ex) / 2}" y="${q.cy - 4}" text-anchor="middle" class="sf-ll k-${klass} ${dim ? 'dim' : ''}">${esc(label)}</text>`
            : `<text x="${gx + (dir > 0 ? -4 : 4)}" y="${(p.cy + q.cy) / 2 + 4}" text-anchor="${dir > 0 ? 'end' : 'start'}" class="sf-ll k-${klass} ${dim ? 'dim' : ''}">${esc(label)}</text>`;
        }
      }
      if (p.r === q.r && label) labels += `<text x="${(sx + ex) / 2}" y="${q.cy - 4}" text-anchor="middle" class="sf-ll k-${klass} ${dim ? 'dim' : ''}">${esc(label)}</text>`;
    }
    if (p.l === q.l && label) labels += `<text x="${p.cx + 6}" y="${(p.y + BH + q.y) / 2 + 4}" class="sf-ll k-${klass} ${dim ? 'dim' : ''}">${esc(label)}</text>`;
    svg += `<path d="${d}" class="sf-ln k-${klass} ${dim ? 'dim' : ''}" marker-end="url(#sfa-${klass})"/>`;
  }
  for (const [id, [t1, t2]] of Object.entries(step.box)) {
    const p = pos(id), exc = step.exc.includes(id), act = on.has(id), n = L.n[id];
    svg += `<g class="sf-b ${exc ? 'exc' : ''} ${act ? 'on' : ''}"><title>${esc(SF_LANES[p.l])} · ${esc(t1)} — ${esc(t2)}${n ? ` (${esc(n)})` : ''}</title>
      <rect x="${p.x}" y="${p.y}" width="${BW}" height="${BH}" rx="4"/>
      <text x="${p.cx}" y="${p.y + 15}" text-anchor="middle" class="sf-t1">${esc(t1)}</text><text x="${p.cx}" y="${p.y + 30}" text-anchor="middle" class="sf-t2">${esc(t2)}</text>
      ${n ? `<text x="${p.x + BW - 3}" y="${p.y - 3}" text-anchor="end" class="sf-n">${esc(n)}</text>` : ''}</g>`;
  }
  return svg + labels + '</svg>';
}

// STEP 머리말에 붙는 셀 실시간 상태
export const stepCells = (step, sim) => cellsOf(sim, step.cells).map((st) => ({ name: st.name, state: st.state, label: ST_LABEL[st.state] ?? st.state }));
