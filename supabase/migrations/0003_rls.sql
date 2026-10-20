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
