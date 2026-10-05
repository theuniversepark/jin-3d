// AAS 파일 호환 검증 — 로봇 AAS(AASX·JSON·XML)가 Eclipse BaSyx Python SDK(엄격 모드)로 그대로 읽히는지.
// ① 모든 valueType이 AAS 규격 이름(xs:…)인지 (예: bool → xs:boolean) ② 기본 메타모델 v3.1 네임스페이스, 옵션 v3.0
// ③ BaSyx SDK가 있으면(../BaSyx/Jin-AASX/.venv 또는 BASYX_PY) AASX·JSON·XML을 failsafe=False로 파싱해 객체·보조 파일 수 확인. 실행: npm test
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { buildRobotEnvironment, buildEnvironment, toXML, videoLinkFiles, setAasVersion, AAS_VERSIONS } from '../js/aas.js';
import { buildAASX } from '../js/aasx.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
console.log('== AAS 파일 호환 (BaSyx SDK)');
// 셀 AMMR 로봇처럼 bool 필드(HoldingPart)가 있는 자산 + 영상 링크
const plate = { manufacturer: 'Jin-3D', product: 'AMMR', serial: 'S-1', year: '2026' };
const asset = { id: 'SORT_R1', kind: 'CellRobot', name: '부품분류셀 AMMR #1', nameplate: plate, tech: { Axes: 13, RobotType: 'AMMR' },
  fields: [{ idShort: 'HoldingPart', label: '부품 파지', type: 'bool' }, { idShort: 'Battery', label: '배터리', type: 'double', unit: '%' }, { idShort: 'RackTrips', label: '선반 왕복', type: 'int' }, { idShort: 'PlatformPhase', label: '상태', type: 'string' }] };
const t = '2026-10-06T00:00:00.000Z', samples = [{ t, v: { SORT_R1: [true, 87.5, 3, 'pick'] } }, { t: '2026-10-06T00:00:10.000Z', v: { SORT_R1: [false, 87.2, 4, 'drive'] } }];
const last = { t, SORT_R1: [true, 87.5, 3, 'pick'] };
const detail = { fields: [{ idShort: 'J1', label: '관절1', type: 'double', unit: 'deg' }, { idShort: 'Grip', label: '파지', type: 'bool' }], rows: [{ t, simT: 0, v: [1.5, true] }] };
const videos = ['head', 'handL'].map((c, i) => ({ segment: 'run-x_robotcam_0001', file: 'run-x_robotcam_0001.webm', camera: c, label: c, rect: [i * 256, 30, 256, 144], start: t, end: t, fps: 2, url: 'http://127.0.0.1:47615/videos/robotcam/run-x_robotcam_0001.webm', mp4Url: `http://127.0.0.1:47615/videos/robotcam/run-x_robotcam_0001/SORT_R1_${c}.mp4`, mp4Path: `/data/robotcam/x/${c}.mp4`, localPath: '/data/robotcam/x.webm', index: 'x.json' }));
const csvPath = '/aasx/SORT_R1/files/SORT_R1_telemetry.csv', links = videoLinkFiles('SORT_R1', videos);
const env = buildRobotEnvironment({ asset, samples, detail, last, opts: { fileRef: csvPath, videos } });
const vts = []; JSON.stringify(env, (k, v) => { if (k === 'valueType') vts.push(v); return v; });
check('모든 valueType이 AAS 규격 이름 (bool → xs:boolean)', vts.length > 0 && vts.every((v) => /^xs:/.test(v)) && vts.includes('xs:boolean'), [...new Set(vts)].join(' · '));
check('기본 메타모델 v3.1 네임스페이스', setAasVersion('3.1') === '3.1' && toXML(env).includes(`xmlns="${AAS_VERSIONS['3.1']}"`));
check('옵션 v3.0 네임스페이스 (구버전 도구 호환)', setAasVersion('3.0') === '3.0' && toXML(env).includes(`xmlns="${AAS_VERSIONS['3.0']}"`) && setAasVersion('x') === '3.1');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jin3d-basyx-'));
setAasVersion('3.1');
const aasx31 = path.join(dir, 'r31.aasx'), json = path.join(dir, 'r.aas.json'), xml = path.join(dir, 'r.aas.xml'), aasx30 = path.join(dir, 'r30.aasx');
fs.writeFileSync(aasx31, buildAASX('SORT_R1', toXML(env), [{ path: csvPath, data: 'a,b\n', contentType: 'text/csv' }, ...links]));
fs.writeFileSync(json, JSON.stringify(env, null, 1)); fs.writeFileSync(xml, toXML(env));
const full = buildEnvironment([asset], samples, last, { recent: 60, csvName: 'x.csv' }); fs.writeFileSync(path.join(dir, 'full.aas.xml'), toXML(full));
setAasVersion('3.0'); fs.writeFileSync(aasx30, buildAASX('SORT_R1', toXML(env), [])); setAasVersion('3.1');
const PY = process.env.BASYX_PY ?? path.resolve('..', 'BaSyx', 'Jin-AASX', '.venv', 'bin', 'python');
if (!fs.existsSync(PY)) console.log(`  SKIP  BaSyx SDK 없음 (${PY}) — 파싱 시험 건너뜀`);
else {
  const py = `
import json, sys, logging
logging.disable(logging.CRITICAL)
from basyx.aas import model
from basyx.aas.adapter import aasx
from basyx.aas.adapter.json import read_aas_json_file
from basyx.aas.adapter.xml import read_aas_xml_file
d = sys.argv[1]; out = {}
def aasx_read(f):
    s, fl = model.DictIdentifiableStore(), aasx.DictSupplementaryFileContainer()
    try:
        with aasx.AASXReader(f, failsafe=False) as r: r.read_into(s, fl)
        return {'ok': True, 'n': len(s), 'files': len(list(fl))}
    except Exception as e: return {'ok': False, 'err': str(e)[:200]}
def rd(fn, f):
    try: return {'ok': True, 'n': len(fn(f, failsafe=False))}
    except Exception as e: return {'ok': False, 'err': str(e)[:200]}
out['aasx31'] = aasx_read(d + '/r31.aasx'); out['aasx30'] = aasx_read(d + '/r30.aasx')
out['json'] = rd(read_aas_json_file, d + '/r.aas.json'); out['xml'] = rd(read_aas_xml_file, d + '/r.aas.xml'); out['full'] = rd(read_aas_xml_file, d + '/full.aas.xml')
print(json.dumps(out))`;
  const r = spawnSync(PY, ['-c', py, dir], { encoding: 'utf8', timeout: 120000 });
  let o = {}; try { o = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { console.log(r.stderr?.slice(-800)); }
  check('BaSyx: 로봇 AASX(v3.1) 엄격 파싱 — 셸·서브모델·개념 설명 + 보조 파일(CSV·영상 링크)', o.aasx31?.ok && o.aasx31.n >= 5 && o.aasx31.files === links.length + 1, JSON.stringify(o.aasx31));
  check('BaSyx: 로봇 AAS JSON 엄격 파싱 (bool 필드 포함)', o.json?.ok && o.json.n >= 5, JSON.stringify(o.json));
  check('BaSyx: 로봇 AAS XML · 데이터 허브 AAS XML 엄격 파싱', o.xml?.ok && o.full?.ok, `${JSON.stringify(o.xml)} · ${JSON.stringify(o.full)}`);
  check('v3.0 옵션은 BaSyx SDK 2.x가 받지 않음 (그래서 기본 v3.1)', o.aasx30 && !o.aasx30.ok && /3\/1/.test(o.aasx30.err ?? ''), (o.aasx30?.err ?? '').slice(0, 90));
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
