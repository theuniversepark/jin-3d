// 토리 영어 안내: js/tori-en.js가 한국어 주제와 단계마다 맞는지 (단계 수 · 상황별 음성 종류 · 녹음 문장에 한글 없음)
import assert from 'node:assert/strict';
import { EN } from '../js/tori-en.js';
import { narration, speakText, voiceKey } from '../js/tori.js';

const src = (await import('node:fs')).readFileSync(new URL('../js/tori.js', import.meta.url), 'utf8');
let n = 0;
for (const [k, E] of Object.entries(EN)) {
  if (!E.steps) continue;
  const m = src.match(new RegExp(`\\n  ${k}: \\{ name: '[^']*'[^\\n]*steps: \\[\\n([\\s\\S]*?)\\n  \\] \\},`));
  assert.ok(m, `주제 ${k}`);
  const ko = m[1].split('\n').filter((l) => /^    \{/.test(l)).length;
  assert.equal(E.steps.length, ko, `${k}: 영어 ${E.steps.length}단계 · 한국어 ${ko}단계`);
  for (const s of E.steps) { assert.ok(s.say, `${k}: say 없음`); n++; }
}
const en = narration('en'), ko = narration('ko');
assert.ok(en.length >= ko.length - 2, `녹음 문장 수 영어 ${en.length} · 한국어 ${ko.length}`);
for (const t of en) assert.ok(!/[가-힣]/.test(speakText(t, 'en')), `영어 문장에 한글: ${t.slice(0, 50)}`);
assert.notEqual(voiceKey('Hello', 'en'), voiceKey('안녕', 'ko'));
console.log(`toriEn ok — ${n}단계 · 영어 녹음 문장 ${new Set(en).size}개`);
