// 설비 대시보드 JSON 생성 (Grafana 12 · InfluxDB 2 Flux) → monitoring/grafana/dashboards/*.json — 정밀조립Zone 설비만
//  ① 공장 개요 · ② 설비 건강도·RUL · ③ 환경·설비 센서 · ④ Zone 운영 분석 — 모두 운영 이벤트(경보·주의·조치)를 그래프 위에 겹친다
// 실행: node tools/gen-grafana.mjs  (결과 JSON을 저장소에 둔다 — 앱이 monitoring/ 폴더를 그대로 데이터 폴더로 복사해 쓴다)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../monitoring/grafana/dashboards');
const DS = { type: 'influxdb', uid: 'jm-influx' };
const R = 'range(start: v.timeRangeStart, stop: v.timeRangeStop)';
let pid = 0;
const target = (query, refId = 'A') => ({ datasource: DS, refId, query });
const panel = (type, title, grid, targets, extra = {}) => ({ id: ++pid, type, title, datasource: DS, gridPos: grid, targets: Array.isArray(targets) ? targets : [target(targets)], ...extra });
const ts = (title, grid, q, { unit = 'short', min, max, thresholds, desc, overrides = [] } = {}) => panel('timeseries', title, grid, q, {
  description: desc,
  fieldConfig: { defaults: { unit, min, max, custom: { lineWidth: 1, fillOpacity: 6, showPoints: 'never', spanNulls: true, ...(thresholds ? { thresholdsStyle: { mode: 'line+area' } } : {}) }, ...(thresholds ? { thresholds: { mode: 'absolute', steps: thresholds } } : {}) }, overrides: overrides.map(([n, d, c]) => ({ matcher: { id: 'byName', options: n }, properties: [{ id: 'displayName', value: d }, { id: 'color', value: { mode: 'fixed', fixedColor: c } }, ...(n === 'value' ? [{ id: 'custom.showPoints', value: 'always' }] : [{ id: 'custom.lineStyle', value: { fill: 'dash', dash: [8, 4] } }])] })) },
  options: { legend: { displayMode: 'table', placement: 'right', calcs: ['lastNotNull', 'min', 'max'] }, tooltip: { mode: 'multi', sort: 'desc' } },
});
const stat = (title, grid, q, { unit = 'short', color = 'blue', thresholds, decimals } = {}) => panel('stat', title, grid, q, {
  fieldConfig: { defaults: { unit, decimals, color: { mode: thresholds ? 'thresholds' : 'fixed', fixedColor: color }, thresholds: { mode: 'absolute', steps: thresholds ?? [{ color, value: null }] } }, overrides: [] },
  options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'background', graphMode: 'area', textMode: 'value', justifyMode: 'center' },
});
const HEALTH_STEPS = [{ color: 'red', value: null }, { color: 'orange', value: 40 }, { color: 'yellow', value: 55 }, { color: 'green', value: 70 }];
// 운영 이벤트 겹치기 (Flux → time · text · tags)
const annotations = () => ({ list: [
  { builtIn: 1, datasource: { type: 'grafana', uid: '-- Grafana --' }, enable: true, hide: true, iconColor: 'rgba(0, 211, 255, 1)', name: 'Annotations & Alerts', type: 'dashboard' },
  ...[['alert', '경보', 'red'], ['warn', '주의', 'orange'], ['act', '조치', 'blue']].map(([lv, name, color]) => ({
    datasource: DS, enable: lv !== 'act', iconColor: color, name: `운영 이벤트 — ${name}`,
    target: { refId: 'Anno', query: `from(bucket: "raw") |> ${R} |> filter(fn: (r) => r._measurement == "event" and r.level == "${lv}") |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value") |> map(fn: (r) => ({ _time: r._time, text: r.title + (if exists r.text then " — " + r.text else ""), tags: r.zone }))` },
  })),
] });
// 센서 대시보드만 구역을 고른다 (정밀조립Zone 셀 · 공용 설비·물류) — 설비 요약 · OEE · 품질은 정밀조립Zone 하나뿐이다
const snZoneVar = { name: 'zone', label: '구역', type: 'custom', query: '전체 : all,정밀조립 : main,공용·물류 : fac', current: { text: '전체', value: 'all' }, options: [], includeAll: false, multi: false };
const dash = (uid, title, panels, { vars = [], desc, from = 'now-30m', refresh = '10s' } = {}) => ({
  uid, title, description: desc, tags: ['Jin-3D'], timezone: 'browser', refresh, time: { from, to: 'now' }, schemaVersion: 41, version: 1, editable: false,
  templating: { list: vars }, annotations: annotations(), panels,
  links: [{ title: 'Jin-3D 대시보드', type: 'dashboards', tags: ['Jin-3D'], asDropdown: true, includeVars: false, keepTime: true }],
});
const zoneF = 'r.zone == "main"', snF = '(r.zone == "${zone}" or "${zone}" == "all")';   // 설비 요약 = 정밀조립Zone · 센서 = 고른 구역
const lastEq = (field) => `from(bucket: "raw") |> range(start: -2m) |> filter(fn: (r) => r._measurement == "equipment" and r._field == "${field}" and ${zoneF}) |> last()`;

// ① 공장 개요
pid = 0;
const overview = dash('jm-overview', 'Jin-3D · 공장 개요 (정밀조립Zone)', [
  stat('가동 중 셀', { x: 0, y: 0, w: 6, h: 5 }, `${lastEq('busy')} |> group() |> sum() |> map(fn: (r) => ({ r with _field: "가동 중" }))`, { color: 'green' }),
  stat('고장·정비 중 셀', { x: 6, y: 0, w: 6, h: 5 }, `${lastEq('down')} |> group() |> sum() |> map(fn: (r) => ({ r with _field: "고장·정비" }))`, { thresholds: [{ color: 'green', value: null }, { color: 'orange', value: 1 }, { color: 'red', value: 3 }] }),
  stat('평균 건강도', { x: 12, y: 0, w: 6, h: 5 }, `${lastEq('health')} |> group() |> mean() |> map(fn: (r) => ({ r with _field: "평균 건강도" }))`, { unit: 'percent', thresholds: HEALTH_STEPS, decimals: 1 }),
  stat('최저 건강도', { x: 18, y: 0, w: 6, h: 5 }, `${lastEq('health')} |> group() |> min() |> map(fn: (r) => ({ r with _field: r.name }))`, { unit: 'percent', thresholds: HEALTH_STEPS, decimals: 1 }),
  panel('bargauge', '셀별 건강도', { x: 0, y: 5, w: 8, h: 8 }, `${lastEq('health')} |> group() |> keep(columns: ["name", "_value"]) |> sort(columns: ["_value"])`,
    { fieldConfig: { defaults: { unit: 'percent', min: 0, max: 100, thresholds: { mode: 'absolute', steps: HEALTH_STEPS }, color: { mode: 'thresholds' }, displayName: '${__field.labels.name}' }, overrides: [] }, options: { orientation: 'horizontal', displayMode: 'gradient', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true }, showUnfilled: true } }),
  ts('고장·정비 중 셀 수', { x: 8, y: 5, w: 16, h: 8 }, `from(bucket: "raw") |> ${R} |> filter(fn: (r) => r._measurement == "equipment" and r._field == "down" and ${zoneF}) |> aggregateWindow(every: v.windowPeriod, fn: max, createEmpty: false) |> group(columns: ["_time"]) |> sum() |> group() |> map(fn: (r) => ({ r with _field: "고장·정비 중" }))`, { desc: '고장(DOWN) 또는 정비 중(MAINT)인 셀 수' }),
  panel('table', '설비 현재 상태 (건강도 낮은 순)', { x: 0, y: 13, w: 24, h: 12 }, `from(bucket: "raw") |> range(start: -2m) |> filter(fn: (r) => r._measurement == "equipment" and ${zoneF}) |> last() |> pivot(rowKey: ["asset", "name"], columnKey: ["_field"], valueColumn: "_value") |> group() |> keep(columns: ["asset", "name", "health", "rul_min", "risk10", "cpk", "state"]) |> sort(columns: ["health"])`,
    { fieldConfig: { defaults: { custom: { align: 'auto' } }, overrides: [
      { matcher: { id: 'byName', options: 'health' }, properties: [{ id: 'displayName', value: '건강도 %' }, { id: 'custom.cellOptions', value: { type: 'color-background' } }, { id: 'thresholds', value: { mode: 'absolute', steps: HEALTH_STEPS } }, { id: 'decimals', value: 1 }] },
      { matcher: { id: 'byName', options: 'rul_min' }, properties: [{ id: 'displayName', value: 'RUL (분)' }, { id: 'decimals', value: 0 }] },
      { matcher: { id: 'byName', options: 'risk10' }, properties: [{ id: 'displayName', value: '10분 고장확률' }, { id: 'unit', value: 'percentunit' }] },
      { matcher: { id: 'byName', options: 'cpk' }, properties: [{ id: 'displayName', value: 'Cpk' }] },
      { matcher: { id: 'byName', options: 'state' }, properties: [{ id: 'displayName', value: '상태' }] },
      { matcher: { id: 'byName', options: 'name' }, properties: [{ id: 'displayName', value: '설비' }] },
      { matcher: { id: 'byName', options: 'asset' }, properties: [{ id: 'displayName', value: '설비 ID' }] }] }, options: { showHeader: true, cellHeight: 'sm' },
      transformations: [{ id: 'organize', options: { indexByName: { asset: 0, name: 1, health: 2, state: 3, rul_min: 4, risk10: 5, cpk: 6 } } }] }),
], { desc: '정밀조립Zone 가동·고장 셀 수, 셀별 건강도, 설비 현재 상태 — 앱 MQTT(UNS) metafactory/telemetry/v1' });

// ② 설비 건강도 · RUL
pid = 0;
const assetVar = { name: 'asset', label: '설비', type: 'query', datasource: DS, query: 'import "influxdata/influxdb/schema"\nschema.tagValues(bucket: "raw", tag: "name", predicate: (r) => r._measurement == "equipment" and r.zone == "main", start: -1d)', refresh: 2, includeAll: true, multi: true, current: { text: 'All', value: '$__all' }, allValue: '.*', sort: 1 };
const eqTs = (field) => `from(bucket: "raw") |> ${R} |> filter(fn: (r) => r._measurement == "equipment" and r._field == "${field}" and ${zoneF} and r.name =~ /^\${asset:regex}$/) |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false) |> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: r.name })) |> group(columns: ["_field"])`;
const health = dash('jm-health', 'Jin-3D · 설비 건강도 · RUL', [
  ts('건강도 (%)', { x: 0, y: 0, w: 24, h: 10 }, eqTs('health'), { unit: 'percent', min: 0, max: 100, thresholds: [{ color: 'transparent', value: null }, { color: 'red', value: 0 }, { color: 'transparent', value: 50 }], desc: '빨간 영역 = 예지정비 착수 검토 구간 (건강도 50% 미만)' }),
  ts('잔여수명 RUL (분)', { x: 0, y: 10, w: 12, h: 9 }, eqTs('rul_min'), { unit: 'm' }),
  ts('10분 고장확률', { x: 12, y: 10, w: 12, h: 9 }, eqTs('risk10'), { unit: 'percentunit' }),
  ts('공정능력 Cpk', { x: 0, y: 19, w: 12, h: 8 }, eqTs('cpk'), { thresholds: [{ color: 'red', value: null }, { color: 'transparent', value: 1.33 }], desc: '빨간 영역 = Cpk 1.33 미만 (재보정 검토)' }),
  ts('건강도 장기 추세 (1분 집계 · 90일 보관)', { x: 12, y: 19, w: 12, h: 8 }, `from(bucket: "agg_1m") |> ${R} |> filter(fn: (r) => r._measurement == "equipment" and r._field == "health" and ${zoneF} and r.name =~ /^\${asset:regex}$/) |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false) |> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: r.name })) |> group(columns: ["_field"])`, { unit: 'percent', min: 0, max: 100 }),
], { vars: [assetVar], from: 'now-1h', desc: '셀별 건강도·RUL·고장확률·Cpk 추세 — 예지정비 근거' });

// ③ 환경 · 설비 센서 (정밀조립Zone 셀 · 환경 노드 · 공용 설비)
pid = 0;
const metricVar = { name: 'metric', label: '지표', type: 'query', datasource: DS, query: 'import "influxdata/influxdb/schema"\nschema.tagValues(bucket: "raw", tag: "m", predicate: (r) => r._measurement == "sensor" and (r.zone == "${zone}" or "${zone}" == "all"), start: -1d)', refresh: 2, includeAll: true, multi: true, current: { text: 'All', value: '$__all' }, allValue: '.*', sort: 1 };
const sensor = dash('jm-sensors', 'Jin-3D · 환경 · 설비 센서', [
  ts('센서 측정값 (지표별 · 센서별)', { x: 0, y: 0, w: 24, h: 14 }, `from(bucket: "raw") |> ${R} |> filter(fn: (r) => r._measurement == "sensor" and r._field == "v" and ${snF} and r.m =~ /^\${metric:regex}$/) |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false) |> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: r.m + " · " + r.s + " (" + r.u + ")" })) |> group(columns: ["_field"])`),
  panel('table', '센서 최신값', { x: 0, y: 14, w: 24, h: 12 }, `from(bucket: "raw") |> range(start: -5m) |> filter(fn: (r) => r._measurement == "sensor" and r._field == "v" and ${snF} and r.m =~ /^\${metric:regex}$/) |> last() |> group() |> keep(columns: ["zone", "cell", "s", "m", "u", "_value", "_time"]) |> sort(columns: ["zone", "cell", "m"])`,
    { fieldConfig: { defaults: {}, overrides: [{ matcher: { id: 'byName', options: '_value' }, properties: [{ id: 'displayName', value: '값' }, { id: 'decimals', value: 2 }] }, { matcher: { id: 'byName', options: 's' }, properties: [{ id: 'displayName', value: '센서' }] }, { matcher: { id: 'byName', options: 'm' }, properties: [{ id: 'displayName', value: '지표' }] }, { matcher: { id: 'byName', options: 'u' }, properties: [{ id: 'displayName', value: '단위' }] }, { matcher: { id: 'byName', options: '_time' }, properties: [{ id: 'displayName', value: '수신' }] }] }, options: { showHeader: true, cellHeight: 'sm' } }),
], { vars: [snZoneVar, metricVar], from: 'now-15m', desc: '환경(온습도·진동·PM2.5 등)·설비 센서 — 셀 엣지 묶음 metafactory/sensors/v1 (정밀조립Zone 셀 · 환경 노드 · 공용 설비·물류)' });

// ④ 정밀조립Zone 운영 분석 — OEE · 손실·NG 파레토 · 관리도(I-MR) · 산점도 (앱 「Zone 대시보드」 창과 같은 계산 — js/zonekpi.js가 metafactory/oee · quality로 보냄)
pid = 0;
const keyVar = (name, label, prefix) => ({ name, label, type: 'query', datasource: DS, query: `import "influxdata/influxdb/schema"\nimport "strings"\nschema.fieldKeys(bucket: "raw", predicate: (r) => r._measurement == "quality" and r.zone == "main", start: -1d) |> filter(fn: (r) => strings.hasPrefix(v: r._value, prefix: "${prefix}"))`, refresh: 2, includeAll: false, multi: false, sort: 1 });
const oeeLast = (f) => `from(bucket: "raw") |> range(start: -1h) |> filter(fn: (r) => r._measurement == "oee" and r.zone == "main" and r._field == "${f}") |> last()`;
const LOSS_KO = [['loss_down', '설비 고장'], ['loss_setup', '준비·교체'], ['loss_stop', '운영 정지'], ['loss_idle', '자재 대기(공전)'], ['loss_blocked', '출구 막힘'], ['loss_speed', '속도 저하'], ['loss_defect', '불량·재작업']];
const lossName = LOSS_KO.reduceRight((a, [k, l]) => `if r._field == "${k}" then "${l}" else ${a}`, 'r._field');
const cum = (src, labelExpr, valExpr) => `data = ${src} |> map(fn: (r) => ({ label: ${labelExpr}, v: ${valExpr} })) |> sort(columns: ["v"], desc: true)
tt = data |> sum(column: "v") |> findColumn(fn: (key) => true, column: "v")
total = if length(arr: tt) > 0 then tt[0] else 0.0
data |> map(fn: (r) => ({ r with c: r.v })) |> cumulativeSum(columns: ["c"]) |> map(fn: (r) => ({ label: r.label + " · 누적 " + string(v: int(v: if total > 0.0 then r.c / total * 100.0 + 0.5 else 0.0)) + "%", v: r.v }))`;   // 누적 %는 막대 이름에 (막대 차트에 꺾은선을 겹칠 수 없어서)
const paretoPanel = (title, grid, q, vName, vUnit) => panel('barchart', title, grid, q, {
  fieldConfig: { defaults: { unit: vUnit, color: { mode: 'fixed', fixedColor: '#ff8a5c' }, custom: { fillOpacity: 80, lineWidth: 0 } }, overrides: [
    { matcher: { id: 'byName', options: 'v' }, properties: [{ id: 'displayName', value: vName }] }] },
  options: { xField: 'label', orientation: 'horizontal', showValue: 'always', groupWidth: 0.75, barWidth: 0.9, legend: { displayMode: 'list', placement: 'bottom', showLegend: true }, tooltip: { mode: 'multi' } },
});
const zone = dash('jm-zone', 'Jin-3D · 정밀조립Zone 운영 분석 (OEE · 파레토 · 관리도 · 산점도)', [
  stat('OEE', { x: 0, y: 0, w: 5, h: 5 }, oeeLast('oee'), { unit: 'percentunit', decimals: 1, thresholds: [{ color: 'red', value: null }, { color: 'orange', value: 0.45 }, { color: 'green', value: 0.65 }] }),
  stat('가동률 A', { x: 5, y: 0, w: 5, h: 5 }, oeeLast('a'), { unit: 'percentunit', decimals: 1, color: 'green' }),
  stat('성능 P', { x: 10, y: 0, w: 5, h: 5 }, oeeLast('p'), { unit: 'percentunit', decimals: 1, color: 'blue' }),
  stat('품질 Q', { x: 15, y: 0, w: 4, h: 5 }, oeeLast('q'), { unit: 'percentunit', decimals: 1, color: 'orange' }),
  panel('gauge', '교대 계획 진행률', { x: 19, y: 0, w: 5, h: 5 }, oeeLast('progress'), { fieldConfig: { defaults: { unit: 'percentunit', min: 0, max: 1, thresholds: { mode: 'absolute', steps: [{ color: 'blue', value: null }] }, color: { mode: 'thresholds' } }, overrides: [] }, options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, showThresholdMarkers: false } }),
  ts('OEE · 가동률 · 성능 · 품질 추세 (누적)', { x: 0, y: 5, w: 24, h: 8 }, `from(bucket: "raw") |> ${R} |> filter(fn: (r) => r._measurement == "oee" and r.zone == "main" and (r._field == "oee" or r._field == "a" or r._field == "p" or r._field == "q")) |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false) |> map(fn: (r) => ({ _time: r._time, _value: r._value, _field: if r._field == "oee" then "OEE" else if r._field == "a" then "가동률" else if r._field == "p" then "성능" else "품질" })) |> group(columns: ["_field"])`, { unit: 'percentunit', min: 0, max: 1, desc: 'ISO 22400-2 — OEE = 가동률 × 성능 × 품질 (계획 정비 제외)' }),
  paretoPanel('손실 시간 파레토 (6대 손실 · 분)', { x: 0, y: 13, w: 12, h: 9 }, cum(`from(bucket: "raw") |> range(start: -1h) |> filter(fn: (r) => r._measurement == "oee" and r.zone == "main" and r._field =~ /^loss_/) |> last() |> group()`, lossName, 'r._value'), '손실 (분)', 'm'),
  paretoPanel('NG 유형 파레토 (선택 기간 · 건)', { x: 12, y: 13, w: 12, h: 9 }, cum(`from(bucket: "raw") |> ${R} |> filter(fn: (r) => r._measurement == "quality" and r.zone == "main" and r._field == "ng" and r._value == 1) |> group(columns: ["kind"]) |> count() |> group()`, 'r.kind', 'float(v: r._value)'), 'NG (건)', 'none'),
  ts('관리도 (I-MR) — ${yvar}', { x: 0, y: 22, w: 14, h: 10 }, `import "math"
data = from(bucket: "raw") |> ${R} |> filter(fn: (r) => r._measurement == "quality" and r.zone == "main" and r._field == "\${yvar}") |> group() |> sort(columns: ["_time"]) |> keep(columns: ["_time", "_value"])
mr = data |> difference() |> map(fn: (r) => ({ r with _value: math.abs(x: r._value) })) |> mean() |> findColumn(fn: (key) => true, column: "_value")
cl = data |> mean() |> findColumn(fn: (key) => true, column: "_value")
m = if length(arr: mr) > 0 then mr[0] else 0.0
c = if length(arr: cl) > 0 then cl[0] else 0.0
data |> map(fn: (r) => ({ _time: r._time, value: r._value, ucl: c + 2.66 * m, cl: c, lcl: c - 2.66 * m }))`, { overrides: [['value', '측정값', '#cfe6f0'], ['ucl', 'UCL', '#ff7a7a'], ['cl', 'CL (평균)', '#7fd6ff'], ['lcl', 'LCL', '#ff7a7a']], desc: '개별값 관리도 — UCL·LCL = 평균 ± 2.66 × 평균 이동범위 (선택 기간 전체로 계산). 앱 「Zone 대시보드」는 X̄-R(부분군 5)과 Western Electric 규칙 위반도 표시' }),
  panel('xychart', '산점도 — ${xvar} × ${yvar} (양품 · NG)', { x: 14, y: 22, w: 10, h: 10 }, `from(bucket: "raw") |> ${R} |> filter(fn: (r) => r._measurement == "quality" and r.zone == "main" and (r._field == "\${xvar}" or r._field == "\${yvar}" or r._field == "ng")) |> map(fn: (r) => ({ r with _value: float(v: r._value) })) |> group() |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value") |> filter(fn: (r) => exists r["\${xvar}"] and exists r["\${yvar}"]) |> map(fn: (r) => ({ 판정: if exists r.ng and r.ng == 1.0 then "NG" else "양품", x: r["\${xvar}"], y: r["\${yvar}"] })) |> group(columns: ["판정"])`,
    { fieldConfig: { defaults: { custom: { show: 'points', pointSize: { fixed: 5 } } }, overrides: [] }, options: { mapping: 'auto', series: [{}], legend: { displayMode: 'list', placement: 'bottom', showLegend: true }, tooltip: { mode: 'single' } } }),
], { vars: [keyVar('yvar', '품질 특성 (y)', 'y_'), keyVar('xvar', '공정 변수 (x)', 'x_')], from: 'now-1h', refresh: '10s', desc: '정밀조립Zone OEE·6대 손실·NG 유형·관리도·공정–품질 상관 — 앱 MQTT metafactory/oee/v1 · metafactory/quality/v1' });

fs.mkdirSync(OUT, { recursive: true });
for (const [f, d] of [['jm-overview', overview], ['jm-health', health], ['jm-sensors', sensor], ['jm-zone', zone]]) fs.writeFileSync(path.join(OUT, `${f}.json`), JSON.stringify(d, null, 1));
console.log('dashboards →', OUT);
