-- 사용자 칸 초기화 (비밀번호를 잊었을 때). 본인 확인 뒤에만 실행합니다.
-- 기록은 그대로 두고, 비밀번호를 「미설정」으로 되돌리고, 모든 기기 로그인을 끊습니다.
-- 초기화한 칸은 「사용 안 함」으로 임시 잠가 둡니다 → 본인이 바로 새 비밀번호를 정할 수 있을 때 open_slot.sql 로 열고 곧바로 설정합니다.

do $$
declare
  slot_no int := 1;
  uid uuid;
begin
  if not exists (select 1 from public.ex_auth_state where slot = slot_no) then raise exception 'slot % not found', slot_no; end if;
  select user_id into uid from public.ex_auth_state where slot = slot_no;
  update public.ex_auth_state
     set state = 'disabled', failed_count = 0, lock_level = 0, locked_until = null, updated_at = now()
   where slot = slot_no;
  if uid is not null then perform public.ex_revoke_sessions(uid); end if;
  raise notice '초기화 완료 (임시 잠금). 준비가 되면 open_slot.sql 로 여세요.';
end $$;
