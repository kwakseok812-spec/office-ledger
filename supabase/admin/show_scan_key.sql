-- 영수증 스캔 등록 키 읽기 (PC 쪽 키 파일에 한 번 옮길 때만). SQL 편집기의 결과 칸에서 값을 복사해
-- OneDrive 밖의 PC 파일(예: C:\Users\jongh\expense-keys\scan_key.txt)에 저장하세요. 채팅·저장소·보고에는 쓰지 않습니다.
select value as scan_key from public.ex_secret where name = 'scan_key';
