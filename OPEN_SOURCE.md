# 오픈소스 고지 (Open Source Notices)

Jin-3D(메타팩토리 정밀조립Zone 디지털트윈)를 만들고 배포하는 데 사용한 오픈소스 라이브러리, 개발 도구, 외부 사이트·서비스, 참고 표준을 정리합니다. 버전·라이선스는 프로젝트에 설치된 각 패키지의 `package.json` 기준입니다.

## 1. 오픈소스 라이브러리 (앱에 포함되어 동작)

| 이름 | 버전 | 라이선스 | 출처 | 쓰인 곳 |
|---|---|---|---|---|
| three.js | 0.186.1 | MIT | https://github.com/mrdoob/three.js | 3D 렌더링 전체 (`vendor/three`) |
| └ OrbitControls · CSS2DRenderer · EffectComposer · RenderPass · UnrealBloomPass · OutputPass | (three.js `examples/jsm`) | MIT | 같은 저장소 | 시점 조작, 라벨, 발광·후처리 |
| └ WebGLRenderTarget · readRenderTargetPixels | (three.js 코어) | MIT | 같은 저장소 | 로봇 카메라 영상(관제 디스플레이 8분할, 로봇 정보 창 실시간 영상) |
| └ GLTFLoader · RoomEnvironment (+ BufferGeometryUtils · SkeletonUtils) | (three.js `examples/jsm`) | MIT | 같은 저장소 | Blender 모델 렌더(기본) — glTF 모델 불러오기·실내 환경광 (`vendor/three/addons`) |
| Electron | 44.5.1 | MIT | https://github.com/electron/electron | Mac 앱 셸 (Jin-3D.app) |
| @electron/packager | 20.3.0 | BSD-2-Clause | https://github.com/electron/packager | Mac 앱 패키징 (`npm run package`) |
| @anthropic-ai/sdk | 0.131.0 | MIT | https://github.com/anthropics/anthropic-sdk-typescript | Agent(Claude API) 호출 서버 |
| aedes | 1.2.0 | MIT | https://github.com/moscajs/aedes | 내장 MQTT 브로커 |
| MQTT.js (mqtt) | 5.16.0 | MIT | https://github.com/mqttjs/MQTT.js | 외부 MQTT 브로커 연계(브리지) |
| mammoth | 1.13.0 | BSD-2-Clause | https://github.com/mwilliamson/mammoth.js | 공정 설계 첨부 워드(.docx) 본문 추출 (`vendor/mammoth`) |
| SheetJS Community Edition (xlsx) | 0.20.3 | Apache-2.0 | https://git.sheetjs.com/SheetJS/sheetjs (배포: https://cdn.sheetjs.com) | 공정 설계 첨부 엑셀 → CSV (`vendor/xlsx`) |

`vendor/three`, `vendor/mammoth`, `vendor/xlsx`에는 각 라이선스 원문(`LICENSE`)이 함께 들어 있습니다. npm 패키지의 라이선스 원문은 `node_modules/<패키지>/LICENSE`에 있으며, Mac 앱 배포본에도 Electron·three.js 등의 라이선스 고지를 함께 포함해야 합니다.

## 2. 개발·검증 도구 (앱에는 포함되지 않음)

| 이름 | 라이선스 | 출처 | 쓰인 곳 |
|---|---|---|---|
| Blender 5.2 | GPL-2.0-or-later (프로그램) — 만든 결과물(모델·렌더)은 만든 사람의 것 | https://www.blender.org | `blender/build_assets.py`로 AMR·AGV·지게차·드론·휴머노이드·사족보행·6축 팔·AMMR·화물트럭·갠트리·e-axle·도어트림·조립·체결 부품·정비실 비품 모델링과 기본 도형 라이브러리(`tools/collect-primitives.cjs`로 모은 치수 284종) → `assets/blender/*.glb`·미리보기 렌더 (Blender 프로그램은 앱에 포함하지 않음) |
| aas-core3.0 (Python) | MIT | https://github.com/aas-core-works/aas-core3.0-python | 내보낸 AAS JSON·XML 표준 적합성 검증 (메타모델 v3.0으로 저장한 파일 — v3.1 기본 파일은 BaSyx SDK로 검증) |
| Eclipse BaSyx Python SDK 2.2 · Compliance Tool | MIT | https://github.com/eclipse-basyx/basyx-python-sdk | 내보낸 AASX·AAS JSON·XML(메타모델 v3.1)이 BaSyx로 엄격 파싱되는지 검증 (`tests/aasbasyx.mjs`, 별도 빌드한 Jin-AASX 가상환경 사용 · 앱에 포함하지 않음) |
| Node.js · npm | MIT 등 | https://nodejs.org | 서버 실행, 시뮬레이션 자동 시험(`npm test`) |
| Python 3 | PSF | https://python.org | 개발 보조 스크립트, AAS 검증 |
| Git · GitHub CLI | GPL-2.0 · MIT | https://git-scm.com · https://cli.github.com | 형상 관리, 저장소·배포 상태 확인 |
| macOS codesign | Apple 기본 도구 | — | Mac 앱 서명 (ad-hoc) |
| FFmpeg (libx264 포함) | LGPL-2.1-or-later / GPL-2.0-or-later (libx264 사용 빌드) | https://ffmpeg.org | 로봇 카메라·CCTV 녹화 영상(WebM)을 MP4(H.264)로 변환하고 카메라별로 잘라 냄 (`server/video-convert.mjs`). **앱에 포함하지 않고** 이 컴퓨터에 설치된 ffmpeg를 외부 프로그램으로 실행만 함 (FFMPEG_PATH → Homebrew → ~/.local/bin → PATH 순으로 찾음). 없으면 WebM으로만 저장 |

## 3. 외부 사이트·서비스

| 사이트·서비스 | 용도 |
|---|---|
| GitHub — https://github.com/theuniversepark/jin-3d | 소스 저장소 |
| GitHub Pages — https://theuniversepark.github.io/jin-3d/ | 웹 버전 배포 |
| jsDelivr CDN — https://cdn.jsdelivr.net/npm/three@0.186.1/ | 공유 페이지(Claude 아티팩트)에서 three.js 로드 |
| Claude 아티팩트 (claude.ai) | 공유 페이지 호스팅 |
| Anthropic Claude API (모델 `claude-opus-5-5`) | 대화 기반 Agent 해석, 자연어 공정 설계 (API 키가 있을 때만) |
| https://console.anthropic.com/settings/keys | 설정 화면의 API 키 발급 안내 링크 |
| 캠틱종합기술원 — https://camtic.or.kr | 로고 이미지 `assets/camtic_logo.png` 출처 |
| 사용자 제공 이미지 | 도어트림 실물 이미지 `assets/doortrim.png` · e-axle 실물 단면 이미지 `assets/eaxle.png` (부품분류셀 이후 AMR 위 제품 표시) |

- AAS 데이터 안의 `https://admin-shell.io/...`, `https://camtic.or.kr/aas/jin3d/...` 등은 의미 식별자(semanticId·id)이며 실행 중 접속하지 않습니다.
- 폰트는 외부에서 받지 않고 운영체제 기본 폰트(Apple SD Gothic Neo, 대체 Noto Sans KR·맑은 고딕)를 씁니다.

## 4. 참고·준수한 표준 (규격 문서 — 구현 코드는 직접 작성)

| 표준 | 쓰인 곳 |
|---|---|
| IDTA Asset Administration Shell Part 1 메타모델 — **v3.1(기본)** · v3.0(저장 옵션) (IDTA-01001-3-1 · 3-0) | 설비·로봇 자산 모델 (JSON·XML·RDF), 로봇 카메라·CCTV 영상 링크 서브모델 `VideoRecordings` (`js/aas.js`) |
| IDTA AAS Part 5 (AASX 패키지) · ISO/IEC 29500-2 (OPC 패키징) | 로봇별 누적 데이터 `.aasx` |
| IDTA 02008 Time Series Data | 시계열 서브모델 (InternalSegment·ExternalSegment) |
| IDTA 02006 Digital Nameplate (ZVEI 2.0) · IDTA 02003 Technical Data (ZVEI 1.2) | 명판·기술 데이터 서브모델 |
| OPC UA Part 14 PubSub (JSON 메시지 매핑) | 데이터·메타데이터·이벤트·명령 메시지 |
| MQTT 3.1.1 | 메시지 전송 |
| AutomationML / CAEX 3.0 (IEC 62714) | `.aml` 내보내기 |
| W3C RDF 1.1 Turtle | `.ttl` 내보내기 |
| IEC 60204-1 (정지 카테고리 0·2) · ISO/TS 15066 (협동 로봇 속도 제한) | 비상정지·보호정지·안전 감속 명령 정의 |
| Odoo 외부 API (JSON-RPC `/jsonrpc`, execute_kw) · 데이터 모델 purchase.order · stock.picking · stock.quant · maintenance.request | Odoo ERP 연동 (`js/odoo.js`, `server/odoo-gateway.mjs`, 직접 작성 — Odoo 소스·라이브러리는 포함하지 않음. Odoo Community는 LGPL v3로 사용자가 따로 설치·운영) |
| W3C MediaStream Recording (MediaRecorder) · `HTMLCanvasElement.captureStream` · WebM(Matroska) · VP9/VP8 | 로봇 카메라·CCTV 영상 자동 녹화·개별 녹화 (`js/robotrec.js`, `js/cctvrec.js` — 브라우저·Electron 내장 기능) |
| ITU-T H.264 / MPEG-4 AVC · ISO/IEC 14496-12·14 (MP4) | ffmpeg로 변환한 MP4 영상(전체 분할·카메라별) (`server/video-convert.mjs`) |
| libpcap 파일 형식 (tcpdump.org) · IETF RFC 791(IPv4) · RFC 9293(TCP) · OASIS MQTT 3.1.1 | 패킷 덤프 `.pcap` 생성 (`js/pcap.js`, 직접 작성 — Wireshark·tcpdump는 분석용 외부 도구이며 포함하지 않음) |
| 3GPP TR 38.901 (InF 실내 공장 채널 모델) · TS 38.211 (PCI = 3·SSS + PSS) · TS 38.331 (A3 이벤트·TTT) · TS 38.300 (Xn 핸드오버) · Rel-16 DAPS 핸드오버 (끊김 0ms) | Private 5G 기지국 배치·PCI·핸드오버 시뮬레이션 (`js/net5g.js`) |
| 3GPP TS 22.104 (공장 자동화 서비스 요구) · TR 38.824 (URLLC — TDD 정렬·HARQ·설정 그랜트) · SON MLB (이동성 부하 분산) | 5G 지연 10ms(p99) 모델 · 기지국당 임계 대수 · 부하 분산 핸드오버·수락 제어 (`js/net5g.js`) |

## 5. 참고한 AI 알고리즘 (모델·가중치는 포함하지 않음 — 출력 형식만 재현)

CCTV 영상 AI 파이프라인(`js/cctv.js` `AI_MODELS`, `js/cctvview.js`)은 아래 공개 알고리즘의 역할과 출력 형식(박스·마스크·클래스·추적 ID·신뢰도)을 참고해 직접 작성한 시뮬레이션입니다. 모델 코드·가중치·데이터셋은 앱에 들어 있지 않습니다.

| 알고리즘·데이터셋 | 라이선스 | 출처 | 참고한 역할 |
|---|---|---|---|
| Ultralytics YOLO11 (탐지·분할) | AGPL-3.0 (상용 라이선스 별도) | https://github.com/ultralytics/ultralytics | 객체 탐지, 바닥 이상 인스턴스 분할 |
| ByteTrack | MIT | https://github.com/ifzhang/ByteTrack | 다중 객체 추적 ID |
| D-Fire 데이터셋 | CC0-1.0 | https://github.com/gaiasd/DFireDataset | 연기·화재 탐지 모델 학습 데이터 |

실제 현장 적용 시 YOLO11을 쓰려면 AGPL-3.0 의무를 지키거나 Ultralytics 상용 라이선스를 받아야 합니다.

## 6. 직접 작성한 부분

**로봇 외형 참고 (상표·디자인)** — 휴머노이드(Boston Dynamics 전동식 Atlas), 사족보행(Boston Dynamics Spot), 6축 팔(Rainbow Robotics RB20-1900), AMMR(Rainbow Robotics RB-Y1)은 각 제품의 **분위기만 참고해 Blender로 새로 모델링한 독자 디자인**입니다. 제조사의 3D 데이터·도면·이미지를 쓰지 않았고 로고·상표를 넣지 않았으며, 각 제품명·상표는 해당 회사의 것입니다(이 저장소와 제휴 관계 없음).

**FACOS(공장 운영 SW) 전체** — 시뮬레이션 엔진, 운영 에이전트, 오케스트레이터, 상위 명령·지시 게이트, 대화 기반 해석기, 출하·입고 트럭·물류 창고·드론, 설비 현황판, VLA 조립 동작(역기구학), VLA 에피소드 기록·zip 데이터셋·학습·배포 파이프라인, AIOS 공장 운영 AI(운영 데이터셋·정책 학습·트윈 검증·오케스트레이터 배포), 로봇 카메라 영상(렌더 타깃), CCTV 사각지대 배치·CCTV 에이전트·전광판·AI 오버레이(위 5절 알고리즘의 출력 형식 재현), Private 5G 기지국 배치·핸드오버 시뮬레이션, MQTT/TCP/IP 패킷 덤프(pcap), Blender 모델링 스크립트와 그 결과 모델(assets/blender), Odoo ERP 연동(발주·재고·설비보전), AAS·AASX·OPC UA 메시지 생성기, KPI 영향 분석·개선 제안·디지털트윈 검증, 혼합형 다중 에이전트(반사 계층·도메인 에이전트·메인 조정자)와 구조 비교, 문제 해결 우선순위(안전 우선), 진로 위 현장 이벤트 우회·대기, 로봇 카메라·CCTV 영상 자동 녹화와 AAS 영상 링크, 5G 지연 10ms 모델·부하 분산, 3D 모델(설비·로봇·트럭·드론 등), 화면 UI는 이 저장소에서 직접 작성했습니다. 외부 3D 모델 파일이나 외부 이미지는 위 로고 외에는 쓰지 않습니다.

FACOS는 공장 운영용 오픈소스 프레임워크(ROS 2·Open-RMF·Eclipse BaSyx·Node-RED 등)를 쓰지 않고 이 저장소에서 직접 작성했습니다. 위 1절 라이브러리는 3D 화면·앱 실행·MQTT 전송·Claude API 호출·첨부 파일 읽기에만 쓰이고, 판단·운영 로직(오케스트레이터·에이전트·셀 게이트·명령 센터·VLA·AIOS·CCTV 에이전트·Private 5G)은 모두 직접 작성한 코드입니다. VLA·AIOS 학습은 신경망이 아니라 규칙 기반 정책 탐색이며, 효과는 시뮬레이션에서 측정한 값입니다.

## 7. 유의 사항

- **캠틱 로고**: 이미지의 권리는 캠틱종합기술원에 있습니다. 공개 저장소·웹 버전에서의 사용 허락 여부를 확인하십시오.
- 위 라이브러리는 모두 MIT·BSD-2-Clause·Apache-2.0 라이선스로 상업적 사용이 가능하며, 재배포 시 저작권·라이선스 고지를 함께 포함해야 합니다.
