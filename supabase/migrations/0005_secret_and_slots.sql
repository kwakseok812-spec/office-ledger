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
