"""SQL 문법 검사(실제 서버 없이): PostgreSQL 문법 분석기(pglast)로 모든 SQL 파일이 읽히는지 확인한다.
설치: pip install pglast     실행: python tools/check_sql.py
이것은 문법만 본다. 표·권한 동작은 supabase/tests/rls_test.sql 로 서버에서 확인한다."""
import glob
import os
import sys

import pglast

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
files = sorted(glob.glob(os.path.join(ROOT, 'supabase', 'migrations', '*.sql'))) + sorted(glob.glob(os.path.join(ROOT, 'supabase', 'admin', '*.sql')))
files += sorted(glob.glob(os.path.join(ROOT, 'supabase', 'tests', '*.sql'))) + sorted(glob.glob(os.path.join(ROOT, 'supabase', '*.sql')))
seed = os.path.join(ROOT, 'seed_private', 'seed_insert.sql')
if os.path.exists(seed):
    files.append(seed)
bad = 0
for f in files:
    s = open(f, encoding='utf-8').read()
    name = os.path.relpath(f, ROOT).replace(os.sep, '/')
    try:
        n = len(pglast.parse_sql(s))
        print('OK   %s (%d)' % (name, n))
    except Exception as e:
        bad += 1
        print('FAIL %s: %s' % (name, str(e)[:300]))
sys.exit(1 if bad else 0)
