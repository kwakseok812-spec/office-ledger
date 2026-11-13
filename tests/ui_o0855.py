"""O-0855 학교 장부 화면 시험(Playwright, 가짜 서버 ?mock=1): 뒤로가기 순서표 / 하나 더 입력 날짜 / 월 칩 / 360폭 차트 / 엑셀 내려받기(실제로 눌러 받음).
사용: python ui_o0855.py [앱 폴더(기본: 이 저장소)] [그림 폴더 또는 빈 글자] [표 이름: before|after]"""
import sys, os, http.server, socketserver, threading, functools, json
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SH = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
TAG = sys.argv[3] if len(sys.argv) > 3 else 'after'
PORT = 18533


class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8'}

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(('127.0.0.1', PORT), functools.partial(H, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{PORT}/index.html?mock=1&auto=1'
rows = []


def where(pg):
    if 'index.html' not in pg.url:
        return '(앱 밖으로 나감)'
    return pg.evaluate("""() => { const d = window.__ex.ui; const parts = [d.dialog ? '확인창' : '', d.sheet ? '시트(' + d.sheet.kind + ')' : '', '화면:' + d.screen]; return parts.filter(Boolean).join(' + ') }""")


def act(pg, a):
    pg.locator(('.sheet [data-act="%s"]' if a in ('close-sheet', 'save-tx', 'add-again') else '[data-act="%s"]') % a).first.click()
    pg.wait_for_timeout(260)


def fresh(b, w=390, h=844):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, locale='ko-KR', accept_downloads=True)
    pg = ctx.new_page()
    pg.goto(BASE)
    pg.wait_for_timeout(900)
    return ctx, pg


def back(pg):
    pg.go_back()
    pg.wait_for_timeout(350)


def scenario(name, fn, b):
    ctx, pg = fresh(b)
    log = []
    try:
        fn(pg, log)
    except Exception as e:  # noqa
        log.append(('오류', str(e)[:80]))
    rows.append((name, log))
    ctx.close()


def sA(pg, log):
    act(pg, 'go-records'); act(pg, 'go-report'); log.append(('내역→정산서', where(pg)))
    back(pg); log.append(('뒤로', where(pg)))
    back(pg); log.append(('뒤로', where(pg)))
    back(pg); log.append(('뒤로(처음 화면에서)', where(pg)))


def sB(pg, log):
    act(pg, 'go-settings'); log.append(('설정', where(pg)))
    back(pg); log.append(('뒤로', where(pg)))


def sC(pg, log):
    act(pg, 'go-records'); act(pg, 'go-trash'); log.append(('내역→휴지통', where(pg)))
    back(pg); log.append(('뒤로', where(pg)))
    back(pg); log.append(('뒤로', where(pg)))


def sD(pg, log):
    act(pg, 'go-records'); act(pg, 'add-tx'); log.append(('내역→지출 추가 시트', where(pg)))
    back(pg); log.append(('뒤로', where(pg)))
    back(pg); log.append(('뒤로', where(pg)))


def sE(pg, log):
    act(pg, 'go-records'); act(pg, 'add-tx')
    pg.locator('.sheet [data-keep="amount"]').fill('9999999')
    pg.locator('.sheet [data-keep="summary"]').fill('시험 큰 금액')
    act(pg, 'save-tx'); log.append(('저장 누름(금액이 커서 확인창)', where(pg)))
    back(pg); log.append(('뒤로', where(pg)))
    back(pg); log.append(('뒤로', where(pg)))
    back(pg); log.append(('뒤로', where(pg)))


def sF(pg, log):
    act(pg, 'go-records'); act(pg, 'go-report'); act(pg, 'go-records'); log.append(('내역→정산서→앱의 「내역」 단추', where(pg)))
    act(pg, 'go-home'); log.append(('「처음 화면」 단추', where(pg)))
    back(pg); log.append(('뒤로', where(pg)))


def sG(pg, log):
    act(pg, 'go-records'); act(pg, 'add-tx'); act(pg, 'close-sheet'); log.append(('시트를 X 단추로 닫음', where(pg)))
    back(pg); log.append(('뒤로', where(pg)))
    back(pg); log.append(('뒤로', where(pg)))


def sH(pg, log):
    pg.locator('[data-act="go-month"]').nth(2).click(); pg.wait_for_timeout(260); log.append(('홈 그래프의 달 누름', where(pg)))
    back(pg); log.append(('뒤로', where(pg)))


def sI(pg, log):
    act(pg, 'go-records'); act(pg, 'go-trash'); act(pg, 'go-records'); act(pg, 'add-tx'); act(pg, 'close-sheet'); act(pg, 'go-home')
    log.append(('여러 곳을 돌아 처음 화면', where(pg)))
    n = pg.evaluate("window.__ex.ui._stack ? window.__ex.ui._stack.length : -1"); log.append(('쌓인 기록 칸 수(-1=기록 장치 없음)', n))
    back(pg); log.append(('뒤로', where(pg)))


bad = []
with sync_playwright() as p:
    b = p.chromium.launch()
    for nm, fn in [('A 홈→내역→정산서', sA), ('B 홈→설정', sB), ('C 내역→휴지통', sC), ('D 내역→시트', sD), ('E 시트→확인창', sE),
                   ('F 「처음 화면」 단추로 한꺼번에', sF), ('G 시트를 단추로 닫은 뒤', sG), ('H 홈 그래프→내역', sH), ('I 여러 곳 돌아다닌 뒤', sI)]:
        scenario(nm, fn, b)
    print('===== 뒤로가기 순서표 (%s) =====' % TAG)
    for nm, log in rows:
        print('[%s]' % nm)
        for a, w in log:
            print('   %-40s -> %s' % (a, w))
    if TAG != 'before':
        ctx, pg = fresh(b); act(pg, 'go-records'); act(pg, 'add-tx')
        pg.locator('.sheet [data-keep="amount"]').fill('12000'); pg.locator('.sheet [data-keep="summary"]').fill('시험 식당')
        pg.locator('.sheet [data-f="tx_date"]').fill('2026-11-05'); pg.wait_for_timeout(200)
        act(pg, 'save-tx'); act(pg, 'add-again')
        d = pg.locator('.sheet [data-f="tx_date"]').input_value()
        print('B-07 하나 더 입력 날짜:', d, '(기대 2026-11-05)')
        if d != '2026-11-05':
            bad.append('B-07')
        ctx.close()
    print('===== 360/390/PC 폭 넘침 검사 =====')
    for nm, (w, h) in {'w360': (360, 740), 'w390': (390, 844), 'pc': (1100, 800)}.items():
        ctx, pg = fresh(b, w, h)
        r = pg.evaluate("""() => { const c = document.querySelector('.chart-card').getBoundingClientRect(); const out = []; document.querySelectorAll('.chart .mbar, .limit-line span').forEach(e => { const r = e.getBoundingClientRect(); if (r.right > c.right - 8 || r.left < c.left) out.push(e.className + ' ' + Math.round(r.left) + '-' + Math.round(r.right) + ' 카드 ' + Math.round(c.left) + '-' + Math.round(c.right)); }); return out; }""")
        print(nm, '차트 넘침:', r or '없음')
        if r and TAG != 'before':
            bad += r
        if SH:
            pg.evaluate("document.querySelector('.chart-card').scrollIntoView({block:'center'})"); pg.wait_for_timeout(250)
            pg.screenshot(path=os.path.join(SH, 'ledger_%s_chart_%s.png' % (TAG, nm)))
        act(pg, 'go-records'); act(pg, 'go-report')
        info = pg.evaluate("""() => { const c = document.querySelector('.month-chips'), on = c.querySelector('.chip-f.on'); const cr = c.getBoundingClientRect(), orr = on.getBoundingClientRect(); return { scroll: Math.round(c.scrollLeft), onVisible: orr.left >= cr.left - 1 && orr.right <= cr.right + 1, cls: c.className }; }""")
        print(nm, '월 칩(고른 달이 보이는지):', info)
        if TAG != 'before' and not info['onVisible']:
            bad.append('chip-not-visible ' + nm)
        pg.locator('.month-chips .chip-f').last.click(); pg.wait_for_timeout(300)
        vis = pg.evaluate("""() => { const c = document.querySelector('.month-chips'), on = c.querySelector('.chip-f.on'); const cr = c.getBoundingClientRect(), orr = on.getBoundingClientRect(); return orr.left >= cr.left - 1 && orr.right <= cr.right + 1; }""")
        print(nm, '맨 끝 달을 누른 뒤에도 보임:', vis)
        if TAG != 'before' and not vis:
            bad.append('last-chip-hidden ' + nm)
        if SH:
            pg.screenshot(path=os.path.join(SH, 'ledger_%s_report_chips_%s.png' % (TAG, nm)))
        ctx.close()
    if TAG != 'before':
        print('===== 엑셀 내려받기(실제 클릭) =====')
        outdir = os.path.join(SH, '..', 'sample', 'dl') if SH else os.path.join(ROOT, 'xlsx_dl')
        os.makedirs(outdir, exist_ok=True)
        ctx, pg = fresh(b, 390, 844); act(pg, 'go-records'); act(pg, 'go-report')
        for idx, ym in [(3, '2026-11'), (2, '2026-10'), (1, '2026-09')]:
            pg.locator('.month-chips .chip-f').nth(idx).click(); pg.wait_for_timeout(250)
            screen = pg.evaluate("""() => { const rows = [...document.querySelectorAll('.rep tbody tr')].filter(tr => tr.children.length > 2); const foot = document.querySelector('.rep tfoot tr'); return { n: rows.length, amounts: rows.map(tr => tr.children[4].textContent.replace(/,/g, '')), foot: foot.children[1].textContent.replace(/,/g, ''), footLabel: foot.children[0].textContent }; }""")
            with pg.expect_download() as dl:
                act(pg, 'export-xlsx')
            d = dl.value
            path = os.path.abspath(os.path.join(outdir, d.suggested_filename)); d.save_as(path)
            print(ym, '파일명:', d.suggested_filename, '| 화면:', screen['footLabel'], screen['foot'], '| 화면 행 수:', screen['n'])
            json.dump(screen, open(os.path.join(outdir, 'screen_%s.json' % ym), 'w'))
        act(pg, 'go-records'); act(pg, 'go-home')
        pg.locator('[data-act="pick-ledger"][data-code="research"]').click(); pg.wait_for_timeout(300)
        act(pg, 'go-records'); act(pg, 'go-report')
        with pg.expect_download() as dl:
            act(pg, 'export-xlsx')
        d = dl.value
        print('연구비 파일명:', d.suggested_filename)
        d.save_as(os.path.abspath(os.path.join(outdir, d.suggested_filename)))
        if SH:
            pg.evaluate('window.scrollTo(0, 99999)'); pg.wait_for_timeout(250)
            pg.screenshot(path=os.path.join(SH, 'ledger_%s_report_research_buttons_w390.png' % TAG))
        ctx.close()
        ctx, pg = fresh(b, 390, 844); act(pg, 'go-records'); act(pg, 'go-report'); pg.evaluate('window.scrollTo(0, 99999)'); pg.wait_for_timeout(250)
        if SH:
            pg.screenshot(path=os.path.join(SH, 'ledger_%s_report_buttons_w390.png' % TAG))
        ctx.close()
    b.close()
print('문제 있음: %s' % bad if bad else '끝: 문제 없음')
