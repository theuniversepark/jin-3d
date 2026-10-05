// 공장 운영 에이전트 — 관찰(Observe) → 판단(Decide) → 실행(Act) 루프.
// 전통 모드에서는 '작업반장'의 경험 기반 수동 운영(지연·임계치 기반)을 흉내낸다.

import { LOC, PALLET_RAW, RAW_CAP } from './sim.js';

// 의사결정 분류 (제목으로 판정)
export const AGENT_CAT = [['예지정비', /예지정비|정비 지시/], ['품질 보정', /보정|SPC/], ['투입 제어', /투입/], ['병목 최적화', /병목|사이클 복귀|표준 사이클/], ['자재 물류', /자재|공급|조달|배차/], ['AGV 충전', /충전/], ['에너지 절감', /절전/]];

const fmtMin = (sec) => (sec >= 60 ? `${(sec / 60).toFixed(1)}분` : `${Math.round(sec)}초`);

export class FactoryAgent {
  constructor(sim) {
    this.sim = sim;
    this.m = sim.mode;
    this.t = 0;
    this.cool = new Map();
    this.decisions = 0; this.byCat = {}; this.history = [];
    this.supplyWait = 0;
    this.boosted = null;
    this.disruptHandled = 0;
    this.lastThought = '라인 상태 학습 중…';
  }

  get name() { return this.m.agentActive ? (this.m.key === 'dark' ? '피지컬AI 자율운영 에이전트' : '자동화 운영 에이전트 (MES)') : '작업반장 (수동 운영)'; }

  ready(key, sec) {
    const last = this.cool.get(key) ?? -1e9;
    if (this.sim.time - last >= sec) { this.cool.set(key, this.sim.time); return true; }
    return false;
  }

  decide(level, title, body) {
    this.decisions++;
    // FACOS 자율 에이전트 화면: 분류별 누적 + 최근 판단 근거
    const cat = AGENT_CAT.find(([, re]) => re.test(title))?.[0] ?? '기타';
    this.byCat[cat] = (this.byCat[cat] ?? 0) + 1;
    this.history.push({ t: this.sim.time, level, cat, title, ...body }); if (this.history.length > 200) this.history.shift();
    this.sim.log(level, title, body);
  }

  update(dt) {
    this.t += dt;
    if (this.t >= 1) { this.t = 0; this.think(); }
  }

  think() {
    this.logistics();
    if (!this.m.agentActive) return;
    this.maintenance();
    this.quality();
    this.flowControl();
    this.energy();
    this.fleet();
    this.summary();
  }

  nearest(list, loc) {
    let best = null, bd = 1e9;
    for (const v of list) {
      const d = Math.abs(v.x - loc.x) + Math.abs(v.z - loc.z);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  // ── 물류: 자재 공급 / 완제품 출하 ─────────────────
  logistics() {
    const s = this.sim, m = this.m;
    const free = s.vehicles.filter((v) => v.idle && !(m.batteryDrain && v.battery < (m.chargeAt ?? 0) * 0.6));
    const projected = s.rawStock + s.inboundRaw;

    if (projected <= m.reorderPoint) {
      this.supplyWait += 1;
      // 공급 차질 중에도 배차한다 — AGV는 자재창고에서 출고 재개를 기다린다 (안전재고 긴급 운송은 flowControl)
      if (this.supplyWait >= m.dispatchDelay) {
        const pool = free.length ? free : [];
        const v = m.agentActive
          ? pool.sort((a, b) => (Math.abs(a.x - LOC.WH.x) - a.battery * 0.3) - (Math.abs(b.x - LOC.WH.x) - b.battery * 0.3))[0]
          : pool[0];
        if (v) {
          s.dispatchSupply(v);
          this.supplyWait = 0;
          if (m.agentActive) {
            const rate = Math.max(1, 3600 / s.releaseInterval);
            this.decide('act', `자재 보충 배차 → ${v.id}`, {
              obs: `투입구 재고 ${s.rawStock}개 (재주문점 ${m.reorderPoint}개)`,
              dec: `소진 예상 ${fmtMin((s.rawStock / rate) * 3600)} · 배터리·거리 기준 최적 차량 선택`,
              act: `${v.id} 자재창고→투입구 팔레트 ${PALLET_RAW}개 운송`,
            });
          } else {
            this.decide('warn', '자재 부족 확인 → 지게차 출고 지시', {
              obs: `투입구 재고 ${s.rawStock}개 — 작업자 보고 후 ${m.dispatchDelay}초 경과`,
              act: `${v.id} 자재 운반`,
            });
          }
        }
      }
    } else this.supplyWait = 0;

    // 완제품 출하는 출하 지게차가 트럭 야드로 옮긴다 (js/shipping.js)
  }

  // ── 예지보전 ─────────────────
  maintenance() {
    const s = this.sim, m = this.m;
    for (const st of s.processing) {
      if (st.request || st.state === 'DOWN' || st.state === 'MAINT') continue;
      if (st.health >= m.pmThreshold) continue;
      const a = s.assess(st);
      const opportune = st.state !== 'BUSY';
      if (!opportune && st.health > m.pmThreshold - 7) continue;
      s.requestTech(st, 'pm');
      const who = m.techKind === 'humanoid' ? '정비 휴머노이드' : '정비원';
      this.decide('plan', `${st.name} 예지정비 지시`, {
        obs: `건강도 ${st.health.toFixed(0)}% · 진동/온도 추세 상승 · 10분 내 고장확률 ${(a.risk10 * 100).toFixed(0)}%`,
        dec: `잔여수명(RUL) 약 ${a.rul.toFixed(0)}분 → ${opportune ? '설비 대기 구간 활용' : '고장 임박, 즉시'} 계획정비 (고장수리 대비 다운타임 ${Math.round((1 - m.pmTime / m.repairTime) * 100)}%↓)`,
        act: `${who} 배정 (예상 ${m.pmTime}초)`,
      });
    }
  }

  // ── 품질(SPC) ─────────────────
  quality() {
    const s = this.sim, m = this.m;
    for (const st of s.processing) {
      if (st.def.inspect || st.request || st.state === 'DOWN' || st.state === 'MAINT') continue;
      const { cpk } = s.assess(st);
      if (cpk >= (m.cpkMin ?? 1.15)) continue;   // 재보정 시작 Cpk (개선 제안으로 조정)
      if (m.key === 'dark') {
        if (s.selfCalibrate(st)) {
          this.decide('plan', `${st.name} 자율 보정`, {
            obs: `SPC 공정능력 Cpk ${cpk.toFixed(2)} (기준 1.33 미달)`,
            dec: '공정 파라미터 드리프트 감지 — 폐루프 자율 보정 가능',
            act: '설비 자체 재보정 실행 (10초, 인력 불필요)',
          });
        }
      } else if (s.requestTech(st, 'cal')) {
        this.decide('plan', `${st.name} 공정 재보정`, {
          obs: `SPC 공정능력 Cpk ${cpk.toFixed(2)} (기준 1.33 미달)`,
          dec: '불량 발생 확률 증가 추세 — 선제 보정',
          act: '정비원 재보정 작업 배정 (약 15초)',
        });
      }
    }
  }

  // ── 흐름 제어: 병목·WIP·공급 차질 ─────────────────
  flowControl() {
    const s = this.sim, m = this.m;
    const src = s.stations[0];

    // 1) 공급 차질 대응
    if (s.supplyDisrupted && this.disruptHandled < s.supplyDisruptedUntil) {
      const remain = s.supplyDisruptedUntil - s.time;
      const act = this.expedite();
      if (!act) return;   // 운송할 AGV가 없으면 다음 주기에 다시 시도
      s.supplyCommand?.(act);   // 오케스트레이터 판단·명령 단계로 기록
      this.decide('alert', '자재 공급 차질 감지', {
        obs: `창고 출고 중단 — 복구까지 ${fmtMin(remain)} 예상`,
        dec: 'SCM 연계로 대체 공급처 확보 가능, 라인 정지 회피 필요',
        act,
      });
    }

    // 2) 투입 속도(풀 방식) — 병목 사이클에 동기화. 혼류 Zone은 셀별 처리 비중을 곱한 부하로 본다
    let bott = null, bc = 0;
    for (const st of s.processing) {
      const c = st.def.cycle * m.cycleMul * st.speedMul * (st.def.share ?? 1);
      if (c > bc) { bc = c; bott = st; }
    }
    const target = +(bc * (m.releaseMargin ?? 0.98)).toFixed(2);
    if (Math.abs(target - s.releaseInterval) > 0.15) {
      s.releaseInterval = target;
      if (this.ready('release', 30)) {
        this.decide('act', '투입 속도 동기화', {
          obs: `현재 병목: ${bott.name} (${(bott.def.share ?? 1) < 1 ? `투입 1개당 부하 ${bc.toFixed(1)}초 · 처리 비중 ${Math.round(bott.def.share * 100)}%` : `사이클 ${bc.toFixed(1)}초`})`,
          dec: '병목보다 빠른 투입은 재공(WIP)만 증가 — 풀(Pull) 방식 적용',
          act: `투입 간격 ${target}초로 조정`,
        });
      }
    }

    // 3) WIP 제어
    const down = s.processing.filter((st) => st.state === 'DOWN' || st.state === 'MAINT');
    const wip = s.wip();
    if (!s.releaseHold && down.length && wip >= 12) {
      s.releaseHold = true;
      this.decide('act', '투입 일시 보류', {
        obs: `${down.map((d) => d.name).join(', ')} 정지 중 · 재공 ${wip}개`,
        dec: '상류 컨베이어 포화 → 추가 투입은 대기만 늘림',
        act: '자재 투입 보류 (설비 복구 시 자동 재개)',
      });
    } else if (s.releaseHold && (!down.length || wip < 7)) {
      s.releaseHold = false;
      this.decide('ok', '투입 재개', { obs: `재공 ${wip}개 · 정지 설비 ${down.length}대`, act: '자재 투입 재개' });
    }
    if (src.state === 'HOLD' && !s.releaseHold && !s.cmd.feedHold) src.state = 'BUSY';

    // 4) 병목 설비 사이클 최적화
    if (!this.ready('bneck', 45)) return;
    let cand = null, cu = 0;
    for (const st of s.processing) {
      if (st.def.inspect) continue;
      const q = s.queueLen(st);
      if (st.ema > (m.boostUtil ?? 0.85) && q >= (m.boostQueue ?? 3) && st.ema > cu && st.health > 60) { cu = st.ema; cand = st; }
    }
    if (this.boosted && (this.boosted.health < 55 || (cand && cand !== this.boosted))) {
      const b = this.boosted;
      b.speedMul = 1; this.boosted = null;
      this.decide('info', `${b.name} 표준 사이클 복귀`, {
        obs: `건강도 ${b.health.toFixed(0)}%`, dec: '고속 운전 마모 누적 방지', act: '사이클 100% 복귀',
      });
    }
    if (cand && cand !== this.boosted) {
      cand.speedMul = m.boostMul ?? 0.9; this.boosted = cand;
      this.decide('act', `병목 해소: ${cand.name} 사이클 최적화`, {
        obs: `이용률 ${(cand.ema * 100).toFixed(0)}% · 대기열 ${s.queueLen(cand)}개`,
        dec: '라인 산출은 병목이 결정 — 건강도 여유 있음, 마모 +30% 감수',
        act: `공정 파라미터 최적화로 사이클 ${Math.round((1 - (m.boostMul ?? 0.9)) * 100)}% 단축`,
      });
    }
  }

  // 안전재고를 AGV로 긴급 운송 + 대체 발주로 차질 기간 30% 단축 (차질 1건당 1회)
  // 재고가 실제로 투입구에 도착해야 쓰이고, 차질이 길면 그래도 라인이 자재 대기에 빠진다.
  expedite() {
    const s = this.sim;
    if (!s.supplyDisrupted || this.disruptHandled >= s.supplyDisruptedUntil) return null;
    const v = s.vehicles.filter((x) => x.idle && x.battery > 25).sort((a, b) => Math.abs(a.x - LOC.WH.x) - Math.abs(b.x - LOC.WH.x))[0];
    if (!v) return null;
    const remain = s.supplyDisruptedUntil - s.time;
    const add = Math.max(0, Math.min(s.safetyStock, RAW_CAP - s.rawStock - s.inboundRaw));
    if (add) s.dispatchSafety(v, add);
    s.supplyDisruptedUntil = s.time + remain * 0.7;
    this.disruptHandled = s.supplyDisruptedUntil;
    return `${add ? `안전재고 ${add}개 ${v.id} 긴급 운송 + ` : ''}대체 발주 (복구 ${fmtMin(remain * 0.7)}로 단축)`;
  }

  // ── 에너지 ─────────────────
  energy() {
    for (const st of this.sim.processing) {
      if (st.state === 'STARVED' && st.starvedFor > (this.m.ecoWait ?? 25) && !st.powerSave) {
        st.powerSave = true;
        if (this.sim.time > 120 && this.ready('eco' + st.id, 120)) {
          this.decide('info', `${st.name} 절전 모드`, {
            obs: `자재대기 ${Math.round(st.starvedFor)}초 지속`,
            act: `대기전력 70% 절감 (${(st.def.idleKW * 0.7).toFixed(1)}kW)`,
          });
        }
      }
    }
  }

  // ── AGV 충전 관리 ─────────────────
  fleet() {
    const s = this.sim, m = this.m;
    if (!m.batteryDrain) return;
    for (const v of s.vehicles) {
      if (!v.idle || v.battery >= m.chargeAt) continue;
      s.dispatchCharge(v);
      if (this.ready('chg' + v.id, 60)) {
        this.decide('info', `${v.id} 충전 지시`, {
          obs: `배터리 ${v.battery.toFixed(0)}%`,
          dec: m.key === 'dark' ? '유휴 구간 기회충전(Opportunity charging)' : '임계치 이하',
          act: '충전소 이동',
        });
      }
    }
  }

  summary() {
    const s = this.sim;
    let worst = null, wr = -1;
    for (const st of s.processing) {
      const a = s.assess(st);
      if (a.risk10 > wr) { wr = a.risk10; worst = st; }
    }
    let bott = null, bu = -1;
    for (const st of s.processing) if (st.ema > bu) { bu = st.ema; bott = st; }
    this.lastThought = `병목 ${bott.name}(이용률 ${(bu * 100).toFixed(0)}%) · 최대 위험 ${worst.name} (10분 고장확률 ${(wr * 100).toFixed(1)}%)`;
    if (s.time > 30 && this.ready('summary', 180)) {
      const k = s.kpi();
      this.sim.log('info', '라인 상태 요약', {
        obs: `UPH ${k.uphRecent.toFixed(0)} · OEE ${(k.OEE * 100).toFixed(1)}% · 재공 ${k.wip}개 · 전력 ${k.powerKW.toFixed(0)}kW`,
        dec: this.lastThought,
      });
    }
  }
}
