"""seed_private\\*.csv 에서 서버 입력 SQL(seed_private\\seed_insert.sql)을 만든다.

* 이 스크립트에는 개인 자료가 없다(공개 저장소에 있어도 된다). 자료는 seed_private\\ 의 CSV 두 개에만 있고, 그 폴더는 .gitignore 로 올라가지 않는다.
* 만든 SQL 도 seed_private\\ 에 둔다(올리지 않음). 관리자가 서버 준비(0001~0005) + 사용자 본인 처음 사용 설정 + 앱을 한 번 연 뒤
  Supabase SQL 편집기에 붙여 넣어 한 번 실행한다. 여러 번 실행해도 같은 내역은 다시 넣지 않는다.
* 실행: python tools/make_seed.py
"""
import csv
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SEED = os.path.join(ROOT, 'seed_private')
OPEX_CSV = os.path.join(SEED, 'history_2026_08_10.csv')
RES_CSV = os.path.join(SEED, 'research_2026_07_09.csv')
OUT = os.path.join(SEED, 'seed_insert.sql')

# 확인된 건수·합계와 연구비 비목별 예산은 개인 금액이라 저장소에 두지 않고 seed_private\seed_config.json 에서 읽는다
#   {"expect_opex": [건수, 합계], "expect_res": [건수, 합계], "res_budgets": {"비목": 금액, ...}}
import json
with open(os.path.join(SEED, 'seed_config.json'), encoding='utf-8') as _f:
    _cfg = json.load(_f)
RES_BUDGETS = _cfg['res_budgets']
CARDS = _cfg.get('cards', {})      # {"opex": "끝 4자리", "research": "끝 4자리"} — 개인 설정이라 저장소에 두지 않는다
EXPECT_OPEX = tuple(_cfg['expect_opex'])
EXPECT_RES = tuple(_cfg['expect_res'])


def q(v):
    """SQL 글자 값(작은따옴표 겹치기). 빈 값은 null"""
    if v is None or str(v).strip() == '':
        return 'null'
    return "'" + str(v).replace("'", "''") + "'"


def read(path):
    with open(path, encoding='utf-8-sig', newline='') as f:
        rows = list(csv.reader(f))
    return rows[0], rows[1:]


def col(head, *names):
    for n in names:
        for i, h in enumerate(head):
            if h == n or re.sub(r'\(.*\)', '', h).strip() == n:
                return i
    raise SystemExit('열을 찾을 수 없습니다: %s / %s' % (names, head))


def blank_if_missing(v):
    """원본 자료가 「자료에 없음」이라고 적은 칸은 앱에서는 빈 값으로 둔다"""
    return '' if re.sub(r'\s+', '', v or '') in ('자료에없음', '미상', '없음') else v


def amount(s):
    return int(re.sub(r'[,\s원]', '', s))


def main():
    oh, orows = read(OPEX_CSV)
    c = {k: col(oh, *v) for k, v in {'date': ('사용일자',), 'settle': ('정산일자',), 'meal': ('구분',), 'summary': ('적요',), 'amount': ('금액',), 'att': ('참가자',), 'hc': ('인원',)}.items()}
    opex = []
    for r in orows:
        opex.append(dict(date=r[c['date']], settle=r[c['settle']] or r[c['date']], meal=r[c['meal']], summary=r[c['summary']], amount=amount(r[c['amount']]), att=blank_if_missing(r[c['att']]), hc=int(r[c['hc']]) if r[c['hc']].strip() else None))
    n, total = len(opex), sum(x['amount'] for x in opex)
    if (n, total) != EXPECT_OPEX:
        raise SystemExit('운영비 건수·합계가 확인된 값과 다릅니다: %s != %s' % ((n, total), EXPECT_OPEX))

    rh, rrows = read(RES_CSV)
    d = {k: col(rh, *v) for k, v in {'date': ('사용일자',), 'summary': ('세부내역',), 'cat': ('항목',), 'kind': ('구분',), 'amount': ('금액',), 'proof': ('증빙번호',), 'pay': ('결제수단',), 'settle': ('정산일자',), 'project': ('과제명',), 'inst': ('지원기관',), 'att': ('참가자/인원',)}.items()}
    res = []
    for r in rrows:
        res.append(dict(date=r[d['date']], summary=r[d['summary']], cat=r[d['cat']], kind=r[d['kind']], amount=amount(r[d['amount']]), proof=r[d['proof']], pay=re.sub(r'\(.*\)', '', r[d['pay']]).strip(), settle=r[d['settle']], att=blank_if_missing(r[d['att']])))
    project = {r[d['project']] for r in rrows}
    inst = {re.sub(r'\(.*\)', '', r[d['inst']]).strip() for r in rrows}
    if len(project) != 1:
        raise SystemExit('과제명이 여러 개입니다')
    rn, rtotal = len(res), sum(x['amount'] for x in res)
    if (rn, rtotal) != EXPECT_RES:
        raise SystemExit('연구비 건수·합계가 확인된 값과 다릅니다: %s != %s' % ((rn, rtotal), EXPECT_RES))

    out = []
    w = out.append
    w('-- 학교 장부 시작 내역 입력 (개인 자료 - 이 파일은 저장소에 올리지 않습니다: seed_private\\ 는 .gitignore)')
    w('-- 만든 날: python tools/make_seed.py')
    w('-- 실행 전 조건: ①SQL 0001~0005 적용 ②사용자 본인이 앱에서 비밀번호를 정함(처음 사용 설정) ③앱을 한 번 열어 장부 2개가 만들어짐')
    w('-- 실행 방법: Supabase SQL 편집기에 전부 붙여 넣고 [Run]. 여러 번 실행해도 같은 내역은 다시 넣지 않습니다.')
    w('-- 기대 결과(맨 아래 확인 조회): 운영비 %d건 %s원 / 연구비 %d건 %s원' % (EXPECT_OPEX[0], format(EXPECT_OPEX[1], ','), EXPECT_RES[0], format(EXPECT_RES[1], ',')))
    w('')
    w('do $$')
    w('declare uid uuid; lo uuid; lr uuid;')
    w('begin')
    w("  select user_id into uid from public.ex_auth_state where slot = 1;")
    w("  if uid is null then raise exception '사용자 본인이 앱에서 비밀번호를 먼저 정해야 합니다(처음 사용 설정).'; end if;")
    w("  select id into lo from public.ex_ledgers where user_id = uid and code = 'opex';")
    w("  select id into lr from public.ex_ledgers where user_id = uid and code = 'research';")
    w("  if lo is null or lr is null then raise exception '앱을 한 번 열어 장부가 만들어진 뒤에 실행하세요.'; end if;")
    w('')
    w('  -- 연구비 장부: 과제 정보와 비목별 예산')
    budgets = ', '.join('"%s": %d' % (k, v) for k, v in RES_BUDGETS.items())
    pj = list(project)[0]
    ins = list(inst)[0] if inst else ''
    w("  update public.ex_ledgers set")
    w("    project = coalesce(project, '{}'::jsonb) || jsonb_build_object('name', %s, 'institution', %s)," % (q(pj), q(ins)))
    w("    budgets = '{%s}'::jsonb, total_budget = %d, card_last4 = %s, period_start = date '2026-06-01', period_end = date '2027-02-28'" % (budgets, sum(RES_BUDGETS.values()), q(CARDS.get('research'))))
    w("  where id = lr;")
    if CARDS.get('opex'):
        w("  update public.ex_ledgers set card_last4 = %s where id = lo;" % q(CARDS['opex']))
    w('')
    w('  -- 운영비 %d건' % n)
    w('  insert into public.ex_tx (user_id, ledger_id, tx_date, settle_date, category, meal, summary, amount, attendees, headcount, source)')
    w('  select uid, lo, v.tx_date::date, v.settle_date::date, \'식비\', v.meal, v.summary, v.amount, v.attendees, v.headcount, \'import\'')
    w('  from (values')
    vals = ['    (%s, %s, %s, %s, %d, %s, %s)' % (q(x['date']), q(x['settle']), q(x['meal']), q(x['summary']), x['amount'], q(x['att']), x['hc'] if x['hc'] is not None else 'null') for x in opex]
    w(',\n'.join(vals))
    w('  ) as v(tx_date, settle_date, meal, summary, amount, attendees, headcount)')
    w('  where not exists (select 1 from public.ex_tx t where t.user_id = uid and t.ledger_id = lo and t.tx_date = v.tx_date::date and t.amount = v.amount and t.summary = v.summary);')
    w('')
    w('  -- 연구비 %d건 (세부 비목은 적요가 「회의비」일 때만 채움)' % rn)
    w('  insert into public.ex_tx (user_id, ledger_id, tx_date, settle_date, category, sub_item, meal, summary, amount, proof_no, pay_method, attendees, source)')
    w("  select uid, lr, v.tx_date::date, v.settle_date::date, v.category, case when v.summary = '회의비' then '회의비' else null end, v.meal, v.summary, v.amount, v.proof_no, v.pay_method, v.attendees, 'import'")
    w('  from (values')
    vals = ['    (%s, %s, %s, %s, %s, %d, %s, %s, %s)' % (q(x['date']), q(x['settle']), q(x['cat']), q(x['kind']), q(x['summary']), x['amount'], q(x['proof']), q(x['pay']), q(x['att'])) for x in res]
    w(',\n'.join(vals))
    w('  ) as v(tx_date, settle_date, category, meal, summary, amount, proof_no, pay_method, attendees)')
    w('  where not exists (select 1 from public.ex_tx t where t.user_id = uid and t.ledger_id = lr and t.tx_date = v.tx_date::date and t.amount = v.amount and t.summary = v.summary and coalesce(t.proof_no, \'\') = coalesce(v.proof_no, \'\'));')
    w('end $$;')
    w('')
    w('-- 확인 조회: 장부·달별 건수와 합계 (기대값과 맞는지 보세요)')
    w("select l.code as ledger, to_char(t.tx_date, 'YYYY-MM') as month, count(*) as n, sum(t.amount) as total")
    w('from public.ex_tx t join public.ex_ledgers l on l.id = t.ledger_id')
    w('where t.deleted_at is null group by 1, 2 order by 1, 2;')
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(out) + '\n')
    print('만들었습니다: %s (운영비 %d건 %s원 / 연구비 %d건 %s원)' % (OUT, n, format(total, ','), rn, format(rtotal, ',')))


if __name__ == '__main__':
    sys.exit(main())
