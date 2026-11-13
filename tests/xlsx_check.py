"""엑셀 파일 검사(openpyxl): 칸 형식(날짜 칸·숫자 칸)·한글·행 수·합계를 읽어 출력. 사용: python xlsx_check.py 파일.xlsx [기대합계 기대건수]"""
import sys, datetime
from openpyxl import load_workbook
f = sys.argv[1]
wb = load_workbook(f)            # 식 그대로
wv = load_workbook(f, data_only=True)  # 저장된 계산값
ws, wsv = wb.worksheets[0], wv.worksheets[0]
print('시트:', wb.sheetnames, '| 머리 고정:', ws.freeze_panes)
hdr = None
for r in range(1, ws.max_row + 1):
    if ws.cell(r, 1).value == '사용일자': hdr = r; break
cols = [c.value for c in ws[hdr]]
print('표 머리(줄 %d):' % hdr, cols)
amt = cols.index('금액') + 1
body = []
r = hdr + 1
while not str(ws.cell(r, 1).value or '').startswith('합계'):
    body.append(r); r += 1
foot = r
bad = []
for r in body:
    for c in (1, 2):
        v = ws.cell(r, c).value
        if not isinstance(v, (datetime.datetime, datetime.date)): bad.append(('날짜칸 아님', r, c, v))
        elif ws.cell(r, c).number_format not in (r'yyyy\-mm\-dd', 'yyyy-mm-dd'): bad.append(('날짜 서식', r, c, ws.cell(r, c).number_format))
    v = ws.cell(r, amt).value
    if not isinstance(v, (int, float)): bad.append(('금액 숫자칸 아님', r, v))
    if ws.cell(r, amt).number_format != '#,##0': bad.append(('금액 서식', r, ws.cell(r, amt).number_format))
    if '인원' in cols:
        h = ws.cell(r, cols.index('인원') + 1).value
        if h not in (None, '') and not isinstance(h, (int, float)): bad.append(('인원 숫자칸 아님', r, h))
total = sum(ws.cell(r, amt).value for r in body)
print('본문 행 수:', len(body), '| 본문 금액 합:', total, '| 합계줄 식:', ws.cell(foot, amt).value, '| 저장값:', wsv.cell(foot, amt).value, '| 합계줄 글:', ws.cell(foot, 1).value)
print('요약 영역:', [(ws.cell(r, 1).value, wsv.cell(r, 2).value) for r in range(1, hdr - 1) if ws.cell(r, 1).value])
print('한글 샘플:', [ws.cell(r, 4).value for r in body][:3])
s2 = wv.worksheets[1]
print('시트2:', [[c.value for c in row] for row in s2.iter_rows()])
if len(sys.argv) >= 4:
    exp_sum, exp_n = int(sys.argv[2]), int(sys.argv[3])
    ok = total == exp_sum == wsv.cell(foot, amt).value and len(body) == exp_n
    print('화면 값과 대조(합계 %d, %d건):' % (exp_sum, exp_n), '일치' if ok else '불일치')
    if not ok: bad.append(('화면 값과 다름',))
print('문제:', bad if bad else '없음')
sys.exit(1 if bad else 0)
