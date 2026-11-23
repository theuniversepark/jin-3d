// ERPNext 연동 (선택 · 앱 전용) — FacOS 업무 기록(FAC)과 공장 오더를 오픈소스 ERP(ERPNext v16, GPL-3.0 · REST로만 호출)에 실제 전표로 남긴다.
// 흐름: 화면 FAC 기록 → 2초마다 /api/fac/push (server/fac-api.mjs) → 이 다리(facListen) → 디스크 대기열 → ERPNext REST /api/resource · /api/method
//   기준정보(「ERPNext 준비」): 초기 설정(회사 · KRW · 회계연도) · 품목 · 창고 · 공급사 · 고객사 · BOM(원자재 1 + 부품 키트 1 — 설계 가정) · 작업장 ·
//                              사용자 정의 필드 mf_ref(중복 방지) · 음수 재고 허용(시뮬레이션 전표 순서 차이 흡수) · 초과 생산 100% · 설비 자산 분류·정비팀
//   po.create → Purchase Order · receipt.done → Purchase Receipt(구매오더 연결) · internal.done → Stock Entry(Material Transfer)
//   production.done → Stock Entry(Manufacture — BOM 소비 + 완제품 입고 · 정밀조립 제품은 열린 작업지시에 먼저 배분) · delivery.done → Delivery Note
//   order.assign → Work Order(제품별 · 혼류 비중) · order.close → 계획보다 적게 만든 작업지시 중지(Stopped)
//   mr.create → Asset(처음이면 등록) + 긴급 = Asset Repair · 예방 = Asset Maintenance Log · mr.stage done → 완료 · 제출
// 모든 문서에 mf_ref(운전 ID:FAC 번호)를 남기고 만들기 전에 찾아본다 — 재전송해도 한 번만. ERPNext가 꺼져 있으면 대기열에 두고 다시 (앱은 그대로)
// 검증 오류(4xx)로 받지 못한 전표는 건너뛰고 사유를 남긴다 (한 건 때문에 연동이 멈추지 않게). 키는 데이터 폴더 erpnext/config.json — 응답에는 여부만
// 실제 ERPNext v16.52.0(frappe_docker pwd.yml)으로 문서 생성 방식을 확인했다.
import fs from 'node:fs';
import path from 'node:path';
import { FAC_PRODUCTS, SUPPLIER, CUSTOMER } from '../js/fac.js';
import { gs1Check } from '../js/serial.js';
import { configFile, writePrivate } from './secrets.mjs';
import { loadJsonl } from './jsonl.mjs';

export const WH_NAME = { rackRaw: '물류선반-원자재', rackParts: '물류선반-부품', feeder: '정밀조립-투입구', cells: '정밀조립-셀', output: '구분적재장', qis: '샘플재검-보류' };   // qis = 출하 전 샘플 재검(검사·포장셀 최종 검사대) 동안 샘플을 두는 보류 창고
// 품질: 검사 항목 · 품질 절차 (Non Conformance · Quality Action은 절차를 반드시 지정)
export const Q_PARAM = '샘플 재검 판정 (검사·포장셀)';
export const Q_PROC = { sample: '출하 전 샘플 재검 · 봉쇄 (ISO 2859-1)', mrb: '부적합품 처리 · MRB (ISO 9001 8.7)', d8: '8D 문제 해결 (IATF 16949 10.2.3)' };
// 완제품 BOM (원자재 1 + 부품 키트 1 — 설계 가정) · 원천 창고
export const BOMS = {
  doortrim: [['raw', 'feeder'], ['parts', 'cells']], eaxle: [['raw', 'feeder'], ['parts', 'cells']],
};
const WO_PRODUCTS = ['doortrim', 'eaxle'];   // 공장 오더(정밀조립 혼류)가 있는 제품
const REF_DOCTYPES = ['Purchase Order', 'Purchase Receipt', 'Stock Entry', 'Delivery Note', 'Work Order', 'Asset', 'Asset Repair', 'Asset Maintenance Log', 'Quality Inspection', 'Non Conformance', 'Quality Action'];
// SSCC EPC (urn:epc:id:sscc:업체코드.확장자리+일련) → 18자리 SSCC (확장 1 + 업체코드 + 일련 + 검사 숫자)
const ssccOfEpc = (epc) => { const [cp, rest] = String(epc).split(':').pop().split('.'); const b = `${rest[0]}${cp}${rest.slice(1)}`; return b + gs1Check(b); };
const rackOf = (p) => (p === 'raw' ? 'rackRaw' : 'rackParts');
const code = (p) => FAC_PRODUCTS[p]?.code ?? p;
class Transient extends Error {}

export function makeErpBridge({ dir, fetchImpl = globalThis.fetch, interval = 1500, serialsOf = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(dir, 'config.json'), qFile = path.join(dir, 'queue.jsonl'), stFile = path.join(dir, 'state.json');
  // 설정 파일 — API 키·비밀 키는 앱에서 safeStorage로 암호화해 쓴다 (server/secrets.mjs)
  const conf = configFile(cfgFile, { url: '', apiKey: '', apiSecret: '', company: '', enabled: false, serials: false }, ['apiKey', 'apiSecret']), cfg = conf.cfg;
  const st = Object.assign({ cursor: 0, prepared: null, wo: {}, docs: [], fail: [], sent: 0, skipped: 0 }, (() => { try { return JSON.parse(fs.readFileSync(stFile, 'utf8')); } catch { return {}; } })());
  // 대기열 — 깨진 줄이 있어도 정상 줄은 모두 살리고(server/jsonl.mjs) 상태에 복구 내용을 알린다. 깨진 줄은 보낼 때 건너뛴 것으로 센다
  const Lq = loadJsonl(qFile);
  let queue = Lq.items;
  const recovery = Lq.bad || Lq.torn ? { at: new Date().toISOString(), bad: Lq.bad, torn: Lq.torn } : null;
  if (st.cursor > queue.length) st.cursor = queue.length;   // 대기열 파일이 지워졌으면 보낸 위치도 맞춘다
  const rt = { busy: false, nextAt: 0, backoff: interval, lastError: recovery ? `대기열 파일 복구 — 깨진 줄 ${recovery.bad + (recovery.torn ? 1 : 0)}개 (정상 줄은 모두 살림${recovery.torn ? ` · 끝 조각은 ${path.basename(recovery.torn)}` : ''})` : null, lastOk: null, prep: null };
  const saveCfg = () => conf.save();
  const saveSt = () => writePrivate(stFile, JSON.stringify(st));   // 임시 파일 → 이름 바꾸기 (쓰다가 꺼져도 커서·전표 배분이 반쯤 쓰이지 않게)
  const base = () => String(cfg.url ?? '').replace(/\/+$/, '');
  const A = () => st.prepared?.abbr ?? 'JM', CO = () => st.prepared?.company ?? cfg.company, W = (k) => `${WH_NAME[k] ?? k} - ${A()}`;

  // ── ERPNext REST ─────────────────
  async function api(method, p, body) {
    let r;
    try { r = await fetchImpl(base() + p, { method, headers: { Authorization: `token ${cfg.apiKey}:${cfg.apiSecret}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); }
    catch (e) { throw new Transient(e.cause?.code === 'ECONNREFUSED' ? '연결 거부 — ERPNext가 꺼져 있거나 주소·포트가 다릅니다' : e.name === 'TimeoutError' ? '응답 없음 (시간 초과)' : e.message); }
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = {}; }
    if (!r.ok) {
      let msg = j.exception ?? j.exc_type ?? `HTTP ${r.status}`;
      try { if (j._server_messages) msg = JSON.parse(j._server_messages).map((m) => JSON.parse(m).message).join(' · ').replace(/<[^>]+>/g, ''); } catch { /* 그대로 */ }
      if (r.status >= 500 || r.status === 429 || r.status === 401 || r.status === 403) throw new Transient(`HTTP ${r.status} ${String(msg).slice(0, 200)}`);
      throw new Error(`HTTP ${r.status} ${String(msg).slice(0, 300)}`);
    }
    return j;
  }
  const q = (o) => encodeURIComponent(JSON.stringify(o));
  const find = (dt, filters, fields = ['name']) => api('GET', `/api/resource/${encodeURIComponent(dt)}?filters=${q(filters)}&fields=${q(fields)}&limit_page_length=500`).then((j) => j.data ?? []);
  const ins = (dt, doc) => api('POST', `/api/resource/${encodeURIComponent(dt)}`, doc).then((j) => j.data);
  const upd = (dt, name, doc) => api('PUT', `/api/resource/${encodeURIComponent(dt)}/${encodeURIComponent(name)}`, doc).then((j) => j.data);
  const call = (m, args) => api('POST', `/api/method/${m}`, args).then((j) => j.message);
  const byRef = async (dt, ref) => (await find(dt, [['mf_ref', '=', ref]]))[0]?.name ?? null;
  const ensure = async (dt, filters, doc) => (await find(dt, filters))[0]?.name ?? (await ins(dt, doc)).name;
  const note = (doctype, name, ref, what) => { st.docs.unshift({ t: new Date().toISOString(), doctype, name, ref, what }); if (st.docs.length > 200) st.docs.pop(); };

  // ── 연결 시험 ─────────────────
  async function test() {
    if (!/^https?:\/\//.test(base())) return { ok: false, error: 'http:// 또는 https:// 주소를 넣으세요' };
    if (!cfg.apiKey || !cfg.apiSecret) return { ok: false, error: 'API 키와 비밀 키를 넣으세요 (ERPNext 사용자 설정 → API Access → Generate Keys)' };
    try {
      const u = await call('frappe.auth.get_logged_user'); const done = (await call('frappe.client.get_single_value', { doctype: 'System Settings', field: 'setup_complete' })) ? 1 : 0;
      const cos = (await find('Company', [], ['name', 'abbr'])).map((c) => c.name);
      return { ok: true, user: u, setupComplete: !!done, companies: cos };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ── 「ERPNext 준비」: 기준정보 (이미 있으면 건너뜀) ─────────────────
  async function prepare() {
    if (rt.prep?.running) return rt.prep;
    rt.prep = { running: true, step: '시작', done: 0, error: null, t0: new Date().toISOString() };
    const S = (s) => { rt.prep.step = s; rt.prep.done++; };
    (async () => {
      try {
        if (!(await call('frappe.client.get_single_value', { doctype: 'System Settings', field: 'setup_complete' }))) {
          S('초기 설정 (회사 · KRW · 회계연도)');
          const y = new Date().getFullYear();
          await call('frappe.desk.page.setup_wizard.setup_wizard.setup_complete', { args: { language: 'English', country: 'Korea, Republic of', timezone: 'Asia/Seoul', currency: 'KRW', full_name: 'Jin-3D', email: 'admin@jin-3d.example', company_name: cfg.company || 'Jin-3D Testbed', company_abbr: 'JM', chart_of_accounts: 'Standard', fy_start_date: `${y}-01-01`, fy_end_date: `${y}-12-31`, setup_demo: 0 } });
        }
        S('회사'); const cos = await find('Company', cfg.company ? [['name', '=', cfg.company]] : [], ['name', 'abbr']);
        if (!cos.length) throw new Error(`회사를 찾을 수 없습니다${cfg.company ? ` — ${cfg.company}` : ''}`);
        st.prepared = { company: cos[0].name, abbr: cos[0].abbr, url: base(), at: null };
        S('사용자 정의 필드 mf_ref');
        for (const dt of REF_DOCTYPES) await ensure('Custom Field', [['dt', '=', dt], ['fieldname', '=', 'mf_ref']], { dt, fieldname: 'mf_ref', label: 'Jin-3D Ref', fieldtype: 'Data', read_only: 1, no_copy: 1, search_index: 1, insert_after: dt === 'Asset' ? 'asset_name' : dt.startsWith('Asset') ? 'asset' : 'company' });
        for (const [dt, fn, lb] of [['Delivery Note', 'mf_shipment', 'Jin-3D 출하 (트럭 · SSCC)'], ['Delivery Note', 'mf_serials', 'Jin-3D 시리얼']]) await ensure('Custom Field', [['dt', '=', dt], ['fieldname', '=', fn]], { dt, fieldname: fn, label: lb, fieldtype: fn === 'mf_serials' ? 'Small Text' : 'Data', read_only: 1, no_copy: 1, insert_after: 'mf_ref' });
        S('재고·제조 설정'); await upd('Stock Settings', 'Stock Settings', { allow_negative_stock: 1 }); await upd('Manufacturing Settings', 'Manufacturing Settings', { overproduction_percentage_for_work_order: 100, backflush_raw_materials_based_on: 'BOM' });
        S('품목'); await ensure('Item Group', [['name', '=', 'Jin-3D']], { item_group_name: 'Jin-3D', parent_item_group: 'All Item Groups' });
        for (const [k, P] of Object.entries(FAC_PRODUCTS)) await ensure('Item', [['name', '=', P.code]], { item_code: P.code, item_name: P.name, item_group: 'Jin-3D', stock_uom: 'Nos', is_stock_item: 1, valuation_rate: P.price, standard_rate: P.price, description: `메타팩토리 ${k}` });
        S('창고'); const grp = await ensure('Warehouse', [['warehouse_name', '=', '메타팩토리'], ['company', '=', CO()]], { warehouse_name: '메타팩토리', is_group: 1, company: CO(), parent_warehouse: `All Warehouses - ${A()}` });
        for (const k of Object.keys(WH_NAME)) await ensure('Warehouse', [['name', '=', W(k)]], { warehouse_name: WH_NAME[k], company: CO(), parent_warehouse: grp });
        S('거래처'); await ensure('Supplier', [['name', '=', SUPPLIER]], { supplier_name: SUPPLIER, supplier_group: (await find('Supplier Group', [['is_group', '=', 0]]))[0]?.name ?? 'All Supplier Groups' });
        const terr = await find('Territory', [['is_group', '=', 0]]);
        await ensure('Customer', [['name', '=', CUSTOMER]], { customer_name: CUSTOMER, customer_group: (await find('Customer Group', [['is_group', '=', 0]]))[0]?.name, territory: terr.find((t) => /Korea/.test(t.name))?.name ?? terr[0]?.name });
        S('BOM'); st.prepared.bom = {};
        for (const [p, parts] of Object.entries(BOMS)) {
          const ex = (await find('BOM', [['item', '=', code(p)], ['is_default', '=', 1], ['docstatus', '=', 1]]))[0]?.name;
          st.prepared.bom[p] = ex ?? (await call('frappe.client.submit', { doc: { ...(await ins('BOM', { item: code(p), company: CO(), quantity: 1, is_active: 1, is_default: 1, rm_cost_as_per: 'Valuation Rate', items: parts.map(([m, w]) => ({ item_code: code(m), qty: 1, source_warehouse: W(w) })) })), doctype: 'BOM' } })).name;
        }
        S('작업장'); for (const n of ['부품분류셀', '도어트림 조립셀', '도어트림 체결셀', 'e-axle 조립셀', 'e-axle 체결셀', '검사·포장셀']) await ensure('Workstation', [['name', '=', n]], { workstation_name: n });
        S('설비 자산 분류 · 정비팀');
        await ensure('Location', [['name', '=', '메타팩토리']], { location_name: '메타팩토리' });
        const acc = async (t, like) => (await find('Account', [['company', '=', CO()], ['account_type', '=', t], ['is_group', '=', 0], ...(like ? [['name', 'like', `%${like}%`]] : [])]))[0]?.name ?? (await find('Account', [['company', '=', CO()], ['account_type', '=', t], ['is_group', '=', 0]]))[0]?.name;
        await ensure('Asset Category', [['name', '=', '메타팩토리 설비']], { asset_category_name: '메타팩토리 설비', accounts: [{ company_name: CO(), fixed_asset_account: await acc('Fixed Asset', 'Plants'), accumulated_depreciation_account: await acc('Accumulated Depreciation'), depreciation_expense_account: await acc('Depreciation') }] });
        await ensure('Item', [['name', '=', 'MF-EQUIPMENT']], { item_code: 'MF-EQUIPMENT', item_name: '메타팩토리 설비 (셀 · 로봇 · 이동 로봇)', item_group: 'Jin-3D', stock_uom: 'Nos', is_stock_item: 0, is_fixed_asset: 1, asset_category: '메타팩토리 설비' });
        const users = (await find('User', [['user_type', '=', 'System User'], ['enabled', '=', 1], ['name', 'not in', ['Administrator', 'Guest']]])).map((u) => u.name);
        const tech = users[0] ?? (await ins('User', { email: 'maint@jin-3d.example', first_name: '메타팩토리 정비', send_welcome_email: 0, user_type: 'System User', roles: [{ role: 'Maintenance Manager' }, { role: 'Maintenance User' }] })).name;
        st.prepared.tech = tech;
        await ensure('Asset Maintenance Team', [['name', '=', '메타팩토리 정비팀']], { maintenance_team_name: '메타팩토리 정비팀', maintenance_manager: tech, company: CO(), maintenance_team_members: [{ team_member: tech, maintenance_role: 'Maintenance Manager' }] });
        S('품질 — 검사 항목 · 품질 절차');
        await ensure('Quality Inspection Parameter', [['name', '=', Q_PARAM]], { parameter: Q_PARAM, description: '검사·포장셀 최종 검사대 출하 전 샘플 재검 판정 (OK · NG)' });
        const PROC_STEPS = { sample: ['샘플 지정 즉시 로트 출하 보류', '샘플 → 검사·포장셀 최종 검사대 재검 (판정)', 'OK → 보류 해제 · NG → 봉쇄(±10분) · 유출 의심 회수 대상', '샘플링 강화 (N/2, 3회 연속 OK면 복귀)'], mrb: ['식별 · 격리', '처분 판정 (재작업 · 폐기 · 특채)', '재작업 → 재검 합격 시 시리얼 유지 · 폐기 → 시리얼 폐기 기록', '처분 결과 기록'], d8: ['D0 NG 판정·격리', 'D1 팀 구성', 'D2 문제 기술', 'D3 봉쇄', 'D4 근본 원인', 'D5 대책', 'D6 시행·검증', 'D7 재발 방지', 'D8 종결'] };
        for (const [k, n] of Object.entries(Q_PROC)) await ensure('Quality Procedure', [['name', '=', n]], { quality_procedure_name: n, process_owner: tech, processes: PROC_STEPS[k].map((x) => ({ process_description: x })) });
        st.prepared.at = new Date().toISOString(); saveSt();
        rt.prep = { ...rt.prep, running: false, step: '완료', ok: true };
      } catch (e) { rt.prep = { ...rt.prep, running: false, ok: false, error: e.message }; }
    })();
    return rt.prep;
  }

  // ── FAC 이벤트 → ERPNext 문서 ─────────────────
  const ref = (run, k) => `${run}:${k}`;
  const submitIns = async (dt, doc, what) => { const d = await ins(dt, { ...doc, docstatus: 1 }); note(dt, d.name, doc.mf_ref, what); return d; };
  async function manufacture(run, key, product, qty, wo, tag = '') {
    const r = ref(run, `${key}:${product}${wo ? `:${wo}` : ''}${tag}`);   // 근거 = 운전:FAC 번호:제품[:작업지시][:over] — 배분 한 줄마다 따로 (일부만 성공하고 끊겨도 나머지만 다시)
    if (await byRef('Stock Entry', r)) return;
    if (wo) {
      const m = await call('erpnext.manufacturing.doctype.work_order.work_order.make_stock_entry', { work_order_id: wo, purpose: 'Manufacture', qty });
      return submitIns('Stock Entry', { ...m, mf_ref: r }, `생산 입고 ${FAC_PRODUCTS[product]?.name ?? product} ${qty} (작업지시 ${wo})`);
    }
    return submitIns('Stock Entry', { stock_entry_type: 'Manufacture', company: CO(), mf_ref: r, items: [...BOMS[product].map(([m, w]) => ({ item_code: code(m), qty, s_warehouse: W(w) })), { item_code: code(product), qty, t_warehouse: W('output'), is_finished_item: 1 }] }, `생산 입고 ${FAC_PRODUCTS[product]?.name ?? product} ${qty}`);
  }
  const H = {
    master: async () => {},   // 기준정보는 「ERPNext 준비」에서 — 운전마다 다시 만들지 않는다
    'po.create': async (run, e) => {
      const r = ref(run, e.key); if (await byRef('Purchase Order', r)) return;
      const d = new Date().toISOString().slice(0, 10);
      await submitIns('Purchase Order', { supplier: SUPPLIER, company: CO(), transaction_date: d, schedule_date: d, mf_ref: r, items: e.lines.map((l) => ({ item_code: code(l.product), qty: l.qty, rate: l.price ?? FAC_PRODUCTS[l.product]?.price ?? 0, warehouse: W(rackOf(l.product)), schedule_date: d })) }, `구매오더 ${e.key}`);
    },
    'receipt.done': async (run, e) => {
      const r = ref(run, e.key); if (await byRef('Purchase Receipt', r)) return;
      const po = await byRef('Purchase Order', ref(run, e.po));
      const lines = e.lines.filter((l) => l.qty > 0); if (!lines.length) return;
      if (po) {
        const m = await call('erpnext.buying.doctype.purchase_order.purchase_order.make_purchase_receipt', { source_name: po });
        m.items = m.items.map((it) => { const l = lines.find((x) => code(x.product) === it.item_code); return l ? { ...it, qty: l.qty, received_qty: l.qty, warehouse: W(l.to ?? rackOf(l.product)) } : null; }).filter(Boolean);
        return submitIns('Purchase Receipt', { ...m, mf_ref: r }, `입고 ${e.key} (구매오더 ${po})`);
      }
      return submitIns('Purchase Receipt', { supplier: SUPPLIER, company: CO(), mf_ref: r, items: lines.map((l) => ({ item_code: code(l.product), qty: l.qty, rate: FAC_PRODUCTS[l.product]?.price ?? 0, warehouse: W(l.to ?? rackOf(l.product)) })) }, `입고 ${e.key}`);
    },
    'internal.done': async (run, e) => {
      const r = ref(run, e.key); if (await byRef('Stock Entry', r)) return;
      const items = e.lines.filter((l) => l.qty > 0 && WH_NAME[l.from] && WH_NAME[l.to]).map((l) => ({ item_code: code(l.product), qty: l.qty, s_warehouse: W(l.from), t_warehouse: W(l.to) }));
      if (items.length) await submitIns('Stock Entry', { stock_entry_type: 'Material Transfer', company: CO(), mf_ref: r, remarks: e.origin ?? '', items }, `재고 이동 ${e.key}`);
    },
    // 생산 입고: 작업지시 배분을 처음 한 번 정해 상태 파일에 남기고(작업지시 생산 수량도 그때 반영), 배분 줄마다 전표를 낸다.
    // 일부만 성공하고 ERPNext가 끊기면 다시 보낼 때 남은 줄만 낸다 — 이미 낸 줄은 mf_ref로 확인 (수량이 빠지거나 두 번 들어가지 않음)
    'production.done': async (run, e) => {
      const A = (st.alloc ??= {});
      for (const l of e.lines.filter((x) => x.qty > 0 && BOMS[x.product])) {
        const base = `${ref(run, e.key)}:${l.product}`;
        if (!A[base]) {
          // 배분 기록 이전 버전이 이미 낸 생산 입고(전표 있음 · 배분 기록 없음)는 처리한 것으로 본다
          if ((await find('Stock Entry', [['mf_ref', 'like', `${base}%`]])).length) { A[base] = [{ legacy: true, done: true }]; saveSt(); continue; }
          const plan = []; let left = l.qty;
          if (WO_PRODUCTS.includes(l.product)) {
            const list = Object.values(st.wo).filter((w) => w.run === run && w.product === l.product && !w.stopped);
            for (const w of list) { const n = Math.min(left, Math.max(0, w.qty - w.produced)); if (!n) continue; plan.push({ wo: w.name, n }); w.produced += n; left -= n; if (!left) break; }
            const last = list.at(-1);
            if (left && last) { plan.push({ wo: last.name, n: left, tag: ':over' }); last.produced += left; left = 0; }   // 초과 생산 (허용 100%)
          }
          if (left) plan.push({ wo: null, n: left });
          A[base] = plan; saveSt();
        }
        for (const a of A[base]) { if (a.done) continue; await manufacture(run, e.key, l.product, a.n, a.wo, a.tag ?? ''); a.done = true; saveSt(); }
      }
    },
    'delivery.done': async (run, e) => {
      const r = ref(run, e.key); if (await byRef('Delivery Note', r)) return;
      const items = e.lines.filter((l) => l.qty > 0).map((l) => ({ item_code: code(l.product), qty: l.qty, rate: FAC_PRODUCTS[l.product]?.price ?? 0, warehouse: W('output') }));
      if (!items.length) return;
      // 실린 팔레트 SSCC · 시리얼은 FAC 출고 확정 이벤트에 함께 온다 (EPCIS 업로드보다 먼저 와도 빠지지 않음). 예전 이벤트만 EPCIS 저장소에서 출하 ID(= 트럭 이름)로 찾는다
      const truck = String(e.origin ?? '').replace(/^출하\s*/, ''), sid = e.shipment ?? truck;
      let sscc = [], serials = [];
      if (cfg.serials) {
        if (Array.isArray(e.serials)) { sscc = e.sscc ?? []; serials = e.serials; }
        else if (serialsOf) { const S = serialsOf(sid); sscc = (S?.pallets ?? []).map(ssccOfEpc); serials = (S?.serials ?? []).map((x) => x.split('.').slice(2).join('.')); }
      }
      await submitIns('Delivery Note', { customer: CUSTOMER, company: CO(), mf_ref: r, mf_shipment: [truck, sid !== truck ? sid : null, ...sscc.map((x) => `SSCC (00)${x}`)].filter(Boolean).join(' · ').slice(0, 140), ...(serials.length ? { mf_serials: serials.join('\n') } : {}), items }, `출하 ${e.key} ${truck}`);
    },
    'order.assign': async (run, e) => {
      for (const p of WO_PRODUCTS) {
        const share = e.mix?.[p] ?? 0.5, qty = Math.round((e.target ?? 100) * share); if (qty <= 0) continue;
        const r = ref(run, `${e.key}:${p}`); let name = await byRef('Work Order', r);
        if (!name) name = (await submitIns('Work Order', { production_item: code(p), bom_no: st.prepared?.bom?.[p], qty, company: CO(), skip_transfer: 1, wip_warehouse: W('cells'), fg_warehouse: W('output'), planned_start_date: new Date().toISOString().slice(0, 19).replace('T', ' '), mf_ref: r }, `작업지시 ${e.key} ${FAC_PRODUCTS[p].name} ${qty}`)).name;
        st.wo[r] ??= { run, order: e.key, product: p, name, qty, produced: 0, stopped: false }; saveSt();
      }
    },
    'order.close': async (run, e) => {
      for (const w of Object.values(st.wo).filter((x) => x.run === run && x.order === e.key && !x.stopped)) {
        if (w.produced < w.qty) { try { await call('erpnext.manufacturing.doctype.work_order.work_order.stop_unstop', { work_order: w.name, status: 'Stopped' }); note('Work Order', w.name, `${run}:${e.key}`, `작업지시 중지 — 계획 ${w.qty} · 생산 ${w.produced} (오더 종료)`); } catch (err) { if (!/stopped|completed/i.test(err.message)) throw err; } }
        w.stopped = true; w.closed = true; saveSt();
      }
    },
    'mr.create': async (run, e) => {
      const asset = await assetOf(e.equipment, run); const r = ref(run, e.key);
      if (e.mtype === 'corrective') { if (!(await byRef('Asset Repair', r))) { const d = await ins('Asset Repair', { asset, company: CO(), failure_date: now(), repair_status: 'Pending', description: `${e.name} — ${e.description ?? ''}`, mf_ref: r }); note('Asset Repair', d.name, r, `긴급 정비 ${e.key}`); } return; }
      if (await byRef('Asset Maintenance Log', r)) return;
      const am = await maintOf(asset), task = (await find('Asset Maintenance Task', [['parent', '=', am]]))[0]?.name;
      const d = await ins('Asset Maintenance Log', { asset_maintenance: am, task, maintenance_status: 'Planned', due_date: now().slice(0, 10), description: `${e.name} — ${e.description ?? ''}`, mf_ref: r }); note('Asset Maintenance Log', d.name, r, `예지·예방 정비 ${e.key}`);
    },
    'mr.update': async (run, e) => {   // 예방정비 중 고장 → 긴급 수리로 (예방정비 기록은 취소)
      if (e.mtype !== 'corrective') return;
      const r = ref(run, e.key), log = (await find('Asset Maintenance Log', [['mf_ref', '=', r]], ['name', 'asset_name']))[0]; if (!log || (await byRef('Asset Repair', r))) return;
      const d = await ins('Asset Repair', { asset: log.asset_name, company: CO(), failure_date: now(), repair_status: 'Pending', description: `${e.name ?? ''} — 예방정비 중 고장으로 전환`, mf_ref: r }); note('Asset Repair', d.name, r, `긴급 정비 ${e.key} (예방 → 긴급)`);
      await upd('Asset Maintenance Log', log.name, { maintenance_status: 'Cancelled', actions_performed: '고장으로 긴급 수리 전환' });
    },
    'mr.stage': async (run, e) => {
      if (e.stage !== 'done') return;
      const r = ref(run, e.key), rep = await byRef('Asset Repair', r);
      if (rep) { const d = await upd('Asset Repair', rep, { repair_status: 'Completed', completion_date: now(), actions_performed: `수리 완료 (${Math.round((e.duration ?? 0) * 60)}분)` }); await call('frappe.client.submit', { doc: { ...d, doctype: 'Asset Repair' } }); note('Asset Repair', rep, r, `긴급 정비 완료 ${e.key}`); return; }
      const log = await byRef('Asset Maintenance Log', r);
      if (log) { const d = await upd('Asset Maintenance Log', log, { maintenance_status: 'Completed', completion_date: now().slice(0, 10), actions_performed: `정비 완료 (${Math.round((e.duration ?? 0) * 60)}분)` }); await call('frappe.client.submit', { doc: { ...d, doctype: 'Asset Maintenance Log' } }); note('Asset Maintenance Log', log, r, `예지·예방 정비 완료 ${e.key}`); }
    },
  };
  // ── 품질 (3단계) ─────────────────
  const today = () => now().slice(0, 10);
  const PN = (p) => FAC_PRODUCTS[p]?.name ?? p;
  const move1 = (r, p, from, to, what) => submitIns('Stock Entry', { stock_entry_type: 'Material Transfer', company: CO(), mf_ref: r, items: [{ item_code: code(p), qty: 1, s_warehouse: W(from), t_warehouse: W(to) }] }, what);
  // 품질 조치(Quality Action) 해결 항목 표 덮어쓰기 · 한 줄 더하기
  async function qaUpsert(r, { procedure, rows, status, append = false, what }) {
    const name = await byRef('Quality Action', r);
    if (!name) { const d = await ins('Quality Action', { corrective_preventive: 'Corrective', procedure, status, date: today(), mf_ref: r, resolutions: rows }); note('Quality Action', d.name, r, what); return d.name; }
    const cur = append ? (await api('GET', `/api/resource/Quality%20Action/${encodeURIComponent(name)}`)).data.resolutions.map(({ name: n, problem, resolution, status: s2 }) => ({ name: n, problem, resolution, status: s2 })) : [];
    const all = [...cur, ...rows];
    await upd('Quality Action', name, { status: status ?? (all.some((x) => x.status === 'Open') ? 'Open' : 'Completed'), resolutions: all }); return name;
  }
  const ncResolve = async (r, text) => { const n = await byRef('Non Conformance', r); if (n) await upd('Non Conformance', n, { status: 'Resolved', ...(text ? { corrective_action: text } : {}) }); return n; };
  Object.assign(H, {
    'q.sample.req': async (run, e) => { const r = ref(run, `${e.key}:out`); if (!(await byRef('Stock Entry', r))) await move1(r, e.product, 'output', 'qis', `샘플 ${e.key} ${e.serial} → 샘플 재검 보류`); },
    'q.sample': async (run, e) => {
      const r = ref(run, e.key); let se = await byRef('Stock Entry', ref(run, `${e.key}:out`));
      if (!se) se = (await move1(ref(run, `${e.key}:out`), e.product, 'output', 'qis', `샘플 ${e.key} ${e.serial} → 샘플 재검 보류`)).name;
      if (!(await byRef('Quality Inspection', r))) await submitIns('Quality Inspection', { company: CO(), report_date: today(), inspection_type: 'In Process', reference_type: 'Stock Entry', reference_name: se, item_code: code(e.product), sample_size: 1, inspected_by: st.prepared?.tech, status: e.result === 'NG' ? 'Rejected' : 'Accepted', manual_inspection: 1, remarks: `출하 전 샘플 재검 ${e.key} · 시리얼 ${e.serial} · 로트 ${e.lot}개`, mf_ref: r, readings: [{ specification: Q_PARAM, status: e.result === 'NG' ? 'Rejected' : 'Accepted', manual_inspection: 1, value: e.result, reading_value: e.result }] }, `품질검사 ${e.key} ${PN(e.product)} ${e.result}`);
      if (e.result !== 'NG') { const b = ref(run, `${e.key}:back`); if (!(await byRef('Stock Entry', b))) await move1(b, e.product, 'qis', 'output', `샘플 ${e.key} OK → 구분 적재장`); return; }
      if (!(await byRef('Non Conformance', r))) { const d = await ins('Non Conformance', { subject: `출하 전 샘플 재검 ${e.key} NG — ${PN(e.product)} ${e.serial}`.slice(0, 140), procedure: Q_PROC.sample, process_owner: st.prepared?.tech, status: 'Open', details: `<p>샘플 ${e.serial} 재검 판정 NG · 로트 ${e.lot}개 출하 보류 · 같은 시간대 ±10분 봉쇄 · 처분 판정(MRB) 대기</p>`, mf_ref: r }); note('Non Conformance', d.name, r, `부적합 ${e.key} 샘플 NG`); }
      await qaUpsert(ref(run, `${e.key}:mrb`), { procedure: Q_PROC.mrb, status: 'Open', what: `처분 판정(MRB) ${e.key}`, rows: [{ problem: `샘플 ${e.key} NG — 로트 봉쇄`, resolution: `로트 ${e.lot}개 출하 보류 · 처분 판정 대기`, status: 'Completed' }] });
    },
    'q.disp': async (run, e) => {
      const r = ref(run, `${e.key}:${e.d}`);
      if (e.d === 'scrap' && !(await byRef('Stock Entry', r))) await submitIns('Stock Entry', { stock_entry_type: 'Material Issue', company: CO(), mf_ref: r, remarks: e.why, items: [{ item_code: code(e.product), qty: 1, s_warehouse: W(e.sample ? 'qis' : 'output') }] }, `폐기 출고 ${e.key} — ${e.why}`);
      if (e.d === 'rework.done' && e.sample) { const b = ref(run, `${e.key}:back`); if (!(await byRef('Stock Entry', b))) await move1(b, e.product, 'qis', 'output', `재작업 ${e.key} 재검 합격 → 구분 적재장`); }
      if (!e.lot) return;
      const row = { problem: `${e.key} 처분`, resolution: e.d === 'scrap' ? `폐기 — ${e.why}` : e.d === 'rework' ? `재작업 — ${e.why}` : e.why, status: e.d === 'rework' ? 'Open' : 'Completed' };
      if (e.d === 'rework.done') {   // 재작업 줄을 완료로
        const name = await byRef('Quality Action', ref(run, `${e.lot}:mrb`)); if (!name) return;
        const rows = (await api('GET', `/api/resource/Quality%20Action/${encodeURIComponent(name)}`)).data.resolutions.map(({ name: n, problem, resolution, status: s2 }) => (problem === `${e.key} 처분` ? { name: n, problem, resolution: `${resolution}<br>${e.why}`, status: 'Completed' } : { name: n, problem, resolution, status: s2 }));
        await upd('Quality Action', name, { resolutions: rows, status: rows.some((x) => x.status === 'Open') ? 'Open' : 'Completed' }); return;
      }
      await qaUpsert(ref(run, `${e.lot}:mrb`), { procedure: Q_PROC.mrb, append: true, what: `처분 판정(MRB) ${e.lot}`, rows: [row] });
    },
    'q.lot': async (run, e) => {
      const S = e.sorted ?? {}, text = `<p>선별검사 ${S.n ?? 0}개 → 양품 ${S.ok ?? 0} 보류 해제 · 불량 ${S.bad ?? 0} 처분 · ±10분 추가 봉쇄 ${e.extra} · 유출 의심(회수 대상) ${e.recall}</p>`;
      await ncResolve(ref(run, e.key), text);
      await qaUpsert(ref(run, `${e.key}:mrb`), { procedure: Q_PROC.mrb, append: true, what: `처분 판정(MRB) ${e.key}`, rows: [{ problem: `로트 ${e.key} 선별검사(전수)`, resolution: text, status: 'Completed' }] });
    },
    'q.ng': async (run, e) => {
      const r = ref(run, e.key); if (await byRef('Non Conformance', r)) return;
      const d = await ins('Non Conformance', { subject: `${e.station} 전수 검사 NG ${e.key} — ${PN(e.product)} ${e.serial}`.slice(0, 140), procedure: Q_PROC.d8, process_owner: st.prepared?.tech, status: 'Open', details: `<p>${e.mode} (토크 ${e.torque ?? '-'} N·m · 각도 ${e.angle ?? '-'}°) · 시리얼 없이 WIP ID로 배출함 격리 · 8D 진행</p>`, mf_ref: r });
      note('Non Conformance', d.name, r, `부적합 ${e.key} 체결 NG`);
    },
    'q.capa': async (run, e) => {
      const done = e.status === 'closed' || e.status === 'held';
      const LANE = { field: '현장', zone: 'Zone 오케스트레이터', hq: '공장 오케스트레이터', policy: '운영 정책' };
      const rows = (e.steps ?? []).map((x) => ({ problem: `${x.d}${x.lane ? ` · ${LANE[x.lane] ?? x.lane}` : ''}`, resolution: String(x.text ?? '').slice(0, 2000), status: 'Completed' }));
      // ERPNext는 해결 항목이 모두 완료면 품질 조치를 Completed로 바꾼다 — 진행 중인 8D는 현재 단계를 미완료 항목으로 남긴다
      if (!done) rows.push({ problem: `진행 중 — ${e.stage ?? ''}`, resolution: e.status === 'approval' ? '정책 반영 결정 대기 (사람 결정 — 공장 오케스트레이터)' : e.status === 'verify' ? '효과 검증 중' : '다음 단계 진행 중', status: 'Open' });
      await qaUpsert(ref(run, e.key), { procedure: Q_PROC.d8, status: done ? 'Completed' : 'Open', what: `8D ${e.key} ${e.title ?? ''}`.slice(0, 120), rows });
      if (done) { const text = `<p>${e.key} ${e.status === 'held' ? '보류 종결' : '종결'} — 원인 ${e.cause ?? '-'}</p>`; for (const c of e.kind === 'main' ? e.cases ?? [] : [e.lot]) if (c) await ncResolve(ref(run, c), text); }
    },
  });
  const now = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');   // ERPNext 시각 (Asia/Seoul)
  const equipName = {};   // 설비 일련번호 → 이름 (master)
  async function assetOf(serial, run) {
    if (!serial) throw new Error('설비 일련번호 없음');
    const ex = await byRef('Asset', serial); if (ex) return ex;
    const d = await ins('Asset', { asset_name: (equipName[serial] ?? serial).slice(0, 140), item_code: 'MF-EQUIPMENT', company: CO(), location: '메타팩토리', is_existing_asset: 1, purchase_date: '2026-01-01', available_for_use_date: '2026-01-01', gross_purchase_amount: 1, net_purchase_amount: 1, asset_quantity: 1, calculate_depreciation: 0, mf_ref: serial, docstatus: 1 });
    note('Asset', d.name, serial, `설비 등록 ${equipName[serial] ?? serial}`); return d.name;
  }
  async function maintOf(asset) {
    const ex = (await find('Asset Maintenance', [['asset_name', '=', asset]]))[0]?.name; if (ex) return ex;
    return (await ins('Asset Maintenance', { asset_name: asset, company: CO(), maintenance_team: '메타팩토리 정비팀', asset_maintenance_tasks: [{ maintenance_task: '예지·예방 정비', maintenance_type: 'Preventive Maintenance', maintenance_status: 'Planned', periodicity: 'Monthly', start_date: now().slice(0, 10), assign_to: st.prepared?.tech }] })).name;
  }

  // ── 대기열 ─────────────────
  function enqueue(run, events) {
    for (const e of events) if (e.type === 'master') for (const x of e.equipment ?? []) equipName[x.serial_no] = x.name;   // 설비 이름은 연동을 켜기 전에도 받아 둔다
    if (!cfg.enabled) return 0;
    let n = 0;
    for (const e of events) {
      if (!H[e.type] || e.type === 'master') continue;
      const item = { run, e }; queue.push(item); fs.appendFileSync(qFile, JSON.stringify(item) + '\n'); n++;
    }
    return n;
  }
  async function pump() {
    if (!cfg.enabled || !st.prepared?.at || rt.busy || Date.now() < rt.nextAt || st.cursor >= queue.length) return;
    rt.busy = true;
    try {
      for (let k = 0; k < 20 && st.cursor < queue.length; k++) {
        const item = queue[st.cursor];
        if (!item?.e) { st.skipped++; st.fail.unshift({ t: new Date().toISOString(), type: '?', key: null, error: `대기열 ${st.cursor + 1}번째 줄이 깨져 읽을 수 없음` }); if (st.fail.length > 50) st.fail.pop(); st.cursor++; saveSt(); continue; }
        const { run, e } = item;
        try { await H[e.type](run, e); st.sent++; rt.lastOk = new Date().toISOString(); rt.lastError = null; }
        catch (err) {
          if (err instanceof Transient) throw err;
          st.skipped++; st.fail.unshift({ t: new Date().toISOString(), type: e.type, key: e.key, error: err.message }); if (st.fail.length > 50) st.fail.pop();
          rt.lastError = `${e.type} ${e.key ?? ''} 건너뜀 — ${err.message}`;
        }
        st.cursor++; saveSt();
      }
      rt.backoff = interval;
      if (st.cursor > 5000 && st.cursor === queue.length) { queue = []; st.cursor = 0; fs.writeFileSync(qFile, ''); saveSt(); }   // 다 보낸 대기열 비우기
    } catch (err) { rt.lastError = err.message; rt.backoff = Math.min(60000, rt.backoff * 2); rt.nextAt = Date.now() + rt.backoff; }
    finally { rt.busy = false; }
  }
  const timer = setInterval(() => { pump().catch(() => {}); }, interval); timer.unref?.();

  const status = () => ({ url: cfg.url, company: st.prepared?.company ?? cfg.company, enabled: !!cfg.enabled, serials: !!cfg.serials, apiKey: !!cfg.apiKey, apiSecret: !!cfg.apiSecret,
    prepared: st.prepared?.at ? { at: st.prepared.at, company: st.prepared.company, url: st.prepared.url } : null, prepare: rt.prep,
    queued: queue.length - st.cursor, recovery, sent: st.sent, skipped: st.skipped, lastOk: rt.lastOk, lastError: rt.lastError, retryMs: rt.nextAt ? Math.max(0, rt.nextAt - Date.now()) : 0,
    workOrders: Object.values(st.wo).slice(-10).map((w) => ({ order: w.order, product: w.product, name: w.name, qty: w.qty, produced: w.produced, stopped: w.stopped })), docs: st.docs.slice(0, 30), failures: st.fail.slice(0, 10) });
  const route = async (method, pathname, query, bodyText) => {
    const p = pathname.replace(/^\/api\/erpnext\/v1\/?/, '');
    let b = {}; if (method === 'POST') { try { b = JSON.parse(bodyText || '{}'); } catch { return { code: 400, body: { error: 'JSON이 아닙니다' } }; } }
    if (p === '' || p === 'status') return { code: 200, body: status() };
    if (p === 'config' && method === 'POST') {
      if (b.url != null) { const u = String(b.url).trim().replace(/\/+$/, ''); if (u && !/^https?:\/\//.test(u)) return { code: 400, body: { error: 'http:// 또는 https:// 주소를 넣으세요' } }; if (u !== cfg.url) { cfg.url = u; st.prepared = null; saveSt(); for (const k of ['apiKey', 'apiSecret']) if (!b[k]) conf.forget(k); } }   // 주소를 바꾸면 저장한 키는 버린다 — 새 주소의 키를 다시 넣어야 보낸다
      for (const k of ['apiKey', 'apiSecret']) if (b[k]) cfg[k] = String(b[k]).trim();
      if (b.company != null) cfg.company = String(b.company).trim();
      if (b.enabled != null) cfg.enabled = !!b.enabled;
      if (b.serials != null) cfg.serials = !!b.serials;
      saveCfg(); rt.nextAt = 0; rt.backoff = interval;
      return { code: 200, body: status() };
    }
    if (p === 'test' && method === 'POST') return { code: 200, body: await test() };
    if (p === 'prepare' && method === 'POST') { const t = await test(); if (!t.ok) return { code: 200, body: { ok: false, error: t.error } }; return { code: 202, body: await prepare() }; }
    return null;
  };
  return { route, status, enqueue, pump, close: () => clearInterval(timer), _state: st };
}
