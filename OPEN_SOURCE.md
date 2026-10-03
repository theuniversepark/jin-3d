# 오픈소스 고지 (Open Source Notices)

Jin-3D(메타팩토리 정밀조립Zone 디지털트윈)를 만들고 배포하는 데 사용한 오픈소스 라이브러리, 개발 도구, 외부 사이트·서비스, 참고 표준을 정리합니다. 버전·라이선스는 프로젝트에 설치된 각 패키지의 `package.json` 기준입니다.

## 1. 오픈소스 라이브러리 (앱에 포함되어 동작)

| 이름 | 버전 | 라이선스 | 출처 | 쓰인 곳 |
|---|---|---|---|---|
| three.js | 0.186.1 | MIT | https://github.com/mrdoob/three.js | 3D 렌더링 전체 (`vendor/three`) |
| └ OrbitControls · CSS2DRenderer · EffectComposer · RenderPass · UnrealBloomPass · OutputPass | (three.js `examples/jsm`) | MIT | 같은 저장소 | 시점 조작, 라벨, 발광·후처리 |
| └ WebGLRenderTarget · readRenderTargetPixels | (three.js 코어) | MIT | 같은 저장소 | 로봇 카메라 영상(관제 디스플레이 8분할, 로봇 정보 창 실시간 영상) |
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
| aas-core3.0 (Python) | MIT | https://github.com/aas-core-works/aas-core3.0-python | 내보낸 AAS JSON·XML 표준 적합성 검증 |
| Node.js · npm | MIT 등 | https://nodejs.org | 서버 실행, 시뮬레이션 자동 시험(`npm test`) |
| Python 3 | PSF | https://python.org | 개발 보조 스크립트, AAS 검증 |
| Git · GitHub CLI | GPL-2.0 · MIT | https://git-scm.com · https://cli.github.com | 형상 관리, 저장소·배포 상태 확인 |
| macOS codesign | Apple 기본 도구 | — | Mac 앱 서명 (ad-hoc) |

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

- AAS 데이터 안의 `https://admin-shell.io/...`, `https://camtic.or.kr/aas/jin3d/...` 등은 의미 식별자(semanticId·id)이며 실행 중 접속하지 않습니다.
- 폰트는 외부에서 받지 않고 운영체제 기본 폰트(Apple SD Gothic Neo, 대체 Noto Sans KR·맑은 고딕)를 씁니다.

## 4. 참고·준수한 표준 (규격 문서 — 구현 코드는 직접 작성)

| 표준 | 쓰인 곳 |
|---|---|
| IDTA Asset Administration Shell Part 1 v3.0 (메타모델) | 설비·로봇 자산 모델 (JSON·XML·RDF) |
| IDTA AAS Part 5 (AASX 패키지) · ISO/IEC 29500-2 (OPC 패키징) | 로봇별 누적 데이터 `.aasx` |
| IDTA 02008 Time Series Data | 시계열 서브모델 (InternalSegment·ExternalSegment) |
| IDTA 02006 Digital Nameplate (ZVEI 2.0) · IDTA 02003 Technical Data (ZVEI 1.2) | 명판·기술 데이터 서브모델 |
| OPC UA Part 14 PubSub (JSON 메시지 매핑) | 데이터·메타데이터·이벤트·명령 메시지 |
| MQTT 3.1.1 | 메시지 전송 |
| AutomationML / CAEX 3.0 (IEC 62714) | `.aml` 내보내기 |
| W3C RDF 1.1 Turtle | `.ttl` 내보내기 |
| IEC 60204-1 (정지 카테고리 0·2) · ISO/TS 15066 (협동 로봇 속도 제한) | 비상정지·보호정지·안전 감속 명령 정의 |

## 5. 직접 작성한 부분

시뮬레이션 엔진, 운영 에이전트, 오케스트레이터, 상위 명령·지시 게이트, 대화 기반 해석기, 출하·트럭·드론, 설비 현황판, VLA 조립 동작(역기구학), VLA 에피소드 기록·zip 데이터셋·학습·배포 파이프라인, 로봇 카메라 영상(렌더 타깃), AAS·AASX·OPC UA 메시지 생성기, 3D 모델(설비·로봇·트럭·드론 등), 화면 UI는 이 저장소에서 직접 작성했습니다. 외부 3D 모델 파일이나 외부 이미지는 위 로고 외에는 쓰지 않습니다.

## 6. 유의 사항

- **캠틱 로고**: 이미지의 권리는 캠틱종합기술원에 있습니다. 공개 저장소·웹 버전에서의 사용 허락 여부를 확인하십시오.
- 위 라이브러리는 모두 MIT·BSD-2-Clause·Apache-2.0 라이선스로 상업적 사용이 가능하며, 재배포 시 저작권·라이선스 고지를 함께 포함해야 합니다.
