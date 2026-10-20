-- 영수증 스캔 등록 키 교체 (키가 새어 나갔다고 의심될 때). 실행 즉시 옛 키는 쓸 수 없고,
-- 새 키는 show_scan_key.sql 로 읽어 PC 키 파일을 바꿉니다. 잠금(10번 틀림)도 풀립니다.
update public.ex_secret set value = encode(extensions.gen_random_bytes(32), 'hex'), created_at = now() where name = 'scan_key';
update public.ex_scan_state set fails = 0, locked_until = null where id = 1;
