-- 학교 장부 서버 준비 묶음 (0001~0005를 순서대로 이어 붙인 것). 새 Supabase 프로젝트의 SQL 편집기에 통째로 붙여 넣고 한 번 실행합니다.
-- 여러 번 실행해도 안전합니다(이미 있는 표·값은 그대로 둠, 비밀값은 덮어쓰지 않음).
-- 편집기가 「Potential issue detected」 경고를 띄우면 [Run query] 를 눌러야 실행됩니다(함수 안의 delete 문 때문).

-- ============================================================
-- 0001_schema.sql
-- ============================================================
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

-- ============================================================
-- 0002_triggers.sql
-- ============================================================
-- 쓰기 전 점검(시각·날짜·소유자·기간 보호)과 이력 기록

create or replace function public.ex_before_write() returns trigger
language plpgsql set search_path = public as $$
declare
  led ex_ledgers%rowtype;
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;      -- 만든 시각·주인·출처는 바꿀 수 없음
    new.user_id    := old.user_id;
    new.ledger_id  := old.ledger_id;       -- 어느 장부인지는 바꿀 수 없음
    new.source     := old.source;
    new.scan_id    := old.scan_id;
  end if;
  new.summary   := btrim(new.summary);
  new.attendees := nullif(btrim(coalesce(new.attendees, '')), '');
  new.meal      := nullif(btrim(coalesce(new.meal, '')), '');
  new.sub_item  := nullif(btrim(coalesce(new.sub_item, '')), '');
  new.pay_method := nullif(btrim(coalesce(new.pay_method, '')), '');
  new.proof_no  := nullif(btrim(coalesce(new.proof_no, '')), '');
  new.vendor    := nullif(btrim(coalesce(new.vendor, '')), '');
  if new.settle_date is null then new.settle_date := new.tx_date; end if;
  -- 지우지 않는 기록만: 준비 중 장부 금지, 앞으로 올 날짜 금지(한국 날짜), 장부 기간 밖 금지, 분류는 장부 목록 안에서
  if new.deleted_at is null then
    select * into led from public.ex_ledgers where id = new.ledger_id and user_id = new.user_id;
    if not found then raise exception 'no ledger' using errcode = '23503'; end if;
    if led.status <> 'active' then raise exception 'ledger not ready' using errcode = '22023'; end if;
    if new.tx_date > (now() at time zone 'Asia/Seoul')::date then
      raise exception 'future date' using errcode = '22008';
    end if;
    if new.tx_date < led.period_start or new.tx_date > led.period_end then
      raise exception 'out of period' using errcode = '22008';
    end if;
    if not (led.categories ? new.category) then
      raise exception 'bad category' using errcode = '22023';
    end if;
    if new.sub_item is not null and not (coalesce(led.subitems -> new.category, '[]'::jsonb) ? new.sub_item) then
      raise exception 'bad sub item' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists ex_tx_before on public.ex_tx;
create trigger ex_tx_before before insert or update on public.ex_tx for each row execute function public.ex_before_write();

create or replace function public.ex_ledgers_before() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.user_id := old.user_id; new.code := old.code; new.card_last4 := old.card_last4; new.created_at := old.created_at; end if;
  return new;
end $$;
drop trigger if exists ex_ledgers_before on public.ex_ledgers;
create trigger ex_ledgers_before before insert or update on public.ex_ledgers for each row execute function public.ex_ledgers_before();

create or replace function public.ex_settings_before() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.user_id := old.user_id; end if;
  return new;
end $$;
drop trigger if exists ex_settings_before on public.ex_settings;
create trigger ex_settings_before before insert or update on public.ex_settings for each row execute function public.ex_settings_before();

create or replace function public.ex_log_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare o jsonb; n jsonb;
begin
  n := jsonb_build_object('tx_date', new.tx_date, 'settle_date', new.settle_date, 'category', new.category, 'sub_item', new.sub_item, 'meal', new.meal, 'pay_method', new.pay_method, 'proof_no', new.proof_no, 'vendor', new.vendor,
        'summary', new.summary, 'amount', new.amount, 'attendees', new.attendees, 'headcount', new.headcount, 'deleted_at', new.deleted_at);
  if tg_op = 'UPDATE' then
    o := jsonb_build_object('tx_date', old.tx_date, 'settle_date', old.settle_date, 'category', old.category, 'sub_item', old.sub_item, 'meal', old.meal, 'pay_method', old.pay_method, 'proof_no', old.proof_no, 'vendor', old.vendor,
        'summary', old.summary, 'amount', old.amount, 'attendees', old.attendees, 'headcount', old.headcount, 'deleted_at', old.deleted_at);
    if o = n then return null; end if;
  end if;
  insert into public.ex_history (user_id, entity_id, action, old, new)
  values (new.user_id, new.id, case when tg_op = 'INSERT' then 'create' else 'update' end, o, n);
  return null;
end $$;
drop trigger if exists ex_tx_hist on public.ex_tx;
create trigger ex_tx_hist after insert or update on public.ex_tx for each row execute function public.ex_log_history();

-- ============================================================
-- 0003_rls.sql
-- ============================================================
-- 행 단위 보안: 로그인한 사람은 자기 행만 읽고 쓴다. 삭제 권한은 아무에게도 주지 않는다(휴지통은 deleted_at).
-- 참가자 칸에는 다른 사람의 이름이 들어가므로 본인 외에는 읽을 수 없게 하는 것이 핵심입니다.

alter table public.ex_auth_state enable row level security;   -- 정책 없음 = 앱에서는 접근 불가
alter table public.ex_ledgers    enable row level security;
alter table public.ex_settings   enable row level security;
alter table public.ex_tx         enable row level security;
alter table public.ex_history    enable row level security;
alter table public.ex_scan_state enable row level security;   -- 정책 없음

revoke all on public.ex_auth_state, public.ex_ledgers, public.ex_settings, public.ex_tx, public.ex_history, public.ex_scan_state from anon, authenticated;
grant select, insert, update on public.ex_settings, public.ex_tx to authenticated;
grant select, update on public.ex_ledgers to authenticated;   -- 장부는 ex_ensure_ledgers() 로만 만든다
grant select on public.ex_history to authenticated;
grant all on public.ex_auth_state, public.ex_ledgers, public.ex_settings, public.ex_tx, public.ex_history, public.ex_scan_state to service_role;

drop policy if exists ex_ledgers_select on public.ex_ledgers;
drop policy if exists ex_ledgers_update on public.ex_ledgers;
create policy ex_ledgers_select on public.ex_ledgers for select to authenticated using (user_id = (select auth.uid()));
create policy ex_ledgers_update on public.ex_ledgers for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists ex_settings_select on public.ex_settings;
drop policy if exists ex_settings_insert on public.ex_settings;
drop policy if exists ex_settings_update on public.ex_settings;
create policy ex_settings_select on public.ex_settings for select to authenticated using (user_id = (select auth.uid()));
create policy ex_settings_insert on public.ex_settings for insert to authenticated with check (user_id = (select auth.uid()));
create policy ex_settings_update on public.ex_settings for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists ex_tx_select on public.ex_tx;
drop policy if exists ex_tx_insert on public.ex_tx;
drop policy if exists ex_tx_update on public.ex_tx;
create policy ex_tx_select on public.ex_tx for select to authenticated using (user_id = (select auth.uid()));
create policy ex_tx_insert on public.ex_tx for insert to authenticated with check (user_id = (select auth.uid()));
create policy ex_tx_update on public.ex_tx for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists ex_history_select on public.ex_history;
create policy ex_history_select on public.ex_history for select to authenticated using (user_id = (select auth.uid()));

-- ============================================================
-- 0004_functions.sql
-- ============================================================
-- 서버 함수. 앱이 부르는 것(authenticated 전용), 로그인 함수만 부르는 것(service_role 전용), 영수증 스캔 함수(service_role 전용)로 나뉩니다.

create extension if not exists pgcrypto with schema extensions;

-- 1) 방금 만든 것 취소(되돌리기): 만든 지 5분 안의 본인 행만 지움.
create or replace function public.ex_undo_create(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n int;
begin
  if uid is null then raise exception 'not logged in' using errcode = '42501'; end if;
  if not exists (select 1 from ex_tx where id = p_id and user_id = uid) then return; end if;
  delete from ex_tx where id = p_id and user_id = uid and created_at > now() - interval '5 minutes';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'too old' using errcode = '42501'; end if;
  delete from ex_history where user_id = uid and entity_id = p_id;
end $$;

-- 2) 휴지통 30일이 지난 본인 행을 영구 삭제 (앱을 열 때마다 앱이 부름)
create or replace function public.ex_purge_mine() returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); cutoff timestamptz := now() - interval '30 days';
begin
  if uid is null then raise exception 'not logged in' using errcode = '42501'; end if;
  delete from ex_history h using ex_tx t
   where h.user_id = uid and h.entity_id = t.id and t.user_id = uid and t.deleted_at is not null and t.deleted_at <= cutoff;
  delete from ex_tx where user_id = uid and deleted_at is not null and deleted_at <= cutoff;
end $$;

-- 3) 로그인 함수(ex-auth) 전용: 틀린 횟수와 잠금
create or replace function public.ex_lock_minutes(p_level int) returns int
language sql immutable as $$
  select case when p_level <= 1 then 15 else 60 end
$$;   -- supabase/functions/ex-auth/logic.js 의 lockMinutes 와 같아야 함

create or replace function public.ex_auth_fail(p_slot int)
returns table (allowed boolean, just_locked boolean, remaining int, until_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare s ex_auth_state%rowtype;
begin
  select * into s from ex_auth_state where slot = p_slot for update;
  if not found then raise exception 'no slot'; end if;
  allowed := true; just_locked := false; remaining := 0; until_at := s.locked_until;
  if s.locked_until is not null and s.locked_until > now() then
    allowed := false;
    return next; return;
  end if;
  if s.last_failed_at is not null and now() - s.last_failed_at >= interval '24 hours' then
    s.failed_count := 0; s.lock_level := 0;
  end if;
  s.failed_count := s.failed_count + 1;
  if s.failed_count >= 5 then
    s.lock_level := least(s.lock_level + 1, 2);
    s.locked_until := now() + make_interval(mins => public.ex_lock_minutes(s.lock_level));
    s.failed_count := 0;
    just_locked := true;
  end if;
  update ex_auth_state
     set failed_count = s.failed_count, lock_level = s.lock_level, locked_until = s.locked_until,
         last_failed_at = now(), updated_at = now()
   where slot = p_slot;
  remaining := case when just_locked then 0 else 5 - s.failed_count end;
  until_at := s.locked_until;
  return next;
end $$;

create or replace function public.ex_auth_ok(p_slot int) returns void
language sql security definer set search_path = public as $$
  update ex_auth_state set failed_count = 0, lock_level = 0, locked_until = null, last_failed_at = null, updated_at = now() where slot = p_slot;
$$;

create or replace function public.ex_auth_claim(p_slot int)
returns table (claimed boolean, user_id uuid)
language plpgsql security definer set search_path = public as $$
declare u uuid; n int;
begin
  update ex_auth_state set state = 'set', updated_at = now()
   where slot = p_slot and state = 'unset'
   returning ex_auth_state.user_id into u;
  get diagnostics n = row_count;
  claimed := n > 0;
  user_id := u;
  return next;
end $$;

create or replace function public.ex_auth_set_user(p_slot int, p_user uuid) returns void
language sql security definer set search_path = public as $$
  update ex_auth_state set user_id = p_user, updated_at = now() where slot = p_slot and user_id is null;
$$;

create or replace function public.ex_auth_unclaim(p_slot int) returns void
language sql security definer set search_path = public as $$
  update ex_auth_state set state = 'unset', updated_at = now() where slot = p_slot;
$$;

create or replace function public.ex_revoke_sessions(p_user uuid) returns void
language sql security definer set search_path = public, auth as $$
  delete from auth.sessions where user_id = p_user;
$$;

-- 4) 장부 만들기: 앱이 로그인 뒤 한 번 부름. 두 장부(보직자 운영비 / 교내과제 연구비)가 없으면 만들고, 있으면 그대로 둠.
create or replace function public.ex_ensure_ledgers() returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not logged in' using errcode = '42501'; end if;
  insert into ex_ledgers (user_id, code, name, card_last4, status, period_start, period_end, monthly_limit, total_budget, categories, sort)
  values (uid, 'opex', '보직자 운영비', '9801', 'active', date '2026-08-01', date '2027-02-28', 300000, 2100000,
          '["식비","교통비","회의비","물품구매","사무용품","기타"]'::jsonb, 1)
  on conflict (user_id, code) do nothing;
  -- 연구비 장부: 비목·세부 비목·구분·결제수단 목록만 넣어 둔다. 과제명·총액·비목별 예산은 개인 자료이므로
  -- 이 파일에 쓰지 않고 앱의 「연구 설정」 화면 또는 seed_private 의 입력 파일로 채운다(비워 둬도 입력은 된다).
  insert into ex_ledgers (user_id, code, name, card_last4, status, period_start, period_end, monthly_limit, total_budget, categories, subitems, budgets, project, sort)
  values (uid, 'research', '교내과제 연구비', '8837', 'active', date '2026-06-01', date '2027-02-28', null, null,
          '["연구활동비","연구수당","학생인건비","시설장비비","재료비","위탁연구개발비","간접비"]'::jsonb,
          '{"연구활동비":["회의비","국외 출장 여비","수용비 및 수수료","기술정보활동비(전문가활용비)","조사연구비","연구홍보비","국내 출장 여비 및 시내교통비","연구환경유지비","야근(특근) 식대"]}'::jsonb,
          '{"연구활동비":0,"연구수당":0,"학생인건비":0,"시설장비비":0,"재료비":0,"위탁연구개발비":0,"간접비":0}'::jsonb,
          '{"name":"","institution":"","kinds":["직접비","간접비"],"pay_methods":["법인카드","개인카드","계좌이체","현금"]}'::jsonb, 2)
  on conflict (user_id, code) do nothing;
end $$;

-- 5) 영수증 스캔 전용 (ex-scan 함수만 서비스 권한으로 부름)
-- 키 확인: 틀리면 횟수를 올리고 10번 틀리면 15분 잠금. 반환 'ok' | 'bad' | 'locked'
create or replace function public.ex_scan_check_key(p_key text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare s ex_scan_state%rowtype; good text;
begin
  select * into s from ex_scan_state where id = 1 for update;
  if s.locked_until is not null and s.locked_until > now() then return 'locked'; end if;
  select value into good from ex_secret where name = 'scan_key';
  if good is not null and p_key is not null and length(p_key) >= 32
     and encode(digest(p_key, 'sha256'), 'hex') = encode(digest(good, 'sha256'), 'hex') then
    update ex_scan_state set fails = 0, locked_until = null where id = 1;
    return 'ok';
  end if;
  if s.fails + 1 >= 10 then
    update ex_scan_state set fails = 0, locked_until = now() + interval '15 minutes' where id = 1;
  else
    update ex_scan_state set fails = s.fails + 1 where id = 1;
  end if;
  return 'bad';
end $$;

-- 장부 고르기: 장부 코드(opex/research) 또는 카드 끝 4자리. 없으면 no_ledger, 준비 중이면 ledger_not_ready
create or replace function public.ex_scan_pick_ledger(p_uid uuid, p_ledger text, p_card text) returns ex_ledgers
language plpgsql security definer set search_path = public as $$
declare led ex_ledgers%rowtype;
begin
  if p_ledger is not null and p_ledger <> '' then
    select * into led from ex_ledgers where user_id = p_uid and code = p_ledger;
  elsif p_card is not null and p_card <> '' then
    select * into led from ex_ledgers where user_id = p_uid and card_last4 = p_card;
  else
    raise exception 'no_ledger';
  end if;
  if not found then raise exception 'no_ledger'; end if;
  if led.status <> 'active' then raise exception 'ledger_not_ready'; end if;
  return led;
end $$;

-- 그날·그달·전체 숫자 (지운 것 제외, 장부 기간 안의 것만)
create or replace function public.ex_scan_summary_for(p_uid uuid, p_ledger uuid, p_date date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare led ex_ledgers%rowtype; mu bigint; tu bigint; dc int; ds bigint;
begin
  select * into led from ex_ledgers where id = p_ledger and user_id = p_uid;
  select coalesce(sum(amount), 0) into tu from ex_tx where user_id = p_uid and ledger_id = p_ledger and deleted_at is null and tx_date between led.period_start and led.period_end;
  select coalesce(sum(amount), 0) into mu from ex_tx where user_id = p_uid and ledger_id = p_ledger and deleted_at is null and tx_date between led.period_start and led.period_end
     and to_char(tx_date, 'YYYY-MM') = to_char(p_date, 'YYYY-MM');
  select count(*), coalesce(sum(amount), 0) into dc, ds from ex_tx where user_id = p_uid and ledger_id = p_ledger and deleted_at is null and tx_date = p_date;
  return jsonb_build_object('ledger', led.code, 'date', p_date, 'month', to_char(p_date, 'YYYY-MM'), 'month_used', mu, 'monthly_limit', led.monthly_limit,
    'total_used', tu, 'total_budget', led.total_budget, 'total_remaining', led.total_budget - tu, 'day_count', dc, 'day_sum', ds);
end $$;

create or replace function public.ex_scan_summary(p_ledger text, p_card text, p_date date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; led ex_ledgers%rowtype;
begin
  select user_id into uid from ex_auth_state where slot = 1;
  if uid is null then raise exception 'not_ready'; end if;
  led := public.ex_scan_pick_ledger(uid, p_ledger, p_card);
  return public.ex_scan_summary_for(uid, led.id, coalesce(p_date, (now() at time zone 'Asia/Seoul')::date));
end $$;

-- 등록: 같은 scan_id 가 이미 있으면 새로 만들지 않고 그 건을 돌려줌(duplicate=true). 하루 건수·금액 상한을 서버가 강제.
create or replace function public.ex_scan_register(p_ledger text, p_card text, p_date date, p_amount bigint, p_summary text, p_category text, p_scan_id text, p_sub_item text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid; led ex_ledgers%rowtype; st ex_settings%rowtype; maxc int := 20; maxa bigint := 1000000;
  r ex_tx%rowtype; day_start timestamptz; c int; a bigint; new_id uuid;
begin
  select user_id into uid from ex_auth_state where slot = 1;
  if uid is null then raise exception 'not_ready'; end if;
  led := public.ex_scan_pick_ledger(uid, p_ledger, p_card);
  if p_scan_id is null or p_scan_id !~ '^[0-9a-f]{8}$' then raise exception 'bad_scan_id'; end if;
  if p_category is null or not (led.categories ? p_category) then raise exception 'bad_category'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 99999999 then raise exception 'bad_amount'; end if;
  if p_summary is null or char_length(btrim(p_summary)) not between 1 and 60 then raise exception 'bad_summary'; end if;
  select * into r from ex_tx where user_id = uid and scan_id = p_scan_id;
  if found then
    return jsonb_build_object('id', r.id, 'duplicate', true, 'deleted', r.deleted_at is not null, 'tx_date', r.tx_date, 'amount', r.amount)
      || jsonb_build_object('summary', public.ex_scan_summary_for(uid, r.ledger_id, r.tx_date));
  end if;
  select * into st from ex_settings where user_id = uid;
  if found then maxc := st.scan_daily_max_count; maxa := st.scan_daily_max_amount; end if;
  day_start := (date_trunc('day', now() at time zone 'Asia/Seoul')) at time zone 'Asia/Seoul';
  select count(*), coalesce(sum(amount), 0) into c, a from ex_tx where user_id = uid and source = 'scan' and created_at >= day_start;
  if c + 1 > maxc or a + p_amount > maxa then raise exception 'daily_limit'; end if;
  if p_sub_item is not null and not (coalesce(led.subitems -> p_category, '[]'::jsonb) ? p_sub_item) then raise exception 'bad_sub_item'; end if;
  insert into ex_tx (user_id, ledger_id, tx_date, category, sub_item, pay_method, summary, amount, source, scan_id)
  values (uid, led.id, p_date, p_category, p_sub_item, case when led.code = 'research' then '법인카드' else null end, btrim(p_summary), p_amount, 'scan', p_scan_id)
  returning id into new_id;
  return jsonb_build_object('id', new_id, 'duplicate', false, 'tx_date', p_date, 'amount', p_amount)
    || jsonb_build_object('summary', public.ex_scan_summary_for(uid, led.id, p_date));
end $$;

-- 권한: 앱용은 로그인한 사람만, 로그인·스캔 함수용은 서비스 키만
revoke all on function public.ex_undo_create(uuid) from public, anon;
revoke all on function public.ex_purge_mine() from public, anon;
revoke all on function public.ex_ensure_ledgers() from public, anon;
grant execute on function public.ex_ensure_ledgers() to authenticated;
grant execute on function public.ex_undo_create(uuid) to authenticated;
grant execute on function public.ex_purge_mine() to authenticated;

revoke all on function public.ex_lock_minutes(int), public.ex_auth_fail(int), public.ex_auth_ok(int), public.ex_auth_claim(int),
  public.ex_auth_unclaim(int), public.ex_auth_set_user(int, uuid), public.ex_revoke_sessions(uuid),
  public.ex_scan_check_key(text), public.ex_scan_pick_ledger(uuid, text, text), public.ex_scan_summary_for(uuid, uuid, date), public.ex_scan_summary(text, text, date),
  public.ex_scan_register(text, text, date, bigint, text, text, text, text) from public, anon, authenticated;
grant execute on function public.ex_lock_minutes(int), public.ex_auth_fail(int), public.ex_auth_ok(int), public.ex_auth_claim(int),
  public.ex_auth_set_user(int, uuid), public.ex_auth_unclaim(int), public.ex_revoke_sessions(uuid),
  public.ex_scan_check_key(text), public.ex_scan_pick_ledger(uuid, text, text), public.ex_scan_summary_for(uuid, uuid, date), public.ex_scan_summary(text, text, date),
  public.ex_scan_register(text, text, date, bigint, text, text, text, text) to service_role;

-- ============================================================
-- 0005_secret_and_slots.sql
-- ============================================================
-- 비밀값(pepper, 영수증 스캔 등록 키)과 사용자 칸 초기 상태. SQL만으로 초기 설정이 끝나도록 합니다(키·비밀값을 사람이 입력하지 않음).
-- 여러 번 실행해도 안전합니다(이미 있는 값은 유지하고 덮어쓰지 않음).

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.ex_secret (
  name       text primary key,
  value      text not null,
  created_at timestamptz not null default now()
);
alter table public.ex_secret enable row level security;     -- 정책 없음 = 서비스 권한 외에는 읽기·쓰기 모두 불가
revoke all on public.ex_secret from public, anon, authenticated;
grant select on public.ex_secret to service_role;

-- 비밀번호를 섞는 값: 한 번만 만든다(바꾸면 비밀번호가 무효가 되므로 덮어쓰기 금지). 화면·로그에 출력하지 않는다.
insert into public.ex_secret (name, value)
values ('pepper', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

-- 영수증 스캔 등록 키: 한 번만 만든다. PC 쪽 파일에 옮길 때는 admin/show_scan_key.sql 로 SQL 편집기에서 한 번 읽습니다.
insert into public.ex_secret (name, value)
values ('scan_key', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

-- 사용자 칸 1: 처음 사용(비밀번호 미설정). 로그인 계정은 첫 설정 때 로그인 함수가 만든다.
insert into public.ex_auth_state (slot, state) values (1, 'unset')
on conflict (slot) do nothing;

