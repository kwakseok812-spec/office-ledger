# 학교 장부

보직자 운영비와 교내과제 연구비 장부를 한곳에서 보는 설치형 웹앱입니다. 정적 파일(GitHub Pages) + Supabase. 사용자는 1명(비밀번호 하나)입니다.
이 저장소에는 **개인 금액·사용처·참가자 자료가 없습니다**(그런 자료는 `seed_private/` 에만 있고 `.gitignore` 로 올라가지 않습니다).

## 장부 2개

| 장부 | 카드 끝 | 내용 |
|---|---|---|
| 보직자 운영비(`opex`) | 9801 | 월 한도 30만 원 · 총 210만 원 · 2026.8.1~2027.2.28 · 항목 6개. 월 한도 초과는 빨간 표시만, 총액 초과는 확인 창 한 번 |
| 교내과제 연구비(`research`) | 8837 | 과제 1개 · 비목별 예산 · 세부 비목 · 월별 사용/정산일/누적(지급신청) · 월 한도 없음 |

기간·한도·분류(항목·비목)·카드는 코드가 아니라 서버 표 `ex_ledgers` 에서 읽습니다(설정 화면에서 고침). `js/calc.js` 의 `DEFAULTS` 는 서버 연결 전 표시용 기본값이며 SQL `ex_ensure_ledgers()` 와 같은 값입니다.

## 파일 구성

| 위치 | 내용 |
|---|---|
| `index.html`, `css/`, `js/`, `sw.js`, `manifest.webmanifest`, `icons/` | 앱 화면 (빌드 과정 없음) |
| `js/calc.js` | 계산 규칙(월·전체 요약, 연구비 요약, 저장 전 점검, 가져오기 읽기). 화면·서버와 무관한 순수 함수 |
| `js/data.js` | 서버 연결 계층: Supabase 어댑터 / 시험용 메모리 가짜 서버(영수증 스캔 입구 흉내 포함) |
| `js/store.js` | 상태·입력·수정·휴지통·되돌리기·가져오기·오프라인 재전송 |
| `js/ui.js`, `js/demo.js` | 화면 / 서버 없이 눌러 보는 시험 화면(주소 끝에 `?mock=1`, 이 PC에서만 열림, 가짜 데이터) |
| `js/config.js` | **서버 주소와 공개용 키 자리표시자**(비밀 키는 넣지 않음), 앱 이름 |
| `supabase/migrations/` | 표·권한·함수·비밀값 SQL (0001 → 0005). `supabase/ALL_IN_ONE.sql` 은 이것을 이어 붙인 묶음 |
| `supabase/functions/ex-auth/` | 로그인 함수(`index.single.ts` = 편집기에 붙여넣는 단일 파일, `logic.js` = 앱·시험과 공유하는 규칙) |
| `supabase/functions/ex-scan/` | 영수증 스캔 전용 입구(등록·요약만, 삭제·목록 없음) |
| `supabase/admin/` | 칸 초기화·열기, 스캔 키 읽기·교체 SQL(관리자용) |
| `supabase/tests/rls_test.sql` | 분리·권한·규칙·스캔 입구 서버 시험(되돌림 트랜잭션) |
| `contract/scan_ledger_contract.md` | 영수증 스캔 ↔ 장부 등록 계약(준비만, PC 쪽 교체는 아직) |
| `tools/` | `build_sql_bundle.py`(묶음 만들기), `check_sql.py`(SQL 문법 검사), `make_seed.py`(시작 내역 입력 SQL 만들기, 개인 자료는 seed_private 에서만 읽음) |
| `tests/` | 자동 시험 (`node --test tests/*.test.mjs`, `python tests/ui_check.py` 폰 폭 화면) |
| `android/`, `capacitor.config.json`, `.github/workflows/android.yml` | 안드로이드 설치파일(APK) 껍데기(웹 직접 불러오기). 앱 id `kr.officeledger.app` |
| `seed_private/` | **올리지 않음.** 시작 내역 CSV·입력 SQL |

## 서버를 붙일 때 순서 (새 무료 Supabase 프로젝트 기준)

사람이 비밀번호·키를 입력하는 단계가 없습니다. 서버 비밀값(비밀번호를 섞는 값, 영수증 스캔 등록 키)은 SQL 0005 가 DB 안에 스스로 만듭니다.

1. SQL 편집기에 `supabase/ALL_IN_ONE.sql` 전체를 붙여 넣고 실행(경고창이 뜨면 「Run query」). 끝나면 `ex_` 표 7개가 생깁니다.
2. Edge Functions 에 새 함수 `ex-auth`(`supabase/functions/ex-auth/index.single.ts` 붙여넣기)와 `ex-scan`(`.../ex-scan/index.single.ts`)을 만들고 **둘 다 「Verify JWT」 끔**.
3. 프로젝트 주소와 공개용 키를 `js/config.js` 에 넣고 올립니다(서비스 키는 어디에도 넣지 않음).
4. `supabase/tests/rls_test.sql` 을 실행해 「PASS」 확인(롤백되어 흔적이 없음).
5. 사용자 본인이 앱을 열어 **처음 사용 설정**(비밀번호 정하기)을 합니다 → 앱이 장부 2개를 만들어 둡니다.
6. 시작 내역: `python tools/make_seed.py` 로 `seed_private/seed_insert.sql` 을 만들어 SQL 편집기에서 한 번 실행(같은 내역은 다시 넣지 않음), 끝의 확인 조회로 건수·합계를 대조합니다.
7. (영수증 스캔 교체 때) `supabase/admin/show_scan_key.sql` 로 등록 키를 읽어 PC의 OneDrive 밖 파일에 저장합니다.

비밀번호를 잊었을 때: `supabase/admin/reset_slot.sql` → 본인이 준비되면 `open_slot.sql` → 곧바로 새 비밀번호 설정(기록은 그대로).

## 시험

```
node --test tests/*.test.mjs        # 계산·저장 흐름·로그인 함수·스캔 입구·서버 요청 모양 (가짜 서버, 44개)
python tests/ui_check.py            # 폰 폭 390/750 · 밝은/어두운 · 큰 글씨 화면 그림(shots/), 가로 넘침·잘림 검사
python tools/check_sql.py           # SQL 문법 검사(pip install pglast)
```

화면을 바꿔 올릴 때는 `js/config.js` 의 `APP_BUILD` 와 `sw.js` 의 `CACHE` 숫자를 함께 올립니다.
