# 오픈소스 고지 (Open Source Notices)

피지컬AI 실증 메타팩토리(메타팩토리 정밀조립Zone 디지털트윈)를 만들고 배포하는 데 사용한 오픈소스 라이브러리, 개발 도구, 외부 사이트·서비스, 참고 표준을 정리합니다. 버전·라이선스는 프로젝트에 설치된 각 패키지의 `package.json` 기준입니다. 이 저장소의 소스 코드 자체는 MIT 라이선스([LICENSE](LICENSE), 저작권자 캠틱종합기술원)이며, 아래 외부 라이브러리 · 모델 · 로고 · 상표는 각자의 조건을 따릅니다.

## 1. 오픈소스 라이브러리 (앱에 포함되어 동작)

| 이름 | 버전 | 라이선스 | 출처 | 쓰인 곳 |
|---|---|---|---|---|
| three.js | 0.186.1 | MIT | https://github.com/mrdoob/three.js | 3D 렌더링 전체 (`vendor/three`) · 안내 아바타 토리 캔버스는 같은 배포본의 WebGPU 빌드 `vendor/three/three.webgpu.js` (WebGPU가 없으면 WebGL) |
| └ OrbitControls · CSS2DRenderer · EffectComposer · RenderPass · UnrealBloomPass · OutputPass | (three.js `examples/jsm`) | MIT | 같은 저장소 | 시점 조작, 라벨, 발광·후처리 |
| └ WebGLRenderTarget · readRenderTargetPixels | (three.js 코어) | MIT | 같은 저장소 | 로봇 카메라 영상(관제 디스플레이 8분할, 로봇 정보 창 실시간 영상) |
| └ GLTFLoader · RoomEnvironment (+ BufferGeometryUtils · SkeletonUtils) | (three.js `examples/jsm`) | MIT | 같은 저장소 | Blender 모델 렌더(기본) — glTF 모델 불러오기·실내 환경광 (`vendor/three/addons`) |
| Electron | 44.5.1 | MIT | https://github.com/electron/electron | 맥·윈도우 앱 셸 (피지컬AI 실증 메타팩토리.app · 피지컬AI 실증 메타팩토리.exe) |
| @electron/packager | 20.3.0 | BSD-2-Clause | https://github.com/electron/packager | 맥·윈도우 앱 패키징 (`npm run package` · `npm run package:win`) |
| @anthropic-ai/sdk | 0.131.0 | MIT | https://github.com/anthropics/anthropic-sdk-typescript | Agent(Claude API) 호출 서버 |
| aedes | 1.2.0 | MIT | https://github.com/moscajs/aedes | 내장 MQTT 브로커 대비 엔진 (MQTT 3.1.1 — Mosquitto가 없거나 시작에 실패할 때) |
| Eclipse Mosquitto | 2.1.2 | EPL-2.0 OR EDL-1.0 (BSD-3-Clause) | https://mosquitto.org · https://github.com/eclipse-mosquitto/mosquitto | 내장 MQTT 5 브로커 (`vendor/mosquitto/` — 맥: Homebrew 빌드, 라이브러리 경로만 앱 안으로 바꿈 · 윈도우: 공식 설치본 mosquitto-2.1.2-install-windows-x64.exe에서 필요한 파일만) |
| OpenSSL | 3.x | Apache-2.0 | https://www.openssl.org | Mosquitto가 쓰는 암호 라이브러리 (`vendor/mosquitto/*/libssl · libcrypto`) |
| cJSON | 1.7.x | MIT | https://github.com/DaveGamble/cJSON | Mosquitto가 쓰는 JSON 라이브러리 (`vendor/mosquitto/*/libcjson · cjson.dll`) |
| GNU libmicrohttpd | (Mosquitto 윈도우 배포본 포함) | LGPL-2.1-or-later (동적 연결 DLL, 수정 없음) | https://www.gnu.org/software/libmicrohttpd/ | 윈도우 Mosquitto가 함께 쓰는 DLL (`vendor/mosquitto/win32-x64/libmicrohttpd-dll.dll`) |
| Microsoft Visual C++ 런타임 (vcruntime140.dll) | 14.x | Microsoft 재배포 가능 파일 (Visual C++ 재배포 패키지 라이선스) | https://learn.microsoft.com/cpp/windows/redistributing-visual-cpp-files | 윈도우 Mosquitto 실행에 필요 — Mosquitto 설치본에 들어 있는 vc_redist.x64.exe에서 꺼냄 (앱 폴더 배포) |
| MQTT.js (mqtt) | 5.16.0 | MIT | https://github.com/mqttjs/MQTT.js | 외부 MQTT 브로커 연계(브리지) · 앱 서버의 MQTT 5 발행 클라이언트 · Sparkplug B 엣지·주 호스트 |
| mammoth | 1.13.0 | BSD-2-Clause | https://github.com/mwilliamson/mammoth.js | 공정 설계 첨부 워드(.docx) 본문 추출 (`vendor/mammoth`) |
| SheetJS Community Edition (xlsx) | 0.20.3 | Apache-2.0 | https://git.sheetjs.com/SheetJS/sheetjs (배포: https://cdn.sheetjs.com) | 공정 설계 첨부 엑셀 → CSV (`vendor/xlsx`) |

`vendor/three`, `vendor/mammoth`, `vendor/xlsx`에는 각 라이선스 원문(`LICENSE`)이 함께 들어 있습니다. npm 패키지의 라이선스 원문은 `node_modules/<패키지>/LICENSE`에 있으며, Mac 앱 배포본에도 Electron·three.js 등의 라이선스 고지를 함께 포함해야 합니다.

## 2. 개발·검증 도구 (앱에는 포함되지 않음)

| 이름 | 라이선스 | 출처 | 쓰인 곳 |
|---|---|---|---|
| Blender 5.2 | GPL-2.0-or-later (프로그램) — 만든 결과물(모델·렌더)은 만든 사람의 것 | https://www.blender.org | `blender/build_assets.py`로 AMR·AGV·지게차·드론·휴머노이드·사족보행·6축 팔·AMMR·화물트럭·갠트리·e-axle·도어트림·조립·체결 부품·정비실 비품 모델링과 기본 도형 라이브러리(`tools/collect-primitives.cjs`로 모은 치수 284종) → `assets/blender/*.glb`·미리보기 렌더 (Blender 프로그램은 앱에 포함하지 않음) |
| aas-core3.0 (Python) | MIT | https://github.com/aas-core-works/aas-core3.0-python | 내보낸 AAS JSON·XML 표준 적합성 검증 (메타모델 v3.0으로 저장한 파일 — v3.1 기본 파일은 BaSyx SDK로 검증) |
| Eclipse BaSyx Python SDK 2.2 · Compliance Tool | MIT | https://github.com/eclipse-basyx/basyx-python-sdk | 내보낸 AASX·AAS JSON·XML(메타모델 v3.1)이 BaSyx로 엄격 파싱되는지 검증 (`tests/aasbasyx.mjs`, 별도 빌드한 Jin-AASX 가상환경 사용 · 앱에 포함하지 않음) |
| @zxing/library 0.23 | Apache-2.0 | https://github.com/zxing-js/library | 앱 안 QR · DataMatrix 인코더(`js/codes.js`)가 만든 코드가 실제로 읽히는지 시험 (`tests/serial.mjs`) |
| Ajv 8 · ajv-formats 3 | MIT | https://github.com/ajv-validator/ajv | EPCIS 2.0 이벤트 문서를 GS1 공식 JSON 스키마(https://ref.gs1.org/standards/epcis/epcis-json-schema.json)로 검증 (`tests/epcis.mjs`) |
| DoWhy · PyRCA (sfr-pyrca) · causal-learn | MIT · BSD-3-Clause · MIT | https://github.com/py-why/dowhy · https://github.com/salesforce/PyRCA | 불량 원인 분석 노트북 (`analysis/rca/` — 내려받은 데이터셋 분석, 앱과 따로 설치) |
| Node.js · npm | MIT 등 | https://nodejs.org | 서버 실행, 시뮬레이션 자동 시험(`npm test`) |
| Python 3 | PSF | https://python.org | 개발 보조 스크립트, AAS 검증 |
| edge-tts 7.3 (Python) | 저장소 LICENSE 참조 | https://github.com/rany2/edge-tts | 토리(안내 아바타) 음성 녹음 생성(`npm run tori:voice` · `tools/tori-voice.mjs`) — Microsoft Edge 읽기 기능의 신경망 음성 `ko-KR-InJoonNeural` · `en-US-AndrewNeural`을 키 없이 호출하는 비공식 도구. 만들 때만 쓰고 앱 실행 중에는 쓰지 않음. 이 저장소의 녹음은 상위 meta-factory에서 만든 파일 가운데 문장이 같은 것만 가져왔고, 여기서 새로 만들지 않았음 |
| Git · GitHub CLI | GPL-2.0 · MIT | https://git-scm.com · https://cli.github.com | 형상 관리, 저장소·배포 상태 확인 |
| macOS codesign | Apple 기본 도구 | — | Mac 앱 서명 (ad-hoc) |
| FFmpeg (libx264 포함) | LGPL-2.1-or-later / GPL-2.0-or-later (libx264 사용 빌드) | https://ffmpeg.org | 로봇 카메라·CCTV 녹화 영상(WebM)을 MP4(H.264)로 변환하고 카메라별로 잘라 냄 (`server/video-convert.mjs`). **앱에 포함하지 않고** 이 컴퓨터에 설치된 ffmpeg를 외부 프로그램으로 실행만 함 (FFMPEG_PATH → Homebrew → ~/.local/bin → 윈도우는 winget 링크 · C:\ffmpeg · Program Files → PATH 순으로 찾음). 없으면 WebM으로만 저장 |

## 3. 외부 사이트·서비스

| 사이트·서비스 | 용도 |
|---|---|
| GitHub — https://github.com/theuniversepark/jin-3d | 소스 저장소 |
| GitHub Pages — https://theuniversepark.github.io/jin-3d/ | 웹 버전 배포 |
| jsDelivr CDN — https://cdn.jsdelivr.net/npm/three@0.186.1/ | 공유 페이지(Claude 아티팩트)에서 three.js 로드 |
| Claude 아티팩트 (claude.ai) | 공유 페이지 호스팅 |
| Anthropic Claude API (모델 `claude-opus-5-5`) | 대화 기반 Agent 해석, 자연어 공정 설계 (API 키가 있을 때만) |
| https://console.anthropic.com/settings/keys | 설정 화면의 API 키 발급 안내 링크 |
| 캠틱종합기술원 — https://www.camtic.or.kr | 서버 랙 양옆 로고·앞쪽 바닥 표시 이미지 `assets/camtic_logo.png` · `assets/camtic_logo_dark.png` (바닥용 — 흰 로고타입을 진한 회색으로 바꿈). 두 파일 모두 550px 원본을 2200px로 키우고 가장자리를 선명하게 다듬은 것 |
| 사용자 제공 이미지 | 도어트림 실물 이미지 `assets/doortrim.png` · e-axle 실물 단면 이미지 `assets/eaxle.png` (부품분류셀 이후 AMR 위 제품 표시) |
| 사용자 제공 이미지 (캐릭터) | 안내 아바타 토리 — 공장장 캐릭터 이미지 `assets/tori/manager.png` · 영어 안내용 `assets/tori/manager-en.png` |
| Microsoft 신경망 음성 (ko-KR-InJoonNeural · en-US-AndrewNeural) | 토리 안내 음성 녹음 `assets/tori/voice/*.mp3` · `assets/tori/voice/en/*.mp3` — edge-tts로 미리 만든 파일. 앱 실행 중에는 접속하지 않음. 공개 배포물에 넣는 것에 대한 이용 조건은 확인되지 않음(정식 Azure Speech 등으로 다시 만들 수 있게 생성 도구를 분리함) |

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
| W3C MediaStream Recording (MediaRecorder) · `HTMLCanvasElement.captureStream` · WebM(Matroska) · VP9/VP8 | 로봇 카메라·CCTV 영상 자동 녹화·개별 녹화 (`js/robotrec.js`, `js/cctvrec.js` — 브라우저·Electron 내장 기능) |
| ITU-T H.264 / MPEG-4 AVC · ISO/IEC 14496-12·14 (MP4) | ffmpeg로 변환한 MP4 영상(전체 분할·카메라별) (`server/video-convert.mjs`) |
| libpcap 파일 형식 (tcpdump.org) · IETF RFC 791(IPv4) · RFC 9293(TCP) · OASIS MQTT 3.1.1 | 패킷 덤프 `.pcap` 생성 (`js/pcap.js`, 직접 작성 — Wireshark·tcpdump는 분석용 외부 도구이며 포함하지 않음) |
| 3GPP TR 38.901 (InF 실내 공장 채널 모델) · TS 38.211 (PCI = 3·SSS + PSS) · TS 38.331 (A3 이벤트·TTT) · TS 38.300 (Xn 핸드오버) · Rel-16 DAPS 핸드오버 (끊김 0ms) | Private 5G 기지국 배치·PCI·핸드오버 시뮬레이션 (`js/net5g.js`) |
| 3GPP TS 22.104 (공장 자동화 서비스 요구) · TR 38.824 (URLLC — TDD 정렬·HARQ·설정 그랜트) · SON MLB (이동성 부하 분산) | 5G 지연 10ms(p99) 모델 · 기지국당 임계 대수 · 부하 분산 핸드오버·수락 제어 (`js/net5g.js`) |
| W3C Decentralized Identifiers (DID) v1.0 · W3C Verifiable Credentials Data Model | 피지컬AI 다중 계층 보안 시뮬레이션의 주체 신원·권한·OT 명령 검증 흐름 (`js/security.js` — 총괄4 착수보고 구조를 따름, 암호 연산은 하지 않음) |
| ISO 3691-4 (무인 산업용 트럭 — 안전 요구사항) | AMR·AGV 운행 관리에서 사람·휴머노이드 공유 공간의 권장 속도 상한·감속 구역 경고 (`js/fleet.js`, 참고값) |
| IEC 63278-1 (AAS) · ISA-95 / IEC 62264 · NTP / IEEE 1588 PTP | 개념도의 데이터 연계 계층 표기 (`js/factory.js` — 명칭 표기만, 구현은 위 AAS·OPC UA·MQTT 항목) |
| ISO 8601 | AAS·데이터 허브·VLA 에피소드의 시각 표기 (`js/aas.js`, `js/datahub.js`, `js/vla.js`) |
| IEC 61360 · ECLASS · IEC CDD | 미적용 — AAS 운영 필드에 붙일 개선 과제로만 언급 (`docs/AAS_SCHEMA.md`) |
| Open-RMF (Open Robotics) — https://github.com/open-rmf | 미적용 — AMR·AGV 팝업에 "단순 시뮬레이션, Open-RMF 미적용" 안내 (`index.html`) |

## 5. 참고한 AI 알고리즘 (모델·가중치는 포함하지 않음 — 출력 형식만 재현)

CCTV 영상 AI 파이프라인(`js/cctv.js` `AI_MODELS`, `js/cctvview.js`)은 아래 공개 알고리즘의 역할과 출력 형식(박스·마스크·클래스·추적 ID·신뢰도)을 참고해 직접 작성한 시뮬레이션입니다. 모델 코드·가중치·데이터셋은 앱에 들어 있지 않습니다.

| 알고리즘·데이터셋 | 라이선스 | 출처 | 참고한 역할 |
|---|---|---|---|
| Ultralytics YOLO11 (탐지·분할) | AGPL-3.0 (상용 라이선스 별도) | https://github.com/ultralytics/ultralytics | 객체 탐지, 바닥 이상 인스턴스 분할 |
| ByteTrack | MIT | https://github.com/ifzhang/ByteTrack | 다중 객체 추적 ID |
| D-Fire 데이터셋 | CC0-1.0 | https://github.com/gaiasd/DFireDataset | 연기·화재 탐지 모델 학습 데이터 |

실제 현장 적용 시 YOLO11을 쓰려면 AGPL-3.0 의무를 지키거나 Ultralytics 상용 라이선스를 받아야 합니다.

**계산 모델 (일반 공식 — 직접 구현)**

| 모델 | 출처 | 쓰인 곳 |
|---|---|---|
| OEE = 양품 수 × 이상 사이클 타임 ÷ 계획 시간 | Nakajima, *Introduction to TPM* (1988) · ISO 22400-2 (제조 운영 KPI) | KPI·영향 분석·디지털트윈 검증 (`js/sim.js`, `js/impact.js`) |
| M/M/1 대기 시간 99% 꼬리 | Kleinrock, *Queueing Systems Vol. 1* (1975) | 5G p99 지연의 부하 대기 항 (`js/net5g.js`) |
| 2링크 해석적 역기구학(코사인 법칙) | 일반 로봇공학 교재 (예: Craig, *Introduction to Robotics*) | VLA 조립 동작 관절값 (`js/factory.js`) |

## 6. 직접 작성한 부분

**셀 로봇·이동 로봇 형상 (상위 meta-factory와 같은 자산)** — 협동로봇 Universal Robots UR20, 6축 ABB IRB 4600-60/2.05, 양팔 AMMR Rainbow Robotics RB-Y1, 사족보행 Boston Dynamics Spot은 **공개 ROS/URDF·SDK 패키지의 원본 메시·관절 원점·축·한계**를 Blender로 가져와 만들었습니다(`assets/blender/{ur20,irb4600,rby1,quadruped}.glb`). 출처·리비전·라이선스 원문은 `assets/vendor/`(README.md · UR20 그래픽 이용 조건 `ur/meshes/ur20/LICENSE.txt` · ABB Apache-2.0 · Rainbow LICENSE/NOTICE · Spot LICENSE)에, 제조사 제원과 표현 한계는 `blender/PAYLOAD_ROBOTS.md` · `blender/BOSTON_DYNAMICS.md`에 있습니다. 휴머노이드(Atlas)는 공식 사진·제원(키 1.90m)을 참고해 Blender로 새로 만든 재구성 모델이며, 정비로봇 팔과 셀 휴머노이드 팔에 쓰는 6축 팔(arm6)은 독자 디자인입니다. 그리퍼·손목 카메라·받침대는 시뮬레이션용으로 덧붙인 것이고, 각 제품명·상표는 해당 회사의 것입니다(이 저장소와 제휴 관계 없음).

**FACOS(공장 운영 SW) 전체** — 시뮬레이션 엔진, 운영 에이전트, 오케스트레이터, 상위 명령·지시 게이트, 대화 기반 해석기, 출하·입고 트럭·물류 창고·드론, 설비 현황판, VLA 조립 동작(역기구학 — 실물 로봇 원본 관절 체인은 CCD 역기구학), 자재 투입 로봇셀(주행 레일 7축 · 용기 공급 · 툴 체인저)·서열 키팅(SPS)·조립·체결셀 접촉 작업(점별 압입·나사 체결 · 도킹 스테이션 · 앵글 헤드 너트러너 · EOL 시험)·셀별 실제 작업 시간(ZONE_T)·검사·포장셀 최종 검사 시리얼 발행(QR 라벨)·상자 포장 동작, VLA 에피소드 기록·zip 데이터셋·학습·배포 파이프라인, AIOS 공장 운영 AI(운영 데이터셋·정책 학습·트윈 검증·오케스트레이터 배포), 로봇 카메라 영상(렌더 타깃), CCTV 사각지대 배치·CCTV 에이전트·전광판·AI 오버레이(위 5절 알고리즘의 출력 형식 재현), Private 5G 기지국 배치·핸드오버 시뮬레이션, MQTT/TCP/IP 패킷 덤프(pcap), Blender 모델링 스크립트와 그 결과 모델(assets/blender), FAC 업무 기록(발주·재고·설비보전)·FAC API, AAS·AASX·OPC UA 메시지 생성기, KPI 영향 분석·개선 제안·디지털트윈 검증, 혼합형 다중 에이전트(반사 계층·도메인 에이전트·메인 조정자)와 구조 비교, AMR·AGV 운행 관리(속도 배율·정지/시작·상황별 속도 규칙·디지털트윈 예측), 피지컬AI 다중 계층 보안 시뮬레이션(DID/VC 신원·최소 권한·OTAC·DPI·동형암호 연합학습·ZKML·eVDI 반출 통제·메타모픽/차등 테스팅·보안 인시던트 처리 흐름 스윔레인 — 총괄4 착수보고 구조를 따른 흐름 재현, 실제 암호 연산 없음), 문제 해결 우선순위(안전 우선), 진로 위 현장 이벤트 우회·대기, 로봇 카메라·CCTV 영상 자동 녹화와 AAS 영상 링크, 5G 지연 10ms 모델·부하 분산, 3D 모델(설비·로봇·트럭·드론 등), 화면 UI는 이 저장소에서 직접 작성했습니다. 외부 3D 모델 데이터는 위 셀 로봇·Spot의 공개 ROS/URDF·SDK 형상(`assets/vendor/`)만 쓰며, 외부 이미지는 위 로고 외에는 쓰지 않습니다.

FACOS는 공장 운영용 오픈소스 프레임워크(ROS 2·Open-RMF·Eclipse BaSyx·Node-RED 등)를 쓰지 않고 이 저장소에서 직접 작성했습니다. 위 1절 라이브러리는 3D 화면·앱 실행·MQTT 전송·Claude API 호출·첨부 파일 읽기에만 쓰이고, 판단·운영 로직(오케스트레이터·에이전트·셀 게이트·명령 센터·VLA·AIOS·CCTV 에이전트·Private 5G)은 모두 직접 작성한 코드입니다. VLA·AIOS 학습은 신경망이 아니라 규칙 기반 정책 탐색이며, 효과는 시뮬레이션에서 측정한 값입니다.

## 7. 유의 사항

- **캠틱종합기술원 로고**: 상징·로고타입의 권리는 캠틱종합기술원에 있습니다. 바닥 표시는 로고타입을 진한 회색으로 바꿨습니다.
- 위 라이브러리는 모두 MIT·BSD-2-Clause·Apache-2.0 라이선스로 상업적 사용이 가능하며, 재배포 시 저작권·라이선스 고지를 함께 포함해야 합니다.
