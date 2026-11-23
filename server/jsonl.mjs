// 한 줄 하나씩 이어 쓰는 JSON 파일(.jsonl) 읽기 — ERPNext 대기열(server/erpnext-bridge.mjs) · EPCIS 이벤트(server/epcis-api.mjs)
//  · 깨진 줄이 있어도 나머지 정상 줄은 모두 살린다 (한 줄 때문에 전체를 버리지 않는다). 깨진 줄 자리는 undefined로 남겨 순번(대기열 커서)이 밀리지 않게
//  · 끝의 반쯤 쓰인 줄(쓰다가 꺼짐)은 파일에서 잘라 <파일>.torn-<시각>에 따로 두고 줄 경계를 맞춘다 — 그대로 두면 다음 이어 쓰기가 그 조각에 붙어 새 기록까지 깨진다
import fs from 'node:fs';

export function loadJsonl(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return { items: [], bad: 0, torn: null }; }
  const parts = text.split('\n'), tail = parts.pop(), items = [];
  let bad = 0, torn = null;
  for (const l of parts) { if (!l) continue; try { items.push(JSON.parse(l)); } catch { items.push(undefined); bad++; } }
  if (tail) {
    let v; try { v = JSON.parse(tail); } catch { v = undefined; }
    if (v !== undefined) { items.push(v); fs.appendFileSync(file, '\n'); }   // 줄바꿈만 빠진 정상 줄
    else { torn = `${file}.torn-${Date.now()}`; fs.writeFileSync(torn, tail); fs.truncateSync(file, Buffer.byteLength(text) - Buffer.byteLength(tail)); }
  }
  return { items, bad, torn };
}
