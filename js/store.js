// store.js - 앱의 상태와 모든 조작(입력·수정·지우기·되돌리기·가져오기·설정·오프라인 재전송)
import * as C from './calc.js';
import { ApiError, NetworkError, uuid } from './data.js';

export class SaveError extends Error {
  constructor(msg, code = 'save') { super(msg); this.name = 'SaveError'; this.code = code; }
}

const UNDO_MS = 15000;

function friendly(e) {
  if (e instanceof SaveError) return e;
  if (e instanceof ApiError) {
    const m = {
      '22008': '날짜가 예산 기간 밖이거나 앞으로 올 날짜입니다.',
      '23505': '이미 같은 기록이 있습니다.',
      '42501': '권한이 없습니다. 비밀번호를 다시 입력해 주세요.',
      future: '앞으로 올 날짜는 적을 수 없습니다.',
      out_of_period: '예산 기간 밖의 날짜입니다.',
      too_old: '시간이 지나 취소할 수 없습니다.',
      invalid_session: '로그인이 풀렸습니다. 비밀번호를 다시 입력해 주세요.',
      no_auth: '로그인이 풀렸습니다. 비밀번호를 다시 입력해 주세요.',
    }[e.code];
    return new SaveError(m || e.message || '서버가 저장을 거부했습니다.', e.code);
  }
  return new SaveError(e && e.message ? e.message : '저장하지 못했습니다.');
}
const isRetryable = (e) => e instanceof NetworkError || (e instanceof ApiError && e.code === 'invalid_session');

export function createStore({ adapter, storage, clock = () => Date.now() }) {
  const mem = new Map();
  const store0 = storage || { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const ls = {
    get(k, d = null) { try { const v = store0.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { store0.setItem(k, JSON.stringify(v)); } catch { /* 저장소가 막혀 있어도 앱은 동작 */ } },
    del(k) { try { store0.removeItem(k); } catch { /* ignore */ } },
  };

  adapter.onSession = () => persistSession();
  const state = {
    phase: 'boot', // boot | login | app
    slots: [], slot: null, lastSlot: null,
    tx: [], ledgers: [], userSettings: null,   // ledgers: 장부 목록(운영비/연구비), userSettings: 사용자 전체 설정 줄(없으면 null -> 기본값)
    outbox: [], failed: [],
    undo: null,
    needReauth: false, online: true,
    prefs: ls.get('ex.prefs', { font: 'normal', reduceMotion: false, fontChosen: false, ledger: 'opex' }),
    lastError: null,
  };
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => f(state));
  const key = (k) => `ex.${state.slot}.${k}`;

  /* ---------- 시간 ---------- */
  function nowMs() {
    const off = adapter.serverOffsetMs ? adapter.serverOffsetMs() : 0;
    return clock() + (Math.abs(off) >= 600000 ? off : 0);   // 폰 시계가 10분 이상 틀리면 서버 시각 기준
  }
  const nowIso = () => new Date(nowMs()).toISOString();
  const today = () => C.kstDate(nowMs());

  /* ---------- 저장(캐시·세션·설정) ---------- */
  function persistSession() {
    const s = adapter.session;
    if (s && s.refresh_token) ls.set('ex.last', { slot: s.slot, refresh_token: s.refresh_token });
  }
  function persistData() {
    if (!state.slot) return;
    ls.set(key('cache'), { tx: state.tx, ledgers: state.ledgers, userSettings: state.userSettings });
    ls.set(key('outbox'), state.outbox);
    ls.set(key('failed'), state.failed);
  }
  function loadCache() {
    const c = ls.get(key('cache'), null);
    if (c) { state.tx = c.tx || []; state.ledgers = c.ledgers || []; state.userSettings = c.userSettings || null; }
    state.outbox = ls.get(key('outbox'), []);
    state.failed = ls.get(key('failed'), []);
  }

  /* ---------- 로컬 반영 ---------- */
  function applyRows(table, rows, replace) {
    if (table === 'ex_settings') { const r = rows[rows.length - 1]; state.userSettings = replace ? r : { ...(state.userSettings || {}), ...r }; return; }
    for (const r of rows) {
      const i = state.tx.findIndex((x) => x.id === r.id);
      if (i >= 0) state.tx[i] = replace ? r : { ...state.tx[i], ...r }; else state.tx.push(replace ? r : { ...r });
    }
  }
  function applyLocal(steps) {
    for (const st of steps) {
      if (st.type === 'upsert') applyRows(st.table, st.rows, false);
      else if (st.type === 'undoCreate') { const i = state.tx.findIndex((x) => x.id === st.id); if (i >= 0) state.tx.splice(i, 1); }
    }
  }

  /* ---------- 서버로 보내기 ---------- */
  async function sendStep(st) {
    if (st.type === 'upsert') { const rows = await adapter.data.upsert(st.table, st.rows); applyRows(st.table, rows, true); }
    else if (st.type === 'undoCreate') { await adapter.data.undoCreate(st.id); applyLocal([st]); }
  }

  async function sendSteps(steps) {
    const created = [];
    for (let i = 0; i < steps.length; i++) {
      try {
        await sendStep(steps[i]);
        if (steps[i].created) created.push(steps[i]);
        state.online = true;
      } catch (e) {
        persistSession();
        if (isRetryable(e)) {
          if (e instanceof NetworkError) state.online = false; else state.needReauth = true;
          return { rest: steps.slice(i) };
        }
        for (const c of created.reverse()) {   // 거부: 앞서 새로 만든 것은 되돌려 어중간한 상태를 남기지 않음
          try { for (const r of c.rows) { await adapter.data.undoCreate(r.id); applyLocal([{ type: 'undoCreate', id: r.id }]); } } catch { /* 최선 */ }
        }
        throw friendly(e);
      }
    }
    persistSession();
    return { rest: [] };
  }

  async function flush() {
    if (!state.outbox.length) return true;
    while (state.outbox.length) {
      const entry = state.outbox[0];
      let r;
      try { r = await sendSteps(entry.steps); } catch (e) { state.outbox.shift(); state.failed.push({ entry, message: e.message }); continue; }
      if (r.rest.length) { entry.steps = r.rest; persistData(); emit(); return false; }
      state.outbox.shift();
    }
    persistData(); emit();
    return true;
  }
  const enqueue = (steps, label) => { state.outbox.push({ id: uuid(), steps, label, at: nowIso() }); };

  /** 변경 하나를 서버에 저장합니다. 성공/대기 상태를 돌려주고, 거부되면 SaveError 를 던집니다. */
  async function commit(label, steps, inverse, { noUndo = false } = {}) {
    state.lastError = null;
    let status = 'saved';
    if (state.outbox.length) await flush();
    if (state.outbox.length) { applyLocal(steps); enqueue(steps, label); status = 'queued'; }
    else {
      const r = await sendSteps(steps);
      if (r.rest.length) { applyLocal(r.rest); enqueue(r.rest, label); status = 'queued'; }
    }
    if (noUndo) state.undo = null; else state.undo = { label, steps: inverse, expires: nowMs() + UNDO_MS, status };
    persistData(); emit();
    return { status };
  }

  /* ---------- 로그인 ---------- */
  async function loadSlots() {
    try { state.slots = await adapter.auth.slots(); state.online = true; } catch (e) {
      if (e instanceof NetworkError) { state.online = false; state.slots = []; } else throw e;
    }
    emit();
    return state.slots;
  }
  async function enter(session) {
    state.slot = session.slot; state.needReauth = false;
    persistSession(); loadCache();
    state.phase = 'app'; emit();
    await sync();
  }
  async function login(slot, pw) { await enter(await adapter.auth.login(slot, pw)); }
  async function setup(slot, pw) { await enter(await adapter.auth.setup(slot, pw)); }

  async function resume() {
    const last = ls.get('ex.last', null);
    state.lastSlot = last ? last.slot : null;
    if (!last || !last.refresh_token) { state.phase = 'login'; await loadSlots(); return false; }
    adapter.setSession({ slot: last.slot, refresh_token: last.refresh_token, access_token: null });
    try {
      await adapter.auth.refresh(last.refresh_token);
      await enter(adapter.session);
      return true;
    } catch (e) {
      if (e instanceof NetworkError) {   // 인터넷이 없어도 저장된 기록은 보여 줍니다
        state.slot = last.slot; loadCache(); state.online = false; state.phase = 'app'; emit();
        return true;
      }
      adapter.setSession(null);
      state.phase = 'login'; state.needReauth = true;
      await loadSlots();
      return false;
    }
  }
  function logoutLocal() {
    ls.del('ex.last');
    if (state.slot && !state.outbox.length) ls.del(key('cache'));
    adapter.setSession(null);
    Object.assign(state, { phase: 'login', slot: null, tx: [], ledgers: [], userSettings: null, outbox: [], failed: [], undo: null, needReauth: false });
    emit();
  }
  async function logout() { logoutLocal(); await loadSlots(); }
  async function logoutAllDevices() { await adapter.auth.logoutAll(); await logout(); }
  async function changePassword(cur, next) { const s = await adapter.auth.changePassword(cur, next); persistSession(); return s; }

  /* ---------- 동기화 ---------- */
  async function sync() {
    if (!adapter.session) return;
    const ok = await flush();
    if (!ok) return;
    try {
      const d = await adapter.data.loadAll();
      state.tx = d.tx; state.ledgers = d.ledgers || []; state.userSettings = d.settings;
      state.online = true;
      try { await adapter.data.purgeMine(); } catch { /* 다음 기회에 */ }
      persistSession();
    } catch (e) {
      if (e instanceof NetworkError) state.online = false;
      else if (e instanceof ApiError && e.code === 'invalid_session') state.needReauth = true;
      else state.lastError = friendly(e).message;
    }
    persistData(); emit();
  }

  /* ---------- 읽기용 ---------- */
  /** 지금 보고 있는 장부(서버 줄). 아직 못 받았으면 null */
  const curLedger = () => state.ledgers.find((l) => l.code === state.prefs.ledger) || state.ledgers.find((l) => l.status === 'active') || state.ledgers[0] || null;
  const eff = () => C.effective(curLedger());          // 기간·한도·분류 목록은 장부 설정에서만 읽는다
  const ledgerTx = () => { const l = curLedger(); return l ? state.tx.filter((t) => t.ledger_id === l.id) : state.tx; };
  const summary = () => C.summarize(ledgerTx(), curLedger(), today());
  const researchSummary = () => C.researchSummary(ledgerTx(), curLedger(), today());
  function setLedger(code) { state.prefs.ledger = code; ls.set('ex.prefs', state.prefs); emit(); }
  const pendingIds = () => {
    const s = new Set();
    for (const e of state.outbox) for (const st of e.steps) { if (st.type === 'upsert' && st.table === 'ex_tx') st.rows.forEach((r) => s.add(r.id)); }
    return s;
  };
  function trashItems() {
    const n = nowIso();
    return ledgerTx().filter((t) => t.deleted_at && !C.isPurgeDue(t.deleted_at, n))
      .map((t) => ({ row: t, left: C.trashDaysLeft(t.deleted_at, n), deleted_at: t.deleted_at }))
      .sort((a, b) => Date.parse(b.deleted_at) - Date.parse(a.deleted_at));
  }
  const suggestions = () => {
    const cnt = new Map();
    C.liveTx(ledgerTx()).forEach((t) => cnt.set(t.summary, (cnt.get(t.summary) || 0) + 1));
    return [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s).slice(0, 6);
  };

  /* ---------- 조작 ---------- */
  const findTx = (id) => state.tx.find((r) => r.id === id);
  const clean = (f) => ({
    tx_date: f.tx_date,
    settle_date: f.settle_date || f.tx_date,
    category: f.category,
    meal: f.meal ? String(f.meal).trim() || null : null,
    summary: String(f.summary).replace(/\s+/g, ' ').trim(),
    amount: f.amount,
    attendees: f.attendees ? String(f.attendees).trim() || null : null,
    headcount: f.headcount === undefined || f.headcount === null || f.headcount === '' ? null : f.headcount,
    sub_item: f.sub_item ? String(f.sub_item).trim() || null : null,
    pay_method: f.pay_method ? String(f.pay_method).trim() || null : null,
    proof_no: f.proof_no ? String(f.proof_no).trim() || null : null,
    vendor: f.vendor ? String(f.vendor).trim() || null : null,
  });

  function guard(f) {
    const led = curLedger();
    if (!led) throw new SaveError('장부를 불러오는 중입니다. 잠시 뒤에 다시 해 주세요.', 'no_ledger');
    if (led.status !== 'active') throw new SaveError(`${led.name} 장부는 아직 준비 중이라 입력할 수 없습니다.`, 'ledger_not_ready');
    const chk = C.checkEntry({ tx: ledgerTx(), settings: led, f: { ...f, summary: f.summary }, today: today(), exceptId: f.id || null });
    if (chk.error) throw new SaveError(chk.error, 'check');
  }

  async function addTx(f, source = 'manual') {
    guard(f);
    const t = nowIso();
    const row = { id: uuid(), ledger_id: curLedger().id, ...clean(f), source, scan_id: null, created_at: t, updated_at: t, deleted_at: null };
    const r = await commit('지출 추가', [{ type: 'upsert', table: 'ex_tx', rows: [row], created: true }], [{ type: 'undoCreate', id: row.id }]);
    return { row, ...r };
  }

  /** 가져오기: 여러 건을 한 번에(200건씩 나눠 보내되, 하나라도 거부되면 앞서 보낸 것은 되돌림) */
  async function addMany(fs) {
    if (!fs.length) throw new SaveError('넣을 내역이 없습니다.');
    const t = nowIso();
    const rows = fs.map((f) => { guard(f); return { id: uuid(), ledger_id: curLedger().id, ...clean(f), source: 'import', scan_id: null, created_at: t, updated_at: t, deleted_at: null }; });
    const steps = [];
    for (let i = 0; i < rows.length; i += 200) steps.push({ type: 'upsert', table: 'ex_tx', rows: rows.slice(i, i + 200), created: true });
    const inverse = rows.map((r) => ({ type: 'undoCreate', id: r.id }));
    const r = await commit(`${rows.length}건 가져오기`, steps, inverse);
    return { rows, ...r };
  }

  async function editTx(id, f) {
    const old = findTx(id);
    if (!old) throw new SaveError('기록을 찾을 수 없습니다.');
    guard({ ...f, id });
    const row = { ...old, ...clean(f), updated_at: nowIso() };
    return commit('지출 수정', [{ type: 'upsert', table: 'ex_tx', rows: [row] }], [{ type: 'upsert', table: 'ex_tx', rows: [{ ...old }] }]);
  }

  async function setDeleted(id, del) {
    const row = findTx(id);
    if (!row) throw new SaveError('찾을 수 없습니다.');
    if (!del) guard({ ...row });   // 되살릴 때도 기간·날짜 규칙을 지킨다
    const t = nowIso();
    const next = { ...row, deleted_at: del ? t : null, updated_at: t };
    return commit(del ? '지움' : '되살림', [{ type: 'upsert', table: 'ex_tx', rows: [next] }], [{ type: 'upsert', table: 'ex_tx', rows: [{ ...row }] }]);
  }
  const removeTx = (id) => setDeleted(id, true);
  const restoreTx = (id) => setDeleted(id, false);

  async function restoreValue(id, hist) {
    const row = findTx(id);
    if (!row || !hist || !hist.old) throw new SaveError('복원할 수 없습니다.');
    const next = { ...row, updated_at: nowIso() };
    for (const k of ['tx_date', 'settle_date', 'category', 'sub_item', 'meal', 'pay_method', 'proof_no', 'vendor', 'summary', 'amount', 'attendees', 'headcount']) if (hist.old[k] !== undefined) next[k] = hist.old[k];
    guard({ ...next });
    return commit('이전 값 복원', [{ type: 'upsert', table: 'ex_tx', rows: [next] }], [{ type: 'upsert', table: 'ex_tx', rows: [{ ...row }] }]);
  }

  async function historyOf(id) {
    try { return await adapter.data.history(id); } catch (e) { if (e instanceof NetworkError) state.online = false; return []; }
  }

  /** 장부 설정(기간·월 한도·총 예산) 저장. 장부는 서버가 만들어 둔 줄을 고치기만 한다 */
  async function saveLedger(patch) {
    const led = curLedger();
    if (!led) throw new SaveError('장부를 불러오는 중입니다.');
    const next = { ...led, ...patch };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next.period_start) || !/^\d{4}-\d{2}-\d{2}$/.test(next.period_end) || next.period_end < next.period_start) throw new SaveError('기간을 확인해 주세요.');
    for (const k of ['monthly_limit', 'total_budget']) if (next[k] !== null && (!Number.isInteger(next[k]) || next[k] < 0 || next[k] > 999999999)) throw new SaveError('금액을 확인해 주세요.');
    const outside = C.liveTx(ledgerTx()).filter((t) => t.tx_date < next.period_start || t.tx_date > next.period_end).length;
    const upd = {};
    for (const k of ['period_start', 'period_end', 'monthly_limit', 'total_budget']) if (patch[k] !== undefined) upd[k] = next[k];
    try {
      const row = await adapter.data.updateLedger(led.id, upd);
      const i = state.ledgers.findIndex((l) => l.id === led.id);
      if (i >= 0) state.ledgers[i] = row;
    } catch (e) { throw friendly(e); }
    persistData(); emit();
    return { outside };
  }

  /** 연구비 장부 설정(과제 정보·기간·비목별 예산·카드 끝 4자리) 저장. 총 연구비는 비목별 예산의 합으로 맞춘다 */
  async function saveResearch({ name, institution, period_start, period_end, budgets, card_last4 }) {
    const led = curLedger();
    if (!led || led.code !== 'research') throw new SaveError('연구비 장부를 찾을 수 없습니다.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period_start) || !/^\d{4}-\d{2}-\d{2}$/.test(period_end) || period_end < period_start) throw new SaveError('기간을 확인해 주세요.');
    if (card_last4 && !/^\d{4}$/.test(card_last4)) throw new SaveError('카드 끝 4자리는 숫자 4자리입니다.');
    const clean = {};
    for (const c of led.categories) { const v = Number(budgets[c] || 0); if (!Number.isInteger(v) || v < 0 || v > 999999999) throw new SaveError('예산 금액을 확인해 주세요.'); clean[c] = v; }
    const total = Object.values(clean).reduce((a, b) => a + b, 0);
    const project = { ...(led.project || {}), name: String(name || '').trim().slice(0, 100), institution: String(institution || '').trim().slice(0, 60) };
    const upd = { period_start, period_end, budgets: clean, total_budget: total, project };
    if (card_last4) upd.card_last4 = card_last4;
    try {
      const row = await adapter.data.updateLedger(led.id, upd);
      const i = state.ledgers.findIndex((l) => l.id === led.id);
      if (i >= 0) state.ledgers[i] = row;
    } catch (e) { throw friendly(e); }
    persistData(); emit();
    return { total };
  }

  /** 사용자 전체 설정(영수증 보관 삭제일, 스캔 하루 상한) 저장 (줄이 없으면 처음 만든다) */
  async function saveUserSettings(patch) {
    const next = { ...C.userSettings(state.userSettings), ...patch };
    if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(next.receipt_purge_md)) throw new SaveError('삭제일은 월-일(예: 03-01)로 적어 주세요.');
    if (!Number.isInteger(next.scan_daily_max_count) || next.scan_daily_max_count < 1 || next.scan_daily_max_count > 200) throw new SaveError('하루 등록 상한(건수)을 확인해 주세요.');
    if (!Number.isInteger(next.scan_daily_max_amount) || next.scan_daily_max_amount < 1 || next.scan_daily_max_amount > 100000000) throw new SaveError('하루 등록 상한(금액)을 확인해 주세요.');
    const row = { ...(state.userSettings || {}), ...Object.fromEntries(Object.keys(C.USER_DEFAULTS).map((k) => [k, next[k]])) };
    return commit('설정 수정', [{ type: 'upsert', table: 'ex_settings', rows: [row] }], [], { noUndo: true });
  }

  async function undo() {
    const u = state.undo;
    if (!u) return false;
    state.undo = null;
    if (!u.steps.length) return false;
    await commit('되돌리기', u.steps, [], { noUndo: true });
    return true;
  }
  function expireUndo() { if (state.undo && nowMs() >= state.undo.expires) { state.undo = null; emit(); } }
  function clearUndo() { if (state.undo) { state.undo = null; emit(); } }

  async function retryFailed() {
    const items = state.failed.splice(0);
    for (const f of items) state.outbox.push(f.entry);
    persistData(); await flush(); emit();
  }
  async function discardFailed() { state.failed = []; persistData(); await sync(); }

  function setFont(f) { state.prefs.font = f; state.prefs.fontChosen = true; ls.set('ex.prefs', state.prefs); emit(); }
  function setReduceMotion(v) { state.prefs.reduceMotion = !!v; ls.set('ex.prefs', state.prefs); emit(); }

  return {
    adapter, state, on(fn) { listeners.add(fn); return () => listeners.delete(fn); }, emit,
    now: nowMs, nowIso, today,
    loadSlots, login, setup, resume, logout, logoutAllDevices, changePassword, sync, flush,
    eff, curLedger, ledgerTx, setLedger, summary, researchSummary, pendingIds, trashItems, suggestions,
    addTx, addMany, editTx, removeTx, restoreTx, restoreValue, historyOf, saveLedger, saveResearch, saveUserSettings,
    undo, expireUndo, clearUndo, retryFailed, discardFailed, setFont, setReduceMotion, findTx,
  };
}
