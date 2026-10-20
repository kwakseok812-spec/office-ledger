"""화면 시험(Playwright): 폰 폭 접은 390px / 펼친 750px, 밝은·어두운 화면, 큰 글씨. 가짜 서버(?mock=1)만 씁니다."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from ui_lib import *
from playwright.sync_api import sync_playwright

SH = os.path.join(ROOT, 'shots')
os.makedirs(SH, exist_ok=True)
problems = []

def check(pg, tag):
    # 가로로 넘치거나 글자가 잘리는 곳이 없는지
    r = pg.evaluate("""() => {
      const w = document.documentElement.clientWidth; const out = [];
      if (document.documentElement.scrollWidth > w + 1) out.push('page-overflow ' + document.documentElement.scrollWidth + '>' + w);
      document.querySelectorAll('button, .chip-f, .big-btn').forEach(b => { if (b.scrollWidth > b.clientWidth + 2 && getComputedStyle(b).overflow !== 'visible') out.push('clip:' + (b.textContent||'').trim().slice(0,12)); });
      return out; }""")
    if r: problems.append((tag, r))

def shot(pg, name, tag=None):
    pg.wait_for_timeout(350)
    pg.screenshot(path=os.path.join(SH, name + '.png'))
    check(pg, tag or name)

def click(pg, sel, text=None):
    loc = pg.locator(sel + (f':has-text("{text}")' if text else '')).first
    loc.click(); pg.wait_for_timeout(250)

srv = start_server()
with sync_playwright() as p:
    b = p.chromium.launch()
    for size_name, (w, h) in SIZES.items():
        for scheme in ('light', 'dark'):
            ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, locale='ko-KR', color_scheme=scheme)
            pg = ctx.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
            tag = f'{scheme}_{size_name}'
            # 처음 사용(빈 서버) 로그인 화면
            if scheme == 'light' and w == 390:
                pg.goto(BASE + '?mock=1&empty=1'); pg.wait_for_timeout(700)
                shot(pg, '01_login_first_light_390')
            pg.goto(BASE + '?mock=1&auto=1'); pg.wait_for_timeout(900)
            if pg.locator('.font-opt').count(): pg.locator('.font-opt').first.click(); pg.wait_for_timeout(300)
            shot(pg, f'10_home_opex_{tag}')
            pg.evaluate('window.scrollTo(0, 99999)'); shot(pg, f'11_home_opex_scrolled_{tag}', 'scrolled_' + tag); pg.evaluate('window.scrollTo(0,0)')
            # 지출 추가 시트
            click(pg, '[data-act="add-tx"]')
            shot(pg, f'20_add_sheet_{tag}')
            pg.locator('.sheet [data-keep="amount"]').fill('13500'); pg.locator('.sheet [data-keep="summary"]').fill('시험 식당')
            shot(pg, f'21_add_sheet_filled_{tag}')
            click(pg, '.sheet [data-act="save-tx"]')
            shot(pg, f'22_saved_{tag}')
            click(pg, '.sheet [data-act="close-sheet"]')
            # 내역·정산서
            click(pg, '[data-act="go-records"]')
            shot(pg, f'30_records_{tag}')
            click(pg, '[data-act="go-report"]')
            shot(pg, f'31_report_{tag}')
            click(pg, '[data-act="go-records"]')
            click(pg, '[data-act="open-import"]')
            pg.locator('.sheet [data-f="importText"]').fill('2026-09-05,2026-09-05,중식,가짜 식당,12000,시험인 외 1명,2\n잘못된 줄')
            click(pg, '.sheet [data-act="imp-preview"]')
            shot(pg, f'32_import_{tag}')
            click(pg, '.sheet [data-act="close-sheet"]')
            # 연구비 장부
            click(pg, '[data-act="go-home"]')
            click(pg, '[data-act="pick-ledger"][data-code="research"]')
            shot(pg, f'40_home_research_empty_{tag}')
            click(pg, '[data-act="go-settings"]'); click(pg, '[data-act="edit-research"]')
            pg.locator('.sheet [data-keep="name"]').fill('가짜 연구과제'); pg.locator('.sheet [data-keep="bud_0"]').fill('1000000'); pg.locator('.sheet [data-keep="bud_1"]').fill('200000')
            shot(pg, f'41_research_edit_{tag}')
            click(pg, '.sheet [data-act="save-research"]'); pg.wait_for_timeout(300)
            click(pg, '[data-act="go-home"]')
            click(pg, '[data-act="add-tx"]')
            pg.locator('.sheet [data-keep="amount"]').fill('50000'); pg.locator('.sheet [data-keep="summary"]').fill('회의비')
            click(pg, '.sheet [data-act="pick-sub"]', '회의비')
            shot(pg, f'42_research_add_{tag}')
            click(pg, '.sheet [data-act="save-tx"]'); pg.wait_for_timeout(300)
            click(pg, '.sheet [data-act="close-sheet"]')
            shot(pg, f'43_home_research_{tag}')
            pg.evaluate('window.scrollTo(0, 99999)'); shot(pg, f'44_home_research_scrolled_{tag}', 'rscrolled_' + tag)
            click(pg, '[data-act="go-settings"]'); shot(pg, f'50_settings_{tag}')
            if errs: problems.append((tag, ['console/page errors'] + errs[:3]))
            ctx.close()
    # 큰 글씨
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, locale='ko-KR')
    pg = ctx.new_page(); pg.goto(BASE + '?mock=1&auto=1'); pg.wait_for_timeout(900)
    if pg.locator('.font-opt').count(): pg.locator('.font-opt').nth(2).click(); pg.wait_for_timeout(300)
    shot(pg, '60_home_xlarge_390', 'xlarge_home')
    click(pg, '[data-act="add-tx"]'); shot(pg, '61_add_xlarge_390', 'xlarge_add')
    b.close()
srv.shutdown()
print('PROBLEMS:', problems if problems else 'none')
