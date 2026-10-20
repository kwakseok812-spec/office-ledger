"""supabase/migrations/0001~0005 를 이어 붙여 supabase/ALL_IN_ONE.sql 하나로 만든다(SQL 편집기에 한 번에 붙여 넣기용).
마이그레이션을 고친 뒤에는 반드시 다시 실행한다.  실행: python tools/build_sql_bundle.py"""
import glob
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
files = sorted(glob.glob(os.path.join(ROOT, 'supabase', 'migrations', '0*.sql')))
parts = ['-- 학교 장부 서버 준비 묶음 (0001~0005를 순서대로 이어 붙인 것). 새 Supabase 프로젝트의 SQL 편집기에 통째로 붙여 넣고 한 번 실행합니다.',
         '-- 여러 번 실행해도 안전합니다(이미 있는 표·값은 그대로 둠, 비밀값은 덮어쓰지 않음).',
         '-- 편집기가 「Potential issue detected」 경고를 띄우면 [Run query] 를 눌러야 실행됩니다(함수 안의 delete 문 때문).', '']
for f in files:
    parts.append('-- ' + '=' * 60)
    parts.append('-- ' + os.path.basename(f))
    parts.append('-- ' + '=' * 60)
    parts.append(open(f, encoding='utf-8').read().rstrip())
    parts.append('')
out = os.path.join(ROOT, 'supabase', 'ALL_IN_ONE.sql')
open(out, 'w', encoding='utf-8', newline='\n').write('\n'.join(parts) + '\n')
print('만들었습니다:', out, len(files), '개 파일')
