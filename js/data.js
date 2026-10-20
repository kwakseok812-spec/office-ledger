// data.js - 서버와 이야기하는 계층을 한곳에 모았습니다.
//   createSupabaseAdapter : 실제 서버(Supabase)와 이야기합니다.
//   MemoryServer + createMemoryAdapter : 서버 없이 시험하는 메모리 가짜 서버입니다(서버의 표 규칙·행 단위 보안·함수를 흉내).
// 화면과 계산은 어댑터가 어느 쪽인지 모릅니다. (두 어댑터는 같은 메서드를 가집니다)
//
// 어댑터 메서드
//   auth.slots() / setup(slot, pw) / login(slot, pw) / refresh(rt) / changePassword(cur, new) / logoutAll()
//   data.loadAll()            -> {tx, ledgers, settings}   (장부가 없으면 서버/가짜 서버가 두 장부를 만들어 줌)
//   data.upsert(table, rows)  -> 저장된 행들  (table: ex_tx | ex_settings)
//   data.updateLedger(id, patch) -> 고친 장부 줄
//   data.undoCreate(id)       -> 만든 지 5분 안의 본인 행 지우기
//   data.history(id)          -> 이력 목록
//   data.purgeMine()
//   serverOffsetMs()          -> 서버 시계 - 폰 시계

import { validatePassword, derivePassword, registerFail, SLOT_LABEL } from '../supabase/functions/ex-auth/logic.js';
import { kstDate, TRASH_DAYS, CATEGORIES, USER_DEFAULTS, looksLikeInstruction } from './calc.js';

export class NetworkError extends Error {
  constructor(msg = '인터넷에 연결되어 있지 않습니다.') { super(msg); this.name = 'NetworkError'; this.network = true; }
}
export class ApiError extends Error {
  constructor(status, code, msg, data = {}) { super(msg || code); this.name = 'ApiError'; this.status = status; this.code = code; this.data = data; }
}

const uuid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
export { uuid };

const TRACK = ['tx_date', 'settle_date', 'category', 'sub_item', 'meal', 'pay_method', 'proof_no', 'vendor', 'summary', 'amount', 'attendees', 'headcount', 'deleted_at'];
export const TX_FIELDS = ['id', 'ledger_id', 'tx_date', 'settle_date', 'category', 'sub_item', 'pay_method', 'proof_no', 'vendor', 'meal', 'summary', 'amount', 'attendees', 'headcount', 'source', 'scan_id', 'created_at', 'updated_at', 'deleted_at'];

/* ------------------------------------------------------------------ */
/* 메모리 가짜 서버 (시험용)                                            */
/* ------------------------------------------------------------------ */
export class MemoryServer {
  constructor({ now = () => Date.now(), pepper = 'test-pepper', scanKey = 'k'.repeat(64) } = {}) {
    this.now = now;
    this.pepper = pepper;
    this.scanKey = scanKey;
    this.online = true;
    this.failNext = null;
    this.slotsState = { 1: { slot: 1, user_id: uuid(), state: 'unset', failed_count: 0, lock_level: 0, locked_until: null, pwhash: null } };
    this.tables = { ex_tx: [], ex_ledgers: [], ex_settings: [], ex_history: [] };
    this.scanState = { fails: 0, locked_until: null };
    this.access = new Map();
    this.refreshTok = new Map();
  }

  iso(ms = this.now()) { return new Date(ms).toISOString(); }
  _net() { if (!this.online) throw new NetworkError(); }

  /* ---- 로그인 함수(ex-auth 흉내) ---- */
  _session(slot) {
    const st = this.slotsState[slot];
    const access = 'acc_' + uuid();
    const refresh = 'ref_' + uuid();
    this.access.set(access, { user_id: st.user_id, slot, exp: this.now() + 3600 * 1000 });
    this.refreshTok.set(refresh, { user_id: st.user_id, slot, revoked: false });
    return { slot, user_id: st.user_id, access_token: access, refresh_token: refresh };
  }
  fnSlots() {
    this._net();
    const st = this.slotsState[1];
    const lu = st.locked_until && st.locked_until > this.now() ? this.iso(st.locked_until) : null;
    return [{ slot: 1, state: st.state, locked_until: lu }];
  }
  async fnSetup(slot, pw) {
    this._net();
    const st = this.slotsState[slot];
    if (!st) throw new ApiError(400, 'bad_slot', '없는 사용자입니다.');
    const bad = validatePassword(pw);
    if (bad) throw new ApiError(400, 'weak', bad);
    if (st.state !== 'unset') throw new ApiError(409, st.state === 'disabled' ? 'disabled' : 'already_set', '지금은 처음 사용 설정을 할 수 없습니다.');
    st.state = 'set';
    st.pwhash = await derivePassword(slot, pw, this.pepper);
    return this._session(slot);
  }
  async fnLogin(slot, pw) {
    this._net();
    const st = this.slotsState[slot];
    if (!st) throw new ApiError(400, 'bad_slot', '없는 사용자입니다.');
    if (st.state === 'disabled') throw new ApiError(403, 'disabled', '지금은 사용할 수 없습니다.');
    if (st.state === 'unset') throw new ApiError(409, 'unset', '처음 사용 설정이 필요합니다.');
    if (st.locked_until && st.locked_until > this.now()) throw new ApiError(429, 'locked', '잠시 잠겨 있습니다.', { until: this.iso(st.locked_until) });
    const r = this._countFail(st);
    const h = await derivePassword(slot, pw || '', this.pepper);
    if (h !== st.pwhash) {
      if (r.locked_minutes) throw new ApiError(429, 'locked', '잠시 잠겨 있습니다.', { until: this.iso(st.locked_until) });
      throw new ApiError(401, 'wrong', '비밀번호가 다릅니다.', { remaining: r.remaining });
    }
    this._countOk(st);
    return this._session(slot);
  }
  _countFail(st) {
    const r = registerFail(st, this.now());
    st.failed_count = r.failed_count; st.lock_level = r.lock_level; st.last_failed_at = r.last_failed_at;
    if (r.locked_minutes) st.locked_until = this.now() + r.locked_minutes * 60000;
    return r;
  }
  _countOk(st) { st.failed_count = 0; st.lock_level = 0; st.locked_until = null; st.last_failed_at = null; }
  async fnChange(access, cur, next) {
    const a = this._auth(access);
    const bad = validatePassword(next);
    if (bad) throw new ApiError(400, 'weak', bad);
    const st = this.slotsState[a.slot];
    if (st.locked_until && st.locked_until > this.now()) throw new ApiError(429, 'locked', '잠시 잠겨 있습니다.', { until: this.iso(st.locked_until) });
    const r = this._countFail(st);
    const h = await derivePassword(a.slot, cur || '', this.pepper);
    if (h !== st.pwhash) {
      if (r.locked_minutes) throw new ApiError(429, 'locked', '잠시 잠겨 있습니다.', { until: this.iso(st.locked_until) });
      throw new ApiError(401, 'wrong', '현재 비밀번호가 다릅니다.', { remaining: r.remaining });
    }
    this._countOk(st);
    st.pwhash = await derivePassword(a.slot, next, this.pepper);
    this._revokeUser(a.user_id);
    return this._session(a.slot);
  }
  fnLogoutAll(access) { const a = this._auth(access); this._revokeUser(a.user_id); }
  _revokeUser(user_id) {
    for (const [, v] of this.refreshTok) if (v.user_id === user_id) v.revoked = true;
    for (const [k, v] of this.access) if (v.user_id === user_id) this.access.delete(k);
  }
  refreshSession(refresh) {
    this._net();
    const r = this.refreshTok.get(refresh);
    if (!r || r.revoked) throw new ApiError(400, 'invalid_session', '로그인이 풀렸습니다.');
    r.revoked = true;
    return this._session(r.slot);
  }
  adminReset(slot) { const st = this.slotsState[slot]; st.state = 'disabled'; st.pwhash = null; st.failed_count = 0; st.lock_level = 0; st.locked_until = null; this._revokeUser(st.user_id); }
  adminOpen(slot) { this.slotsState[slot].state = 'unset'; }

  /* ---- 표 접근 (행 단위 보안 흉내) ---- */
  _auth(access) {
    this._net();
    const a = this.access.get(access);
    if (!a) throw new ApiError(401, 'no_auth', '권한이 없습니다. (로그인이 필요합니다)');
    if (a.exp <= this.now()) { this.access.delete(access); throw new ApiError(401, 'jwt_expired', '접속 시간이 지났습니다.'); }
    return a;
  }
  clone(o) { return JSON.parse(JSON.stringify(o)); }
  select(table, access) {
    const a = this._auth(access);
    if (!this.tables[table]) throw new ApiError(404, 'no_table', '없는 표');
    return this.tables[table].filter((r) => r.user_id === a.user_id).map((r) => this.clone(r));
  }
  _settingsOf(user_id) { return { ...USER_DEFAULTS, ...(this.tables.ex_settings.find((s) => s.user_id === user_id) || {}) }; }
  _ledger(user_id, id) { return this.tables.ex_ledgers.find((l) => l.user_id === user_id && l.id === id) || null; }
  /** ex_ensure_ledgers 흉내: 두 장부가 없으면 만든다 */
  ensureLedgers(access) {
    const a = this._auth(access);
    const has = (code) => this.tables.ex_ledgers.some((l) => l.user_id === a.user_id && l.code === code);
    const t = this.iso();
    if (!has('opex')) this.tables.ex_ledgers.push({ id: uuid(), user_id: a.user_id, code: 'opex', name: '보직자 운영비', card_last4: null, status: 'active', period_start: '2026-08-01', period_end: '2027-02-28', monthly_limit: 300000, total_budget: 2100000, categories: [...CATEGORIES], subitems: null, budgets: null, project: null, sort: 1, created_at: t, updated_at: t });
    if (!has('research')) this.tables.ex_ledgers.push({ id: uuid(), user_id: a.user_id, code: 'research', name: '교내과제 연구비', card_last4: null, status: 'active', period_start: '2026-06-01', period_end: '2027-02-28', monthly_limit: null, total_budget: null, categories: ['연구활동비', '연구수당', '학생인건비', '시설장비비', '재료비', '위탁연구개발비', '간접비'], subitems: { 연구활동비: ['회의비', '국외 출장 여비', '수용비 및 수수료', '기술정보활동비(전문가활용비)', '조사연구비', '연구홍보비', '국내 출장 여비 및 시내교통비', '연구환경유지비', '야근(특근) 식대'] }, budgets: { 연구활동비: 0, 연구수당: 0, 학생인건비: 0, 시설장비비: 0, 재료비: 0, 위탁연구개발비: 0, 간접비: 0 }, project: { name: '', institution: '', kinds: ['직접비', '간접비'], pay_methods: ['법인카드', '개인카드', '계좌이체', '현금'] }, sort: 2, created_at: t, updated_at: t });
  }
  updateLedger(access, id, patch) {
    const a = this._auth(access);
    const l = this._ledger(a.user_id, id);
    if (!l) throw new ApiError(404, 'no_ledger', '장부를 찾을 수 없습니다.');
    if (patch.categories || patch.subitems) throw new ApiError(400, 'check', '분류 목록은 여기서 바꿀 수 없습니다.');
    const next = { ...l, ...patch, id: l.id, user_id: l.user_id, code: l.code, created_at: l.created_at };
    if (next.card_last4 !== null && next.card_last4 !== undefined && !/^\d{4}$/.test(String(next.card_last4))) throw new ApiError(400, 'check', '카드 끝 4자리는 숫자 4자리입니다.');
    if (next.period_end < next.period_start) throw new ApiError(400, 'check', '기간이 올바르지 않습니다.');
    for (const k of ['monthly_limit', 'total_budget']) if (next[k] !== null && (!Number.isInteger(next[k]) || next[k] < 0)) throw new ApiError(400, 'check', '금액이 올바르지 않습니다.');
    next.updated_at = this.iso();
    Object.assign(l, next);
    return this.clone(l);
  }

  upsert(table, access, rows) {
    const a = this._auth(access);
    if (this.failNext) { const f = this.failNext; this.failNext = null; throw new ApiError(f.status || 400, f.code || 'rejected', f.msg || '서버가 저장을 거부했습니다.'); }
    if (table !== 'ex_tx' && table !== 'ex_settings') throw new ApiError(403, 'rls', '권한이 없습니다.');
    const tbl = this.tables[table];
    const staged = [];
    for (const raw of rows) {
      const row = this.clone(raw);
      if (row.user_id && row.user_id !== a.user_id) throw new ApiError(403, 'rls', 'new row violates row-level security policy');
      row.user_id = a.user_id;
      const idKey = table === 'ex_tx' ? 'id' : 'user_id';
      if (table === 'ex_tx' && !row.id) row.id = uuid();
      const ex = tbl.find((r) => r[idKey] === row[idKey]);
      if (ex && ex.user_id !== a.user_id) throw new ApiError(403, 'rls', 'new row violates row-level security policy');
      if (table === 'ex_tx') this._validateTx(row, ex, a);
      else this._validateSettings(row);
      staged.push({ row, ex, old: ex ? this.clone(ex) : null });
    }
    const out = [];
    for (const { row, ex, old } of staged) {
      const now = this.iso();
      row.created_at = ex ? ex.created_at : now;
      row.updated_at = now;
      if (table === 'ex_tx') {
        row.deleted_at = row.deleted_at || null;
        if (ex) row.ledger_id = ex.ledger_id;
        row.source = ex ? ex.source : (row.source || 'manual');
        row.scan_id = ex ? ex.scan_id : (row.scan_id || null);
        row.settle_date = row.settle_date || row.tx_date;
        row.summary = String(row.summary).trim();
        row.attendees = row.attendees ? String(row.attendees).trim() || null : null;
        row.meal = row.meal ? String(row.meal).trim() || null : null;
        for (const k of ['sub_item', 'pay_method', 'proof_no', 'vendor']) row[k] = row[k] ? String(row[k]).trim() || null : null;
      }
      if (ex) Object.assign(ex, row); else tbl.push(row);
      if (table === 'ex_tx') this._history(old, row, !!ex);
      out.push(this.clone(row));
    }
    return out;
  }

  _validateTx(row, ex, a) {
    const bad = (code, msg) => { throw new ApiError(400, code, msg); };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.tx_date || '')) bad('check', '사용일자가 올바르지 않습니다.');
    if (!Number.isInteger(row.amount) || row.amount <= 0 || row.amount > 99999999) bad('check', '금액이 올바르지 않습니다.');
    if (!row.summary || !String(row.summary).trim() || String(row.summary).trim().length > 60) bad('check', '적요를 확인해 주세요.');
    const led = this._ledger(a.user_id, row.ledger_id);
    if (!led) throw new ApiError(409, 'fk', '장부를 찾을 수 없습니다.');
    if (!row.deleted_at && !led.categories.includes(row.category)) bad('check', '항목이 올바르지 않습니다.');
    if (row.sub_item && !((led.subitems || {})[row.category] || []).includes(row.sub_item)) bad('check', '세부 비목이 올바르지 않습니다.');
    for (const [k, n] of [['pay_method', 20], ['proof_no', 20], ['vendor', 40]]) if (row[k] && String(row[k]).length > n) bad('check', '입력이 너무 깁니다.');
    if (row.attendees && String(row.attendees).length > 120) bad('check', '참가자가 너무 깁니다.');
    if (row.headcount !== null && row.headcount !== undefined && (!Number.isInteger(row.headcount) || row.headcount < 1 || row.headcount > 999)) bad('check', '인원이 올바르지 않습니다.');
    if (row.meal && String(row.meal).length > 10) bad('check', '구분이 올바르지 않습니다.');
    if (!row.deleted_at) {
      if (row.tx_date > kstDate(this.now())) throw new ApiError(400, 'future', '앞으로 올 날짜는 적을 수 없습니다.');
      if (led.status !== 'active') throw new ApiError(400, 'ledger_not_ready', '이 장부는 아직 준비 중입니다.');
      if (row.tx_date < led.period_start || row.tx_date > led.period_end) throw new ApiError(400, 'out_of_period', '예산 기간 밖의 날짜입니다.');
    }
  }
  _validateSettings(row) {
    const bad = (m) => { throw new ApiError(400, 'check', m); };
    if (row.receipt_purge_md !== undefined && !/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(row.receipt_purge_md)) bad('삭제일 형식이 올바르지 않습니다.');
  }
  _history(old, row, isUpdate) {
    const pick = (o) => (o ? Object.fromEntries(TRACK.map((k) => [k, o[k] ?? null])) : null);
    const o = pick(old), n = pick(row);
    if (isUpdate && JSON.stringify(o) === JSON.stringify(n)) return;
    this.tables.ex_history.push({ id: uuid(), user_id: row.user_id, entity_id: row.id, action: isUpdate ? 'update' : 'create', old: o, new: n, at: this.iso() });
  }
  undoCreate(access, id) {
    const a = this._auth(access);
    const tbl = this.tables.ex_tx;
    const i = tbl.findIndex((r) => r.id === id);
    if (i < 0) return;
    const r = tbl[i];
    if (r.user_id !== a.user_id) throw new ApiError(403, 'rls', '권한이 없습니다.');
    if (this.now() - Date.parse(r.created_at) > 5 * 60000) throw new ApiError(403, 'too_old', '너무 오래되어 취소할 수 없습니다.');
    tbl.splice(i, 1);
    this.tables.ex_history = this.tables.ex_history.filter((h) => h.entity_id !== id);
  }
  history(access, id) {
    const a = this._auth(access);
    return this.tables.ex_history.filter((h) => h.user_id === a.user_id && h.entity_id === id).map((h) => this.clone(h));
  }
  purge(access) {
    const a = this._auth(access);
    const cutoff = this.now() - TRASH_DAYS * 86400000;
    const gone = new Set(this.tables.ex_tx.filter((r) => r.user_id === a.user_id && r.deleted_at && Date.parse(r.deleted_at) <= cutoff).map((r) => r.id));
    this.tables.ex_tx = this.tables.ex_tx.filter((r) => !gone.has(r.id));
    this.tables.ex_history = this.tables.ex_history.filter((h) => !gone.has(h.entity_id));
  }

  /* ---- 영수증 스캔 입구(ex-scan 흉내; 키 확인·멱등·하루 상한·기간·항목) ---- */
  scanCall(body) {
    this._net();
    const st = this.scanState;
    if (st.locked_until && st.locked_until > this.now()) return { status: 429, body: { error: 'locked' } };
    if (!body || body.key !== this.scanKey) {
      st.fails += 1;
      if (st.fails >= 10) { st.fails = 0; st.locked_until = this.now() + 15 * 60000; }
      return { status: 401, body: { error: 'bad_key' } };
    }
    st.fails = 0;
    const uid = this.slotsState[1].user_id;
    if (this.slotsState[1].state !== 'set') return { status: 400, body: { error: 'not_ready' } };
    // 장부 고르기: 장부 코드 또는 카드 끝 4자리. 없으면 no_ledger, 준비 중이면 ledger_not_ready
    const code = body.ledger === 'opex' || body.ledger === 'research' ? body.ledger : null;
    const card = /^\d{4}$/.test(String(body.card_last4 || '')) ? String(body.card_last4) : null;
    const led = this.tables.ex_ledgers.find((l) => l.user_id === uid && (code ? l.code === code : card ? l.card_last4 === card : false));
    if (!led) return { status: 400, body: { error: 'no_ledger' } };
    if (led.status !== 'active') return { status: 409, body: { error: 'ledger_not_ready' } };
    const summaryFor = (date, ledId = led.id) => {
      const lg = this._ledger(uid, ledId);
      const rows = this.tables.ex_tx.filter((t) => t.user_id === uid && t.ledger_id === ledId && !t.deleted_at);
      const live = rows.filter((t) => t.tx_date >= lg.period_start && t.tx_date <= lg.period_end);
      const sum = (arr) => arr.reduce((x, t) => x + t.amount, 0);
      const day = rows.filter((t) => t.tx_date === date);
      const mu = sum(live.filter((t) => t.tx_date.slice(0, 7) === date.slice(0, 7)));
      const tu = sum(live);
      return { ledger: lg.code, date, month: date.slice(0, 7), month_used: mu, monthly_limit: lg.monthly_limit, total_used: tu, total_budget: lg.total_budget, total_remaining: lg.total_budget - tu, day_count: day.length, day_sum: sum(day) };
    };
    if (body.action === 'summary') return { status: 200, body: summaryFor(/^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : kstDate(this.now())) };
    if (body.action === 'register') {
      const FIELD_RE = /^[0-9A-Za-z가-힣 \-·&()]+$/;
      if (!Number.isInteger(body.amount) || body.amount <= 0 || body.amount > 99999999) return { status: 400, body: { error: 'bad_amount' } };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) return { status: 400, body: { error: 'bad_date' } };
      const category = body.category ? body.category : (led.code === 'research' ? '연구활동비' : '식비');   // 항목을 안 보내면 장부별 기본값
      if (!led.categories.includes(category)) return { status: 400, body: { error: 'bad_category' } };
      const summary = String(body.summary ?? '').replace(/\s+/g, ' ').trim();
      if (!summary || summary.length > 20 || !FIELD_RE.test(summary) || looksLikeInstruction(summary)) return { status: 400, body: { error: 'bad_summary' } };
      if (!/^[0-9a-f]{8}$/.test(String(body.scan_id ?? ''))) return { status: 400, body: { error: 'bad_scan_id' } };
      const dup = this.tables.ex_tx.find((t) => t.user_id === uid && t.scan_id === body.scan_id);
      if (dup) return { status: 200, body: { id: dup.id, duplicate: true, deleted: !!dup.deleted_at, tx_date: dup.tx_date, amount: dup.amount, summary: summaryFor(dup.tx_date, dup.ledger_id) } };
      const s = this._settingsOf(uid);
      const dayStart = Date.parse(kstDate(this.now()) + 'T00:00:00+09:00');
      const today = this.tables.ex_tx.filter((t) => t.user_id === uid && t.source === 'scan' && Date.parse(t.created_at) >= dayStart);
      if (today.length + 1 > s.scan_daily_max_count || today.reduce((x, t) => x + t.amount, 0) + body.amount > s.scan_daily_max_amount) return { status: 429, body: { error: 'daily_limit' } };
      const subItem = body.sub_item ? String(body.sub_item).slice(0, 40) : null;
      const row = { id: uuid(), user_id: uid, ledger_id: led.id, sub_item: subItem, pay_method: led.code === 'research' ? '법인카드' : null, proof_no: null, vendor: null, tx_date: body.date, settle_date: body.date, category, meal: null, summary, amount: body.amount, attendees: null, headcount: null, source: 'scan', scan_id: body.scan_id, created_at: this.iso(), updated_at: this.iso(), deleted_at: null };
      try { this._validateTx(row, null, { user_id: uid }); } catch (e) { return { status: 400, body: { error: e.code, message: e.message } }; }
      this.tables.ex_tx.push(row);
      this._history(null, row, false);
      return { status: 200, body: { id: row.id, duplicate: false, tx_date: row.tx_date, amount: row.amount, summary: summaryFor(row.tx_date) } };
    }
    return { status: 400, body: { error: 'bad_action' } };
  }
}

export function createMemoryAdapter(server, { phoneClockSkewMs = 0 } = {}) {
  let session = null;
  const ad = {
    onSession: null,
    mode: 'memory',
    server,
    get session() { return session; },
    setSession(s) { session = s; },
    auth: {
      slots: async () => server.fnSlots(),
      setup: async (slot, pw) => (session = await server.fnSetup(slot, pw)),
      login: async (slot, pw) => (session = await server.fnLogin(slot, pw)),
      refresh: async (rt) => (session = server.refreshSession(rt)),
      changePassword: async (cur, next) => (session = await server.fnChange(session.access_token, cur, next)),
      logoutAll: async () => { await call(() => server.fnLogoutAll(session.access_token)); },
    },
    data: {
      loadAll: async () => call(() => {
        server.ensureLedgers(session.access_token);
        return {
          tx: server.select('ex_tx', session.access_token),
          ledgers: server.select('ex_ledgers', session.access_token),
          settings: server.select('ex_settings', session.access_token)[0] || null,
        };
      }),
      upsert: async (table, rows) => call(() => server.upsert(table, session.access_token, rows)),
      updateLedger: async (id, patch) => call(() => server.updateLedger(session.access_token, id, patch)),
      undoCreate: async (id) => call(() => server.undoCreate(session.access_token, id)),
      history: async (id) => call(() => server.history(session.access_token, id)),
      purgeMine: async () => call(() => server.purge(session.access_token)),
    },
    serverOffsetMs: () => phoneClockSkewMs * -1,
  };
  let refreshing = null;
  const renew = () => {
    if (!refreshing) {
      refreshing = Promise.resolve().then(() => { session = server.refreshSession(session.refresh_token); if (ad.onSession) ad.onSession(session); })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  };
  async function call(fn) {
    if (session && !session.access_token) await renew();
    try { return await fn(); } catch (e) {
      if (e instanceof ApiError && (e.code === 'jwt_expired' || e.code === 'no_auth') && session && session.refresh_token) {
        await renew();
        return fn();
      }
      throw e;
    }
  }
  return ad;
}

/* ------------------------------------------------------------------ */
/* 실제 서버(Supabase) 어댑터. 라이브러리 없이 fetch 만 씁니다.           */
/* ------------------------------------------------------------------ */
export function createSupabaseAdapter({ url, anonKey }) {
  let session = null;
  let offset = 0;
  const base = url.replace(/\/$/, '');

  async function raw(path, { method = 'GET', headers = {}, body, token } = {}) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: { apikey: anonKey, Authorization: `Bearer ${token || anonKey}`, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new NetworkError();
    }
    const d = res.headers.get('Date');
    if (d) { const sv = Date.parse(d); if (!Number.isNaN(sv)) offset = sv - Date.now(); }
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = { message: text }; } }
    if (!res.ok) {
      if (res.status >= 500) throw new NetworkError('서버가 잠시 응답하지 않습니다.');
      const code = (data && (data.error || data.code)) || 'error';
      const msg = (data && (data.message || data.msg || data.error_description)) || '요청이 거절되었습니다.';
      // 서버 트리거가 던진 사유(예: 'out of period')를 앱이 아는 코드로 바꿈
      let c = String(code);
      if (/out of period/.test(msg)) c = 'out_of_period';
      else if (/future date/.test(msg)) c = 'future';
      throw new ApiError(res.status, c, msg, data || {});
    }
    return data;
  }

  const toSession = (d, slot) => ({ slot: slot ?? d.slot, user_id: d.user?.id || d.user_id, access_token: d.access_token, refresh_token: d.refresh_token });
  async function fn(body, token) { return raw('/functions/v1/ex-auth', { method: 'POST', body, token }); }

  let refreshing = null;
  const renew = () => {
    if (!refreshing) refreshing = ad.auth.refresh(session.refresh_token).finally(() => { refreshing = null; });
    return refreshing;
  };
  async function authed(path, opts = {}, retry = true) {
    if (!session) throw new ApiError(401, 'no_auth', '로그인이 필요합니다.');
    if (!session.access_token) await renew();
    try {
      return await raw(path, { ...opts, token: session.access_token });
    } catch (e) {
      if (retry && e instanceof ApiError && (e.status === 401 || e.code === 'PGRST301' || /jwt/i.test(e.message))) {
        await renew();
        return authed(path, opts, false);
      }
      throw e;
    }
  }
  // 1000행씩 나눠 받기 (한 번에 최대 1000행까지만 내려오는 서버 한도)
  async function selectAll(table, query = '') {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const rows = await authed(`/rest/v1/${table}?select=*${query}`, { headers: { Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } });
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  }

  const ad = {
    onSession: null,
    mode: 'supabase',
    get session() { return session; },
    setSession(s) { session = s; },
    auth: {
      slots: async () => (await fn({ action: 'slots' })).slots,
      setup: async (slot, pw) => (session = toSession(await fn({ action: 'setup', slot, password: pw }), slot)),
      login: async (slot, pw) => (session = toSession(await fn({ action: 'login', slot, password: pw }), slot)),
      refresh: async (rt) => {
        let d;
        try {
          d = await raw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: rt } });
        } catch (e) {
          if (e instanceof ApiError) throw new ApiError(e.status, 'invalid_session', '로그인이 풀렸습니다.');
          throw e;
        }
        session = { slot: session?.slot, user_id: d.user?.id, access_token: d.access_token, refresh_token: d.refresh_token };
        if (ad.onSession) ad.onSession(session);
        return session;
      },
      changePassword: async (cur, next) => (session = toSession(await fn({ action: 'change', current: cur, password: next }, session.access_token), session.slot)),
      logoutAll: async () => { await authed('/functions/v1/ex-auth', { method: 'POST', body: { action: 'logout_all' } }); },
    },
    data: {
      loadAll: async () => {
        let ledgers = await selectAll('ex_ledgers');
        if (ledgers.length < 2) { await authed('/rest/v1/rpc/ex_ensure_ledgers', { method: 'POST', body: {} }); ledgers = await selectAll('ex_ledgers'); }
        const [tx, st] = await Promise.all([selectAll('ex_tx'), selectAll('ex_settings')]);
        return { tx, ledgers, settings: st[0] || null };
      },
      updateLedger: async (id, patch) => {
        const rows = await authed(`/rest/v1/ex_ledgers?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch });
        return rows[0];
      },
      upsert: async (table, rows) => {
        const conflict = table === 'ex_settings' ? 'user_id' : 'id';
        // 설정 줄은 처음 저장할 때 user_id 가 필요하다
        const body = table === 'ex_settings' ? rows.map((r) => ({ ...r, user_id: r.user_id || session.user_id })) : rows;
        return authed(`/rest/v1/${table}?on_conflict=${conflict}`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body });
      },
      undoCreate: async (id) => { await authed('/rest/v1/rpc/ex_undo_create', { method: 'POST', body: { p_id: id } }); },
      history: async (id) => authed(`/rest/v1/ex_history?entity_id=eq.${id}&order=at.desc`),
      purgeMine: async () => { await authed('/rest/v1/rpc/ex_purge_mine', { method: 'POST', body: {} }); },
    },
    serverOffsetMs: () => offset,
  };
  return ad;
}

export { SLOT_LABEL };
