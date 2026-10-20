// calc.js - 계산 규칙. 화면·서버와 무관한 순수 함수만 둡니다. 날짜는 항상 한국 시간(UTC+9) 기준입니다.
// 서버(SQL ex_ensure_ledgers)가 처음 만드는 운영비 장부 값과 같아야 합니다: 기간 2026-08-01~2027-02-28, 월 한도 300,000, 총 예산 2,100,000.

export const TZ_OFFSET_MIN = 540;
export const TRASH_DAYS = 30;
export const MAX_AMOUNT = 99999999;
export const BIG_AMOUNT = 1000000;      // 운영비: 이 금액 이상이면 저장 전에 한 번 더 확인
export const BIG_AMOUNT_RESEARCH = 5000000;   // 연구비: 이 금액 이상이면 확인(연구비는 비목 예산 초과 확인이 기본)
export const CATEGORIES = ['식비', '교통비', '회의비', '물품구매', '사무용품', '기타'];
export const MEALS = ['중식', '석식', '조식'];
// 장부(ledger) 한 개의 설정. 서버의 ex_ledgers 줄이 있으면 그 값을 쓰고, 없을 때만(서버 연결 전) 이 값을 씁니다.
// 화면 코드는 한도·기간·분류를 이 상수가 아니라 장부 설정에서 읽습니다.
export const DEFAULTS = {
  code: 'opex', name: '보직자 운영비', card_last4: null, status: 'active',
  period_start: '2026-08-01', period_end: '2027-02-28',
  monthly_limit: 300000, total_budget: 2100000,
  categories: CATEGORIES,
};
// 사용자 전체 설정(ex_settings)
export const USER_DEFAULTS = { receipt_purge_md: '03-01', scan_daily_max_count: 20, scan_daily_max_amount: 1000000 };
export const SUMMARY_MAX = 60;
// 영수증 스캔 계약(scan_contract §1)의 지시문 낱말: 적요에 들어 있으면 스캔 등록을 거절한다(서버도 같은 검사)
export const INSTR_WORDS = ['호출', '도구', 'call', 'tool', 'ignore', '무시', '지시', 'instruction', 'system', '프롬프트', 'prompt', '명령', '재시도', '두번', 'twice', 'delete', '삭제', 'export', '내보내', '실행'];
export const looksLikeInstruction = (t) => { const x = String(t).replace(/\s+/g, '').toLowerCase(); return INSTR_WORDS.some((w) => x.includes(w)); };
export const ATTENDEES_MAX = 120;

const pad2 = (n) => String(n).padStart(2, '0');

export function kstDate(d) {
  const t = new Date(new Date(d).getTime() + TZ_OFFSET_MIN * 60000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}
export function kstTime(d) {
  const t = new Date(new Date(d).getTime() + TZ_OFFSET_MIN * 60000);
  return `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
}
export function addDays(dateStr, n) {
  const t = new Date(`${dateStr}T12:00:00+09:00`);
  t.setUTCDate(t.getUTCDate() + n);
  return kstDate(t);
}
export const fmtMD = (dateStr) => { const [, m, d] = dateStr.split('-'); return `${Number(m)}/${Number(d)}`; };
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
export function weekday(dateStr) { return WEEK[new Date(`${dateStr}T12:00:00+09:00`).getUTCDay()]; }
export function fmtLongDate(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}월 ${d}일 (${weekday(dateStr)})`;
}
export function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  const neg = n < 0;
  const s = String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + s;
}
export const fmtWon = (n) => `${fmtNum(n)}원`;
/** 만 원 단위 짧은 표기: 300000 -> 30만, 12500 -> 1.3만 */
export function fmtMan(n) {
  if (n >= 10000) { const v = Math.round(n / 1000) / 10; return `${String(v).replace(/\.0$/, '')}만`; }
  return fmtNum(n);
}

export function effective(ledger) { return { ...DEFAULTS, ...(ledger || {}) }; }
export function userSettings(row) { return { ...USER_DEFAULTS, ...(row || {}) }; }

const live = (r) => !r.deleted_at;
export const liveTx = (tx) => tx.filter(live);
export const cmpTx = (a, b) => (a.tx_date === b.tx_date ? Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0) : a.tx_date < b.tx_date ? 1 : -1);

export const isResearch = (led) => !!led && led.code === 'research';
/** 연구비 장부의 기본 구분·결제수단 목록(서버 장부의 project 에 있으면 그것을 쓴다) */
export const RESEARCH_KINDS = ['직접비', '간접비'];
export const RESEARCH_PAY = ['법인카드', '개인카드', '계좌이체', '현금'];
export function kindChoices(led) { return isResearch(led) ? ((led.project && led.project.kinds) || RESEARCH_KINDS) : MEALS; }
export function payChoices(led) { return (led && led.project && led.project.pay_methods) || RESEARCH_PAY; }
export function subitemsOf(led, category) { return (led && led.subitems && led.subitems[category]) || []; }
/** 연구비 총 연구비: 장부의 총액이 있으면 그것, 없으면 비목별 예산의 합 */
export function researchTotal(led) {
  if (led && led.total_budget) return led.total_budget;
  return Object.values((led && led.budgets) || {}).reduce((a, b) => a + (Number(b) || 0), 0);
}

/** 예산 기간에 속한 달 목록 [{ym:'2026-08', y, m}] */
export function monthsOf(settings) {
  const s = effective(settings);
  const [sy, sm] = s.period_start.split('-').map(Number);
  const [ey, em] = s.period_end.split('-').map(Number);
  const out = [];
  for (let y = sy, m = sm; y < ey || (y === ey && m <= em); m++) {
    if (m > 12) { y++; m = 1; if (y > ey) break; }
    out.push({ ym: `${y}-${pad2(m)}`, y, m });
  }
  return out;
}
export function monthLabel(mo, first) { return mo.y === first.y ? `${mo.m}월` : `'${String(mo.y).slice(2)}.${mo.m}월`; }
export const inPeriod = (dateStr, settings) => { const s = effective(settings); return dateStr >= s.period_start && dateStr <= s.period_end; };

/** 오늘이 속한 달을 기간 안으로 맞춘 달 키 */
export function currentMonthKey(settings, today) {
  const ms = monthsOf(settings);
  const ym = today.slice(0, 7);
  if (ms.some((m) => m.ym === ym)) return ym;
  if (!ms.length) return ym;
  return today < effective(settings).period_start ? ms[0].ym : ms[ms.length - 1].ym;
}

export function monthTx(tx, ym, settings) {
  return liveTx(tx).filter((t) => t.tx_date.slice(0, 7) === ym && inPeriod(t.tx_date, settings)).sort(cmpTx);
}
export function sumAmount(rows) { return rows.reduce((s, r) => s + (r.amount || 0), 0); }
export function totalUsed(tx, settings) { return sumAmount(liveTx(tx).filter((t) => inPeriod(t.tx_date, settings))); }

/** 홈 화면용 요약 */
export function summarize(tx, settings, today) {
  const s = effective(settings);
  const months = monthsOf(settings);
  const first = months[0] || { y: Number(today.slice(0, 4)) };
  const ym = currentMonthKey(settings, today);
  const mUsed = sumAmount(monthTx(tx, ym, settings));
  const tUsed = totalUsed(tx, settings);
  const idx = months.findIndex((m) => m.ym === ym);
  const monthsLeft = idx < 0 ? 0 : months.length - idx - (today <= s.period_end ? 0 : 1);
  return {
    ym, monthNo: Number(ym.slice(5)),
    monthUsed: mUsed, monthLimit: s.monthly_limit, monthRemaining: s.monthly_limit - mUsed,
    monthPct: s.monthly_limit > 0 ? (mUsed / s.monthly_limit) * 100 : 0, monthOver: mUsed > s.monthly_limit,
    totalUsed: tUsed, totalBudget: s.total_budget, totalRemaining: s.total_budget - tUsed,
    totalPct: s.total_budget > 0 ? (tUsed / s.total_budget) * 100 : 0, totalOver: tUsed > s.total_budget,
    monthsLeft,
    monthly: months.map((m) => { const u = sumAmount(monthTx(tx, m.ym, settings)); return { ym: m.ym, label: monthLabel(m, first), used: u, over: u > s.monthly_limit, current: m.ym === ym }; }),
  };
}

/** 연구비 장부 홈용 요약: 총 잔액, 비목별 예산·사용·잔액, 월별 사용·정산일·지급신청 누적 */
export function researchSummary(tx, led, today) {
  const rows = liveTx(tx).filter((t) => inPeriod(t.tx_date, led));
  const budgets = (led && led.budgets) || {};
  const cats = (led && led.categories) || [];
  const total = researchTotal(led);
  const used = sumAmount(rows);
  const byCat = cats.map((c) => {
    const u = sumAmount(rows.filter((t) => t.category === c));
    const b = Number(budgets[c]) || 0;
    return { cat: c, budget: b, used: u, remaining: b - u, pct: b > 0 ? (u / b) * 100 : 0, over: u > b };
  }).filter((x) => x.budget > 0 || x.used > 0);
  const months = monthsOf(led);
  const first = months[0] || { y: Number(today.slice(0, 4)) };
  let cum = 0;
  const monthly = [];
  for (const m of months) {
    if (m.ym > today.slice(0, 7)) break;
    const mr = rows.filter((t) => t.tx_date.slice(0, 7) === m.ym);
    const u = sumAmount(mr);
    cum += u;
    const settles = mr.map((t) => t.settle_date || t.tx_date).sort();
    const cumCat = {};
    cats.forEach((c) => { cumCat[c] = sumAmount(rows.filter((t) => t.category === c && t.tx_date.slice(0, 7) <= m.ym)); });
    monthly.push({ ym: m.ym, label: monthLabel(m, first), used: u, count: mr.length, settle: settles.length ? settles[settles.length - 1] : null, cum, cumCat });
  }
  return { total, used, remaining: total - used, pct: total > 0 ? (used / total) * 100 : 0, over: total > 0 && used > total, byCat, monthly, hasBudget: total > 0 };
}

/** 저장 전 점검. error 는 막는 것, 나머지는 확인창을 띄울 사유. exceptId 는 고치는 중인 건. */
export function checkEntry({ tx, settings, f, today, exceptId = null }) {
  const out = { error: null, dup: null, big: false, overTotal: false, overBy: 0, newTotal: 0, overCat: false, catOverBy: 0 };
  const s = effective(settings);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.tx_date || '')) { out.error = '사용일자를 확인해 주세요.'; return out; }
  if (f.tx_date > today) { out.error = '앞으로 올 날짜는 적을 수 없습니다.'; return out; }
  if (f.tx_date < s.period_start || f.tx_date > s.period_end) { out.error = `예산 기간(${s.period_start} ~ ${s.period_end}) 밖의 날짜입니다.`; return out; }
  if (f.settle_date && !/^\d{4}-\d{2}-\d{2}$/.test(f.settle_date)) { out.error = '정산일자를 확인해 주세요.'; return out; }
  if (!Number.isInteger(f.amount) || f.amount <= 0) { out.error = '금액을 입력해 주세요.'; return out; }
  if (f.amount > MAX_AMOUNT) { out.error = '금액이 너무 큽니다.'; return out; }
  const sum = String(f.summary || '').trim();
  if (!sum) { out.error = '적요(사용처)를 적어 주세요.'; return out; }
  if (sum.length > SUMMARY_MAX) { out.error = `적요가 너무 깁니다. (${SUMMARY_MAX}자 이하)`; return out; }
  if (!(s.categories || CATEGORIES).includes(f.category)) { out.error = '항목을 골라 주세요.'; return out; }
  if (String(f.attendees || '').length > ATTENDEES_MAX) { out.error = `참가자가 너무 깁니다. (${ATTENDEES_MAX}자 이하)`; return out; }
  if (f.headcount !== null && f.headcount !== undefined && (!Number.isInteger(f.headcount) || f.headcount < 1 || f.headcount > 999)) { out.error = '인원은 1 이상의 숫자로 적어 주세요.'; return out; }
  const others = liveTx(tx).filter((t) => t.id !== exceptId);
  out.dup = others.find((t) => t.tx_date === f.tx_date && t.amount === f.amount && t.summary === sum) || null;
  out.big = f.amount >= (isResearch(settings) ? BIG_AMOUNT_RESEARCH : BIG_AMOUNT);
  const used = totalUsed(others, settings) + (inPeriod(f.tx_date, settings) ? f.amount : 0);
  out.newTotal = used;
  const totalCap = isResearch(settings) ? researchTotal(settings) : s.total_budget;
  out.overTotal = totalCap > 0 && used > totalCap;
  out.overBy = used - totalCap;
  if (isResearch(settings)) {   // 연구비: 월 한도는 없고, 비목별 예산이 정해져 있으면 그 비목 예산을 넘는지 되묻는다
    const bud = (settings.budgets || {})[f.category];
    if (totalCap > 0 && bud !== undefined) {
      const usedCat = sumAmount(others.filter((t) => t.category === f.category && inPeriod(t.tx_date, settings))) + (inPeriod(f.tx_date, settings) ? f.amount : 0);
      if (usedCat > (Number(bud) || 0)) { out.overCat = true; out.catOverBy = usedCat - (Number(bud) || 0); }
    }
    if (f.proof_no && String(f.proof_no).length > 20) { out.error = '증빙번호가 너무 깁니다. (20자 이하)'; return out; }
    if (f.vendor && String(f.vendor).length > 40) { out.error = '사용처가 너무 깁니다. (40자 이하)'; return out; }
  }
  return out;
}

/* ---------------------------- 내역 가져오기(CSV·엑셀 붙여넣기) ---------------------------- */

/** 쉼표 또는 탭으로 나뉜 한 줄을 칸으로(큰따옴표 안의 쉼표 허용) */
export function splitLine(line, delim) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/** '2026-08-06' '2026.8.6' '2026/8/6' '2026년 8월 6일' -> 'YYYY-MM-DD' (아니면 null) */
export function normDate(s) {
  const m = String(s || '').trim().match(/^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?$/);
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}
export function normAmount(s) {
  const t = String(s ?? '').replace(/[,\s원₩]/g, '');
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= MAX_AMOUNT ? n : null;
}

const HEAD_KEYS = {
  '신청일자': 'skip', '사용일자': 'tx_date', '사용일': 'tx_date', '날짜': 'tx_date', '일자': 'tx_date',
  '정산일자': 'settle_date', '정산일': 'settle_date', '구분': 'meal', '적요': 'summary', '내용': 'summary',
  '금액': 'amount', '참가자': 'attendees', '인원': 'headcount', '항목': 'category', '분류': 'category',
  // 연구비 정산 자료(괄호 안 설명은 떼고 읽는다)
  '사용월': 'skip', '세부내역': 'summary', '비목': 'category', '증빙번호': 'proof_no', '결제수단': 'pay_method', '정산일자': 'settle_date',
  '과제명': 'skip', '지원기관': 'skip', '참가자/인원': 'attendees', '원문불확실': 'skip', '사용처': 'vendor', '세부비목': 'sub_item', '연번': 'skip',
};
/** 가져오기 머리글로 인정하는 이름(화면 안내문에 그대로 보여 준다) */
export const IMPORT_HEADERS = Object.keys(HEAD_KEYS);
const headKey = (c) => HEAD_KEYS[c] || HEAD_KEYS[String(c).replace(/\(.*\)/, '').trim()] || null;
const DEFAULT_ORDER = ['tx_date', 'settle_date', 'meal', 'summary', 'amount', 'attendees', 'headcount', 'category'];

/**
 * 붙여 넣은 글을 건별 내역으로. 첫 줄에 「사용일자」 같은 머리글이 있으면 그 순서를 따르고(신청일자는 무시),
 * 없으면 정산서 열 순서(사용일자, 정산일자, 구분, 적요, 금액, 참가자, 인원[, 항목])로 읽습니다.
 * 반환 {rows:[{line, f}], errors:[{line, msg}], skippedDup:[{line}], total}
 */
export function parseImport(text, { tx = [], settings = null, today }) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const rows = []; const errors = []; const skippedDup = [];
  if (!lines.length) return { rows, errors: [{ line: 0, msg: '붙여 넣은 내용이 없습니다.' }], skippedDup, total: 0 };
  const delim = lines.some((l) => l.includes('\t')) ? '\t' : ',';
  let order = DEFAULT_ORDER; let start = 0;
  const h0 = splitLine(lines[0], delim);
  if (h0.some((c) => headKey(c) === 'tx_date')) { order = h0.map((c) => headKey(c) || 'skip'); start = 1; }
  const s = effective(settings);
  const seen = liveTx(tx).map((t) => `${t.tx_date}|${t.amount}|${t.summary}`);
  const seenSet = new Set(seen);
  const existing = new Set(seen);
  for (let i = start; i < lines.length; i++) {
    const no = i + 1;
    const cells = splitLine(lines[i], delim);
    const g = {}; order.forEach((k, j) => { if (k !== 'skip' && g[k] === undefined) g[k] = cells[j] === undefined ? '' : cells[j]; });
    const tx_date = normDate(g.tx_date);
    if (!tx_date) { errors.push({ line: no, msg: '사용일자를 읽을 수 없습니다.' }); continue; }
    if (tx_date > today) { errors.push({ line: no, msg: '앞으로 올 날짜입니다.' }); continue; }
    if (tx_date < s.period_start || tx_date > s.period_end) { errors.push({ line: no, msg: `예산 기간(${s.period_start} ~ ${s.period_end}) 밖입니다.` }); continue; }
    const amount = normAmount(g.amount);
    if (!amount) { errors.push({ line: no, msg: '금액을 읽을 수 없습니다.' }); continue; }
    const summary = String(g.summary || '').replace(/\s+/g, ' ').trim();
    if (!summary || summary.length > SUMMARY_MAX) { errors.push({ line: no, msg: '적요가 비었거나 너무 깁니다.' }); continue; }
    let settle = g.settle_date ? normDate(g.settle_date) : null;
    if (g.settle_date && !settle) { errors.push({ line: no, msg: '정산일자를 읽을 수 없습니다.' }); continue; }
    let headcount = null;
    if (g.headcount) { const h = Number(String(g.headcount).replace(/[^\d]/g, '')); if (!Number.isInteger(h) || h < 1 || h > 999) { errors.push({ line: no, msg: '인원을 읽을 수 없습니다.' }); continue; } headcount = h; }
    const category = g.category ? g.category : ((s.categories || CATEGORIES)[0] || '식비');
    if (!(s.categories || CATEGORIES).includes(category)) { errors.push({ line: no, msg: `항목은 ${(s.categories || CATEGORIES).join('·')} 중 하나여야 합니다.` }); continue; }
    const meal = g.meal ? g.meal.slice(0, 10) : null;
    const pay_method = g.pay_method ? g.pay_method.replace(/\(.*\)/, '').trim().slice(0, 20) || null : null;
    const proof_no = g.proof_no ? String(g.proof_no).trim().slice(0, 20) || null : null;
    const vendor = g.vendor ? String(g.vendor).trim().slice(0, 40) || null : null;
    const sub_item = g.sub_item ? String(g.sub_item).trim().slice(0, 40) || null : null;
    const attendees = g.attendees ? g.attendees.slice(0, ATTENDEES_MAX) : null;
    const key = `${tx_date}|${amount}|${summary}`;
    if (seenSet.has(key)) { skippedDup.push({ line: no, reason: existing.has(key) ? '이미 입력된 내역과 같습니다' : '붙여 넣은 글의 앞 줄과 같습니다', f: { tx_date, settle_date: settle || tx_date, category, meal, summary, amount, attendees, headcount, pay_method, proof_no, vendor, sub_item } }); continue; }
    seenSet.add(key);
    rows.push({ line: no, f: { tx_date, settle_date: settle || tx_date, category, meal, summary, amount, attendees, headcount, pay_method, proof_no, vendor, sub_item } });
  }
  return { rows, errors, skippedDup, total: sumAmount(rows.map((r) => r.f)) };
}

/** 월 정산서 표(워드 표와 같은 열 순서): 사용일자 정산일자 구분 적요 금액 참가자 인원 */
export const REPORT_COLUMNS = ['사용일자', '정산일자', '구분', '적요', '금액', '참가자', '인원'];
export const RESEARCH_REPORT_COLUMNS = ['사용일자', '정산일자', '비목', '세부내역', '금액', '증빙번호', '결제수단', '참가자'];
export function reportRows(tx, ym, settings) {
  return monthTx(tx, ym, settings).slice().sort((a, b) => (a.tx_date === b.tx_date ? Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0) : a.tx_date < b.tx_date ? -1 : 1));
}

/** 수정 창의 「이전 값」: 값이 바뀐 이력만, 최신순 */
export function valueHistory(hist) {
  return (hist || []).filter((h) => h.action === 'update' && h.old).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function trashDaysLeft(deletedAt, nowIso) { return Math.max(0, Math.ceil((Date.parse(deletedAt) + TRASH_DAYS * 86400000 - Date.parse(nowIso)) / 86400000)); }
export const isPurgeDue = (deletedAt, nowIso) => Date.parse(deletedAt) + TRASH_DAYS * 86400000 <= Date.parse(nowIso);
export function endOfDayIso(dateStr) { return new Date(`${dateStr}T23:59:59.999+09:00`).toISOString(); }
