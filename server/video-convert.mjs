// 영상 MP4 변환 (ffmpeg) — 로봇 카메라·CCTV 자동 녹화 구간(WebM)을 받으면 차례로
//   ① 전체 분할 영상 MP4 (H.264 · yuv420p · faststart) → data/<kind>/<구간>.mp4
//   ② 칸 색인(JSON)대로 잘라 카메라별 MP4 → data/<kind>/<구간>/<로봇·카메라>.mp4
// 를 만든다. 개별 녹화(CCTV 정보 창)도 MP4로 바꿔 돌려준다. ffmpeg는 FFMPEG_PATH → Homebrew → ~/.local/bin → PATH 순으로 찾는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

let ffmpegPath;
export function findFfmpeg() {
  if (ffmpegPath !== undefined) return ffmpegPath;
  const cands = [process.env.FFMPEG_PATH, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', path.join(os.homedir(), '.local/bin/ffmpeg'), 'ffmpeg'].filter(Boolean);
  ffmpegPath = null;
  for (const c of cands) {
    try { const r = spawnSync(c, ['-hide_banner', '-version'], { timeout: 5000 }); if (r.status === 0) { ffmpegPath = c; break; } } catch { /* 다음 후보 */ }
  }
  return ffmpegPath;
}
let info;
export function ffmpegInfo() {
  if (info) return info;
  const p = findFfmpeg(); if (!p) return (info = { available: false });
  const v = spawnSync(p, ['-hide_banner', '-version'], { timeout: 5000 }).stdout?.toString().split('\n')[0] ?? '';
  return (info = { available: true, path: p, version: v.replace(/^ffmpeg version\s*/, '').split(' ')[0] });
}

function run(args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const p = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let err = ''; p.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg 시간 초과')); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg 종료 코드 ${code}`)); });
  });
}
// MediaRecorder WebM은 길이·타임스탬프가 비어 있을 수 있어 타임스탬프를 다시 만들고 고정 fps로 맞춘다
// 화질·크기: 녹화 구간은 비트레이트 상한(전체 400kbps · 카메라 칸 40kbps, 2fps)으로 WebM과 비슷한 크기, 개별 녹화는 화질 우선(CRF 23)
const H264 = (fps, maxrate = null, crf = 28) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), ...(maxrate ? ['-maxrate', maxrate, '-bufsize', `${parseInt(maxrate, 10) * 2}k`] : []), '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart'];
const even = (v) => Math.max(2, Math.floor(v / 2) * 2);
export const camFile = (t) => `${String(t.robot ?? t.id ?? 'cam').replace(/[^A-Za-z0-9_-]/g, '_')}_${String(t.camera ?? 'view').replace(/[^A-Za-z0-9_-]/g, '_')}.mp4`;

// 구간 하나 변환 (전체 + 카메라별). 결과는 <구간>.mp4.json에 남긴다
export async function convertSegment(dir, id) {
  const webm = path.join(dir, `${id}.webm`), idxF = path.join(dir, `${id}.json`), out = path.join(dir, `${id}.mp4`), resF = path.join(dir, `${id}.mp4.json`);
  if (!findFfmpeg()) throw new Error('ffmpeg를 찾지 못했습니다 (FFMPEG_PATH 또는 Homebrew ffmpeg 설치)');
  if (!fs.existsSync(webm)) throw new Error('영상 구간이 없습니다');
  const meta = fs.existsSync(idxF) ? JSON.parse(fs.readFileSync(idxF, 'utf8')) : { fps: 2, index: [] };
  const fps = meta.fps ?? 2, t0 = Date.now();
  await run(['-fflags', '+genpts', '-i', webm, '-an', ...H264(fps, '400k'), out]);
  // 카메라별: 한 번 디코드해 split → crop → 출력 여러 개 (칸 좌표는 짝수로)
  const cams = (meta.index ?? []).filter((c) => c.rect), files = [];
  if (cams.length) {
    const sub = path.join(dir, id); fs.mkdirSync(sub, { recursive: true });
    for (let k = 0; k < cams.length; k += 24) {   // 출력이 많으면 24개씩 나눠 (명령 길이·메모리)
      const part = cams.slice(k, k + 24);
      const fc = `[0:v]split=${part.length}${part.map((_, i) => `[s${i}]`).join('')};` + part.map((c, i) => { const [x, y, w, h] = c.rect; return `[s${i}]crop=${even(w)}:${even(h)}:${even(x)}:${even(y)}[c${i}]`; }).join(';');
      const outs = part.flatMap((c, i) => ['-map', `[c${i}]`, ...H264(fps, '40k'), path.join(sub, camFile(c))]);
      await run(['-fflags', '+genpts', '-i', webm, '-filter_complex', fc, ...outs]);
      files.push(...part.map((c) => ({ robot: c.robot ?? c.id, camera: c.camera ?? 'view', label: c.label ?? c.place ?? '', file: `${id}/${camFile(c)}` })));
    }
  }
  const res = { segment: id, mp4: `${id}.mp4`, bytes: fs.statSync(out).size, cameras: files, seconds: Math.round((Date.now() - t0) / 100) / 10, at: new Date().toISOString(), ffmpeg: ffmpegInfo().version };
  fs.writeFileSync(resF, JSON.stringify(res, null, 1));
  return res;
}

// 차례 변환 큐 (CPU를 한꺼번에 쓰지 않게) — 같은 구간은 한 번만, 결과를 기다릴 수 있다
const jobs = new Map(); let chain = Promise.resolve();
export function queueConvert(dir, id) {
  const key = `${dir}|${id}`;
  if (jobs.has(key)) return jobs.get(key);
  const done = path.join(dir, `${id}.mp4.json`);
  if (fs.existsSync(done)) { const p = Promise.resolve(JSON.parse(fs.readFileSync(done, 'utf8'))); jobs.set(key, p); return p; }
  const p = (chain = chain.then(() => convertSegment(dir, id), () => convertSegment(dir, id)));
  p.catch(() => jobs.delete(key));   // 실패하면 다음에 다시 시도
  jobs.set(key, p);
  return p;
}
// 개별 녹화(WebM 바이트) → MP4 바이트
export async function convertClip(buf, fps = 8) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jin3d-clip-')), i = path.join(tmp, 'in.webm'), o = path.join(tmp, 'out.mp4');
  try { fs.writeFileSync(i, buf); await run(['-fflags', '+genpts', '-i', i, '-an', ...H264(fps, null, 23), o]); return fs.readFileSync(o); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ── VLA 에피소드: 카메라 프레임(JPEG, 시각 제각각) → MP4 (H.264, 고정 fps) ─────────────────
// 무압축 zip(js/aasx.js zipStore) 읽기: 로컬 파일 헤더를 차례로 — 이름 → 바이트
export function readStoredZip(buf) {
  const out = new Map(); let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18), nl = buf.readUInt16LE(p + 26), xl = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nl), start = p + 30 + nl + xl;
    out.set(name, buf.subarray(start, start + size)); p = start + size;
  }
  return out;
}
// frames: [{ name, data, dur(초) }] — ffmpeg concat으로 프레임마다 머무는 시간을 지키고, fps 고정 영상으로 (빠진 프레임은 앞 프레임 반복)
export async function framesToMp4(frames, fps = 5) {
  if (!findFfmpeg()) throw new Error('ffmpeg 없음');
  if (!frames.length) throw new Error('프레임 없음');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jin3d-ep-'));
  try {
    const list = [];
    frames.forEach((f, i) => { const n = `f${String(i).padStart(5, '0')}.jpg`; fs.writeFileSync(path.join(tmp, n), f.data); list.push(`file '${n}'`, `duration ${Math.max(1 / fps, f.dur).toFixed(4)}`); });
    list.push(`file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'`);   // concat: 마지막 프레임 길이가 지켜지도록 한 번 더
    fs.writeFileSync(path.join(tmp, 'list.txt'), list.join('\n') + '\n');
    const o = path.join(tmp, 'out.mp4');
    await run(['-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'), '-fps_mode', 'cfr', '-r', String(fps), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-movflags', '+faststart', '-an', o]);
    return fs.readFileSync(o);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
