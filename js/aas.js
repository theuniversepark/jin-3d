// AAS(Asset Administration Shell) 모델 — IDTA AAS Part 1 메타모델 v3.0 기준.
// 공장의 각 자산(라인·설비/셀·셀 로봇·AMR·AGV·휴머노이드·사족보행·정비로봇)마다 AAS를 만들고,
// 서브모델은 Nameplate · TechnicalData · OperationalData(실시간 값) · TimeSeries(IDTA 02008, 수집 데이터)로 구성한다.
// 같은 모델을 JSON · XML · RDF(Turtle) · CSV · AutomationML(CAEX 3.0)로 직렬화한다.

// 메타모델 버전: 기본 v3.1 (IDTA-01001-3-1 · Eclipse BaSyx SDK 2.x 등 최신 도구), 저장 옵션으로 v3.0 (구버전 도구 호환)
// XML·RDF의 네임스페이스만 다르고 구성은 같다 (JSON은 네임스페이스가 없어 두 버전 공통)
export const AAS_VERSIONS = { '3.1': 'https://admin-shell.io/aas/3/1', '3.0': 'https://admin-shell.io/aas/3/0' };
export let AAS_VERSION = '3.1';
export let AAS_NS = AAS_VERSIONS['3.1'];
export function setAasVersion(v) { AAS_VERSION = AAS_VERSIONS[v] ? v : '3.1'; AAS_NS = AAS_VERSIONS[AAS_VERSION]; return AAS_VERSION; }
const BASE = 'https://camtic.or.kr/aas/jin3d';
export const SEM = {
  nameplate: 'https://admin-shell.io/zvei/nameplate/2/0/Nameplate',
  technical: 'https://admin-shell.io/ZVEI/TechnicalData/Submodel/1/2',
  timeseries: 'https://admin-shell.io/idta/TimeSeries/1/1',
  operational: 'https://camtic.or.kr/sm/jin3d/OperationalData/1/0',
  events: 'https://camtic.or.kr/sm/jin3d/Events/1/0',
  videos: 'https://camtic.or.kr/sm/jin3d/VideoRecordings/1/0',
  cd: (name) => `https://camtic.or.kr/cd/jin3d/${name}`,
};
export const aasId = (assetId) => `${BASE}/${assetId}`;
export const smId = (assetId, sm) => `${BASE}/${assetId}/sm/${sm}`;
// 값 형식 → AAS DataTypeDefXsd (규격 이름이 아닌 형식이 그대로 나가지 않게 — 예: bool → xs:boolean)
const XSD = { double: 'xs:double', float: 'xs:float', int: 'xs:int', integer: 'xs:integer', long: 'xs:long', string: 'xs:string', boolean: 'xs:boolean', bool: 'xs:boolean', dateTime: 'xs:dateTime', anyURI: 'xs:anyURI' };

const ext = (value) => ({ type: 'ExternalReference', keys: [{ type: 'GlobalReference', value }] });
const modelRef = (type, value) => ({ type: 'ModelReference', keys: [{ type, value }] });
const prop = (idShort, valueType, value, semanticId, desc) => ({
  modelType: 'Property', idShort,
  ...(desc ? { description: [{ language: 'ko', text: desc }] } : {}),
  ...(semanticId ? { semanticId: ext(semanticId) } : {}),
  valueType: XSD[valueType] ?? (String(valueType).startsWith('xs:') ? valueType : 'xs:string'),   // 모르는 형식은 문자열로
  // 값이 없으면 value를 생략한다 (숫자·날짜 형식에 빈 문자열은 값 형식 제약 위반)
  ...(value != null && (value !== '' || valueType === 'string') ? { value: String(value) } : {}),
});
const smc = (idShort, value, semanticId) => ({ modelType: 'SubmodelElementCollection', idShort, ...(semanticId ? { semanticId: ext(semanticId) } : {}), value });
const fmt = (v, type) => (v == null ? '' : type === 'double' ? (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '') : String(v));

// ── AAS 환경 (현재 값 + 수집된 시계열) ─────────────────
// assets: datahub의 자산 정의, samples: [{t(ISO), v: {assetId: [값...]}}], last: 최신 값
// opts.recent: AAS 파일에 직접 넣는 최근 레코드 수, opts.csvName: 전체 시계열 CSV (IDTA 02008 ExternalSegment로 참조)
export const AAS_RECENT = 60;
export function buildEnvironment(assets, samples, last, opts = {}) {
  const shells = [], submodels = [], cds = new Map();
  for (const a of assets) {
    const smIds = ['Nameplate', 'TechnicalData', 'OperationalData', 'TimeSeries'].map((n) => smId(a.id, n));
    shells.push({
      modelType: 'AssetAdministrationShell', idShort: `AAS_${a.id}`, id: aasId(a.id),
      description: [{ language: 'ko', text: a.name }],
      assetInformation: { assetKind: 'Instance', globalAssetId: `${BASE}/asset/${a.id}`, assetType: a.kind },
      submodels: smIds.map((id) => modelRef('Submodel', id)),
    });
    submodels.push({
      modelType: 'Submodel', idShort: 'Nameplate', id: smIds[0], kind: 'Instance', semanticId: ext(SEM.nameplate),
      submodelElements: [
        prop('ManufacturerName', 'string', a.nameplate.manufacturer),
        prop('ManufacturerProductDesignation', 'string', a.nameplate.product),
        prop('SerialNumber', 'string', a.nameplate.serial),
        prop('YearOfConstruction', 'string', a.nameplate.year),
      ],
    });
    submodels.push({
      modelType: 'Submodel', idShort: 'TechnicalData', id: smIds[1], kind: 'Instance', semanticId: ext(SEM.technical),
      submodelElements: [smc('TechnicalProperties', Object.entries(a.tech).map(([k, v]) => prop(k, typeof v === 'number' ? 'double' : 'string', v)))],
    });
    const cur = last?.[a.id];
    submodels.push({
      modelType: 'Submodel', idShort: 'OperationalData', id: smIds[2], kind: 'Instance', semanticId: ext(SEM.operational),
      submodelElements: [prop('Timestamp', 'dateTime', last?.t, SEM.cd('Timestamp'), '기준 시각 (동기화된 공장 시계, UTC)'),
        ...a.fields.map((f, i) => prop(f.idShort, f.type, cur ? fmt(cur[i], f.type) : null, SEM.cd(f.idShort), f.unit ? `${f.label} [${f.unit}]` : f.label))],
    });
    for (const f of a.fields) cds.set(f.idShort, f);
    // IDTA 02008 Time Series Data: Metadata(Record 정의) + Segments/InternalSegment/Records
    const all = samples.filter((s) => s.v[a.id]);
    const recs = opts.recent ? all.slice(-opts.recent) : all;
    submodels.push({
      modelType: 'Submodel', idShort: 'TimeSeries', id: smIds[3], kind: 'Instance', semanticId: ext(SEM.timeseries),
      submodelElements: [
        smc('Metadata', [prop('Name', 'string', `${a.name} 운영 데이터`), smc('Record', [prop('Time', 'dateTime', null, 'https://admin-shell.io/idta/TimeSeries/UtcTime/1/1'), ...a.fields.map((f) => prop(f.idShort, f.type, null, SEM.cd(f.idShort)))])],
          'https://admin-shell.io/idta/TimeSeries/Metadata/1/1'),
        smc('Segments', [smc('InternalSegment', [
          prop('RecordCount', 'int', recs.length),
          prop('StartTime', 'dateTime', recs[0]?.t), prop('EndTime', 'dateTime', recs[recs.length - 1]?.t),
          smc('Records', recs.map((s, k) => smc(`Record${k + 1}`, [prop('Time', 'dateTime', s.t), ...a.fields.map((f, i) => prop(f.idShort, f.type, fmt(s.v[a.id][i], f.type)))])),
            'https://admin-shell.io/idta/TimeSeries/Records/1/1'),
        ], 'https://admin-shell.io/idta/TimeSeries/Segments/InternalSegment/1/1'),
        // 전체 시계열은 CSV 파일로 참조 (파일이 커지지 않게)
        ...(opts.csvName ? [smc('ExternalSegment', [
          prop('Name', 'string', '전체 수집 시계열 (CSV)'),
          prop('RecordCount', 'int', all.length),
          prop('StartTime', 'dateTime', all[0]?.t), prop('EndTime', 'dateTime', all[all.length - 1]?.t),
          { modelType: 'File', idShort: 'Data', semanticId: ext('https://admin-shell.io/idta/TimeSeries/File/1/1'), contentType: 'text/csv', value: opts.csvName },
        ], 'https://admin-shell.io/idta/TimeSeries/Segments/ExternalSegment/1/1')] : [])], 'https://admin-shell.io/idta/TimeSeries/Segments/1/1'),
      ],
    });
  }
  const conceptDescriptions = [{ modelType: 'ConceptDescription', idShort: 'Timestamp', id: SEM.cd('Timestamp') },
    ...[...cds.values()].map((f) => ({ modelType: 'ConceptDescription', idShort: f.idShort, id: SEM.cd(f.idShort), description: [{ language: 'ko', text: f.unit ? `${f.label} [${f.unit}]` : f.label }] }))];
  return { assetAdministrationShells: shells, submodels, conceptDescriptions };
}

// ── XML (AAS XML 스키마 v3.0) ─────────────────
const xesc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
// 스키마의 요소 순서 (xs:sequence)
const ORDER = ['extensions', 'category', 'idShort', 'displayName', 'description', 'administration', 'id', 'embeddedDataSpecifications', 'derivedFrom',
  'assetInformation', 'kind', 'semanticId', 'supplementalSemanticIds', 'qualifiers', 'submodels', 'submodelElements', 'isCaseOf',
  'valueType', 'value', 'valueId', 'assetKind', 'globalAssetId', 'specificAssetIds', 'assetType', 'defaultThumbnail'];
const CHILD = { assetAdministrationShells: 'assetAdministrationShell', submodels: 'submodel', conceptDescriptions: 'conceptDescription', keys: 'key', description: 'langStringTextType' };
const lc = (s) => s[0].toLowerCase() + s.slice(1);
function xmlNode(name, v, ind) {
  const pad = '  '.repeat(ind);
  if (v == null) return '';
  if (typeof v !== 'object') return `${pad}<${name}>${xesc(v)}</${name}>\n`;
  if (Array.isArray(v)) {
    if (!v.length) return '';
    const inner = v.map((x) => {
      if (name === 'submodels' && x.modelType == null) return xmlObj('reference', x, ind + 1);   // AAS의 서브모델 참조 목록
      const child = x.modelType ? lc(x.modelType) : CHILD[name] ?? 'item';
      return xmlObj(child, x, ind + 1);
    }).join('');
    return `${pad}<${name}>\n${inner}${pad}</${name}>\n`;
  }
  return xmlObj(name, v, ind);
}
function xmlObj(name, o, ind) {
  const pad = '  '.repeat(ind);
  if (name === 'langStringTextType') return `${pad}<langStringTextType>\n${pad}  <language>${xesc(o.language)}</language>\n${pad}  <text>${xesc(o.text)}</text>\n${pad}</langStringTextType>\n`;
  const keys = Object.keys(o).filter((k) => k !== 'modelType').sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  // Reference(type, keys) · Key(type, value)는 정의된 순서 그대로
  const ks = 'keys' in o || ('type' in o && 'value' in o && !o.modelType) ? Object.keys(o) : keys;
  return `${pad}<${name}>\n${ks.map((k) => xmlNode(k, o[k], ind + 1)).join('')}${pad}</${name}>\n`;
}
export function toXML(env) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<environment xmlns="${AAS_NS}">\n${['assetAdministrationShells', 'submodels', 'conceptDescriptions'].map((k) => xmlNode(k, env[k], 1)).join('')}</environment>\n`;
}

// ── RDF (Turtle, AAS RDF 매핑 v3.0) ─────────────────
// 속성 IRI = <aas:정의 클래스/속성명>. 식별 가능한 객체(Identifiable)는 자기 id를 IRI로, 나머지는 블랭크 노드.
const RDF_OWNER = {
  idShort: 'Referable', description: 'Referable', category: 'Referable', id: 'Identifiable', semanticId: 'HasSemantics', kind: 'HasKind',
  assetInformation: 'AssetAdministrationShell', assetKind: 'AssetInformation', globalAssetId: 'AssetInformation', assetType: 'AssetInformation',
  keys: 'Reference', language: 'AbstractLangString', text: 'AbstractLangString',
};
const tq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
export function toTurtle(env) {
  const out = [`@prefix aas: <${AAS_NS}/> .`, '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .', '@prefix xs: <http://www.w3.org/2001/XMLSchema#> .', ''];
  let bn = 0;
  const node = (o, cls) => {
    const type = o.modelType ?? cls;
    const subj = o.id && o.modelType ? `<${o.id}>` : `_:b${++bn}`;
    const lines = [`${subj} rdf:type aas:${type}`];
    for (const [k, v] of Object.entries(o)) {
      if (k === 'modelType' || v == null) continue;
      const owner = k === 'value' ? (type === 'Key' ? 'Key' : type) : k === 'type' ? (cls === 'Key' ? 'Key' : 'Reference') : k === 'valueType' ? type
        : k === 'submodels' ? 'AssetAdministrationShell' : k === 'submodelElements' ? 'Submodel' : RDF_OWNER[k] ?? type;
      const p = `<${AAS_NS}/${owner}/${k}>`;
      const one = (x, childCls) => {
        if (typeof x !== 'object') {
          // 열거값은 전체 IRI로 쓴다 (Turtle 접두어 이름에는 '/'를 쓸 수 없음)
          if (k === 'valueType') return `<${AAS_NS}/DataTypeDefXsd/${x.slice(3)[0].toUpperCase() + x.slice(4)}>`;
          if (k === 'assetKind' || k === 'kind') return `<${AAS_NS}/${k === 'kind' ? 'ModellingKind' : 'AssetKind'}/${x}>`;
          if (k === 'type') return `<${AAS_NS}/${cls === 'Key' ? 'KeyTypes' : 'ReferenceTypes'}/${x}>`;
          return tq(x);
        }
        return node(x, childCls);
      };
      const childCls = k === 'keys' ? 'Key' : k === 'description' ? 'LangStringTextType' : ['semanticId', 'submodels'].includes(k) ? 'Reference' : k === 'assetInformation' ? 'AssetInformation' : undefined;
      if (Array.isArray(v)) for (const x of v) lines.push(`  ${p} ${one(x, childCls)}`);
      else lines.push(`  ${p} ${one(v, childCls)}`);
    }
    out.push(lines.join(' ;\n') + ' .\n');
    return subj;
  };
  for (const k of ['assetAdministrationShells', 'submodels', 'conceptDescriptions']) for (const o of env[k]) node(o);
  return out.join('\n');
}

// ── CSV (긴 형식 시계열 + 이벤트) ─────────────────
const csvq = (s) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
// 자산 id → AAS id, idShort → semanticId 규칙은 머리말(#)에 한 번만 적는다
export function toCSV(assets, samples, events, runId) {
  const rows = [`# Jin-3D 운영 데이터 · run ${runId} · 시각: 기준 시계 ISO 8601 UTC`,
    `# aas_id = ${aasId('{asset_id}')} · submodel = ${smId('{asset_id}', 'OperationalData')} · semantic_id = ${SEM.cd('{id_short}')}`,
    'record_type,timestamp_utc,sim_time_s,asset_id,id_short,value,unit'];
  for (const s of samples) {
    const t = s.t, st = s.simT.toFixed(1);
    for (const a of assets) {
      const v = s.v[a.id]; if (!v) continue;
      a.fields.forEach((f, i) => rows.push(`data,${t},${st},${a.id},${f.idShort},${csvq(fmt(v[i], f.type))},${f.unit ?? ''}`));
    }
  }
  for (const e of events) rows.push(['event', e.t, e.simT.toFixed(1), e.source, e.level, `${e.title}${e.text ? ' — ' + e.text : ''}`, ''].map(csvq).join(','));
  return '﻿' + rows.join('\n') + '\n';   // BOM: 엑셀에서 한글이 깨지지 않게
}

// ── AutomationML (CAEX 3.0) ─────────────────
// 공장 계층(InstanceHierarchy) = 라인 → 설비/셀 → 셀 로봇, 이동 로봇은 물류·서비스 그룹.
// 각 요소에 AAS id와 최신 운영 값을 속성으로, 시계열은 함께 내보낸 CSV를 ExternalDataReference로 연결한다.
export function toAutomationML(assets, last, meta) {
  const attr = (name, value, unit, ind, type = 'xs:string') => `${'  '.repeat(ind)}<Attribute Name="${xesc(name)}" AttributeDataType="${type}"${unit ? ` Unit="${xesc(unit)}"` : ''}><Value>${xesc(value ?? '')}</Value></Attribute>\n`;
  const role = { Factory: 'ProductionLine', Station: 'ProductionCell', CellRobot: 'Robot', AMR: 'MobileRobot', AGV: 'MobileRobot', Humanoid: 'HumanoidRobot', Quadruped: 'LeggedRobot', MaintenanceRobot: 'MobileRobot' };
  const ie = (a, ind, children = '') => {
    const pad = '  '.repeat(ind), cur = last?.[a.id];
    return `${pad}<InternalElement Name="${xesc(a.id)}" ID="${xesc(aasId(a.id))}">\n`
      + attr('Description', a.name, null, ind + 1) + attr('AAS_Id', aasId(a.id), null, ind + 1) + attr('AssetType', a.kind, null, ind + 1)
      + Object.entries(a.tech).map(([k, v]) => attr(k, v, null, ind + 1)).join('')
      + `${pad}  <Attribute Name="OperationalData" AttributeDataType="xs:string">\n${pad}    <Value>${xesc(last?.t ?? '')}</Value>\n`
      + a.fields.map((f, i) => attr(f.idShort, cur ? fmt(cur[i], f.type) : '', f.unit, ind + 3, XSD[f.type])).join('')
      + `${pad}  </Attribute>\n`
      + `${pad}  <RoleRequirements RefBaseRoleClassPath="Jin3DRoleClassLib/${role[a.kind] ?? 'Asset'}" />\n${children}${pad}</InternalElement>\n`;
  };
  const by = (k) => assets.filter((a) => a.kind === k);
  const factory = assets.find((a) => a.kind === 'Factory');
  const stations = by('Station').map((st) => ie(st, 3, assets.filter((a) => a.kind === 'CellRobot' && a.parent === st.id).map((r) => ie(r, 4)).join(''))).join('');
  const mobiles = assets.filter((a) => ['AMR', 'AGV', 'Humanoid', 'Quadruped', 'MaintenanceRobot'].includes(a.kind)).map((m) => ie(m, 3)).join('');
  const roles = [...new Set(Object.values(role))].map((r) => `    <RoleClass Name="${r}" />\n`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<CAEXFile xmlns="http://www.dke.de/CAEX" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" SchemaVersion="3.0" FileName="${xesc(meta.fileName)}">
  <SuperiorStandardVersion>AutomationML 2.10</SuperiorStandardVersion>
  <SourceDocumentInformation OriginName="Jin-3D" OriginID="urn:camtic:jin3d" OriginVersion="1.0" LastWritingDateTime="${xesc(meta.writtenAt)}" OriginRelease="1.0" />
  <InstanceHierarchy Name="MetaFactoryTestbed">
    <InternalElement Name="${xesc(factory?.id ?? 'Factory')}" ID="${xesc(aasId(factory?.id ?? 'Factory'))}">
${factory ? attr('Description', factory.name, null, 3) + attr('AAS_Id', aasId(factory.id), null, 3) + attr('ReferenceClockUTC', last?.t ?? '', null, 3) + attr('RunId', meta.runId, null, 3) : ''}      <ExternalInterface Name="TimeSeriesData" ID="${xesc(`${BASE}/timeseries/${meta.runId}`)}" RefBaseClassPath="AutomationMLInterfaceClassLib/AutomationMLBaseInterface/ExternalDataConnector/ExternalDataReference">
        <Attribute Name="refURI" AttributeDataType="xs:anyURI"><Value>${xesc(meta.csvName)}</Value></Attribute>
        <Attribute Name="MIMEType" AttributeDataType="xs:string"><Value>text/csv</Value></Attribute>
      </ExternalInterface>
      <InternalElement Name="ProductionCells" ID="${xesc(`${BASE}/group/cells`)}">
${stations}      </InternalElement>
      <InternalElement Name="MobileRobots" ID="${xesc(`${BASE}/group/mobile`)}">
${mobiles}      </InternalElement>
      <RoleRequirements RefBaseRoleClassPath="Jin3DRoleClassLib/ProductionLine" />
    </InternalElement>
  </InstanceHierarchy>
  <RoleClassLib Name="Jin3DRoleClassLib">
${roles}  </RoleClassLib>
</CAEXFile>
`;
}

// ── 로봇 한 대의 AAS 환경 (누적 데이터) ─────────────────
// asset: datahub 자산 정의(없으면 텔레메트리 정보로 대신), samples: 운영 기록(데이터 허브),
// detail: { fields, rows: [{ t, v }] } 정밀 기록(텔레메트리), opts.fileRef: 정밀 기록 CSV 경로(AASX 안 보조 파일)
const tsSubmodel = (assetId, smName, title, fields, recs, fileRef) => ({
  modelType: 'Submodel', idShort: smName, id: smId(assetId, smName), kind: 'Instance', semanticId: ext(SEM.timeseries),
  description: [{ language: 'ko', text: title }],
  submodelElements: [
    smc('Metadata', [prop('Name', 'string', title), smc('Record', [prop('Time', 'dateTime', null, 'https://admin-shell.io/idta/TimeSeries/UtcTime/1/1'),
      ...fields.map((f) => prop(f.idShort, f.type, null, SEM.cd(f.idShort), f.unit ? `${f.label} [${f.unit}]` : f.label))])], 'https://admin-shell.io/idta/TimeSeries/Metadata/1/1'),
    smc('Segments', [
      smc('InternalSegment', [
        prop('RecordCount', 'int', recs.length), prop('StartTime', 'dateTime', recs[0]?.t), prop('EndTime', 'dateTime', recs[recs.length - 1]?.t),
        smc('Records', recs.map((r, k) => smc(`Record${k + 1}`, [prop('Time', 'dateTime', r.t), ...fields.map((f, i) => prop(f.idShort, f.type, fmt(r.v[i], f.type)))])),
          'https://admin-shell.io/idta/TimeSeries/Records/1/1'),
      ], 'https://admin-shell.io/idta/TimeSeries/Segments/InternalSegment/1/1'),
      ...(fileRef ? [smc('ExternalSegment', [
        prop('Name', 'string', `${title} (CSV)`), prop('RecordCount', 'int', recs.length),
        { modelType: 'File', idShort: 'Data', semanticId: ext('https://admin-shell.io/idta/TimeSeries/File/1/1'), contentType: 'text/csv', value: fileRef },
      ], 'https://admin-shell.io/idta/TimeSeries/Segments/ExternalSegment/1/1')] : []),
    ], 'https://admin-shell.io/idta/TimeSeries/Segments/1/1'),
  ],
});
// ── 영상 기록 서브모델: 로봇 카메라·CCTV가 찍은 영상 파일 링크 (구간마다 카메라별) ─────────────────
// videos: [{ segment, file, camera, label, rect, start, end, fps, url, localPath, linkPath }]
//   File(Video) value = 영상 URL(맥 앱 서버) 또는 파일 이름 · File(LinkFile) value = AASX 안 링크 파일(.url) · 칸 좌표(분할 영상에서 이 카메라 위치)
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_');
export function videoSubmodel(assetId, videos, title = '로봇 카메라 영상 기록') {
  return {
    modelType: 'Submodel', idShort: 'VideoRecordings', id: smId(assetId, 'VideoRecordings'), kind: 'Instance', semanticId: ext(SEM.videos),
    description: [{ language: 'ko', text: `${title} — 자동 녹화 영상 파일 링크 (WebM, 분할 영상의 칸 = 이 자산의 카메라)` }],
    submodelElements: [
      prop('VideoCount', 'int', videos.length),
      // AASX: 영상 링크 목록 파일도 File 요소로 가리킨다 (AAS 도구는 모델이 가리키는 보조 파일만 읽는다 — BaSyx SDK 등)
      ...(videos.some((v) => v.linkPath) ? [{ modelType: 'File', idShort: 'VideoLinkList', contentType: 'application/json', value: `/aasx/${assetId}/files/videos/video_links.json` }] : []), prop('Format', 'string', videos.some((v) => v.mp4Url) ? 'video/mp4 (H.264, ffmpeg 카메라별) · 원본 video/webm' : 'video/webm (VP9/VP8)'),
      smc('Videos', videos.map((v, k) => smc(`Video${k + 1}_${safeId(v.camera)}`, [
        prop('Camera', 'string', v.label ?? v.camera), prop('CameraKey', 'string', v.camera), prop('Segment', 'string', v.segment),
        prop('StartTime', 'dateTime', v.start), prop('EndTime', 'dateTime', v.end), prop('FrameRate', 'double', v.fps),
        prop('CropRect', 'string', v.rect ? v.rect.join(',') : '', null, '분할 영상 안 이 카메라 칸 x,y,폭,높이 (px)'),
        // MP4(ffmpeg, 이 카메라만 잘라낸 영상)가 있으면 Video = MP4, 원본 분할 영상(WebM)은 SourceVideo
        ...(v.mp4Url ? [{ modelType: 'File', idShort: 'Video', contentType: 'video/mp4', value: v.mp4Url }, prop('LocalPath', 'string', v.mp4Path, null, '로컬 저장 경로 (MP4)'),
          { modelType: 'File', idShort: 'SourceVideo', contentType: 'video/webm', value: v.url ?? v.file }]
          : [{ modelType: 'File', idShort: 'Video', contentType: 'video/webm', value: v.url ?? v.file }]),
        ...(v.localPath ? [prop(v.mp4Url ? 'SourceLocalPath' : 'LocalPath', 'string', v.localPath, null, v.mp4Url ? '원본 분할 영상 로컬 경로 (WebM)' : '로컬 저장 경로')] : []),
        ...(v.linkPath ? [{ modelType: 'File', idShort: 'LinkFile', contentType: 'application/internet-shortcut', value: v.linkPath }] : []),
        ...(v.index ? [prop('IndexFile', 'string', v.index, null, '카메라 배치 색인 (JSON)')] : []),
      ]))),
    ],
  };
}
// AASX 안에 넣는 영상 링크 파일(.url · Windows/macOS 인터넷 바로가기) + 목록(video_links.json)
export function videoLinkFiles(assetId, videos) {
  const files = [];
  videos.forEach((v, k) => {
    const path = `/aasx/${assetId}/files/videos/${safeId(v.segment)}_${safeId(v.camera)}.url`;
    v.linkPath = path;
    files.push({ path, contentType: 'application/internet-shortcut', data: `[InternetShortcut]\r\nURL=${v.mp4Url ?? v.url ?? `file://${v.localPath ?? v.file}`}\r\n` });
  });
  if (videos.length) files.push({ path: `/aasx/${assetId}/files/videos/video_links.json`, contentType: 'application/json',
    data: JSON.stringify(videos.map(({ blob, ...v }) => v), null, 1) });
  return files;
}
export function addVideos(env, assetId, videos, title) {
  if (!videos?.length) return env;
  const sm = videoSubmodel(assetId, videos, title);
  env.submodels.push(sm);
  env.assetAdministrationShells.find((a) => a.id === aasId(assetId))?.submodels.push(modelRef('Submodel', sm.id));
  return env;
}
export function buildRobotEnvironment({ asset, samples, detail, last, opts = {} }) {
  const env = buildEnvironment([asset], [], last);
  // 데이터 허브용 TimeSeries(최근 기록용 구조)를 로봇 전용 두 시계열로 바꾼다
  env.submodels = env.submodels.filter((sm) => sm.idShort !== 'TimeSeries');
  env.assetAdministrationShells[0].submodels = env.assetAdministrationShells[0].submodels.filter((r) => !r.keys[0].value.endsWith('/TimeSeries'));
  const op = samples.filter((s) => s.v[asset.id]).map((s) => ({ t: s.t, v: s.v[asset.id] }));
  const sms = [tsSubmodel(asset.id, 'TimeSeries', '운영 기록 (데이터 허브 수집 주기)', asset.fields, op)];
  if (detail?.fields?.length) sms.push(tsSubmodel(asset.id, 'TelemetryTimeSeries', '정밀 기록 (로봇 선택 후 1초 간격: 관절·토크·온도·TCP·센서)', detail.fields, detail.rows, opts.fileRef));
  for (const sm of sms) { env.submodels.push(sm); env.assetAdministrationShells[0].submodels.push(modelRef('Submodel', sm.id)); }
  addVideos(env, asset.id, opts.videos);   // 이 로봇 카메라가 찍은 영상 파일 링크
  const known = new Set(env.conceptDescriptions.map((c) => c.id));
  for (const f of detail?.fields ?? []) {
    if (known.has(SEM.cd(f.idShort))) continue;
    known.add(SEM.cd(f.idShort));
    env.conceptDescriptions.push({ modelType: 'ConceptDescription', idShort: f.idShort, id: SEM.cd(f.idShort), description: [{ language: 'ko', text: f.unit ? `${f.label} [${f.unit}]` : f.label }] });
  }
  return env;
}
export function detailCSV(assetId, detail) {
  const rows = [`# Jin-3D 로봇 정밀 기록 · ${assetId} · 시각: 기준 시계 ISO 8601 UTC`, ['timestamp_utc', 'sim_time_s', ...detail.fields.map((f) => (f.unit ? `${f.idShort} [${f.unit}]` : f.idShort))].join(',')];
  for (const r of detail.rows) rows.push([r.t, r.simT.toFixed(1), ...r.v.map((x, i) => csvq(fmt(x, detail.fields[i].type)))].join(','));
  return '﻿' + rows.join('\n') + '\n';
}
