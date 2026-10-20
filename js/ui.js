// ui.js - 화면 그리기와 누르기 처리. 계산은 calc.js, 저장은 store.js 가 맡습니다.
import * as C from './calc.js';
import { SaveError } from './store.js';
import { ApiError, NetworkError } from './data.js';
import { validatePassword } from '../supabase/functions/ex-auth/logic.js';
import { APP_VERSION, APP_NAME } from './config.js';

const FONT_LABEL = { normal: '보통', large: '크게', xlarge: '아주 크게' };
const LEDGER_SHORT = { opex: '운영비', research: '연구비' };
const MEAL_CHOICES = ['중식', '석식', '조식'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = C.fmtNum;
const won = (n) => `${C.fmtNum(n)}원`;

const ICON = {
  check: '<svg class="ic-check" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="3"/><path d="M15 27l8 8 14-16" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  caret: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  logo: '<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true"><rect x="8" y="8" width="48" height="48" rx="12" fill="currentColor" opacity=".14"/><path d="M20 18h24v6H20zM20 28h24v6H20zM20 38h14v6H20z" fill="currentColor"/></svg>',
};

export function createUI({ root, store, haptics = true }) {
  const S = store.state;
  const ui = {
    screen: 'home',      // home | records | report | trash | settings
    month: null,         // 내역·정산서에서 보고 있는 달 'YYYY-MM' (null = 이번 달)
    login: { error: '', busy: false, show: false },
    sheet: null, dialog: null, busy: false, notice: '',
  };
  let renderQueued = false;
  const toast = document.createElement('div');
  toast.className = 'toast'; toast.setAttribute('role', 'status');
  document.body.appendChild(toast);

  /* ============================== 보조 ============================== */
  const todayStr = () => store.today();
  function buzz() { try { if (haptics && navigator.vibrate && !S.prefs.reduceMotion) navigator.vibrate(8); } catch { /* 지원 안 함 */ } }
  const digitsOf = (s) => String(s || '').replace(/[^0-9]/g, '');
  const fmtInput = (s) => { const d = digitsOf(s).replace(/^0+/, ''); return d ? C.fmtNum(Number(d)) : ''; };
  const curMonth = () => ui.month || C.currentMonthKey(store.curLedger(), todayStr());
  const isRes = () => C.isResearch(store.curLedger());
  const ledgerSoon = () => { const l = store.curLedger(); return !!l && l.status !== 'active'; };
  const monthChips = (act) => {
    const led = store.curLedger();
    const months = C.monthsOf(led);
    const first = months[0];
    const cur = curMonth();
    return `<div class="chips month-chips" role="tablist">${months.map((m) => `<button class="chip-f press ${cur === m.ym ? 'on' : ''}" data-act="${act}" data-ym="${m.ym}">${esc(C.monthLabel(m, first))}</button>`).join('')}</div>`;
  };
  function say(msg, ms = 2200) { ui.notice = msg; rerender(); setTimeout(() => { if (ui.notice === msg) { ui.notice = ''; rerender(); } }, ms); }

  /* ============================== 그리기 ============================== */
  function render() {
    renderQueued = false;
    const el = document.activeElement;
    const keep = el && el.dataset && el.dataset.keep ? { k: el.dataset.keep, s: el.selectionStart, e: el.selectionEnd } : null;
    const vals = {};
    root.querySelectorAll('[data-keep]').forEach((i) => { vals[i.dataset.keep] = i.value; });
    const sb = root.querySelector('.sheet-body'); const sbTop = sb ? sb.scrollTop : 0; const winY = window.scrollY;
    const html = S.phase === 'login' ? loginHtml() : S.phase === 'app' ? appHtml() : '<div class="boot">불러오는 중입니다…</div>';
    root.innerHTML = html + sheetHtml() + dialogHtml();
    { const nb = root.querySelector('.sheet-body'); if (nb && sbTop) nb.scrollTop = sbTop; if (winY && Math.abs(window.scrollY - winY) > 1) window.scrollTo(0, winY); }
    document.documentElement.dataset.font = S.prefs.font;
    document.documentElement.dataset.reduce = S.prefs.reduceMotion ? '1' : '0';
    root.querySelectorAll('[data-keep]').forEach((i) => { if (vals[i.dataset.keep] !== undefined && i.dataset.restore !== '0') i.value = vals[i.dataset.keep]; });
    if (keep) {
      const n = root.querySelector(`[data-keep="${keep.k}"]`);
      if (n) { n.focus(); try { n.setSelectionRange(keep.s, keep.e); } catch { /* 숫자·날짜 칸 */ } }
    }
    const af = root.querySelector('[data-autofocus]');
    if (af && !keep && !ui._focused) af.focus();
    ui._focused = !!af;
    document.body.classList.toggle('no-scroll', !!ui.sheet || !!ui.dialog);
    toast.textContent = ui.notice; toast.classList.toggle('show', !!ui.notice);
  }
  const rerender = () => { if (!renderQueued) { renderQueued = true; queueMicrotask(render); } };

  /* ---------------------------- 로그인 ---------------------------- */
  function loginHtml() {
    const L = ui.login;
    const st = S.slots[0] || { slot: 1, state: 'set', locked_until: null };
    const locked = st.locked_until && Date.parse(st.locked_until) > store.now();
    const first = st.state === 'unset';
    const off = !S.online ? '<p class="notice warn">인터넷에 연결되어 있지 않습니다. 연결한 뒤 다시 열어 주세요.</p>' : '';
    const re = S.needReauth && !first ? '<p class="notice">로그인이 풀렸습니다. 비밀번호를 한 번만 다시 입력해 주세요.</p>' : '';
    const head = `<div class="login-head"><div class="logo-foot">${ICON.logo}</div><h1>${esc(APP_NAME)}</h1>`;
    if (st.state === 'disabled') return `<main class="login">${head}<p class="notice warn">지금은 열 수 없는 상태입니다.</p></div>${off}<p class="ver">버전 ${esc(APP_VERSION)}</p></main>`;
    const t = first
      ? '<p class="lead">처음 사용하시는군요.<br>사용할 비밀번호를 정해 주세요.</p><p class="muted">4자 이상이면 되지만 6자 이상을 권장합니다.</p>'
      : '<p class="lead">비밀번호를 입력해 주세요.</p>';
    const type = L.show ? 'text' : 'password';
    const lockMsg = locked ? `<p class="notice err" role="alert">비밀번호를 여러 번 틀려서 잠겼습니다. ${Math.max(1, Math.ceil((Date.parse(st.locked_until) - store.now()) / 60000))}분 뒤에 다시 해 주세요.</p>` : '';
    return `<main class="login">${head}${t}</div>${re}${off}${lockMsg}
      <label class="field"><span class="lbl">${first ? '새 비밀번호' : '비밀번호'}</span><input class="input" data-keep="pw1" data-autofocus type="${type}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="${first ? 'next' : 'go'}"></label>
      ${first ? `<label class="field"><span class="lbl">한 번 더 입력</span><input class="input" data-keep="pw2" type="${type}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go"></label>` : ''}
      <button class="link press" data-act="toggle-show">${L.show ? '가리기' : '비밀번호 보기'}</button>
      ${L.error ? `<p class="notice err" role="alert">${esc(L.error)}</p>` : ''}
      <button class="big-btn primary press" data-act="login-go" ${L.busy || locked ? 'disabled' : ''}>${L.busy ? '확인 중…' : first ? '정하고 시작하기' : '열기'}</button>
      <p class="ver">버전 ${esc(APP_VERSION)}</p></main>`;
  }

  /* ---------------------------- 본 화면 ---------------------------- */
  function appHtml() {
    if (ui.screen === 'records') return recordsHtml();
    if (ui.screen === 'report') return reportHtml();
    if (ui.screen === 'trash') return trashHtml();
    if (ui.screen === 'settings') return settingsHtml();
    return homeHtml();
  }

  function banners() {
    let b = '';
    const pend = S.outbox.reduce((n, e) => n + e.steps.reduce((m, s) => m + (s.rows ? s.rows.length : 1), 0), 0);
    if (!S.online) b += `<div class="banner warn">인터넷에 연결되어 있지 않습니다.${pend ? ` 올라가지 않은 기록 ${pend}건은 연결되면 자동으로 올라갑니다.` : ' 저장된 기록을 보여 드리는 중입니다.'}</div>`;
    else if (pend) b += `<div class="banner warn">올라가지 않은 기록 ${pend}건을 올리는 중입니다.</div>`;
    if (S.failed.length) b += `<div class="banner err"><div>올리지 못한 기록 ${S.failed.length}건이 있습니다.<br><span class="small">${esc(S.failed[0].message)}</span></div><div class="b-btns"><button class="mini press" data-act="retry-failed">다시 시도</button><button class="mini ghost press" data-act="discard-failed">버리기</button></div></div>`;
    if (S.needReauth) b += '<div class="banner err">로그인이 풀렸습니다. <button class="mini press" data-act="reauth">비밀번호 다시 입력</button></div>';
    if (S.lastError) b += `<div class="banner err">${esc(S.lastError)}</div>`;
    return b;
  }

  function ledgerChips() {
    return `<div class="ledger-chips" role="tablist">${S.ledgers.map((l) => `<button class="chip-f press ledger-chip ${store.curLedger() && store.curLedger().id === l.id ? 'on' : ''}" role="tab" data-act="pick-ledger" data-code="${l.code}">${esc(LEDGER_SHORT[l.code] || l.name)}${l.status !== 'active' ? ' <span class="soon">준비 중</span>' : ''}</button>`).join('')}</div>`;
  }

  function undoBarHtml() {
    const u = S.undo;
    if (!u || ui.sheet || !u.steps.length) return '';
    const left = Math.max(0, Math.ceil((u.expires - store.now()) / 1000));
    if (left <= 0) return '';
    const enter = !u._in; u._in = true;
    return `<div class="undo-bar${enter ? ' enter' : ''}" role="status"><span>${u.status === 'queued' ? '임시로 저장했습니다 (아직 올라가지 않음)' : `방금 ${esc(u.label)}`}</span><button class="undo-btn press" data-act="undo">되돌리기 <span class="count">${left}</span></button></div>`;
  }

  function txRow(t, pend) {
    const meta = (isRes()
      ? [t.category, t.sub_item && t.sub_item !== t.summary ? t.sub_item : null, t.proof_no ? `증빙 ${t.proof_no}` : null, t.pay_method]
      : [t.meal, t.category !== '식비' ? t.category : null, t.headcount ? `${t.headcount}명` : null]).filter(Boolean).join(' · ');
    const badges = `${t.source === 'scan' ? ' <span class="badge">영수증 스캔</span>' : ''}${pend.has(t.id) ? ' <span class="badge">올라가지 않음</span>' : ''}`;
    return `<button class="row tx-row press" data-act="edit-tx" data-id="${t.id}">
      <div class="r-l"><div class="r-date">${C.fmtMD(t.tx_date)}</div><div class="r-app">${C.weekday(t.tx_date)}요일</div></div>
      <div class="r-m"><div class="r-val">${num(t.amount)}<small>원</small></div><div class="r-sub"><b>${esc(t.summary)}</b></div>${meta || badges ? `<div class="r-sub muted">${esc(meta)}${badges}</div>` : ''}</div></button>`;
  }

  function homeHtml() {
    const led = store.curLedger();
    const t = todayStr();
    const head = `<header class="top"><div><div class="date">${C.fmtLongDate(t)}</div><div class="who">${esc(APP_NAME)}</div></div>
        <button class="set-btn press" data-act="go-settings" aria-label="설정">${ICON.gear}<span>설정</span></button></header>${ledgerChips()}${banners()}`;
    if (!led) return `<main class="home">${head}<p class="muted pad">장부를 불러오는 중입니다…</p></main>`;
    if (led.status !== 'active') {
      const cats = (led.categories || []).join(' · ');
      return `<main class="home">${head}<section class="card soon-card"><h2 class="c-name">${esc(led.name)}</h2><p class="lead">준비 중입니다.</p>
        <p class="muted">이 장부는 아직 입력할 수 없습니다. 비목 구조만 먼저 준비해 두었습니다.</p><p class="small muted">카드 끝 ${esc(led.card_last4 || '----')} · 비목 ${esc(cats)}</p></section></main>`;
    }
    if (C.isResearch(led)) return researchHomeHtml(led, head);
    const sm = store.summary();
    const pend = store.pendingIds();
    const recent = C.liveTx(store.ledgerTx()).sort(C.cmpTx).slice(0, 5);
    const mClass = sm.monthOver ? 'over' : '';
    const monthBig = sm.monthRemaining >= 0 ? `${won(sm.monthRemaining)} <small>남음</small>` : `${won(-sm.monthRemaining)} <small>초과</small>`;
    const totalBig = sm.totalRemaining >= 0 ? `${won(sm.totalRemaining)} <small>남음</small>` : `${won(-sm.totalRemaining)} <small>초과</small>`;
    const maxV = Math.max(sm.monthLimit * 1.25, ...sm.monthly.map((m) => m.used), 1);
    const bars = sm.monthly.map((m) => `<button class="mbar press ${m.current ? 'cur' : ''}" data-act="go-month" data-ym="${m.ym}" aria-label="${esc(m.label)} 사용 ${won(m.used)}">
        <span class="mb-val">${m.used ? C.fmtMan(m.used) : ''}</span><span class="mb-col"><i class="${m.over ? 'over' : ''}" style="height:${Math.max(m.used ? 3 : 0, (m.used / maxV) * 100)}%"></i></span><span class="mb-lbl">${esc(m.label)}</span></button>`).join('');
    const limitPos = Math.min(100, (sm.monthLimit / maxV) * 100);
    return `<main class="home">${head}
      <section class="card big-card ${mClass}" aria-label="이번 달"><div class="bc-top"><span class="bc-lbl">${sm.monthNo}월 사용 한도</span>${sm.monthOver ? '<span class="over-tag">한도 초과</span>' : ''}</div>
        <div class="bc-num ${mClass}">${monthBig}</div>
        <div class="meter"><i class="${mClass}" style="width:${Math.min(100, sm.monthPct)}%"></i></div>
        <div class="bc-sub"><span>사용 ${won(sm.monthUsed)}</span><span class="muted">월 한도 ${won(sm.monthLimit)}</span></div></section>
      <section class="card big-card ${sm.totalOver ? 'over' : ''}" aria-label="전체 예산"><div class="bc-top"><span class="bc-lbl">전체 예산 잔액</span><span class="muted small">${sm.monthsLeft > 0 ? `남은 ${sm.monthsLeft}개월` : '기간 끝'}</span></div>
        <div class="bc-num ${sm.totalOver ? 'over' : ''}">${totalBig}</div>
        <div class="meter"><i class="${sm.totalOver ? 'over' : ''}" style="width:${Math.min(100, sm.totalPct)}%"></i></div>
        <div class="bc-sub"><span>사용 ${won(sm.totalUsed)}</span><span class="muted">총 예산 ${won(sm.totalBudget)}</span></div></section>
      <section class="card chart-card" aria-label="월별 사용"><div class="bc-lbl">월별 사용 <span class="muted small">(${esc(led.period_start.slice(0, 7).replace('-', '.'))} ~ ${esc(led.period_end.slice(0, 7).replace('-', '.'))})</span></div>
        <div class="chart"><div class="limit-line" style="bottom:calc(${limitPos}% * .72 + 1.6rem)"><span>월 한도 ${C.fmtMan(sm.monthLimit)}</span></div>${bars}</div></section>
      <section class="card recent-card"><div class="rc-head"><span class="bc-lbl">최근 내역</span><button class="link press" data-act="go-records">전체 보기</button></div>
        <div class="list">${recent.length ? recent.map((x) => txRow(x, pend)).join('') : '<p class="muted pad">아직 입력한 내역이 없습니다.</p>'}</div></section>
      ${undoBarHtml()}
      <nav class="bottom"><button class="big-btn press" data-act="go-records">내역</button><button class="big-btn primary press" data-act="add-tx">지출 추가</button></nav></main>`;
  }

  function researchHomeHtml(led, head) {
    const rs = store.researchSummary();
    const pend = store.pendingIds();
    const recent = C.liveTx(store.ledgerTx()).sort(C.cmpTx).slice(0, 5);
    const pj = led.project || {};
    const big = rs.remaining >= 0 ? `${won(rs.remaining)} <small>남음</small>` : `${won(-rs.remaining)} <small>초과</small>`;
    const title = `<section class="card"><h2 class="c-name">${esc(pj.name || '과제명을 설정에서 적어 주세요')}</h2>
      <p class="muted small">${esc(pj.institution || '')}${pj.institution ? ' · ' : ''}연구기간 ${esc(led.period_start)} ~ ${esc(led.period_end)}</p></section>`;
    const total = rs.hasBudget
      ? `<section class="card big-card ${rs.over ? 'over' : ''}" aria-label="총 연구비"><div class="bc-top"><span class="bc-lbl">총 연구비 잔액</span></div><div class="bc-num ${rs.over ? 'over' : ''}">${big}</div>
        <div class="meter"><i class="${rs.over ? 'over' : ''}" style="width:${Math.min(100, rs.pct)}%"></i></div>
        <div class="bc-sub"><span>사용 ${won(rs.used)}</span><span class="muted">총 연구비 ${won(rs.total)}</span></div></section>`
      : `<section class="card"><p class="lead">연구비 예산이 아직 없습니다.</p><p class="muted">설정에서 비목별 예산을 적으면 잔액이 보입니다.</p><button class="big-btn press" data-act="go-settings">설정으로</button></section>`;
    const cats = rs.byCat.map((c) => `<div class="cat-row"><div class="cr-top"><b>${esc(c.cat)}</b><span class="${c.over ? 'over-text' : ''}">${c.remaining >= 0 ? `${won(c.remaining)} 남음` : `${won(-c.remaining)} 초과`}</span></div>
        <div class="meter small"><i class="${c.over ? 'over' : ''}" style="width:${Math.min(100, c.pct)}%"></i></div><div class="cr-sub muted small">예산 ${won(c.budget)} · 사용 ${won(c.used)}</div></div>`).join('');
    const mrows = rs.monthly.map((m) => `<tr><td>${esc(m.label)}</td><td class="r">${m.count ? num(m.used) : '-'}</td><td>${m.settle ? esc(C.fmtMD(m.settle)) : '-'}</td><td class="r">${num(m.cum)}</td></tr>`).join('');
    return `<main class="home">${head}${title}${total}
      ${cats ? `<section class="card"><div class="bc-lbl">비목별 예산</div><div class="cat-list">${cats}</div></section>` : ''}
      <section class="card"><div class="bc-lbl">월별 사용 · 정산일 · 지급신청 누적</div><div class="rep-wrap"><table class="rep rep-sm"><thead><tr><th>달</th><th>사용</th><th>정산일</th><th>누적(신청)</th></tr></thead><tbody>${mrows || '<tr><td colspan="4" class="muted">아직 입력한 내역이 없습니다.</td></tr>'}</tbody></table></div></section>
      <section class="card recent-card"><div class="rc-head"><span class="bc-lbl">최근 내역</span><button class="link press" data-act="go-records">전체 보기</button></div>
        <div class="list">${recent.length ? recent.map((x) => txRow(x, pend)).join('') : '<p class="muted pad">아직 입력한 내역이 없습니다.</p>'}</div></section>
      ${undoBarHtml()}
      <nav class="bottom"><button class="big-btn press" data-act="go-records">내역</button><button class="big-btn primary press" data-act="add-tx">지출 추가</button></nav></main>`;
  }

  /* ---------------------------- 내역·월 정산서 ---------------------------- */
  function recordsHtml() {
    const led = store.curLedger();
    const ym = curMonth();
    const rows = C.monthTx(store.ledgerTx(), ym, led);
    const used = C.sumAmount(rows);
    const e = C.effective(led);
    const res = C.isResearch(led);
    const over = !res && used > e.monthly_limit;
    const settleDay = res && rows.length ? rows.map((t) => t.settle_date || t.tx_date).sort().pop() : null;
    const pend = store.pendingIds();
    const trashCount = store.trashItems().length;
    return `<main class="page has-bottom"><header class="bar"><button class="back press" data-act="go-home" aria-label="뒤로">${ICON.back}<span>처음 화면</span></button></header>
      <h1 class="page-title">${esc(led ? led.name : '')} 내역</h1>${banners()}${monthChips('pick-month')}
      <div class="month-sum ${over ? 'over' : ''}"><span>${rows.length}건 · 사용 <b>${won(used)}</b></span>${res ? `<span class="muted">${settleDay ? `정산일 ${C.fmtMD(settleDay)}` : ''}</span>` : `<span class="muted">월 한도 ${won(e.monthly_limit)}${over ? ` · <b class="over-text">${won(used - e.monthly_limit)} 초과</b>` : ''}</span>`}</div>
      <section class="list">${rows.length ? rows.map((x) => txRow(x, pend)).join('') : '<p class="muted pad">이 달에는 입력한 내역이 없습니다.</p>'}</section>
      <div class="tool-btns"><button class="big-btn press" data-act="go-report">월 정산서 보기</button><button class="big-btn press" data-act="open-import">내역 가져오기</button></div>
      <button class="big-btn press trash-link" data-act="go-trash">휴지통${trashCount ? ` <span class="count-badge">${trashCount}</span>` : ''}</button>${undoBarHtml()}
      <nav class="bottom one"><button class="big-btn primary press" data-act="add-tx">지출 추가</button></nav></main>`;
  }

  function reportHtml() {
    const led = store.curLedger();
    const ym = curMonth();
    const rows = C.reportRows(store.ledgerTx(), ym, led);
    const used = C.sumAmount(rows);
    const e = C.effective(led);
    const [y, m] = ym.split('-').map(Number);
    const res = C.isResearch(led);
    const md = (d) => esc(d.slice(5).replace('-', '.'));
    const cols = res ? C.RESEARCH_REPORT_COLUMNS : C.REPORT_COLUMNS;
    const body = rows.map((t) => (res
      ? `<tr><td>${md(t.tx_date)}</td><td>${md(t.settle_date || t.tx_date)}</td><td class="l">${esc(t.category)}${t.sub_item ? `<br><small>${esc(t.sub_item)}</small>` : ''}</td><td class="l">${esc(t.summary)}</td><td class="r">${num(t.amount)}</td><td>${esc(t.proof_no || '')}</td><td>${esc(t.pay_method || '')}</td><td class="l">${esc(t.attendees || '')}</td></tr>`
      : `<tr><td>${md(t.tx_date)}</td><td>${md(t.settle_date || t.tx_date)}</td><td>${esc(t.meal || '')}</td><td class="l">${esc(t.summary)}</td><td class="r">${num(t.amount)}</td><td class="l">${esc(t.attendees || '')}</td><td class="r">${t.headcount ?? ''}</td></tr>`)).join('');
    return `<main class="page report"><header class="bar no-print"><button class="back press" data-act="go-records" aria-label="뒤로">${ICON.back}<span>내역</span></button></header>
      <h1 class="page-title">${esc(led ? led.name : '')} ${y}년 ${m}월 정산서</h1>
      <div class="no-print">${monthChips('pick-month')}</div>
      <p class="muted small no-print scroll-hint">표가 넓으면 옆으로 밀어서 보세요 →</p>
      <div class="rep-wrap"><table class="rep"><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}" class="muted">이 달에는 입력한 내역이 없습니다.</td></tr>`}</tbody>
        <tfoot><tr><td colspan="4" class="r">합계 (${rows.length}건)</td><td class="r">${num(used)}</td><td colspan="${cols.length - 5}"></td></tr></tfoot></table></div>
      ${res ? '' : `<p class="muted small">월 한도 ${won(e.monthly_limit)} 대비 ${used <= e.monthly_limit ? `${won(e.monthly_limit - used)} 남음` : `${won(used - e.monthly_limit)} 초과`}</p>`}
      <p class="muted small">이 표는 보조 자료입니다. 증빙은 정산서(워드)와 영수증 원본입니다.</p>
      <button class="big-btn primary press no-print" data-act="print">인쇄 / PDF로 저장</button>${undoBarHtml()}</main>`;
  }

  function trashHtml() {
    const items = store.trashItems();
    const rows = items.map((it) => `<div class="row trash-row"><div class="r-l"><div class="r-app strong">${esc(C.fmtMD(it.row.tx_date))} ${esc(it.row.summary)} ${won(it.row.amount)}</div>
        <div class="r-sub muted">${it.left}일 뒤 완전히 지워집니다</div></div><button class="mini press" data-act="restore" data-id="${it.row.id}">되살리기</button></div>`).join('');
    return `<main class="page"><header class="bar"><button class="back press" data-act="go-records" aria-label="뒤로">${ICON.back}<span>내역</span></button></header>
      <h1 class="page-title">휴지통</h1><p class="muted pad">지운 것은 30일 동안 여기에 있다가 완전히 지워집니다.</p>
      <section class="list">${rows || '<p class="muted pad">휴지통이 비어 있습니다.</p>'}</section>${undoBarHtml()}</main>`;
  }

  function settingsHtml() {
    const led = store.curLedger();
    const e = C.effective(led);
    const us = C.userSettings(S.userSettings);
    const [pm, pd] = us.receipt_purge_md.split('-').map(Number);
    const seg = (k) => `<button class="seg-btn press ${S.prefs.font === k ? 'on' : ''}" data-act="set-font" data-v="${k}">${FONT_LABEL[k]}</button>`;
    const kv = (k, v) => `<div class="kv"><span class="muted">${k}</span><b>${v}</b></div>`;
    return `<main class="page"><header class="bar"><button class="back press" data-act="go-home" aria-label="뒤로">${ICON.back}<span>처음 화면</span></button></header>
      <h1 class="page-title">설정</h1>
      <section class="set"><h2>글씨 크기</h2><div class="seg">${seg('normal')}${seg('large')}${seg('xlarge')}</div></section>
      <section class="set"><h2>움직임</h2><button class="toggle press ${S.prefs.reduceMotion ? 'on' : ''}" data-act="toggle-motion" role="switch" aria-checked="${S.prefs.reduceMotion}"><span>움직임 줄이기</span><span class="sw"><i></i></span></button></section>
      <section class="set"><h2>${esc(led ? led.name : '장부')} 예산</h2><div class="kv-box">
        ${kv(C.isResearch(led) ? '연구 기간' : '예산 기간', `${esc(e.period_start)} ~ ${esc(e.period_end)}`)}${C.isResearch(led) ? kv('총 연구비', won(C.researchTotal(led))) : `${kv('월 한도', won(e.monthly_limit))}${kv('총 예산', won(e.total_budget))}`}${kv('카드 끝 4자리', esc(e.card_last4 || '-'))}</div>
        ${C.isResearch(led) ? '<button class="big-btn press" data-act="edit-research">연구 설정 고치기 (과제·예산)</button>' : '<button class="big-btn press" data-act="edit-ledger">기간·한도 고치기</button>'}</section>
      <section class="set"><h2>영수증</h2><div class="kv-box">${kv('영수증 원본 삭제일', `매년 ${pm}월 ${pd}일`)}${kv('스캔 하루 등록 상한', `${us.scan_daily_max_count}건 · ${won(us.scan_daily_max_amount)}`)}</div>
        <button class="big-btn press" data-act="edit-receipt">삭제일·상한 고치기</button><p class="muted small pad0">영수증 사진은 이 앱에 올리지 않고 PC에만 보관합니다. 삭제일은 PC 쪽 정리 작업이 참고합니다.</p></section>
      <section class="set"><h2>비밀번호</h2><button class="big-btn press" data-act="pw-change">비밀번호 바꾸기</button></section>
      <section class="set"><h2>기기</h2><button class="big-btn press" data-act="logout-all">모든 기기에서 로그아웃</button><p class="muted small pad0">폰을 잃어버렸을 때 눌러 주세요.</p></section>
      <section class="set"><h2>앱 정보</h2><p class="muted">${esc(APP_NAME)} · 버전 ${esc(APP_VERSION)}</p><button class="big-btn danger press" data-act="logout">로그아웃</button></section></main>`;
  }

  /* ---------------------------- 시트 ---------------------------- */
  function dateChip(label, field, value, max) {
    return `<label class="chip-date press">${esc(label)} <span class="chg">· 바꾸기</span> ${ICON.caret}<input type="date" data-f="${field}" data-keep="${field}" data-restore="0" value="${esc(value)}" ${max ? `max="${max}"` : ''} aria-label="${esc(label)} 바꾸기"></label>`;
  }
  function errLine(sh) { return sh.error ? `<p class="notice err" role="alert">${esc(sh.error)}</p>` : ''; }
  const inputF = (field, attrs = '') => `data-f="${field}" data-keep="${field}" data-restore="0" ${attrs}`;

  function researchTxSheet(sh) {
    const f = sh.f; const led = store.curLedger(); const e = store.eff();
    const t = todayStr();
    const dlabel = f.tx_date === t ? `사용일자: 오늘 ${C.fmtMD(f.tx_date)}` : `사용일자: ${C.fmtMD(f.tx_date)} (${C.weekday(f.tx_date)})`;
    const cats = (e.categories || []).map((c) => `<button class="chip-f press ${f.category === c ? 'on' : ''}" data-act="pick-cat" data-v="${esc(c)}">${esc(c)}</button>`).join('');
    const subs = C.subitemsOf(led, f.category);
    const subChips = subs.length ? `<div class="lbl">세부 비목 (선택)</div><div class="chips mini-chips">${['없음'].concat(subs).map((x) => { const v = x === '없음' ? '' : x; return `<button class="chip-f press ${(f.sub_item || '') === v ? 'on' : ''}" data-act="pick-sub" data-v="${esc(v)}">${esc(x)}</button>`; }).join('')}</div>` : '';
    const kinds = C.kindChoices(led).map((k) => `<button class="chip-f press ${f.meal === k ? 'on' : ''}" data-act="pick-meal" data-v="${esc(k)}">${esc(k)}</button>`).join('');
    const pays = C.payChoices(led).map((k) => `<button class="chip-f press ${f.pay_method === k ? 'on' : ''}" data-act="pick-pay" data-v="${esc(k)}">${esc(k)}</button>`).join('');
    const rs = store.researchSummary();
    const info = `<p class="hint">${rs.hasBudget ? `총 연구비 잔액 ${won(rs.remaining)}` : '예산이 아직 없습니다(설정에서 입력)'} · 사용 ${won(rs.used)}</p>`;
    const edit = sh.mode === 'edit';
    const pending = edit && store.pendingIds().has(sh.id) ? '<p class="notice small">이 기록은 아직 올라가지 않았습니다.</p>' : '';
    const actions = edit
      ? `<div class="two-btn sticky-save"><button class="big-btn danger press" data-act="delete-tx" ${ui.busy ? 'disabled' : ''}>지우기</button><button class="big-btn primary press" data-act="save-tx" ${ui.busy ? 'disabled' : ''}>저장</button></div>`
      : `<div class="stack2 sticky-save"><button class="big-btn primary press" data-act="save-tx" ${ui.busy ? 'disabled' : ''}>${ui.busy ? '저장 중…' : '저장'}</button><button class="big-btn press" data-act="save-more" ${ui.busy ? 'disabled' : ''}>저장하고 하나 더</button></div>`;
    return `${info}<div class="row-between">${dateChip(dlabel, 'tx_date', f.tx_date, t)}</div>
      <label class="field"><span class="lbl">금액 (원)</span><input class="input amount" ${inputF('amount', 'type="text" inputmode="numeric" autocomplete="off" placeholder="0"')} value="${esc(f.amount)}"></label>
      <label class="field"><span class="lbl">세부내역 (적요)</span><input class="input" ${inputF('summary', 'type="text" maxlength="60" autocomplete="off" placeholder="예: 회의비"')} value="${esc(f.summary)}"></label>
      <div class="lbl">비목</div><div class="chips mini-chips">${cats}</div>${subChips}
      <div class="lbl">구분</div><div class="chips mini-chips">${kinds}</div>
      <div class="lbl">결제수단</div><div class="chips mini-chips">${pays}</div>
      <label class="field"><span class="lbl">증빙번호 (선택)</span><input class="input" ${inputF('proof_no', 'type="text" maxlength="20" autocomplete="off"')} value="${esc(f.proof_no)}"></label>
      <label class="field"><span class="lbl">사용처 (선택)</span><input class="input" ${inputF('vendor', 'type="text" maxlength="40" autocomplete="off"')} value="${esc(f.vendor)}"></label>
      <label class="field"><span class="lbl">참가자 (선택)</span><input class="input" ${inputF('attendees', 'type="text" maxlength="120" autocomplete="off"')} value="${esc(f.attendees)}"></label>
      <label class="field"><span class="lbl">인원 (선택)</span><input class="input" ${inputF('headcount', 'type="text" inputmode="numeric" autocomplete="off" placeholder="명"')} value="${esc(f.headcount)}"></label>
      <details class="more" ${f.settle_date && f.settle_date !== f.tx_date ? 'open' : ''}><summary class="link">정산일자 바꾸기 (비우면 사용일자와 같음)</summary>
        <div class="row-between">${dateChip(f.settle_date ? `정산일자: ${C.fmtMD(f.settle_date)}` : '정산일자: 사용일자와 같음', 'settle_date', f.settle_date || f.tx_date)}</div></details>
      ${pending}${errLine(sh)}${actions}
      ${edit ? `<h3 class="sub-h">이전 값</h3>${historyHtml(sh)}` : ''}`;
  }

  function researchEditSheet(sh) {
    const f = sh.f; const led = store.curLedger();
    const buds = led.categories.map((c, i) => `<label class="field"><span class="lbl">${esc(c)} 예산 (원)</span><input class="input" ${inputF('bud_' + i, 'type="text" inputmode="numeric"')} value="${esc(f.buds[i])}"></label>`).join('');
    const total = f.buds.reduce((a, v) => a + (digitsOf(v) ? Number(digitsOf(v)) : 0), 0);
    return `<p class="hint">과제 정보와 비목별 예산입니다. 총 연구비는 비목별 예산의 합으로 맞춥니다. 계좌번호 같은 금융 정보는 적지 않습니다.</p>
      <label class="field"><span class="lbl">과제명</span><input class="input" ${inputF('name', 'type="text" maxlength="100"')} value="${esc(f.name)}"></label>
      <label class="field"><span class="lbl">지원기관</span><input class="input" ${inputF('institution', 'type="text" maxlength="60"')} value="${esc(f.institution)}"></label>
      <div class="row-between">${dateChip(`연구 시작일: ${f.period_start}`, 'period_start', f.period_start)}</div>
      <div class="row-between">${dateChip(`연구 종료일: ${f.period_end}`, 'period_end', f.period_end)}</div>
      <label class="field"><span class="lbl">카드 끝 4자리 (영수증 분류용)</span><input class="input" ${inputF('card_last4', 'type="text" inputmode="numeric" maxlength="4"')} value="${esc(f.card_last4)}"></label>
      ${buds}<p class="hint">총 연구비 ${won(total)}</p>${errLine(sh)}
      <button class="big-btn primary press sticky-save" data-act="save-research" ${ui.busy ? 'disabled' : ''}>저장</button>`;
  }

  function txSheet(sh) {
    if (isRes()) return researchTxSheet(sh);
    const f = sh.f; const e = store.eff();
    const t = todayStr();
    const dlabel = f.tx_date === t ? `사용일자: 오늘 ${C.fmtMD(f.tx_date)}` : `사용일자: ${C.fmtMD(f.tx_date)} (${C.weekday(f.tx_date)})`;
    const sug = store.suggestions().filter((s) => s !== f.summary).map((s) => `<button class="chip-f press" data-act="pick-summary" data-v="${esc(s)}">${esc(s)}</button>`).join('');
    const cats = (e.categories || C.CATEGORIES).map((c) => `<button class="chip-f press ${f.category === c ? 'on' : ''}" data-act="pick-cat" data-v="${esc(c)}">${esc(c)}</button>`).join('');
    const meals = MEAL_CHOICES.concat(['해당 없음']).map((m) => { const on = m === '해당 없음' ? !f.meal : f.meal === m; return `<button class="chip-f press ${on ? 'on' : ''}" data-act="pick-meal" data-v="${m === '해당 없음' ? '' : m}">${m}</button>`; }).join('');
    const sm = store.summary();
    const info = `<p class="hint">${sm.monthNo}월 사용 ${won(sm.monthUsed)} / 월 한도 ${won(sm.monthLimit)} · 전체 잔액 ${won(sm.totalRemaining)}</p>`;
    const edit = sh.mode === 'edit';
    const pending = edit && store.pendingIds().has(sh.id) ? '<p class="notice small">이 기록은 아직 올라가지 않았습니다.</p>' : '';
    const actions = edit
      ? `<div class="two-btn sticky-save"><button class="big-btn danger press" data-act="delete-tx" ${ui.busy ? 'disabled' : ''}>지우기</button><button class="big-btn primary press" data-act="save-tx" ${ui.busy ? 'disabled' : ''}>저장</button></div>`
      : `<div class="stack2 sticky-save"><button class="big-btn primary press" data-act="save-tx" ${ui.busy ? 'disabled' : ''}>${ui.busy ? '저장 중…' : '저장'}</button><button class="big-btn press" data-act="save-more" ${ui.busy ? 'disabled' : ''}>저장하고 하나 더</button></div>`;
    return `${info}<div class="row-between">${dateChip(dlabel, 'tx_date', f.tx_date, t)}</div>
      <label class="field"><span class="lbl">금액 (원)</span><input class="input amount" ${inputF('amount', 'type="text" inputmode="numeric" autocomplete="off" placeholder="0"')} value="${esc(f.amount)}"></label>
      <label class="field"><span class="lbl">적요 (사용처·내용)</span><input class="input" ${inputF('summary', 'type="text" maxlength="60" autocomplete="off" placeholder="예: 점심 식사"')} value="${esc(f.summary)}"></label>
      ${sug ? `<div class="chips mini-chips" aria-label="자주 쓴 적요">${sug}</div>` : ''}
      <div class="lbl">항목</div><div class="chips mini-chips">${cats}</div>
      <div class="lbl">구분</div><div class="chips mini-chips">${meals}</div>
      <label class="field"><span class="lbl">참가자</span><input class="input" ${inputF('attendees', 'type="text" maxlength="120" autocomplete="off" placeholder="예: 홍길동 외 2명"')} value="${esc(f.attendees)}"></label>
      <label class="field"><span class="lbl">인원</span><input class="input" ${inputF('headcount', 'type="text" inputmode="numeric" autocomplete="off" placeholder="명"')} value="${esc(f.headcount)}"></label>
      <details class="more" ${f.settle_date && f.settle_date !== f.tx_date ? 'open' : ''}><summary class="link">정산일자 바꾸기 (비우면 사용일자와 같음)</summary>
        <div class="row-between">${dateChip(f.settle_date ? `정산일자: ${C.fmtMD(f.settle_date)}` : '정산일자: 사용일자와 같음', 'settle_date', f.settle_date || f.tx_date)}</div></details>
      ${pending}${errLine(sh)}${actions}
      ${edit ? `<h3 class="sub-h">이전 값</h3>${historyHtml(sh)}` : ''}`;
  }

  function historyHtml(sh) {
    if (!sh.historyLoaded) return '<p class="muted small">이전 값을 불러오는 중입니다…</p>';
    const list = C.valueHistory(sh.history);
    if (!list.length) return '<p class="muted small">고친 적이 없습니다.</p>';
    const f = (o) => `${num(o.amount)}원 · ${esc(o.summary || '')}`;
    return `<ul class="hist">${list.map((h) => `<li><div><div class="h-time">${C.fmtMD(C.kstDate(h.at))} ${C.kstTime(h.at)}에 고침</div><div class="h-vals"><b>${f(h.old)}</b> <span class="muted small">→ ${f(h.new)}</span></div></div><button class="mini ghost press" data-act="hist-restore" data-id="${h.id}">이 값으로</button></li>`).join('')}</ul>`;
  }

  function importSheet(sh) {
    const p = sh.parsed;
    let result = '';
    if (p) {
      const errs = p.errors.slice(0, 8).map((x) => `<li>${x.line ? `${x.line}번째 줄: ` : ''}${esc(x.msg)}</li>`).join('');
      const inc = p.skippedDup.filter((d) => (sh.includeDup || []).includes(d.line));
      const cnt = p.rows.length + inc.length; const tot = p.total + C.sumAmount(inc.map((d) => d.f));
      result = `<div class="imp-result"><p><b>${cnt}건</b> 넣을 수 있습니다 · 합계 <b>${won(tot)}</b></p>
        ${p.skippedDup.length ? `<div class="notice warn small"><b>중복으로 보여 건너뛰는 줄 ${p.skippedDup.length}개</b> — 같은 날·같은 금액·같은 적요입니다. 실제로 두 건이면 「포함」을 눌러 주세요.</div><ul class="imp-dups">${p.skippedDup.map((d) => `<li><span>${d.line}번째 줄 · ${esc(C.fmtMD(d.f.tx_date))} ${esc(d.f.summary)} ${won(d.f.amount)}<br><span class="muted small">${esc(d.reason)}</span></span><button class="chip-f press ${(sh.includeDup || []).includes(d.line) ? 'on' : ''}" data-act="imp-toggle-dup" data-line="${d.line}">${(sh.includeDup || []).includes(d.line) ? '포함함' : '포함'}</button></li>`).join('')}</ul>` : ''}
        ${p.errors.length ? `<p class="notice err small">읽지 못한 줄 ${p.errors.length}개 (넣지 않습니다)</p><ul class="imp-err">${errs}</ul>` : ''}</div>`;
    }
    return `<p class="hint">${isRes() ? '연구비 정산 자료(사용일자·세부내역·항목(비목)·금액·증빙번호·결제수단·정산일자·참가자)를 ' : '정산서 표를 '}복사해 붙여 넣거나 CSV 글을 붙여 넣으세요. 첫 줄에 머리글이 있으면 그 순서를 따르고, 없으면 사용일자, 정산일자, 구분, 적요, 금액, 참가자, 인원[, 항목] 순서로 읽습니다.<br>읽는 머리글: 사용일자(사용일·날짜), 정산일자, 구분, 적요(내용·세부내역), 금액, 참가자, 인원, 항목(비목·분류), 사용처, 증빙번호, 결제수단, 세부비목. 신청일자·연번·과제명·지원기관·사용월·원문불확실은 읽지 않고 넘어갑니다.</p>
      <textarea class="input imp-text" ${inputF('importText', 'rows="7" spellcheck="false" placeholder="2026-08-06,2026-08-06,중식,예시 식당,50000,예시인 외 2명,3"')}>${esc(sh.text)}</textarea>
      ${result}${errLine(sh)}
      <div class="two-btn sticky-save"><button class="big-btn press" data-act="imp-preview">미리 보기</button><button class="big-btn primary press" data-act="imp-go" ${!p || (!p.rows.length && !(sh.includeDup || []).length) || ui.busy ? 'disabled' : ''}>${p && (p.rows.length || (sh.includeDup || []).length) ? `${p.rows.length + (sh.includeDup || []).length}건 넣기` : '넣기'}</button></div>`;
  }

  function ledgerEditSheet(sh) {
    const f = sh.f;
    return `<p class="hint">기간이나 한도가 바뀔 때만 고치세요. 이미 입력한 내역은 그대로이고, 새 기간 밖의 내역은 합계에서 빠집니다.</p>
      <div class="row-between">${dateChip(`시작일: ${f.period_start}`, 'period_start', f.period_start)}</div>
      <div class="row-between">${dateChip(`끝나는 날: ${f.period_end}`, 'period_end', f.period_end)}</div>
      <label class="field"><span class="lbl">월 한도 (원)</span><input class="input" ${inputF('monthly_limit', 'type="text" inputmode="numeric"')} value="${esc(f.monthly_limit)}"></label>
      <label class="field"><span class="lbl">총 예산 (원)</span><input class="input" ${inputF('total_budget', 'type="text" inputmode="numeric"')} value="${esc(f.total_budget)}"></label>
      <label class="field"><span class="lbl">카드 끝 4자리 (영수증 분류용)</span><input class="input" ${inputF('card_last4', 'type="text" inputmode="numeric" maxlength="4"')} value="${esc(f.card_last4)}"></label>
      ${errLine(sh)}<button class="big-btn primary press sticky-save" data-act="save-ledger" ${ui.busy ? 'disabled' : ''}>저장</button>`;
  }
  function receiptEditSheet(sh) {
    const f = sh.f;
    return `<label class="field"><span class="lbl">영수증 원본 삭제일 (월-일)</span><input class="input" ${inputF('receipt_purge_md', 'type="text" maxlength="5" placeholder="03-01"')} value="${esc(f.receipt_purge_md)}"></label>
      <p class="hint">매년 이 날짜에 PC에 보관한 영수증 사진을 지웁니다. 지금은 연구비와 같은 3월 1일입니다.</p>
      <label class="field"><span class="lbl">스캔 하루 등록 상한 (건)</span><input class="input" ${inputF('scan_daily_max_count', 'type="text" inputmode="numeric"')} value="${esc(f.scan_daily_max_count)}"></label>
      <label class="field"><span class="lbl">스캔 하루 등록 상한 (원)</span><input class="input" ${inputF('scan_daily_max_amount', 'type="text" inputmode="numeric"')} value="${esc(f.scan_daily_max_amount)}"></label>
      ${errLine(sh)}<button class="big-btn primary press sticky-save" data-act="save-receipt" ${ui.busy ? 'disabled' : ''}>저장</button>`;
  }
  function savedSheet(sh) {
    const u = S.undo;
    const left = u ? Math.max(0, Math.ceil((u.expires - store.now()) / 1000)) : 0;
    const queued = sh.status === 'queued';
    const play = !sh._play ? ' play' : ''; sh._play = true;
    const head = queued
      ? `<div class="saved-head queued"><div class="ic-wrap${play}">${ICON.check}</div><h2>임시로 저장했습니다</h2><p class="muted">인터넷이 연결되면 자동으로 올라갑니다.<br>아직 올라가지 않았습니다.</p></div>`
      : `<div class="saved-head"><div class="ic-wrap${play}">${ICON.check}</div><h2>${esc(sh.headline)}</h2></div>`;
    const undoBtn = u && u.steps.length && left > 0 ? `<button class="big-btn press" data-act="undo-sheet">되돌리기 <span class="count">${left}</span></button>` : '';
    return `${head}<div class="saved-body">${sh.lines.map((l) => `<p>${l}</p>`).join('')}</div>
      <div class="saved-actions">${sh.again ? '<button class="big-btn primary press" data-act="add-again">하나 더 입력</button>' : ''}${undoBtn}<button class="big-btn ${sh.again ? '' : 'primary'} press" data-act="close-sheet">닫기</button></div>`;
  }
  function fontSheet() {
    const b = (k, sz) => `<button class="font-opt press ${S.prefs.font === k ? 'on' : ''}" data-act="set-font-first" data-v="${k}"><span class="fo-name">${FONT_LABEL[k]}</span><span class="fo-sample" style="font-size:${sz}px">12,345</span></button>`;
    return `<p class="lead small-lead">글씨 크기를 고르세요.<br><span class="muted">나중에 설정에서 바꿀 수 있습니다.</span></p>${b('normal', 22)}${b('large', 28)}${b('xlarge', 34)}`;
  }
  function pwSheet(sh) {
    return `<p class="hint">새 비밀번호는 4자 이상이면 되지만 6자 이상을 권장합니다.</p><label class="field"><span class="lbl">지금 비밀번호</span><input class="input" data-keep="pwcur" data-restore="0" type="password" autocomplete="off"></label>
      <label class="field"><span class="lbl">새 비밀번호</span><input class="input" data-keep="pwnew" data-restore="0" type="password" autocomplete="off"></label>
      <label class="field"><span class="lbl">새 비밀번호 한 번 더</span><input class="input" data-keep="pwnew2" data-restore="0" type="password" autocomplete="off"></label>
      ${errLine(sh)}<button class="big-btn primary press sticky-save" data-act="save-pw" ${ui.busy ? 'disabled' : ''}>바꾸기</button>`;
  }

  function sheetInner(sh) {
    const map = {
      tx: [sh.mode === 'edit' ? '지출 고치기' : '지출 추가', txSheet],
      import: ['내역 가져오기', importSheet], 'research-edit': ['연구 설정', researchEditSheet], 'ledger-edit': ['기간·한도 고치기', ledgerEditSheet], 'receipt-edit': ['영수증 설정', receiptEditSheet],
      saved: ['', savedSheet], font: ['글씨 크기', fontSheet], pwchange: ['비밀번호 바꾸기', pwSheet],
    };
    const [title, fn] = map[sh.kind] || ['', () => ''];
    return { title, inner: fn(sh) };
  }
  function sheetHtml() {
    const sh = ui.sheet;
    if (!sh) return '';
    const { title, inner } = sheetInner(sh);
    const showClose = sh.kind !== 'font';
    const enter = !sh._in && !sh.closing; sh._in = true;
    return `<div class="scrim ${sh.closing ? 'out' : enter ? 'enter' : ''}" data-act="${sh.kind === 'font' ? 'noop' : 'close-sheet'}"></div>
      <div class="sheet ${sh.closing ? 'out' : enter ? 'enter' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="sheet-head"><h2>${esc(title)}</h2>${showClose ? `<button class="icon-btn press" data-act="close-sheet" aria-label="닫기">${ICON.close}</button>` : ''}</div>
        <div class="sheet-body">${inner}</div></div>`;
  }

  /* ---------------------------- 확인창 ---------------------------- */
  function dialogHtml() {
    const d = ui.dialog;
    if (!d) return '';
    const enter = !d._in; d._in = true;
    return `<div class="scrim dlg-scrim"></div><div class="dialog${enter ? ' enter' : ''}" role="alertdialog" aria-modal="true"><h2>${esc(d.title)}</h2>${d.body.map((l) => `<p>${l}</p>`).join('')}
      <div class="dlg-btns">${d.buttons.map((b) => `<button class="big-btn ${b.kind || ''} press" data-act="dlg" data-i="${b.i}">${esc(b.label)}</button>`).join('')}</div></div>`;
  }
  function ask({ title, body, buttons }) {
    return new Promise((resolve) => { ui.dialog = { title, body, buttons: buttons.map((b, i) => ({ ...b, i })), resolve }; rerender(); });
  }
  function answer(i) { const d = ui.dialog; ui.dialog = null; rerender(); if (d) d.resolve(d.buttons[i].value); }

  /* ============================== 시트 열고 닫기 ============================== */
  function openSheet(sh) {
    ui.notice = '';
    ui.sheet = { error: '', ...sh };
    try { history.pushState({ s: 1 }, ''); ui._pushed = (ui._pushed || 0) + 1; } catch { /* 무시 */ }
    rerender();
  }
  function closeSheet({ fromPop = false } = {}) {
    if (!ui.sheet) return;
    if (!fromPop && ui._pushed) { ui._pushed--; ui._ignorePop = true; try { history.back(); } catch { /* 무시 */ } }
    if (S.prefs.reduceMotion || !root.querySelector('.sheet')) { ui.sheet = null; rerender(); return; }
    ui.sheet.closing = true; rerender();
    setTimeout(() => { ui.sheet = null; rerender(); }, 160);
  }
  function switchSheet(sh) { ui.sheet = { error: '', _in: ui.sheet && ui.sheet._in, ...sh }; rerender(); }

  const emptyForm = (over = {}) => ({ tx_date: todayStr(), settle_date: '', amount: '', summary: '', category: store.eff().categories[0] || '식비', meal: '', attendees: '', headcount: '', sub_item: '', pay_method: isRes() ? (C.payChoices(store.curLedger())[0] || '') : '', proof_no: '', vendor: '', ...over });
  function openAdd() {
    store.clearUndo();
    if (ledgerSoon()) { say(`${store.curLedger().name} 장부는 아직 준비 중이라 입력할 수 없습니다.`, 3200); return; }
    openSheet({ kind: 'tx', mode: 'add', f: emptyForm() });
  }
  async function openEdit(id) {
    const t = store.findTx(id);
    if (!t) return;
    openSheet({ kind: 'tx', mode: 'edit', id, history: [], historyLoaded: false,
      f: { tx_date: t.tx_date, settle_date: t.settle_date && t.settle_date !== t.tx_date ? t.settle_date : '', amount: C.fmtNum(t.amount), summary: t.summary, category: t.category, meal: t.meal || '', attendees: t.attendees || '', headcount: t.headcount ? String(t.headcount) : '', sub_item: t.sub_item || '', pay_method: t.pay_method || '', proof_no: t.proof_no || '', vendor: t.vendor || '' } });
    const h = await store.historyOf(id);
    if (ui.sheet && ui.sheet.id === id) { ui.sheet.history = h; ui.sheet.historyLoaded = true; rerender(); }
  }

  /* ============================== 저장 동작 ============================== */
  async function guarded(fn) {
    if (ui.busy) return;
    ui.busy = true; rerender();
    try { await fn(); } finally { ui.busy = false; rerender(); }
  }
  function saveErrorText(e) {
    if (e instanceof SaveError || e instanceof ApiError) return e.message;
    if (e instanceof NetworkError) return '인터넷에 연결되어 있지 않습니다.';
    return '저장하지 못했습니다. 입력한 내용은 그대로 두었으니 다시 눌러 주세요.';
  }
  function readForm(sh) {
    const f = sh.f;
    const amount = digitsOf(f.amount) ? Number(digitsOf(f.amount)) : NaN;
    const hc = digitsOf(f.headcount);
    return {
      tx_date: f.tx_date, settle_date: f.settle_date || f.tx_date, category: f.category, meal: f.meal || null,
      summary: String(f.summary || '').replace(/\s+/g, ' ').trim(), amount: Number.isNaN(amount) ? 0 : amount,
      attendees: String(f.attendees || '').trim() || null, headcount: hc ? Number(hc) : null,
      sub_item: f.sub_item || null, pay_method: f.pay_method || null, proof_no: String(f.proof_no || '').trim() || null, vendor: String(f.vendor || '').trim() || null,
    };
  }
  function txLines(row) {
    if (isRes()) {
      const rs = store.researchSummary();
      const c = rs.byCat.find((x) => x.cat === row.category);
      return [`<b>${esc(row.summary)}</b> · ${C.fmtMD(row.tx_date)} <b class="big">${won(row.amount)}</b>`,
        c ? `${esc(c.cat)} 잔액 <b>${won(c.remaining)}</b>` : '', rs.hasBudget ? `총 연구비 잔액 <b>${won(rs.remaining)}</b>` : ''].filter(Boolean);
    }
    const sm = store.summary();
    return [`<b>${esc(row.summary)}</b> · ${C.fmtMD(row.tx_date)} <b class="big">${won(row.amount)}</b>`,
      `${sm.monthNo}월 사용 <b>${won(sm.monthUsed)}</b> / 월 한도 ${won(sm.monthLimit)}${sm.monthOver ? ' <b class="over-text">(한도 초과)</b>' : ''}`,
      `전체 예산 잔액 <b>${won(sm.totalRemaining)}</b>`];
  }

  async function doSaveTx(more) {
    const sh = ui.sheet;
    const f = readForm(sh);
    const chk = C.checkEntry({ tx: store.ledgerTx(), settings: store.curLedger(), f, today: todayStr(), exceptId: sh.mode === 'edit' ? sh.id : null });
    if (chk.error) { sh.error = chk.error; return rerender(); }
    // 월 한도 초과는 막지 않는다(빨간 표시만). 아래는 되묻기만 한다.
    if (chk.dup) {
      const a = await ask({ title: '같은 내역이 이미 있습니다', body: [`${C.fmtMD(f.tx_date)} · ${esc(f.summary)} · <b>${won(f.amount)}</b>`, '그래도 저장할까요?'], buttons: [{ label: '그래도 저장', kind: 'primary', value: 'go' }, { label: '다시 보기', kind: 'ghost', value: 'no' }] });
      if (a !== 'go') return;
    }
    if (chk.big) {
      const a = await ask({ title: '금액이 큽니다', body: [`<b>${won(f.amount)}</b>입니다. 맞습니까?`], buttons: [{ label: '맞습니다, 저장', kind: 'primary', value: 'go' }, { label: '다시 입력', kind: 'ghost', value: 'no' }] });
      if (a !== 'go') return;
    }
    if (chk.overCat) {
      const a = await ask({ title: '비목 예산을 넘습니다', body: [`<b>${esc(f.category)}</b> 예산보다 <b>${won(chk.catOverBy)}</b> 많아집니다.`, '그래도 저장할까요?'], buttons: [{ label: '그래도 저장', kind: 'primary', value: 'go' }, { label: '다시 입력', kind: 'ghost', value: 'no' }] });
      if (a !== 'go') return;
    }
    if (chk.overTotal) {
      const a = await ask({ title: '총 예산을 넘습니다', body: [`이 금액을 더하면 전체 사용액이 <b>${won(chk.newTotal)}</b>이 되어 총 예산보다 <b>${won(chk.overBy)}</b> 많습니다.`, '그래도 저장할까요?'], buttons: [{ label: '그래도 저장', kind: 'primary', value: 'go' }, { label: '다시 입력', kind: 'ghost', value: 'no' }] });
      if (a !== 'go') return;
    }
    await guarded(async () => {
      try {
        if (sh.mode === 'edit') {
          const r = await store.editTx(sh.id, f);
          const row = store.findTx(sh.id);
          switchSheet({ kind: 'saved', status: r.status, headline: '고쳤습니다', lines: txLines(row) });
        } else {
          const r = await store.addTx(f);
          if (more) {
            ui.sheet.f = emptyForm({ tx_date: f.tx_date, category: f.category, meal: f.meal || '', pay_method: f.pay_method || '', sub_item: f.sub_item || '' });
            ui.sheet.error = ''; ui.sheet._in = true;
            say(r.status === 'queued' ? '임시로 저장했습니다. 하나 더 입력하세요.' : `저장됨 · ${won(f.amount)}. 하나 더 입력하세요.`, 2600);
            const amt = root.querySelector('[data-keep="amount"]'); if (amt) setTimeout(() => amt.focus(), 30);
          } else {
            switchSheet({ kind: 'saved', status: r.status, again: true, headline: '저장됨', lines: txLines(r.row) });
          }
        }
      } catch (e) { sh.error = saveErrorText(e); }
    });
  }

  async function doDelete() {
    const sh = ui.sheet; const row = store.findTx(sh.id);
    if (!row) return;
    const a = await ask({ title: '지울까요?', body: [`<b>${C.fmtMD(row.tx_date)} ${esc(row.summary)} ${won(row.amount)}</b>`, '지워도 휴지통에 30일 동안 있어서 되살릴 수 있습니다.'], buttons: [{ label: '지우기', kind: 'danger', value: 'go' }, { label: '그만두기', kind: 'ghost', value: 'no' }] });
    if (a !== 'go') return;
    await guarded(async () => {
      try { const r = await store.removeTx(sh.id); switchSheet({ kind: 'saved', status: r.status, headline: '지웠습니다', lines: ['<span class="muted">휴지통에서 30일 안에 되살릴 수 있습니다.</span>'] }); } catch (e) { sh.error = saveErrorText(e); }
    });
  }
  async function doHistRestore(hid) {
    const sh = ui.sheet; const h = (sh.history || []).find((x) => x.id === hid);
    if (!h) return;
    await guarded(async () => {
      try { const r = await store.restoreValue(sh.id, h); switchSheet({ kind: 'saved', status: r.status, headline: '이전 값으로 돌렸습니다', lines: txLines(store.findTx(sh.id)) }); } catch (e) { sh.error = saveErrorText(e); }
    });
  }
  async function doUndo(fromSheet) {
    await guarded(async () => {
      try { await store.undo(); if (fromSheet) closeSheet(); say('되돌렸습니다.'); } catch (e) { if (ui.sheet) ui.sheet.error = saveErrorText(e); else say(saveErrorText(e), 4000); }
    });
  }

  function doImportPreview() {
    const sh = ui.sheet;
    const text = (root.querySelector('[data-f="importText"]') || {}).value ?? sh.text;
    sh.text = text;
    sh.parsed = C.parseImport(text, { tx: store.ledgerTx(), settings: store.curLedger(), today: todayStr() });
    sh.includeDup = [];
    sh.error = '';
    rerender();
  }
  async function doImportGo() {
    const sh = ui.sheet;
    if (!sh.parsed) return;
    const p = sh.parsed;
    const inc = p.skippedDup.filter((d) => (sh.includeDup || []).includes(d.line));
    const all = p.rows.concat(inc.map((d) => ({ line: d.line, f: d.f })));
    if (!all.length) return;
    const tot = C.sumAmount(all.map((x) => x.f));
    const a = await ask({ title: `${all.length}건을 넣을까요?`, body: [`합계 <b>${won(tot)}</b>`, p.errors.length ? `읽지 못한 ${p.errors.length}줄은 넣지 않습니다.` : '넣은 직후 15초 동안 되돌릴 수 있습니다.'], buttons: [{ label: '넣기', kind: 'primary', value: 'go' }, { label: '그만두기', kind: 'ghost', value: 'no' }] });
    if (a !== 'go') return;
    await guarded(async () => {
      try {
        const r = await store.addMany(all.sort((a, b) => a.line - b.line).map((x) => x.f));
        const sm = store.summary();
        switchSheet({ kind: 'saved', status: r.status, headline: `${r.rows.length}건을 넣었습니다`, lines: [`합계 <b class="big">${won(tot)}</b>`, `전체 사용 <b>${won(sm.totalUsed)}</b> · 잔액 <b>${won(sm.totalRemaining)}</b>`] });
      } catch (e) { sh.error = saveErrorText(e); }
    });
  }

  /* ---------------------------- 로그인 동작 ---------------------------- */
  function loginErrorText(e) {
    if (e instanceof NetworkError) return '인터넷에 연결되어 있지 않습니다. 연결을 확인해 주세요.';
    if (e instanceof ApiError) {
      if (e.code === 'wrong') { const n = e.data && e.data.remaining; return n !== undefined ? `비밀번호가 달라요. ${n}번 더 해 볼 수 있어요.` : '비밀번호가 달라요.'; }
      if (e.code === 'locked') {
        const mins = e.data && e.data.until ? Math.max(1, Math.ceil((Date.parse(e.data.until) - store.now()) / 60000)) : 15;
        return `비밀번호를 여러 번 틀려서 잠겼습니다. ${mins >= 60 ? '1시간 뒤' : `${mins}분 뒤`}에 다시 해 주세요.`;
      }
      if (e.code === 'weak') return e.message;
      if (e.code === 'already_set') return '이미 비밀번호가 정해져 있습니다. 다시 열어 주세요.';
      if (e.code === 'disabled') return '지금은 열 수 없는 상태입니다.';
      if (e.code === 'unset') return '처음 사용 설정이 필요합니다.';
    }
    return '열지 못했습니다. 잠시 뒤에 다시 해 주세요.';
  }
  async function doLogin() {
    const L = ui.login; const st = S.slots[0] || { state: 'set' };
    const pw1 = (root.querySelector('[data-keep="pw1"]') || {}).value || '';
    const first = st.state === 'unset';
    if (first) {
      const pw2 = (root.querySelector('[data-keep="pw2"]') || {}).value || '';
      const bad = validatePassword(pw1);
      if (bad) { L.error = bad; return rerender(); }
      if (pw1 !== pw2) { L.error = '두 번 입력한 비밀번호가 다릅니다.'; return rerender(); }
    } else if (!pw1) { L.error = '비밀번호를 입력해 주세요.'; return rerender(); }
    L.busy = true; L.error = ''; rerender();
    try {
      if (first) await store.setup(1, pw1); else await store.login(1, pw1);
      L.busy = false; ui.screen = 'home';
      if (!S.prefs.fontChosen) openSheet({ kind: 'font' });
      rerender();
    } catch (e) {
      L.busy = false; L.error = loginErrorText(e);
      if (e instanceof ApiError && ['locked', 'disabled', 'already_set'].includes(e.code)) await store.loadSlots();
      rerender();
    }
  }

  /* ============================== 클릭 분배 ============================== */
  const num0 = (v) => { const d = digitsOf(v); return d ? Number(d) : NaN; };
  const actions = {
    noop() {},
    'toggle-show': () => { ui.login.show = !ui.login.show; rerender(); },
    'login-go': () => doLogin(),
    reauth: () => { store.logout().then(() => { ui.login = { error: '', busy: false, show: false }; rerender(); }); },
    'go-home': () => { ui.screen = 'home'; rerender(); },
    'go-records': () => { ui.screen = 'records'; rerender(); },
    'go-report': () => { ui.screen = 'report'; rerender(); },
    'go-trash': () => { ui.screen = 'trash'; rerender(); },
    'go-settings': () => { ui.screen = 'settings'; rerender(); },
    'go-month': (el) => { ui.month = el.dataset.ym; ui.screen = 'records'; rerender(); },
    'pick-month': (el) => { ui.month = el.dataset.ym; rerender(); },
    'pick-ledger': (el) => { store.setLedger(el.dataset.code); ui.month = null; rerender(); },
    print: () => { try { window.print(); } catch { say('인쇄를 열 수 없습니다.'); } },
    'add-tx': () => openAdd(),
    'edit-tx': (el) => openEdit(el.dataset.id),
    'close-sheet': () => closeSheet(),
    'add-again': () => { switchSheet({ kind: 'tx', mode: 'add', f: emptyForm({ tx_date: (ui.sheet && ui.sheet.lastDate) || todayStr() }) }); },
    'pick-summary': (el) => { ui.sheet.f.summary = el.dataset.v; ui.sheet.error = ''; rerender(); },
    'pick-cat': (el) => { ui.sheet.f.category = el.dataset.v; if (ui.sheet.f.sub_item && !C.subitemsOf(store.curLedger(), el.dataset.v).includes(ui.sheet.f.sub_item)) ui.sheet.f.sub_item = ''; rerender(); },
    'pick-meal': (el) => { ui.sheet.f.meal = el.dataset.v; rerender(); },
    'pick-sub': (el) => { ui.sheet.f.sub_item = el.dataset.v; rerender(); },
    'pick-pay': (el) => { ui.sheet.f.pay_method = el.dataset.v; rerender(); },
    'edit-research': () => {
      const led = store.curLedger(); const pj = led.project || {};
      openSheet({ kind: 'research-edit', f: { name: pj.name || '', institution: pj.institution || '', period_start: led.period_start, period_end: led.period_end, card_last4: led.card_last4 || '', buds: led.categories.map((c) => C.fmtNum((led.budgets || {})[c] || 0)) } });
    },
    'save-research': async () => {
      const sh = ui.sheet; const f = sh.f; const led = store.curLedger();
      const budgets = {}; led.categories.forEach((c, i) => { budgets[c] = digitsOf(f.buds[i]) ? Number(digitsOf(f.buds[i])) : 0; });
      await guarded(async () => {
        try { const r = await store.saveResearch({ name: f.name, institution: f.institution, period_start: f.period_start, period_end: f.period_end, budgets, card_last4: f.card_last4 }); closeSheet(); say(`저장했습니다. 총 연구비 ${won(r.total)}`, 3000); } catch (e) { sh.error = saveErrorText(e); }
      });
    },
    'save-tx': () => doSaveTx(false),
    'save-more': () => doSaveTx(true),
    'delete-tx': () => doDelete(),
    'hist-restore': (el) => doHistRestore(el.dataset.id),
    restore: async (el) => {
      await guarded(async () => { try { await store.restoreTx(el.dataset.id); say('되살렸습니다.'); } catch (e) { say(saveErrorText(e), 4000); } });
    },
    undo: () => doUndo(false),
    'undo-sheet': () => doUndo(true),
    'open-import': () => { if (ledgerSoon()) return say('이 장부는 아직 준비 중입니다.'); store.clearUndo(); openSheet({ kind: 'import', text: '', parsed: null }); },
    'imp-preview': () => doImportPreview(),
    'imp-go': () => doImportGo(),
    'imp-toggle-dup': (el) => { const sh = ui.sheet; const n = Number(el.dataset.line); sh.includeDup = sh.includeDup || []; const i = sh.includeDup.indexOf(n); if (i >= 0) sh.includeDup.splice(i, 1); else sh.includeDup.push(n); rerender(); },
    'edit-ledger': () => { const e = store.eff(); openSheet({ kind: 'ledger-edit', f: { period_start: e.period_start, period_end: e.period_end, monthly_limit: C.fmtNum(e.monthly_limit), total_budget: C.fmtNum(e.total_budget), card_last4: e.card_last4 || '' } }); },
    'save-ledger': async () => {
      const sh = ui.sheet; const f = sh.f;
      const patch = { period_start: f.period_start, period_end: f.period_end, monthly_limit: num0(f.monthly_limit), total_budget: num0(f.total_budget), card_last4: String(f.card_last4 || '').trim() };
      if (Number.isNaN(patch.monthly_limit) || Number.isNaN(patch.total_budget)) { sh.error = '금액을 숫자로 적어 주세요.'; return rerender(); }
      await guarded(async () => {
        try { const r = await store.saveLedger(patch); closeSheet(); say(r.outside ? `저장했습니다. 새 기간 밖의 내역 ${r.outside}건은 합계에서 빠집니다.` : '저장했습니다.', 3500); } catch (e) { sh.error = saveErrorText(e); }
      });
    },
    'edit-receipt': () => { const us = C.userSettings(S.userSettings); openSheet({ kind: 'receipt-edit', f: { receipt_purge_md: us.receipt_purge_md, scan_daily_max_count: String(us.scan_daily_max_count), scan_daily_max_amount: C.fmtNum(us.scan_daily_max_amount) } }); },
    'save-receipt': async () => {
      const sh = ui.sheet; const f = sh.f;
      const patch = { receipt_purge_md: String(f.receipt_purge_md).trim(), scan_daily_max_count: num0(f.scan_daily_max_count), scan_daily_max_amount: num0(f.scan_daily_max_amount) };
      if (Number.isNaN(patch.scan_daily_max_count) || Number.isNaN(patch.scan_daily_max_amount)) { sh.error = '숫자로 적어 주세요.'; return rerender(); }
      await guarded(async () => { try { await store.saveUserSettings(patch); closeSheet(); say('저장했습니다.'); } catch (e) { sh.error = saveErrorText(e); } });
    },
    'retry-failed': () => store.retryFailed(),
    'discard-failed': async () => {
      const a = await ask({ title: '올리지 못한 기록을 버릴까요?', body: ['버리면 이 기록은 사라집니다.'], buttons: [{ label: '버리기', kind: 'danger', value: 'go' }, { label: '그만두기', kind: 'ghost', value: 'no' }] });
      if (a === 'go') store.discardFailed();
    },
    'set-font': (el) => store.setFont(el.dataset.v),
    'set-font-first': (el) => { store.setFont(el.dataset.v); closeSheet(); },
    'toggle-motion': () => store.setReduceMotion(!S.prefs.reduceMotion),
    'pw-change': () => openSheet({ kind: 'pwchange' }),
    'save-pw': async () => {
      const sh = ui.sheet; const g = (k) => (root.querySelector(`[data-keep="${k}"]`) || {}).value || '';
      const cur = g('pwcur'); const n1 = g('pwnew'); const n2 = g('pwnew2');
      if (!cur) { sh.error = '지금 비밀번호를 입력해 주세요.'; return rerender(); }
      const bad = validatePassword(n1);
      if (bad) { sh.error = bad; return rerender(); }
      if (n1 !== n2) { sh.error = '새 비밀번호를 두 번 다르게 입력하셨습니다.'; return rerender(); }
      await guarded(async () => { try { await store.changePassword(cur, n1); closeSheet(); say('비밀번호를 바꾸었습니다.', 2500); } catch (e) { sh.error = loginErrorText(e); } });
    },
    'logout-all': async () => {
      const a = await ask({ title: '모든 기기에서 로그아웃할까요?', body: ['열려 있는 모든 폰에서 로그아웃됩니다.', '다시 쓰려면 비밀번호를 입력해야 합니다.'], buttons: [{ label: '로그아웃', kind: 'danger', value: 'go' }, { label: '그만두기', kind: 'ghost', value: 'no' }] });
      if (a !== 'go') return;
      await guarded(async () => { try { await store.logoutAllDevices(); ui.screen = 'home'; } catch (e) { say(saveErrorText(e), 4000); } });
    },
    logout: async () => {
      const a = await ask({ title: '로그아웃할까요?', body: ['이 폰에서만 로그아웃합니다. 기록은 그대로 있습니다.'], buttons: [{ label: '로그아웃', kind: 'danger', value: 'go' }, { label: '그만두기', kind: 'ghost', value: 'no' }] });
      if (a !== 'go') return;
      await store.logout(); ui.screen = 'home'; ui.login = { error: '', busy: false, show: false }; rerender();
    },
    dlg: (el) => answer(Number(el.dataset.i)),
  };

  root.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.disabled) return;
    if (ui.dialog && el.dataset.act !== 'dlg') return;
    const fn = actions[el.dataset.act];
    if (fn) { buzz(); Promise.resolve(fn(el)).catch((e) => { console.error(e); ui.busy = false; rerender(); }); }
  });
  root.addEventListener('focusin', (ev) => {
    const t = ev.target;
    if (t.matches && t.matches('.sheet input[type="text"], .sheet input[type="password"], .sheet textarea')) setTimeout(() => { try { t.scrollIntoView({ block: 'center' }); } catch { /* 무시 */ } }, 320);
  });
  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.matches && ev.target.matches('[data-keep="pw1"], [data-keep="pw2"]')) { ev.preventDefault(); doLogin(); }
    if (ev.key === 'Escape') { if (ui.dialog) answer(ui.dialog.buttons.length - 1); else closeSheet(); }
  });
  root.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.matches('[data-keep="pw1"], [data-keep="pw2"]')) ui.login.error = '';
    if (t.dataset && t.dataset.f && ui.sheet) {
      const k = t.dataset.f;
      if (k === 'importText') { ui.sheet.text = t.value; return; }
      let v = t.value;
      if (['amount', 'monthly_limit', 'total_budget', 'scan_daily_max_amount'].includes(k)) { v = fmtInput(v); t.value = v; }
      if (['headcount', 'scan_daily_max_count', 'card_last4'].includes(k)) { v = digitsOf(v); t.value = v; }
      if (/^bud_\d+$/.test(k)) { v = fmtInput(v); t.value = v; if (ui.sheet.f && ui.sheet.f.buds) ui.sheet.f.buds[Number(k.slice(4))] = v; ui.sheet.error = ''; return; }
      if (ui.sheet.f) ui.sheet.f[k] = v;
      ui.sheet.error = '';
    }
  });
  root.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset && t.dataset.f && t.type === 'date' && ui.sheet && ui.sheet.f && t.value) {
      let v = t.value;
      if (t.dataset.f === 'tx_date' && v > todayStr()) v = todayStr();
      ui.sheet.f[t.dataset.f] = v;
      ui.sheet.error = '';
      rerender();
    }
  });
  window.addEventListener('popstate', () => {
    if (ui._ignorePop) { ui._ignorePop = false; return; }
    if (ui.dialog) return;
    if (ui.sheet) { ui._pushed = Math.max(0, (ui._pushed || 1) - 1); closeSheet({ fromPop: true }); return; }
    if (ui.screen !== 'home') { ui.screen = ui.screen === 'report' || ui.screen === 'trash' ? 'records' : 'home'; rerender(); }
  });

  store.on(() => rerender());
  setInterval(() => {
    const un = S.undo;
    if (!un) return;
    const left = Math.ceil((un.expires - store.now()) / 1000);
    if (left <= 0) { store.expireUndo(); rerender(); return; }
    root.querySelectorAll('.undo-btn .count, [data-act="undo-sheet"] .count').forEach((el) => { if (el.textContent !== String(left)) el.textContent = String(left); });
  }, 1000);

  function showLoginFor() { ui.login = { error: '', busy: false, show: false }; rerender(); }
  return { ui, render, ask, actions, showLoginFor };
}
