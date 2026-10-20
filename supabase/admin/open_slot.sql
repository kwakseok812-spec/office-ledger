-- 사용자 칸 열기: 「사용 안 함」(초기화 직후 임시 잠금) 상태를 「처음 사용(비밀번호 미설정)」으로 바꿉니다.
-- 연 직후 바로 비밀번호를 정할 수 있을 때만 실행하세요. 이미 비밀번호가 정해진 칸(state = 'set')은 건드리지 않습니다.

do $$
begin
  update public.ex_auth_state
     set state = 'unset', failed_count = 0, lock_level = 0, locked_until = null, updated_at = now()
   where slot = 1 and state = 'disabled';
  if not found then raise notice '「사용 안 함」 상태가 아니어서 바꾸지 않았습니다.'; end if;
end $$;
