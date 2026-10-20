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
