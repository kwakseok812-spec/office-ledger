# 영수증 스캔 ↔ 학교 장부 등록 계약 (v1, 준비만 — PC 쪽 교체는 아직 하지 않음)

이 문서는 영수증 스캔(PC `scan_register.py`)이 학교 장부에 **서버 함수로 직접** 등록할 때의 약속입니다.
옛 방식(러버블 커넥터 `mcp__claude_ai_7__*` = 운영비, `mcp__claude_ai_2__*` = 연구비)은 이 계약으로 대체됩니다.
교체(PC 코드 수정·스마트비서 새 버전 배포)는 서버 준비와 시작 내역 입력이 끝난 **같은 날**, 사용자 확인 뒤에 순서대로 합니다.

## 1. 장부 고르기 (카드 끝 4자리 → 장부)

| 카드 끝 4자리 | 장부 코드 | 이름 | 상태 |
|---|---|---|---|
| (운영비 카드 끝 4자리, 서버 장부 설정값) | `opex` | 보직자 운영비 | 사용 중 |
| (연구비 카드 끝 4자리, 서버 장부 설정값) | `research` | 교내과제 연구비 | 사용 중 |

카드 번호 자체는 이 저장소에 적지 않습니다. 실제 값은 서버 `ex_ledgers.card_last4`(처음에는 비어 있음 → 설정 화면 또는 시작 내역 입력 파일로 채움)와 PC 쪽 `scan_receipt.CARD_MAP` 에만 있습니다.

* 요청에는 `card_last4`(위 표) 또는 `ledger`(`opex`/`research`) 중 하나를 넣습니다. 둘 다 없거나 모르는 값이면 `no_ledger` 로 거절됩니다.
* 장부 상태가 「준비 중」(`soon`)이면 `ledger_not_ready`(409) 로 **등록을 거절**합니다. (지금은 두 장부 모두 사용 중)
* 카드·장부 대응은 서버 표 `ex_ledgers`(`card_last4`)에 있고, 앱 설정에서 바꾸면 이 표가 기준이 됩니다. `scan_receipt.CARD_MAP` 은 같은 값으로 맞춥니다(같은 값 두 곳 규칙).

## 2. 호출 (PC → 서버)

`POST {프로젝트 주소}/functions/v1/ex-scan`, 본문 JSON. **등록 키**(`key`)는 서버가 만든 값이며 PC의 OneDrive 밖 파일에만 둡니다(저장소·보고·로그에 쓰지 않음, 읽는 법은 `supabase/admin/show_scan_key.sql`, 바꾸는 법은 `rotate_scan_key.sql`).

| action | 보내는 값 | 응답 |
|---|---|---|
| `register` | `key`, `card_last4` 또는 `ledger`, `date`(YYYY-MM-DD), `amount`(정수 1~99,999,999), `summary`(적요, 20자 이내), `category`(항목/비목), `scan_id`(행 id 앞 8자리 소문자 16진), `sub_item`(연구비 세부 비목, 선택) | `{id, duplicate, tx_date, amount, summary:{ledger, month_used, monthly_limit, total_used, total_budget, total_remaining, day_count, day_sum}}` |
| `summary` | `key`, `card_last4` 또는 `ledger`, `date`(선택) | 위 `summary` 객체 (읽기만, 목록·참가자 등은 내보내지 않음) |

* 삭제·수정·목록 읽기 동작은 **없습니다**(`bad_action`). 잘못 들어간 건은 사람이 앱 화면에서 지웁니다(휴지통 30일).
* 같은 `scan_id` 로 다시 보내면 새로 만들지 않고 `duplicate:true` 로 그 건을 돌려줍니다(재시도 안전). 지운 건이면 `deleted:true`.
* 등록 직후 `summary.day_count`·`day_sum` 으로 「그 날짜에 정확히 한 건이 늘었는지」를 확인합니다. (지금 PC가 하는 읽기-등록-읽기 3번 호출을 1번으로 대체)

## 3. 필드 규칙

| 필드 | 운영비(`opex`) | 연구비(`research`) |
|---|---|---|
| `summary`(적요) | 사용처. 한글·영문·숫자·공백·`-` `·` `&` `(` `)` 만, 20자 이내, 지시문 낱말 불가 | 세부내역(예: 회의비). 같은 규칙 |
| `category` | 식비·교통비·회의비·물품구매·사무용품·기타 (기본 식비). **장부의 목록 안에서만**(서버가 확인) | 연구활동비·연구수당·학생인건비·시설장비비·재료비·위탁연구개발비·간접비 (기본 연구활동비) |
| `sub_item` | 쓰지 않음 | 연구활동비의 세부 비목(회의비 등), 그 비목 목록 안에서만 |
| 서버가 채우는 값 | `source='scan'`, 정산일자=사용일자 | 위 + 결제수단=법인카드 |
| 기간 | 장부 설정의 기간(운영비 기본 2026-08-01~2027-02-28) 안, 오늘 이후 불가 | 장부 설정의 연구 기간 안 |

지시문 낱말(공백 제거·소문자 비교로 하나라도 들어 있으면 거절): 호출, 도구, call, tool, ignore, 무시, 지시, instruction, system, 프롬프트, prompt, 명령, 재시도, 두번, twice, delete, 삭제, export, 내보내, 실행 — `scan_contract_v921.md` §1 과 같은 목록이며 서버 함수·앱 코드(`INSTR_WORDS`)가 같은 값을 갖는지 시험이 확인합니다.

## 4. 안전 장치

* **등록 키 확인**: 틀린 키를 10번 보내면 15분 동안 잠깁니다(맞는 키도 거절). 서버 표 `ex_scan_state`.
* **하루 상한**: 스캔 등록은 하루(한국 시간) 건수 20건·금액 1,000,000원이 기본이며 앱 설정(`ex_settings`)에서 바꿉니다. 넘으면 `daily_limit`(429).
* 서버 오류 문장은 코드(`error`)와 짧은 한글 안내(`message`)만 돌려주고 서버 내부 문구는 내보내지 않습니다.

## 5. 오류 코드

| HTTP | error | 뜻 | PC 동작(교체 때) |
|---|---|---|---|
| 401 | `bad_key` | 등록 키가 다름 | 등록 중단·사용자에게 알림 |
| 429 | `locked` | 키 잠금 중 | 15분 뒤 사람이 확인 |
| 429 | `daily_limit` | 하루 상한 초과 | 앱 카드에 「오늘 등록 상한」 안내, 사람이 설정 확인 |
| 400 | `no_ledger` · `bad_category` · `bad_amount` · `bad_date` · `bad_summary` · `bad_scan_id` · `bad_sub_item` · `out_of_period` · `future_date` | 입력 문제 | 앱 카드에서 고치게 함(`validate_selection` 과 같은 사유 문장) |
| 400 | `not_ready` | 사용자가 아직 처음 사용 설정을 안 함 | 중단 |
| 409 | `ledger_not_ready` | 장부가 준비 중 | 등록 거절 안내 |
| 500 | `server` | 서버 문제 | **자동 재시도하지 않고** `summary` 로 확인(같은 `scan_id` 는 어차피 한 건) |

## 6. 바꿔야 할 곳 (교체 때 — 이번에는 만들지 않음)

| 파일 | 바꿀 것 |
|---|---|
| `voice-memo-collector\scan_register.py` | 운영비·연구비 읽기/등록/검증을 위 호출로 교체(`READ_TOOLS`, `ADD_TOOL`, `tool_name`, `_read_check`, `_verify_added`, `build_*_prompt`, `make_claude_runner` 중 운영/연구 경로). `register_backend` 스위치(`mcp`/`direct`)를 둠 |
| `scan_switch.json` | `connector_ids` 대신 서버 주소(공개)·키 파일 경로(비밀 아님: 경로만), `budgets` 는 서버 장부 값으로 대체 |
| `scan_contract_v921.md`, `scan_selftest.py` | 항목 규칙(운영비 6개, 연구비 7개+세부)·기간·장부 대응을 이 문서와 맞추고 시험이 글자 단위로 대조 |
| `scan_receipt.py` | `CARD_MAP`, 연구비 비목 상수(`RESEARCH_CATEGORIES/SUBITEMS`)를 새 비목 목록으로 |
| 스마트비서 `app.js` | 항목 칩(운영비 6개 / 연구비 비목·세부), 기간 `SCAN_OPEX`, 결과 문장(「학교 장부 · 운영비/연구비」) |
| `scan_purge.py` | 영수증 원본 삭제일을 서버 설정 `receipt_purge_md`(기본 03-01) 기준으로(앱 설정에서 바꿀 수 있음) |
| 11시 앱 현황 보고(`daily-apps-status-report`) | 운영비·연구비 줄을 `summary` 호출 결과로 |

**복귀는 사실상 불가능합니다**: 옛 러버블 커넥터와 서버는 현재 끊겨 있어 `mcp` 로 되돌려도 등록되지 않습니다. 실제 되돌리는 길은 (a) 서버 함수를 잠시 끄고 스캔 카드의 [입력 내용 복사]로 앱에 직접 입력, (b) PC 스캔 코드를 백업(`*.before-<번호>-<날짜>`)으로 되돌려 스캔 등록을 멈추는 것입니다. 전환 직후 며칠은 스캔 등록 결과를 건마다 앱 화면에서 확인합니다.

## 7. 허브·이름

* 앱 이름은 「학교 장부」(화면 제목·설치 이름·홈 화면 아이콘 이름). 허브(office-hub) 카드 「보직자 운영비」·「연구비 관리」 두 장을 「학교 장부」 한 장으로 합칩니다(허브 목록은 암호화본이므로 재생성하고 `sw.js` 캐시 이름을 올립니다).
* 새 주소는 저장소를 올린 뒤 `https://<계정>.github.io/office-ledger/` 형태가 됩니다(저장소 이름은 올릴 때 확정).
