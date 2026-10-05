// 자율 에이전트 구성 화면 (FACOS 🤖 자율 에이전트 팝업 → "🧩 에이전트 구성" 버튼)
// 에이전트 목록 · 기능 · 역할 · 권한 · 상관 관계(도식) · 메인 조정자 판정 순서 · 충돌 규칙을 지금 운전 중인 실제 수치와 함께 보여 준다.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 상관 관계 도식 (SVG): 상위 오케스트레이터 · 현장 보고 · 도메인 에이전트 → 제안 큐 → 메인 조정자 → 실행, 반사 계층은 바로 실행
function diagram(hybrid, H) {
  const box = (x, y, w, h, title, sub, cls) => `<g class="ai-box ${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9"/><text x="${x + w / 2}" y="${y + (sub ? h / 2 - 4 : h / 2 + 4)}" class="t">${esc(title)}</text>${sub ? `<text x="${x + w / 2}" y="${y + h / 2 + 13}" class="s">${esc(sub)}</text>` : ''}</g>`;
  const arrow = (x1, y1, x2, y2, label, cls = '') => `<g class="ai-arrow ${cls}"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#aiHead)"/>${label ? `<text x="${(x1 + x2) / 2 + 4}" y="${(y1 + y2) / 2 - 4}" class="l">${esc(label)}</text>` : ''}</g>`;
  const a = (k) => H?.agents.find((x) => x.key === k);
  const defs = '<defs><marker id="aiHead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>';
  if (!hybrid) {
    return `<svg class="ai-svg" viewBox="0 0 860 250" role="img" aria-label="단일 에이전트 구조">${defs}
      ${box(300, 10, 260, 46, '공장 오케스트레이터 (상위)', '안전 우선순위 P1~P5 · 인시던트 · 정비 배정', 'orch')}
      ${box(250, 95, 360, 60, '단일 자율 에이전트 (1초 루프)', '물류 → 정비 → 품질 → 흐름 → 에너지 → 충전 (순서대로 판단·실행)', 'main')}
      ${box(40, 105, 160, 40, '사족보행 순찰', '이상 징후 → 바로 정비·보정', 'field')}
      ${box(300, 195, 260, 44, '공장 (셀 · AGV · 정비 인력)', '시뮬레이션 실행', 'plant')}
      ${arrow(430, 155, 430, 193, '바로 실행')}${arrow(430, 93, 430, 58, '정비 요청')}${arrow(200, 125, 300, 205, '바로 실행', 'dash')}
      ${box(660, 95, 170, 60, '데이터', '공장 상태 · KPI', 'data')}${arrow(658, 125, 612, 125, '관찰')}</svg>`;
  }
  return `<svg class="ai-svg" viewBox="0 0 860 400" role="img" aria-label="혼합형 다중 에이전트 상관 관계">${defs}
    ${box(290, 8, 280, 48, '공장 오케스트레이터 (상위)', '안전 우선순위 P1~P5 · 인시던트 · 정비 인력 배정', 'orch')}
    ${box(20, 92, 170, 44, '정비 에이전트 · 5초', `제안 ${a('maint')?.proposed ?? 0} · 승인 ${a('maint')?.approved ?? 0}`, 'dom')}
    ${box(20, 146, 170, 44, '품질 에이전트 · 2초', `제안 ${a('quality')?.proposed ?? 0} · 승인 ${a('quality')?.approved ?? 0}`, 'dom')}
    ${box(20, 200, 170, 44, '흐름 에이전트 · 3초', `제안 ${a('flow')?.proposed ?? 0} · 승인 ${a('flow')?.approved ?? 0}`, 'dom')}
    ${box(20, 270, 170, 44, '사족보행 순찰 (현장 보고)', `보고 ${H?.reports ?? 0}건 → 정비·품질 제안`, 'field')}
    ${box(245, 150, 130, 50, '제안 큐', `대기 ${H?.queue ?? 0}건 · 중복 제거`, 'queue')}
    ${box(430, 132, 220, 86, '메인 조정자 · 1초', `승인 ${H?.approved ?? 0} · 보류 ${H?.deferred ?? 0} · 충돌 ${H?.conflicts ?? 0}`, 'main')}
    ${box(700, 150, 140, 50, '데이터', '공장 상태 스냅샷', 'data')}
    ${box(430, 300, 220, 46, '공장 실행', '셀 · AGV · 정비 인력 · 투입', 'plant')}
    ${box(700, 300, 140, 46, '반사 계층 · 1초', '배차 · 절전 · 충전 · 투입 보류', 'reflex')}
    ${arrow(190, 114, 243, 165, '제안')}${arrow(190, 168, 243, 172, '')}${arrow(190, 222, 243, 182, '')}${arrow(105, 268, 105, 246, '보고', 'dash')}
    ${arrow(375, 175, 428, 175, '판정')}
    ${arrow(540, 218, 540, 298, '승인 → 실행')}
    ${arrow(540, 130, 520, 58, 'P1 조회', 'dash')}${arrow(470, 58, 490, 130, '', 'dash')}<text x="404" y="100" class="ai-cap">P1 여부</text>
    ${arrow(615, 130, 560, 58, '정비 요청')}
    ${arrow(700, 175, 652, 175, '관찰')}${arrow(770, 202, 770, 298, '관찰')}
    ${arrow(698, 323, 652, 323, '바로 실행')}
    <text x="20" y="390" class="ai-cap">도메인 에이전트끼리는 직접 대화하지 않습니다 — 모든 제안은 제안 큐 → 메인 조정자. 반사 계층은 메인을 거치지 않아 메인이 멈춰도 계속 동작합니다.</text></svg>`;
}

export function agentStructureHTML(agent, sim) {
  const hybrid = agent.arch === 'hybrid', H = hybrid ? agent.status() : null, R = H?.rule ?? {};
  const dark = sim.mode.key === 'dark';
  const row = (name, layer, period, fn, role, power, live) => `<tr><td><b>${name}</b></td><td>${layer}</td><td>${period}</td><td class="ins2">${fn}</td><td class="ins2">${role}</td><td>${power}</td><td>${live ?? '-'}</td></tr>`;
  const a = (k) => H?.agents.find((x) => x.key === k);
  const list = hybrid ? [
    row('반사 계층', '실행 계층', '매 1초', '자재 보충 배차(재주문점 이하 → 배터리·거리 기준 AGV) · 공급 차질 중 배차 유지 · 셀 절전(자재대기 지속 → 대기전력 70%↓) · AGV 충전 · 정지 설비 앞 투입 보류(재공 12↑)·재개(7↓)', '빨라야 하는 판단을 규칙으로 즉시 처리 — 메인이 멈춰도 공장이 돈다', '<span class="ok">바로 실행</span>', '자재 배차·충전·절전'),
    row('정비 에이전트', '도메인', '5초', '셀 건강도 < 예지정비 기준이면 예지정비 제안 (기준−7%p 이하는 "위급") · 근거: 건강도·10분 고장확률·잔여수명 · 사족보행 순찰 보고(열화상·진동)도 받음', '설비 수명·고장 위험 담당', '제안만', `제안 ${a('maint').proposed} · 승인 ${a('maint').approved}`),
    row('품질 에이전트', '도메인', '2초', '공정능력 Cpk < 재보정 기준이면 재보정 제안 (피지컬AI: 셀 자율 보정 · 자동화: 정비원 재보정) · 순찰 미세 편차 보고도 받음', '품질·공정 편차 담당', '제안만', `제안 ${a('quality').proposed} · 승인 ${a('quality').approved}`),
    row('흐름 에이전트', '도메인', '3초', '투입 간격 = 병목 사이클 × 배율 · 병목 셀 고속 운전(사이클 10%↓)·해제 · 공급 차질 긴급 조달(안전재고 운송 + 대체 발주)', '처리량·재공 담당', '제안만', `제안 ${a('flow').proposed} · 승인 ${a('flow').approved}`),
    row('메인 조정자', '조정 계층', '매 1초', '제안 큐를 우선순위로 정렬 → 정리 → 안전 → 충돌 판정 → 승인한 것만 실행 · 판단 지연·충돌·보류·되돌림 기록', '에이전트 간 목표 충돌(처리량 ↔ 설비 수명 ↔ 안전)을 근거로 정리', '<span class="ok">승인·실행</span>', `승인 ${H.approved} · 보류 ${H.deferred} · 충돌 ${H.conflicts} · 평균 지연 ${H.avgLat.toFixed(1)}초`),
    row('공장 오케스트레이터', '상위 시스템', '사건마다', '인시던트 판단·명령 · 안전 우선순위 P1 화재·인명 → P2 시설 안전 → P3 생산 정지 → P4 생산 차질 → P5 효율 · 정비 인력 배정·선점', '메인 조정자가 P1 진행 여부를 조회 · 승인된 정비 요청을 받아 배정', '명령', `진행 중 인시던트 ${sim.orch.openCount()}건`),
    ...(dark ? [row('사족보행 순찰', '현장 보고자', '순찰마다', '열화상·진동·소음 스캔 → 이상 징후를 정비·품질 에이전트 제안으로 올림 (혼합형) · 단일 구조에서는 바로 정비', '현장 센서 · 판단 근거 제공', '보고만', `보고 ${H.reports ?? 0}건`)] : []),
  ] : [
    row('단일 자율 에이전트', '단일', '매 1초', '모듈 6개를 순서대로: ① 물류(자재 배차) ② 예지정비 ③ 품질(SPC 보정) ④ 흐름 제어(투입 간격·투입 보류·병목 고속 운전·공급 차질) ⑤ 에너지(절전) ⑥ 차량 충전', '판단하고 바로 실행 — 모듈 순서로 충돌을 피함', '<span class="ok">바로 실행</span>', `의사결정 ${agent.decisions}건`),
    row('공장 오케스트레이터', '상위 시스템', '사건마다', '인시던트 판단·명령 · 안전 우선순위 P1~P5 · 정비 인력 배정·선점 (P1 중 예지정비·재보정 보류)', '정비 요청을 받아 배정', '명령', `진행 중 인시던트 ${sim.orch.openCount()}건`),
    ...(dark ? [row('사족보행 순찰', '현장', '순찰마다', '열화상·진동 이상 → 바로 예지정비 · 미세 편차 → 바로 셀 자율 보정', '현장 감지와 실행', '바로 실행', '-')] : []),
  ];
  const steps = hybrid ? [
    ['정렬', '제안을 우선순위로 — P4(공급 차질·투입 간격·고속 운전 해제) → P5(예지정비·재보정·고속 운전), 같은 순위는 건강도 낮은 셀 먼저', '-'],
    ['정리', '이미 처리됐거나(정비 중·고장·요청 있음) 1분 넘은 제안은 버림', `${R.stale ?? 0}건`],
    ['안전', '오케스트레이터에 P1(화재·인명) 인시던트가 열려 있으면 예지정비·재보정 보류', `${R.p1 ?? 0}건`],
    ['충돌 ① 병목', '병목 셀이 가동 중이면 위급하지 않은 예지정비는 대기 구간까지 미룸', `${R.bott ?? 0}건`],
    ['충돌 ② 병목 근접', '실효 부하가 병목의 85%를 넘는 셀도 건강도가 조금 남았으면 기다림', `${R.nearBott ?? 0}건`],
    ['충돌 ③ 인력 한도', '정비 인력 수보다 많은 예지정비는 동시에 걸지 않음 (위급은 예외)', `${R.slots ?? 0}건`],
    ['충돌 ④ 정비 ↔ 고속 운전', '건강도가 낮거나 정비 제안이 대기 중인 셀의 고속 운전 거절', `${R.boostMaint ?? 0}건`],
    ['충돌 ⑤ 진동 방지', '투입 간격을 20초 안에 반대로 되돌리지 않음 (차이 0.6초 이상은 예외)', `${R.releaseOsc ?? 0}건`],
    ['실행', '통과한 제안만 실행하고 "○○ 에이전트 제안 → N초 뒤 실행"으로 기록 · 보류는 다음 판정 때 다시', `${H.approved}건 · 평균 ${H.avgLat.toFixed(1)}초 · 최대 ${H.latMax.toFixed(0)}초`],
  ] : [
    ['① 물류', '투입구 재고가 재주문점 이하이면 배터리·거리 기준 AGV 배차', '-'], ['② 예지정비', '건강도 < 기준이면 정비 지시 (가동 중이면 기준−7%p까지 기다림)', '-'],
    ['③ 품질', 'Cpk < 기준이면 재보정', '-'], ['④ 흐름 제어', '공급 차질 대응 → 투입 간격 동기화 → 정지 설비 앞 투입 보류 → 병목 고속 운전', '-'],
    ['⑤ 에너지', '자재대기가 이어진 셀 절전', '-'], ['⑥ 충전', '배터리 임계 이하 AGV 충전', '-'],
  ];
  const pend = hybrid && H.pending.length ? `<h4>지금 대기 중인 제안 ${H.pending.length}건</h4><table class="vla-t"><thead><tr><th>제안</th><th>대상</th><th>에이전트</th><th>출처</th><th>대기</th></tr></thead><tbody>${H.pending.slice(0, 8).map((q) => `<tr><td>${({ pm: '예지정비', cal: '재보정', release: '투입 간격', boost: '고속 운전', unboost: '고속 해제', expedite: '긴급 조달' })[q.kind] ?? q.kind}</td><td>${esc(q.st ?? '라인')}</td><td>${esc(H.agents.find((x) => x.key === q.by)?.label ?? q.by)}</td><td>${esc(q.source ?? '자체 감시')}</td><td>${q.age.toFixed(0)}초</td></tr>`).join('')}</tbody></table>` : '';
  return `<div class="ai-info">
    <p class="vla-note">지금 구조: <b>${hybrid ? '혼합형 다중 에이전트' : '단일 자율 에이전트'}</b> ${dark ? '(피지컬AI 기본: 혼합형)' : ''} — 오른쪽 에이전트 패널의 <b>단일 에이전트 | 혼합형 다중</b> 버튼으로 바꾸고, <b>🔬 트윈 비교</b>로 두 구조를 같은 조건에서 비교할 수 있습니다.</p>
    <h4>상관 관계</h4>${diagram(hybrid, H)}
    <h4>에이전트 목록 · 기능 · 역할</h4><div class="ai-tw"><table class="vla-t ai-t"><thead><tr><th>에이전트</th><th>계층</th><th>주기</th><th>기능</th><th>역할</th><th>권한</th><th>이번 운전</th></tr></thead><tbody>${list.join('')}</tbody></table></div>
    <h4>${hybrid ? '메인 조정자 판정 순서 (매 1초)' : '판단 순서 (매 1초, 모듈 순서)'}</h4><ol class="ai-steps">${steps.map(([k, d, n]) => `<li><b>${k}</b><span>${d}</span><em>${n}</em></li>`).join('')}</ol>
    ${pend}
    <h4>두 구조 비교 (트윈 · 시드 평균)</h4><table class="vla-t"><thead><tr><th>단계</th><th>단일</th><th>혼합형</th><th>판단 지연</th></tr></thead><tbody>
      <tr><td>자동화 · 2시간 × 5</td><td>UPH 391.2 · OEE 58.65%</td><td>UPH 400.5 · OEE 60.04% (+2.4%)</td><td>평균 약 0.7초</td></tr>
      <tr><td>피지컬AI · 2시간 × 5</td><td>UPH 381.1 · OEE 57.12%</td><td>UPH 383.1 · OEE 57.40% (+0.5%)</td><td>평균 0.75초</td></tr></tbody></table>
  </div>`;
}
