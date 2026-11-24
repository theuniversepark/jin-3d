// .env 파일 읽기 — KEY=값 줄을 환경변수로 올린다. 이미 있는 환경변수는 덮어쓰지 않고, 빈 값 · 주석(#) 줄은 건너뛴다.
// npm start(server.mjs)와 맥·윈도우 앱(electron/env.mjs)이 같이 쓴다. 읽은 변수 이름만 돌려준다(값은 기록하지 않는다).
import fs from 'node:fs';

export function loadEnvFile(file, env = process.env) {
  const names = [];
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return names; }   // 없거나 못 읽으면 조용히 넘어간다
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !env[m[1]]) { env[m[1]] = m[2].replace(/^["']|["']$/g, ''); names.push(m[1]); }
  }
  return names;
}
