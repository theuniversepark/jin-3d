# AAS 데이터 스키마 설계 기준

Jin-3D가 만드는 AAS(Asset Administration Shell) 데이터의 스키마와 속성을 무엇을 기준으로 정했는지 정리한 문서입니다.
구현은 `js/aas.js`(AAS 모델·직렬화), `js/aasx.js`(AASX 패키지), `js/datahub.js`(자산·필드 정의)에 있습니다.

기준은 세 층입니다.

1. **IDTA 공식 규격**으로 뼈대(메타모델 · 패키지 · 서브모델 템플릿)를 잡았습니다.
2. **표준 템플릿이 없는 운영 데이터**는 시뮬레이션이 실제로 계산하는 값 중 운영·분석에 쓰이는 것을 골라 자체 서브모델로 만들었습니다.
3. **형식·통신 호환성**(OPC UA · BaSyx · aas-core 검증)으로 다듬었습니다.

표준을 완전히 채운 것은 아니며, 한계는 마지막 절에 적었습니다.

## 1. 뼈대: IDTA 규격

| 기준 | 적용한 내용 |
|---|---|
| **AAS Part 1 메타모델** (v3.1 기본, v3.0 저장 옵션) | 자산마다 AAS 셸 1개 + 서브모델 + 개념 설명(ConceptDescription). 요소는 Property · SubmodelElementCollection · File만 사용 |
| **AAS Part 5 (AASX)** · ISO/IEC 29500-2 (OPC 패키징) | 로봇 AASX에 AAS XML과 보조 파일(정밀 기록 CSV · 영상 링크 `.url` · `video_links.json`)을 aas-suppl 관계로 연결 |
| **IDTA 02006 Digital Nameplate** | `Nameplate` 서브모델: 제조사 · 제품명 · 일련번호 · 제조연도 |
| **IDTA 02003 Technical Data** | `TechnicalData` 서브모델: 설비 종류 · 로봇 축 수·가반하중 · 기준 사이클 등 고정 사양 |
| **IDTA 02008 Time Series Data** | `TimeSeries` 서브모델: Metadata(Record 정의) + InternalSegment(최근 기록) + ExternalSegment(전체 시계열은 CSV 파일로 참조) |

식별자 규칙

- AAS 셸 id: `https://camtic.or.kr/aas/jin3d/<자산 id>`
- 서브모델 id: `https://camtic.or.kr/aas/jin3d/<자산 id>/sm/<서브모델 이름>`
- 자산 id(globalAssetId): `https://camtic.or.kr/aas/jin3d/asset/<자산 id>`
- 메타모델 네임스페이스: v3.1 `https://admin-shell.io/aas/3/1` (기본) · v3.0 `https://admin-shell.io/aas/3/0`

## 2. 자체 서브모델 — 표준 템플릿이 없는 운영 데이터

| 서브모델 | semanticId | 담은 것 |
|---|---|---|
| `OperationalData` | `https://camtic.or.kr/sm/jin3d/OperationalData/1/0` | 지금 값 — 기준 시각 + 자산별 실시간 필드 |
| `TelemetryTimeSeries` | IDTA 02008 구조 재사용 | 로봇을 선택한 뒤 1초 간격 정밀 기록 (관절 · 토크 · 온도 · TCP · 센서) |
| `VideoRecordings` | `https://camtic.or.kr/sm/jin3d/VideoRecordings/1/0` | 카메라별 영상 링크(MP4 · 원본 WebM) · 시각 · 분할 영상 칸 좌표 · 로컬 경로 · AASX 링크 파일 |
| 이벤트 | `https://camtic.or.kr/sm/jin3d/Events/1/0` | 인시던트 · 명령 기록 (데이터 허브 내보내기) |

### 속성을 고른 기준

자산 종류별로 **운영자·AI가 판단에 실제로 쓰는 값**을 시뮬레이션 상태에서 골랐습니다 (`js/datahub.js` `buildAssets`).

| 자산 | 속성 |
|---|---|
| **공장(라인)** | 생산 KPI — UPH · OEE와 가용률·성능·품질 · 양품·불량·유출 ppm · 재공 · 전력·누적 에너지 · 자재·완제품 재고 · 투입 간격 · 현장 인원 |
| **설비·셀** | 상태와 예지정비 판단 근거 — 상태 · 건강도 · 잔여수명 · 10분 고장확률 · 공정능력 Cpk · 이용률 · 사이클 · 처리·불량·고장 누적 · 대기열 · 부품 재고 · 전력. 분류·포장셀은 게이트 판별 결과 |
| **셀 로봇** | 관절값 · TCP 위치(mm) · 그리퍼 · 작업 단계. 양팔 로봇은 오른팔 TCP, AMMR은 부품 파지 · 선반 왕복 · 배터리 |
| **이동 로봇** (AMR · AGV · 지게차 · 휴머노이드 · 사족보행 · 드론) | 위치 · 방향 · 속도 · 작업 · 배터리. 드론은 고도 · 비행 모드 |
| **5G 기지국** | PCI · 대역 · 위치 등 사양 |

### 속성 규칙

- **이름(idShort)**: 영문 PascalCase (예: `RemainingUsefulLife`, `FailureRisk10min`)
- **설명·단위**: 한글 설명과 단위를 description에 `설명 [단위]` 형식으로
- **값 형식(valueType)**: AAS 규격 이름만 사용 — `xs:double` · `xs:int` · `xs:boolean` · `xs:string` · `xs:dateTime` (규격에 없는 형식은 `xs:string`으로)
- **시각**: 모두 공장 기준 시계의 ISO 8601 UTC
- **의미 식별자(semanticId)**: `https://camtic.or.kr/cd/jin3d/<이름>` — 같은 id의 개념 설명(ConceptDescription)을 함께 넣음

## 3. 호환성 기준

- **OPC UA PubSub(Part 14)과 같은 모델**: 같은 자산·필드 정의로 OPC UA JSON 메시지를 만들어 MQTT로 보냅니다. 값 형식은 OPC UA 기본 타입 번호(Built-in Type Id)와 맞췄습니다.
- **검증 도구 통과**: v3.0 파일은 aas-core3.0, v3.1 파일은 Eclipse BaSyx Python SDK 엄격 파싱과 Compliance Tool로 확인했습니다 (`npm test` — `tests/aasbasyx.mjs`). 이 과정에서 `bool` 값 형식 문제와 3.0/3.1 네임스페이스 문제를 찾아 고쳤습니다.
- **파일이 커지지 않게**: AAS 안에는 자산별 최근 60개 기록만 넣고, 전체 시계열은 CSV로, 영상은 링크로 참조합니다.

## 4. 한계

- **Nameplate·TechnicalData는 간소화했습니다.** IDTA 02006 필수 항목 중 일부(제조사 상세 주소·연락처, 제품 URI, 다국어 표기 형식 등)를 넣지 않았고, 값도 시뮬레이션용 가상 값입니다("Jin-3D 가상 자산").
- **운영 필드의 의미 식별자는 자체 정의입니다.** ECLASS나 IEC 공통 데이터 사전(CDD) 식별자, IEC 61360 데이터 사양(정의·단위 코드)을 붙이지 않아, 다른 시스템이 값의 의미를 자동으로 연결하기 어렵습니다.
- **OPC UA 산업 표준 모델을 참고하지 않았습니다.** 로봇·설비용 companion specification(Robotics 40010, Machinery 40001 등)을 따르지 않고 속성 이름과 구조를 직접 정했습니다.

## 5. 현장 연동을 위한 다음 단계 (제안)

1. Nameplate를 **IDTA 02006 전체 항목**으로 채우기
2. 주요 운영 필드(OEE · 건강도 · 관절값 등)에 **ECLASS 또는 IEC CDD 식별자**와 **IEC 61360 데이터 사양** 붙이기
3. 로봇 서브모델을 **OPC UA Robotics 40010** 구조에 맞추기
