-- 운영비 장부 서버 표 (모든 이름이 ex_ 로 시작합니다. 새 Supabase 프로젝트 전용)
-- 적용: 0001 -> 0002 -> 0003 -> 0004 -> 0005 (또는 ALL_IN_ONE.sql 한 번에). SQL Editor 에 붙여 넣어 실행합니다.
-- 이 파일들은 실제 서버에 아직 적용하지 않았습니다.

-- 사용자 칸(1명). 앱(브라우저)은 이 표에 접근할 수 없고, 로그인 함수(ex-auth)만 서비스 키로 읽고 씁니다.
create table if not exists public.ex_auth_state (
  slot         int primary key check (slot = 1),
  user_id      uuid unique,
  state        text not null default 'unset' check (state in ('unset', 'set', 'disabled')),
  failed_count int  not null default 0,
  lock_level   int  not null default 0,
  locked_until timestamptz,
  last_failed_at timestamptz,
  updated_at   timestamptz not null default now()
);

-- 장부 (보직자 운영비 / 교내과제 연구비). 기간·한도·분류 목록은 코드가 아니라 이 표에 둡니다.
-- 처음 로그인한 뒤 앱이 ex_ensure_ledgers() 를 불러 두 장부를 만들어 둡니다(이미 있으면 그대로).
create table if not exists public.ex_ledgers (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete restrict,
  code         text not null check (code in ('opex', 'research')),
  name         text not null check (char_length(btrim(name)) between 1 and 30),
  card_last4   text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),   -- 영수증 스캔이 카드 끝 4자리로 장부를 고름
  status       text not null default 'active' check (status in ('active', 'soon')),   -- soon = 준비 중(입력 막음)
  period_start date   not null,
  period_end   date   not null,
  monthly_limit bigint check (monthly_limit is null or monthly_limit between 0 and 999999999),
  total_budget  bigint check (total_budget is null or total_budget between 0 and 999999999),
  categories   jsonb  not null,        -- 분류(항목) 목록 ["식비", ...]
  subitems     jsonb,                  -- 연구비: 대분류별 세부 비목 {"연구활동비": ["회의비", ...]}
  budgets      jsonb,                  -- 연구비: 비목(대분류)별 예산 {"연구재료비": 0, ...}
  project      jsonb,                  -- 연구비: 과제 정보 {"name": "", "institution": "", "kinds": [...], "pay_methods": [...]}
  sort         int    not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, code),
  unique (id, user_id),
  check (period_end >= period_start)
);

-- 사용자 전체 설정 (한 줄): 영수증 보관 삭제일, 영수증 스캔 하루 상한
create table if not exists public.ex_settings (
  user_id      uuid primary key default auth.uid() references auth.users (id) on delete restrict,
  receipt_purge_md text not null default '03-01' check (receipt_purge_md ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  scan_daily_max_count  int    not null default 20 check (scan_daily_max_count between 1 and 200),
  scan_daily_max_amount bigint not null default 1000000 check (scan_daily_max_amount between 1 and 100000000),
  updated_at   timestamptz not null default now()
);

-- 지출 한 건 (월 정산서의 한 줄: 사용일자·정산일자·구분·적요·금액·참가자·인원)
create table if not exists public.ex_tx (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete restrict,
  ledger_id   uuid not null,                                   -- 어느 장부의 지출인가
  tx_date     date not null,                                   -- 사용일자(한국 날짜)
  settle_date date,                                            -- 정산일자(비우면 사용일자로 채움)
  category    text not null default '식비' check (char_length(category) between 1 and 30),   -- 분류(항목): 장부의 categories 안에 있어야 함(트리거가 확인)
  sub_item    text check (sub_item is null or char_length(sub_item) between 1 and 40),     -- 연구비 세부 비목(운영비는 비움)
  meal        text check (meal is null or char_length(meal) between 1 and 10),   -- 구분(중식/석식 등)
  summary     text not null check (char_length(btrim(summary)) between 1 and 60), -- 적요(사용처·내용)
  amount      bigint not null check (amount > 0 and amount <= 99999999),
  pay_method  text check (pay_method is null or char_length(pay_method) between 1 and 20),   -- 결제수단(연구비: 법인카드 등)
  proof_no    text check (proof_no is null or char_length(proof_no) between 1 and 20),       -- 증빙번호(연구비)
  vendor      text check (vendor is null or char_length(vendor) between 1 and 40),           -- 사용처(비워둘 수 있음)
  attendees   text check (attendees is null or char_length(attendees) <= 120),    -- 참가자 (예: "OOO 외 N명")
  headcount   int check (headcount is null or headcount between 1 and 999),       -- 인원
  source      text not null default 'manual' check (source in ('manual', 'scan', 'import')),
  scan_id     text check (scan_id is null or scan_id ~ '^[0-9a-f]{8}$'),         -- 영수증 스캔 행 번호(같은 요청 두 번 와도 한 건)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,                                      -- 휴지통(30일 뒤 ex_purge_mine 이 영구 삭제)
  foreign key (ledger_id, user_id) references public.ex_ledgers (id, user_id) on delete restrict
);
create unique index if not exists ex_tx_scan_once on public.ex_tx (user_id, scan_id) where scan_id is not null;
create index if not exists ex_tx_user_date on public.ex_tx (user_id, ledger_id, tx_date);

-- 변경 이력 (화면의 「이전 값」)
create table if not exists public.ex_history (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null,
  entity_id uuid not null,
  action    text not null check (action in ('create', 'update')),
  old       jsonb,
  new       jsonb,
  at        timestamptz not null default now()
);
create index if not exists ex_history_lookup on public.ex_history (user_id, entity_id, at desc);

-- 영수증 스캔 등록 키 시도 횟수 (잘못된 키를 계속 시도하면 잠금)
create table if not exists public.ex_scan_state (
  id int primary key check (id = 1),
  fails int not null default 0,
  locked_until timestamptz
);
insert into public.ex_scan_state (id) values (1) on conflict (id) do nothing;
