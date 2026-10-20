-- 분리·권한·규칙 서버 시험. 새 프로젝트에 0001~0005 를 적용한 뒤 SQL Editor 에 통째로 붙여 넣어 실행합니다.
-- 끝에서 항상 ROLLBACK 하므로 아무것도 남지 않습니다(실제 기록·비밀번호·키 변경 0). 시험용 사용자 2명은 이 안에서 만들고 롤백됩니다.
-- 실패하면 「FAIL: ...」 오류로 멈춥니다. 끝까지 오면 「PASS」 알림이 나옵니다.
-- 주의: 이미 실제 사용자가 설정된 서버에서도 안전하도록 ex_auth_state 의 칸은 롤백되는 범위에서만 바꿉니다.
-- (이 파일은 작성만 했고 아직 실제 서버에서 실행하지 않았습니다 - 관리자가 서버 준비 직후 실행)

begin;

do $$
declare
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid();
  lo1 uuid; lr1 uuid; lo2 uuid;
  t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
  n int; ok boolean; r jsonb; k text; old_uid uuid; old_state text;
begin
  insert into auth.users (id, aud, role, email) values
    (u1, 'authenticated', 'authenticated', 'rls-test-1@ex.example.com'),
    (u2, 'authenticated', 'authenticated', 'rls-test-2@ex.example.com');

  -- ---- 사용자1·2 가 각자 장부를 만들고 지출을 넣는다
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.ex_ensure_ledgers();
  perform public.ex_ensure_ledgers();   -- 두 번 불러도 장부는 2개
  select id into lo1 from public.ex_ledgers where code = 'opex';
  select id into lr1 from public.ex_ledgers where code = 'research';
  select count(*) into n from public.ex_ledgers; if n <> 2 then raise exception 'FAIL: 장부 수 %', n; end if;
  select count(*) into n from public.ex_ledgers where card_last4 is not null; if n <> 0 then raise exception 'FAIL: 기본 장부에 카드 번호가 들어 있음'; end if;
  -- 카드 끝 4자리는 앱 사용자가 설정에서 바꿀 수 있다(형식 검사는 표가 함)
  update public.ex_ledgers set card_last4 = '1111' where id = lo1; get diagnostics n = row_count; if n <> 1 then raise exception 'FAIL: 카드 끝 4자리를 못 바꿈'; end if;
  update public.ex_ledgers set card_last4 = '2222' where id = lr1;
  ok := false; begin update public.ex_ledgers set card_last4 = '12a4' where id = lo1; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 카드 형식 검사가 안 걸림'; end if;
  insert into public.ex_tx (id, ledger_id, tx_date, category, summary, amount) values (t1, lo1, (now() at time zone 'Asia/Seoul')::date, '식비', '시험 식당', 10000);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.ex_ensure_ledgers();
  select id into lo2 from public.ex_ledgers where code = 'opex';
  insert into public.ex_tx (id, ledger_id, tx_date, category, summary, amount) values (t2, lo2, (now() at time zone 'Asia/Seoul')::date, '식비', '시험 식당2', 20000);

  -- ---- 1·2·7: 사용자2 눈에는 사용자1 의 장부·지출·이력·설정이 0행
  select count(*) into n from public.ex_ledgers where user_id <> u2; if n <> 0 then raise exception 'FAIL: 남의 장부가 보임 %', n; end if;
  select count(*) into n from public.ex_tx where user_id <> u2; if n <> 0 then raise exception 'FAIL: 남의 지출이 보임 %', n; end if;
  select count(*) into n from public.ex_history where user_id <> u2; if n <> 0 then raise exception 'FAIL: 남의 이력이 보임 %', n; end if;
  select count(*) into n from public.ex_settings where user_id <> u2; if n <> 0 then raise exception 'FAIL: 남의 설정이 보임 %', n; end if;
  select count(*) into n from public.ex_tx; if n <> 1 then raise exception 'FAIL: 내 지출 수 %', n; end if;

  -- ---- 3: 남의 user_id 로 쓰기 / 남의 장부에 내 지출 붙이기 -> 거부
  ok := false; begin insert into public.ex_tx (user_id, ledger_id, tx_date, category, summary, amount) values (u1, lo1, (now() at time zone 'Asia/Seoul')::date, '식비', 'X', 1); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 남의 user_id 로 쓰기가 통과됨'; end if;
  ok := false; begin insert into public.ex_tx (ledger_id, tx_date, category, summary, amount) values (lo1, (now() at time zone 'Asia/Seoul')::date, '식비', 'X', 1); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 남의 장부에 지출이 붙음'; end if;
  ok := false; begin insert into public.ex_ledgers (code, name, period_start, period_end, categories) values ('opex', 'X', date '2026-01-01', date '2026-12-31', '["식비"]'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 앱에서 장부를 직접 만들 수 있음'; end if;

  -- ---- 4: 남의 행 수정 -> 0행, 삭제는 권한 자체가 없음
  update public.ex_tx set amount = 999999 where id = t1; get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: 남의 지출을 수정함'; end if;
  update public.ex_ledgers set monthly_limit = 1 where id = lo1; get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: 남의 장부를 수정함'; end if;
  ok := false; begin delete from public.ex_tx where id = t2; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 삭제 권한이 열려 있음'; end if;
  ok := false; begin perform public.ex_undo_create(t1); n := 1; exception when others then ok := true; end;
  reset role;
  select count(*) into n from public.ex_tx where id = t1; if n <> 1 then raise exception 'FAIL: 남의 지출이 되돌리기로 지워짐'; end if;

  -- ---- 5: 로그인 안 한 상태(anon)로는 모든 표·함수 거부
  set local role anon;
  ok := false; begin perform count(*) from public.ex_tx; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: anon 이 지출을 읽음'; end if;
  ok := false; begin perform count(*) from public.ex_ledgers; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: anon 이 장부를 읽음'; end if;
  ok := false; begin perform public.ex_scan_summary('opex', null, null); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: anon 이 스캔 함수를 부름'; end if;
  reset role;

  -- ---- 6: 로그인한 앱 사용자도 비밀값·로그인 상태·스캔 함수에는 접근 불가
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  ok := false; begin perform count(*) from public.ex_secret; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 앱 사용자가 비밀값 표를 읽음'; end if;
  ok := false; begin perform count(*) from public.ex_auth_state; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 앱 사용자가 로그인 상태 표를 읽음'; end if;
  ok := false; begin perform public.ex_scan_register('opex', null, current_date, 1, 'x', '식비', 'abcdef12'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 앱 사용자가 스캔 등록 함수를 부름'; end if;
  ok := false; begin perform public.ex_auth_fail(1); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 앱 사용자가 로그인 함수를 부름'; end if;

  -- ---- 규칙(트리거): 기간 밖·미래·없는 항목·세부 비목
  ok := false; begin insert into public.ex_tx (ledger_id, tx_date, category, summary, amount) values (lo1, date '2026-07-31', '식비', 'X', 1); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 기간 밖 날짜가 통과됨'; end if;
  ok := false; begin insert into public.ex_tx (ledger_id, tx_date, category, summary, amount) values (lo1, (now() at time zone 'Asia/Seoul')::date + 1, '식비', 'X', 1); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 미래 날짜가 통과됨'; end if;
  ok := false; begin insert into public.ex_tx (ledger_id, tx_date, category, summary, amount) values (lo1, (now() at time zone 'Asia/Seoul')::date, '연구활동비', 'X', 1); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 운영비에 연구비 비목이 들어감'; end if;
  ok := false; begin insert into public.ex_tx (ledger_id, tx_date, category, summary, amount) values (lr1, date '2026-07-10', '연구활동비', 'X', 0); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 금액 0 이 통과됨'; end if;
  insert into public.ex_tx (ledger_id, tx_date, category, sub_item, summary, amount, pay_method, proof_no) values (lr1, date '2026-07-10', '연구활동비', '회의비', '회의비', 1000, '법인카드', '1');
  ok := false; begin insert into public.ex_tx (ledger_id, tx_date, category, sub_item, summary, amount) values (lr1, date '2026-07-10', '연구수당', '회의비', 'X', 1000); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 다른 비목의 세부 비목이 통과됨'; end if;
  -- 만든 날·주인·장부는 바꿀 수 없음
  update public.ex_tx set ledger_id = lr1, user_id = u2 where id = t1; get diagnostics n = row_count;
  -- 정산일자는 비우면 사용일자로 채워짐
  select count(*) into n from public.ex_tx where settle_date is null; if n <> 0 then raise exception 'FAIL: 정산일자가 비어 있음'; end if;
  -- 이력: 같은 값으로 고치면 늘지 않고, 다른 값이면 한 줄
  update public.ex_tx set amount = 12000 where id = t1; update public.ex_tx set amount = 12000 where id = t1;
  select count(*) into n from public.ex_history where entity_id = t1 and action = 'update'; if n <> 1 then raise exception 'FAIL: 이력 수 %', n; end if;
  -- 방금 만든 것은 되돌리기(5분 안)가 됨
  perform public.ex_undo_create(t1);
  select count(*) into n from public.ex_tx where id = t1; if n <> 0 then raise exception 'FAIL: 되돌리기가 안 됨'; end if;
  reset role;

  -- ---- 영수증 스캔 함수 (서비스 권한만). 시험을 위해 칸 1 에 사용자1 을 연결(롤백됨)
  select user_id, state into old_uid, old_state from public.ex_auth_state where slot = 1;
  update public.ex_auth_state set user_id = u1, state = 'set' where slot = 1;
  set local role service_role;
  r := public.ex_scan_register('opex', null, (now() at time zone 'Asia/Seoul')::date, 38500, '시험 식당', '식비', 'a1b2c3d4');
  if (r ->> 'duplicate') <> 'false' then raise exception 'FAIL: 스캔 첫 등록'; end if;
  r := public.ex_scan_register(null, '1111', (now() at time zone 'Asia/Seoul')::date, 38500, '시험 식당', '식비', 'a1b2c3d4');
  if (r ->> 'duplicate') <> 'true' then raise exception 'FAIL: 같은 scan_id 가 두 건이 됨'; end if;
  select count(*) into n from public.ex_tx where user_id = u1 and scan_id = 'a1b2c3d4'; if n <> 1 then raise exception 'FAIL: scan_id 중복 %', n; end if;
  r := public.ex_scan_register(null, '2222', date '2026-07-11', 5000, '회의비', '연구활동비', 'b1b2b3b4', '회의비');
  if (r -> 'summary' ->> 'ledger') <> 'research' then raise exception 'FAIL: 카드 2222 이 연구비로 안 감'; end if;
  ok := false; begin perform public.ex_scan_register('opex', null, current_date, 1000, '시험', '연구활동비', 'c1c2c3c4'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 운영비 장부에 연구비 비목이 들어감'; end if;
  ok := false; begin perform public.ex_scan_register(null, '0000', current_date, 1000, '시험', '식비', 'c1c2c3c5'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 없는 카드가 통과됨'; end if;
  r := public.ex_scan_summary(null, '1111', (now() at time zone 'Asia/Seoul')::date);
  if (r ->> 'day_count')::int < 1 or (r ->> 'total_used')::bigint < 38500 then raise exception 'FAIL: 요약 숫자 %', r; end if;
  -- 하루 상한: 건수 1 로 줄이면 다음 등록은 거부
  reset role;
  insert into public.ex_settings (user_id, scan_daily_max_count) values (u1, 1);
  set local role service_role;
  ok := false; begin perform public.ex_scan_register('opex', null, (now() at time zone 'Asia/Seoul')::date, 100, '시험', '식비', 'd1d2d3d4'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 하루 상한이 안 걸림'; end if;
  -- 준비 중 장부는 거부
  reset role;
  update public.ex_ledgers set status = 'soon' where id = lr1;
  set local role service_role;
  ok := false; begin perform public.ex_scan_register(null, '2222', date '2026-07-12', 100, '회의비', '연구활동비', 'e1e2e3e4'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL: 준비 중 장부에 등록됨'; end if;
  -- 스캔 키: 맞는 키 ok, 틀린 키 10번이면 잠금
  k := (select value from public.ex_secret where name = 'scan_key');
  if public.ex_scan_check_key(k) <> 'ok' then raise exception 'FAIL: 맞는 키가 거부됨'; end if;
  for n in 1..10 loop perform public.ex_scan_check_key(repeat('x', 64)); end loop;
  if public.ex_scan_check_key(k) <> 'locked' then raise exception 'FAIL: 키 잠금이 안 걸림'; end if;
  reset role;

  -- ---- 기본 장부 값(운영비)이 앱 기본값과 같은지
  select count(*) into n from public.ex_ledgers where user_id = u1 and code = 'opex' and monthly_limit = 300000 and total_budget = 2100000
     and period_start = date '2026-08-01' and period_end = date '2027-02-28' and card_last4 = '1111' and categories = '["식비","교통비","회의비","물품구매","사무용품","기타"]'::jsonb;
  if n <> 1 then raise exception 'FAIL: 운영비 장부 기본값이 앱과 다름'; end if;

  raise notice 'PASS: 사용자 분리·권한·규칙·스캔 입구 시험 통과 (롤백되어 아무것도 남지 않음)';
end $$;

rollback;
