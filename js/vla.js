// VLA 데이터 파이프라인 (피지컬AI 단계)
// 1) 수집: VLA 로봇(6축 협동·산업용 로봇, AMMR)의 작업 사이클 하나를 에피소드 하나로 기록한다.
//    관측(관절·TCP·그리퍼·작업 단계)과 행동(다음 관절 목표)을 5Hz로, 로봇 카메라 프레임(JPEG)을 단계가 바뀔 때와 1초마다,
//    자연어 지시와 품질 결과(성공/실패) 라벨을 함께 남기고, 기준 시계(UTC)로 시각을 맞춘다 → AI-ready 데이터
// 2) 저장: 에피소드를 zip(메타·스텝 JSONL·카메라 JPEG)으로 묶어 서버(data/episodes/<로봇 ID>/)에 올린다. 서버가 없으면 브라우저에 보관
// 3) 학습·평가·배포: 새 에피소드가 쌓이면 VLA 학습 서버가 학습(에폭·손실) → 검증 성공률 게이트 → 카나리 1대 → 전체 OTA 배포
//    새 모델은 VLA 셀의 불량률·사이클을 조금 개선한다. 학습 자체는 시뮬레이션이고, 에피소드 데이터는 실제 기록이다.
import { zipStore } from './aasx.js';

export const EP_HZ = 5;                 // 스텝 기록 주기 (시뮬레이션 기준 Hz)
const KEEP = 30;                        // 로봇당 브라우저에 보관하는 최근 에피소드 수
export const SAMPLE = 3;                // 로봇마다 작업 사이클 3번에 1번을 에피소드로 기록 (데이터량·화면 부하 조절)
const TRAIN_MIN = 200;                  // 새 에피소드가 이만큼 쌓이면 자동 학습 (평가에서 떨어지면 두 배를 더 모은다)
const PHASES = ['approach', 'grasp', 'transport', 'insert', 'retract'];
const PHASE_KO = { approach: '접근', grasp: '집기', transport: '운반', insert: '조립·체결', retract: '복귀', assemble: '양팔 조립' };
const enc = new TextEncoder();
const two = (n, w = 6) => String(n).padStart(w, '0');

// VLA 6축 로봇의 작업 단계 (factory.animVLA 키프레임과 같은 구간)
function phaseOf(u) { return u < 0.1 ? 'approach' : u < 0.3 ? 'grasp' : u < 0.55 ? 'transport' : u < 0.75 ? 'insert' : 'retract'; }
// AMMR: 부품 선반 왕복 → 양팔 작업 단계를 VLA 단계 이름으로
const ammrPhase = (a) => (!a ? 'assemble' : a.phase === 'turnOut' || a.phase === 'driveOut' ? 'approach' : a.phase === 'pick' ? 'grasp' : a.phase === 'turnIn' || a.phase === 'driveIn' ? 'transport' : a.carry ? 'insert' : 'assemble');
function instruction(st, kind, product, color, lead = true) {
  if (!lead) return `${st.type === 'pack' ? '포장' : '분류'} 게이트 결정에 따라 작업물을 양팔로 잡아 고정하고 ${st.type === 'pack' ? '라벨을 붙여라' : 'ID 태그를 달아라'} (보조)`;
  const prod = product === 'eaxle' ? 'e-axle' : product === 'doortrim' ? '도어트림' : '제품';
  const verb = st.type === 'screw' || st.type === 'fasten' ? '체결' : st.type === 'sort' ? '분류' : st.type === 'pack' ? '포장' : '조립';
  if (kind === 'humanoid') return `머리 카메라로 피더의 부품을 확인하고 양손으로 집어 AMR 위 ${prod}에 ${verb}하라`;
  return kind === 'ammr' ? `옆 선반으로 이동해 양팔로 부품을 집어 와 ${prod}에 ${verb}하라` : `선반의 ${color} 부품을 집어 AMR 위 ${prod}에 ${verb}하라`;
}

// ── 에피소드 기록기 (3D 화면 쪽: 관절값·카메라는 화면 모델에서 읽는다) ─────────────────
export class EpisodeRecorder {
  constructor(view, camWall, hub) { this.view = view; this.camWall = camWall; this.hub = hub; this.server = false; this.onEpisode = null; }
  attach(sim) {
    this.sim = sim; this.on = sim.mode.key === 'dark';
    this.byRobot = new Map(); this.rec = new Map(); this.seq = 0; this.total = 0; this.uploaded = 0; this.bytes = 0; this.captureQ = [];
    this.runId = this.hub?.runId ?? `run-${Date.now()}`;
  }
  // 기록 대상: VLA 6축 로봇과 AMMR (셀 로봇 ID가 있는 것)
  robots() {
    const out = [];
    for (const sv of this.view.stationViews) (sv.parts.robots ?? []).forEach((r, i) => {
      const uid = sv.st.robotUids?.[i];
      if (uid && (r.vla || ((r.kind === 'ammr' || r.kind === 'humanoid') && sv.st.vla))) out.push({ uid, r, i, sv, st: sv.st });
    });
    return out;
  }
  list(uid) { return this.byRobot.get(uid) ?? []; }

  update() {
    if (!this.on || !this.sim) return;
    const sim = this.sim, t = sim.time;
    for (const R of this.robots()) {
      const { uid, r, i, st } = R;
      let rec = this.rec.get(uid);
      const working = st.state === 'BUSY' && st.item && !st.item.scrap;
      const p = st.progress ?? 0, u = r.vla ? (p + i * 0.07) % 1 : p;
      if (!rec && working && p < 0.2 && R.st.item.id !== this.lastItem?.get(uid)) {   // 새 사이클 → (샘플링해) 에피소드 시작
        (this.lastItem ??= new Map()).set(uid, st.item.id);
        const k = (this.cycles ??= new Map()).get(uid) ?? 0; this.cycles.set(uid, k + 1);
        if (k % SAMPLE) continue;
        const color = ['파란', '초록', '노란', '빨간'][(st.c.processed + i) % 4];
        rec = { id: `ep_${two(++this.seq)}`, uid, robot: r, idx: i, st, kind: r.kind, item: st.item.id, product: st.item.product ?? null,
          t0: t, iso0: this.hub.iso(t), steps: [], frames: [], lastSample: -1, lastPhase: null, instruction: instruction(st, r.kind, st.item.product, color, this.sim.isLead(st, i)),
          model: sim.vla?.versionOf(uid) ?? 'v1.0' };
        this.rec.set(uid, rec);
      }
      if (!rec) continue;
      const ended = !st.item || st.item.id !== rec.item || st.done || p >= 0.999;
      const broken = ['DOWN', 'ESTOP', 'PSTOP'].includes(st.state);
      if (t - rec.lastSample >= 1 / EP_HZ - 1e-6 || ended || broken) {
        rec.lastSample = t;
        const q = r.joints().map((v, k) => Math.round(v * (r.jointDefs?.[k]?.unit === 'mm' ? 1000 : 1e4)) / (r.jointDefs?.[k]?.unit === 'mm' ? 1 : 1e4));
        const b = r.root.getWorldPosition(r.root.position.clone()), w = r.tip.getWorldPosition(r.tip.position.clone());
        const tcp = [Math.round((w.x - b.x) * 1000), Math.round(-(w.z - b.z) * 1000), Math.round((w.y - b.y) * 1000)];
        const phase = r.vla ? phaseOf(u) : ammrPhase(st.ammr?.[i]);
        const grip = r.vla ? (r.vla.held.visible ? 1 : 0) : st.ammr?.[i]?.carry ? 1 : 0;
        const step = { i: rec.steps.length, t: Math.round((t - rec.t0) * 1000) / 1000, ts: this.hub.iso(t), state: q, tcp_mm: tcp, gripper: grip, phase, frame: null };
        if (phase !== rec.lastPhase || rec.steps.length - (rec.lastFrameStep ?? -99) >= EP_HZ) {   // 단계가 바뀌거나 1초마다 카메라 프레임
          const fname = `frame_${two(rec.frames.length, 3)}.jpg`; step.frame = fname; rec.lastPhase = phase; rec.lastFrameStep = rec.steps.length;
          this.captureQ.push({ rec, fname, ref: { type: 'cell', stationId: st.id, idx: i }, t: step.t });
        }
        rec.steps.push(step);
      }
      if (ended || broken) this.finish(rec, broken ? `중단: ${st.state}` : null);
    }
    // 카메라 캡처는 한 프레임에 2장까지 (화면 끊김 방지)
    for (let k = 0; k < 2 && this.captureQ.length; k++) {
      const c = this.captureQ.shift(), pr = this.camWall.captureFrame(c.ref, 160, 120);
      c.rec.frames.push({ file: c.fname, t: c.t, data: pr });
    }
  }

  async finish(rec, abort) {
    this.rec.delete(rec.uid);
    const st = rec.st;
    // 행동 = 다음 스텝의 관절 목표 (마지막 스텝은 자기 자신)
    rec.steps.forEach((s, k) => { s.action = (rec.steps[k + 1] ?? s).state; });
    const defect = st.item && st.item.id === rec.item ? !!st.item.defect : false;
    const ep = {
      id: rec.id, robot: rec.uid, cell: st.id, cell_name: st.name, robot_kind: rec.kind, product: rec.product, item_id: rec.item,
      instruction: rec.instruction, model_version: rec.model, start: rec.iso0, end: this.hub.iso(this.sim.time),
      duration_s: Math.round((this.sim.time - rec.t0) * 100) / 100, length: rec.steps.length, fps: EP_HZ,
      success: !abort && !defect && rec.steps.length >= 3, termination: abort ?? (defect ? '품질 불량' : '정상 완료'),
      steps: rec.steps, frames: rec.frames, jointNames: (rec.robot.jointDefs ?? []).map((j) => j.name), jointUnits: (rec.robot.jointDefs ?? []).map((j) => (j.unit === 'mm' ? 'mm' : 'rad')),
    };
    if (ep.length < 3) return;
    const arr = this.byRobot.get(rec.uid) ?? []; arr.push(ep); if (arr.length > KEEP) arr.shift(); this.byRobot.set(rec.uid, arr);
    this.total++;
    this.dataBytes = (this.dataBytes ?? 0) + JSON.stringify(ep.steps).length + ep.frames.length * 6000;   // 관절·동작 기록 + 카메라 프레임(160×120 JPEG 약 6KB)
    this.sim.vla?.onEpisode(ep);
    // 서버 저장 (맥 앱·npm start) — 에피소드 하나를 zip으로
    if (this.server) {
      try {
        const zip = await buildEpisodesZip(rec.uid, [ep], this.runId);
        const r = await fetch(`/api/episodes?robot=${encodeURIComponent(rec.uid)}&id=${encodeURIComponent(`${this.runId}_${ep.id}`)}`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip });
        if (r.ok) { this.uploaded++; this.bytes += zip.length; ep.stored = true; }
      } catch { /* 서버 저장 실패해도 브라우저 보관본은 유지 */ }
    } else { ep.stored = false; }
  }
}

// ── 에피소드 파일 (zip) ─────────────────
// meta/info.json(데이터 카드·스키마) · meta/episodes.jsonl(에피소드 요약) · data/<에피소드>.jsonl(스텝) · videos/<에피소드>/frame_*.jpg
export async function buildEpisodesZip(uid, eps, runId) {
  const files = [];
  const e0 = eps[0];
  const info = {
    dataset: `jin3d_${uid}`, format: 'Jin-3D VLA episode v1 (LeRobot 유사 구조: 메타 · 스텝 JSONL · 카메라 JPEG)', generator: 'Jin-3D 디지털트윈 (시뮬레이션 데이터)',
    run_id: runId, robot: { id: uid, kind: e0?.robot_kind, cell: e0?.cell, cell_name: e0?.cell_name, joints: e0?.jointNames, units: e0?.jointUnits },
    fps: EP_HZ, episodes: eps.length, total_steps: eps.reduce((a, e) => a + e.length, 0),
    features: {
      'observation.state': { dtype: 'float32', shape: [e0?.jointNames?.length ?? 0], names: e0?.jointNames, units: e0?.jointUnits },
      'observation.tcp_mm': { dtype: 'int32', shape: [3], names: ['x', 'y', 'z'], frame: '로봇 베이스 기준 (x 전방, y 왼쪽, z 위)' },
      'observation.gripper': { dtype: 'int8', shape: [1], desc: '1 = 부품 파지' },
      'observation.image': { dtype: 'jpeg', shape: [120, 160, 3], desc: '로봇 카메라 프레임 (작업 단계가 바뀔 때 · 1초마다)' },
      action: { dtype: 'float32', shape: [e0?.jointNames?.length ?? 0], desc: '다음 스텝 관절 목표 (절대값)' },
      phase: { dtype: 'string', values: [...PHASES, 'assemble'] },
      'episode.instruction': { dtype: 'string', desc: '자연어 작업 지시' },
      'episode.success': { dtype: 'bool', desc: '품질 결과 라벨 (불량·중단이면 false)' },
    },
    time: '모든 시각은 디지털트윈 기준 시계(UTC, ISO 8601). t는 에피소드 시작 기준 초',
  };
  files.push({ path: 'meta/info.json', data: JSON.stringify(info, null, 2) });
  files.push({ path: 'meta/episodes.jsonl', data: eps.map((e) => JSON.stringify({ episode: e.id, instruction: e.instruction, success: e.success, termination: e.termination, product: e.product, item_id: e.item_id, model_version: e.model_version, start: e.start, end: e.end, duration_s: e.duration_s, length: e.length, frames: e.frames.length })).join('\n') + '\n' });
  for (const e of eps) {
    files.push({ path: `data/${e.id}.jsonl`, data: e.steps.map((s) => JSON.stringify({ step: s.i, t: s.t, timestamp: s.ts, 'observation.state': s.state, 'observation.tcp_mm': s.tcp_mm, 'observation.gripper': s.gripper, action: s.action, phase: s.phase, 'observation.image': s.frame ? `videos/${e.id}/${s.frame}` : null })).join('\n') + '\n' });
    for (const f of e.frames) { const d = await f.data; if (d) files.push({ path: `videos/${e.id}/${f.file}`, data: d }); }
  }
  files.push({ path: 'README.txt', data: `Jin-3D VLA 에피소드 데이터 — 로봇 ${uid}\n에피소드 ${eps.length}개 · ${EP_HZ}Hz · 카메라 프레임 JPEG 160x120 (단계 전환·1초마다)\n스키마: meta/info.json · 요약: meta/episodes.jsonl · 스텝: data/*.jsonl · 영상: videos/*/frame_*.jpg\n시뮬레이션으로 생성된 데이터입니다.\n` });
  return zipStore(files);
}

// ── VLA 학습·평가·배포 파이프라인 (시뮬레이션 시간으로 진행) ─────────────────
export class VLAPipeline {
  constructor(sim) {
    this.sim = sim; this.on = sim.mode.key === 'dark';
    this.versions = new Map();     // 로봇 ID → 배포된 모델 버전 번호 (1 = v1.0)
    this.latest = 1; this.jobs = []; this.job = null; this.newEps = 0; this.allEps = 0; this.okEps = 0;
    this.robotStats = new Map();   // 로봇 ID → { n, ok }
    sim.vla = this;
  }
  label(v) { return `v1.${v - 1}`; }
  versionOf(uid) { return this.label(this.versions.get(uid) ?? 1); }
  get trainAt() { return TRAIN_MIN * (this.backoff ?? 1); }   // 다음 자동 학습까지 필요한 새 에피소드 수
  // 셀 효과: 셀 로봇들의 모델 버전 평균 — 버전마다 사이클 1.5%·불량 10% 개선 (최대 5단계)
  level(st) { const ids = st.robotUids ?? []; if (!ids.length || !st.vlaCell) return 0; return ids.reduce((a, id) => a + Math.min(5, (this.versions.get(id) ?? 1) - 1), 0) / ids.length; }
  cycleFactor(st) { return Math.pow(0.985, this.level(st)); }
  defectFactor(st) { return Math.pow(0.9, this.level(st)); }

  onEpisode(ep) {
    this.newEps++; this.allEps++; if (ep.success) this.okEps++;
    const s = this.robotStats.get(ep.robot) ?? { n: 0, ok: 0 }; s.n++; if (ep.success) s.ok++; this.robotStats.set(ep.robot, s);
  }
  startTraining(manual = false) {
    if (!this.on || this.job || this.newEps < (manual ? 5 : TRAIN_MIN)) return false;
    const v = this.latest + 1, n = this.newEps;
    this.job = { v, label: this.label(v), episodes: n, total: this.allEps, phase: 'train', t0: this.sim.time, epochs: 10, epoch: 0, loss: [], val: null, rollout: [], log: [] };
    this.jobs.unshift(this.job); if (this.jobs.length > 12) this.jobs.pop();
    this.newEps = 0;
    this.sim.log('plan', `VLA 학습 시작 · ${this.job.label}`, { obs: `새 에피소드 ${n}개 (누적 ${this.allEps}개, 성공률 ${Math.round((this.okEps / Math.max(1, this.allEps)) * 100)}%)`, dec: manual ? '운영자 수동 학습 요청' : `새 에피소드 ${TRAIN_MIN}개 이상 → 자동 재학습`, act: 'VLA 학습 서버에서 미세조정(fine-tuning) 10 에폭' });
    return true;
  }
  update(dt) {
    if (!this.on) return;
    if (!this.job) { if (this.newEps >= TRAIN_MIN * (this.backoff ?? 1)) this.startTraining(); return; }
    const j = this.job, s = this.sim, el = s.time - j.t0;
    if (j.phase === 'train') {
      const ep = Math.min(j.epochs, Math.floor(el / 15));
      while (j.epoch < ep) { j.epoch++; j.loss.push(Math.round((0.12 + 0.9 * Math.exp(-0.32 * (j.epoch + (j.v - 2) * 4)) + 0.02 * Math.sin(j.epoch * 2.1)) * 1000) / 1000); }
      if (j.epoch >= j.epochs) { j.phase = 'eval'; j.t1 = s.time; }
    } else if (j.phase === 'eval' && s.time - j.t1 >= 15) {
      // 검증 성공률은 데이터가 쌓일수록 99%에 점점 다가간다 — 개선이 0.3%p 미만이면 배포하지 않는다
      const curve = (v) => 0.99 - 0.13 * Math.pow(0.72, v - 1);
      const base = curve(j.v) + (Math.sin(j.v * 7.3 + this.allEps) * 0.004), prev = curve(this.latest);
      j.val = Math.round(base * 1000) / 10; j.prevVal = Math.round(prev * 1000) / 10;
      if (base - prev >= 0.003) {
        this.backoff = 1;
        j.phase = 'canary'; j.t2 = s.time; this.latest = j.v;
        const canary = this.sim.processing.find((x) => x.vlaCell && x.robotUids?.length)?.robotUids[0];
        j.canary = canary; if (canary) { this.versions.set(canary, j.v); j.rollout.push(canary); }
        s.log('ok', `VLA ${j.label} 평가 통과 → 카나리 배포`, { obs: `검증 성공률 ${j.val}% (이전 ${j.prevVal}%)`, act: `${canary} 1대에 먼저 배포, 40초 모니터링` });
      } else {
        j.phase = 'rejected'; this.backoff = Math.min(4, (this.backoff ?? 1) * 2);
        s.log('warn', `VLA ${j.label} 평가 미달 — 배포 안 함`, { obs: `검증 성공률 ${j.val}% (이전 ${j.prevVal}%, 개선 0.3%p 미만)`, act: `현재 모델 유지 · 에피소드 ${TRAIN_MIN * this.backoff}개 더 모은 뒤 재학습` });
        this.job = null;
      }
    } else if (j.phase === 'canary' && s.time - j.t2 >= 40) {
      j.phase = 'rollout'; j.t3 = s.time;
      j.queue = this.sim.processing.filter((x) => x.vlaCell).flatMap((x) => x.robotUids ?? []).filter((u) => (this.versions.get(u) ?? 1) < j.v);
      s.log('act', `VLA ${j.label} 전체 OTA 배포 시작`, { obs: `카나리 ${j.canary} 이상 없음`, act: `로봇 ${j.queue.length}대 순차 배포 (3초 간격)` });
    } else if (j.phase === 'rollout') {
      while (j.queue.length && s.time - j.t3 >= (j.rollout.length) * 3) { const u = j.queue.shift(); this.versions.set(u, j.v); j.rollout.push(u); }
      if (!j.queue.length) { j.phase = 'done'; j.tEnd = s.time; s.log('ok', `VLA ${j.label} 배포 완료`, { obs: `로봇 ${j.rollout.length}대 추론 모델 ${j.label}`, act: '셀 불량률·사이클 개선 반영' }); this.job = null; }
    }
  }
}
