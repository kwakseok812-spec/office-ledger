// 계산 규칙·저장 흐름·영수증 스캔 입구를 가짜 서버(MemoryServer) 위에서 시험합니다. 가짜 데이터만 씁니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/calc.js';
import { MemoryServer, createMemoryAdapter, ApiError } from '../js/data.js';
import { createStore, SaveError } from '../js/store.js';

const KST = (d, t = '12:00:00') => Date.parse(`${d}T${t}+09:00`);
const PW = 'test-pw-2468';

async function mk({ now = KST('2026-10-20'), login = true } = {}) {
  const clock = { t: now };
  const server = new MemoryServer({ now: () => clock.t });
  const adapter = createMemoryAdapter(server);
  const store = createStore({ adapter, clock: () => clock.t });
  if (login) {
    await store.loadSlots(); await store.setup(1, PW);
    // 카드 끝 4자리는 서버 기본값이 비어 있으므로(개인 설정) 시험용 가짜 값을 설정한다
    for (const l of store.state.ledgers) await adapter.data.updateLedger(l.id, { card_last4: l.code === 'opex' ? '1111' : '2222' });
    await store.sync();
  }
  return { clock, server, adapter, store };
}
const F = (o = {}) => ({ tx_date: '2026-10-19', category: '식비', meal: '중식', summary: '시험 식당', amount: 30000, attendees: '시험인 외 1명', headcount: 2, ...o });

/* ----------------------------- 계산 ----------------------------- */
test('기간 달 목록은 장부 설정에서 만든다(해를 넘김)', () => {
  const ms = C.monthsOf(C.DEFAULTS);
  assert.deepEqual(ms.map((m) => m.ym), ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
  assert.equal(C.monthLabel(ms[5], ms[0]), "'27.1월");
  const other = { ...C.DEFAULTS, period_start: '2026-06-01', period_end: '2026-08-31' };
  assert.equal(C.monthsOf(other).length, 3);   // 코드 상수가 아니라 장부 값이 기준
});

test('운영비 요약: 월 한도 초과는 막지 않고 표시만, 합계는 기간 안만', () => {
  const tx = [
    { id: '1', tx_date: '2026-10-02', amount: 200000 }, { id: '2', tx_date: '2026-10-09', amount: 150000 },
    { id: '3', tx_date: '2026-09-01', amount: 100000 }, { id: '4', tx_date: '2026-07-01', amount: 999999 },   // 기간 밖
    { id: '5', tx_date: '2026-10-03', amount: 5000, deleted_at: '2026-10-04T00:00:00Z' },                       // 지운 것
  ];
  const s = C.summarize(tx, C.DEFAULTS, '2026-10-20');
  assert.equal(s.monthUsed, 350000); assert.equal(s.monthOver, true); assert.equal(s.monthRemaining, -50000);
  assert.equal(s.totalUsed, 450000); assert.equal(s.totalRemaining, 1650000); assert.equal(s.totalOver, false);
  assert.equal(s.monthsLeft, 5);
  assert.equal(s.monthly.find((m) => m.ym === '2026-10').over, true);
  assert.equal(s.monthly.find((m) => m.ym === '2026-09').over, false);
});

test('저장 전 점검: 막는 것 / 되묻는 것', () => {
  const base = { tx: [{ id: 'a', tx_date: '2026-10-05', amount: 40000, summary: '가 식당' }], settings: C.DEFAULTS, today: '2026-10-20' };
  const chk = (f, extra = {}) => C.checkEntry({ ...base, f: F(f), ...extra });
  assert.ok(chk({ tx_date: '2026-10-21' }).error, '앞으로 올 날짜');
  assert.ok(chk({ tx_date: '2026-07-31' }).error, '기간 밖');
  assert.ok(chk({ amount: 0 }).error); assert.ok(chk({ summary: '  ' }).error); assert.ok(chk({ category: '없는항목' }).error);
  assert.equal(chk({}).error, null);
  assert.ok(chk({ tx_date: '2026-10-05', amount: 40000, summary: '가 식당' }).dup, '같은 날·금액·적요');
  assert.equal(chk({ tx_date: '2026-10-05', amount: 40000, summary: '가 식당' }, { exceptId: 'a' }).dup, null, '자기 자신은 제외');
  assert.equal(chk({ amount: 999999 }).big, false); assert.equal(chk({ amount: 1000000 }).big, true);
  const over = C.checkEntry({ ...base, tx: [{ id: 'b', tx_date: '2026-09-01', amount: 2090000 }], f: F({ amount: 20000 }) });
  assert.equal(over.overTotal, true); assert.equal(over.overBy, 10000);
  assert.equal(chk({ amount: 400000 }).overTotal, false, '월 한도(30만)를 넘어도 총액만 안 넘으면 되묻지 않는다');
});

test('가져오기 파서: 정산서 머리글(신청일자는 무시)·탭 붙여넣기·기본 열 순서·오류·중복', () => {
  const ctx = { tx: [], settings: C.DEFAULTS, today: '2026-10-20' };
  const csv = '신청일자,사용일자,정산일자,구분,적요,금액,참가자,인원\n2026-08-06,2026-08-06,2026-08-07,중식,시험 식당,"11,100",시험인 외 2명,3\n2026-08-20,2026-08-20,2026-08-20,석식,예시 식당,22200,시험인 외 1명,2\n2026-08-21,2026-07-01,,중식,기간밖,1000,,\n2026-09-01,2026-09-01,,중식,이상한 금액,abc,,';
  const r = C.parseImport(csv, ctx);
  assert.equal(r.rows.length, 2); assert.equal(r.total, 33300);
  assert.deepEqual(r.rows[0].f, { tx_date: '2026-08-06', settle_date: '2026-08-07', category: '식비', meal: '중식', summary: '시험 식당', amount: 11100, attendees: '시험인 외 2명', headcount: 3, pay_method: null, proof_no: null, vendor: null, sub_item: null });
  assert.equal(r.errors.length, 2);
  const tab = '2026-09-03\t2026-09-03\t중식\t탭 식당\t33,300\t시험인 외 4명\t5';   // 머리글 없음: 정산서 열 순서
  const t = C.parseImport(tab, ctx);
  assert.equal(t.rows[0].f.amount, 33300); assert.equal(t.rows[0].f.headcount, 5);
  const dup = C.parseImport('2026-08-06,2026-08-06,중식,시험 식당,11100\n2026-08-06,2026-08-06,중식,시험 식당,11100', ctx);
  assert.equal(dup.rows.length, 1); assert.equal(dup.skippedDup.length, 1, '붙여 넣은 글 안의 중복은 건너뜀');
});

test('연구비 요약: 비목별 예산·잔액, 월별 사용·정산일·누적(지급신청)', () => {
  const led = { code: 'research', status: 'active', period_start: '2026-06-01', period_end: '2027-02-28', categories: ['연구활동비', '연구수당', '재료비'], budgets: { 연구활동비: 3000000, 연구수당: 900000, 재료비: 0 }, total_budget: 3900000, subitems: { 연구활동비: ['회의비'] }, project: {} };
  const tx = [
    { id: '1', tx_date: '2026-07-10', settle_date: '2026-08-03', category: '연구활동비', amount: 100000 },
    { id: '2', tx_date: '2026-07-29', settle_date: '2026-08-03', category: '연구활동비', amount: 50000 },
    { id: '3', tx_date: '2026-08-14', settle_date: '2026-09-01', category: '연구활동비', amount: 200000 },
    { id: '4', tx_date: '2026-09-15', settle_date: '2026-10-01', category: '연구활동비', amount: 300000 },
  ];
  const rs = C.researchSummary(tx, led, '2026-10-20');
  assert.equal(rs.total, 3900000); assert.equal(rs.used, 650000); assert.equal(rs.remaining, 3250000);
  const act = rs.byCat.find((c) => c.cat === '연구활동비');
  assert.equal(act.remaining, 2350000); assert.equal(rs.byCat.some((c) => c.cat === '재료비'), false, '예산도 사용도 0이면 숨김');
  const m = Object.fromEntries(rs.monthly.map((x) => [x.ym, x]));
  assert.equal(m['2026-07'].used, 150000); assert.equal(m['2026-07'].settle, '2026-08-03'); assert.equal(m['2026-07'].cum, 150000);
  assert.equal(m['2026-08'].cum, 350000); assert.equal(m['2026-09'].cum, 650000);
  assert.equal(m['2026-09'].cumCat['연구활동비'], 650000);   // 연구활동비 잔액 = 예산 - 누적 (지급신청서의 잔액 흐름)
  assert.equal(m['2026-10'].used, 0);
  assert.equal(C.researchTotal({ budgets: { a: 100, b: 200 } }), 300, '총액이 없으면 비목 예산의 합');
});

test('연구비 연구비 점검: 월 한도 없음, 비목 예산 초과는 되묻기', () => {
  const led = { code: 'research', status: 'active', period_start: '2026-06-01', period_end: '2027-02-28', categories: ['연구활동비', '연구수당'], budgets: { 연구활동비: 100000, 연구수당: 50000 }, total_budget: 150000 };
  const r = C.checkEntry({ tx: [{ id: 'x', tx_date: '2026-07-01', amount: 90000, category: '연구활동비' }], settings: led, today: '2026-10-20', f: F({ category: '연구활동비', amount: 20000, summary: '회의비', tx_date: '2026-07-05' }) });
  assert.equal(r.error, null); assert.equal(r.overCat, true); assert.equal(r.catOverBy, 10000); assert.equal(r.overTotal, false);
  const ok = C.checkEntry({ tx: [], settings: led, today: '2026-10-20', f: F({ category: '연구수당', amount: 50000, summary: '수당', tx_date: '2026-07-05' }) });
  assert.equal(ok.overCat, false);
});

test('연구비 정산 자료 머리글(괄호 설명 포함)을 읽는다', () => {
  const led = { code: 'research', status: 'active', period_start: '2026-06-01', period_end: '2027-02-28', categories: ['연구활동비', '연구수당'] };
  const csv = '사용월,사용일자,세부내역(적요),항목(비목),구분,금액(원),증빙번호,결제수단,정산(작성)일자,과제명,지원기관,참가자/인원,원문불확실\n2026-07,2026-07-10,회의비,연구활동비,직접비,50000,1,법인카드(카드번호 자료에 없음),2026-08-03,시험과제,시험기관,가나다 라마,없음';
  const r = C.parseImport(csv, { tx: [], settings: led, today: '2026-10-20' });
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.rows[0].f, { tx_date: '2026-07-10', settle_date: '2026-08-03', category: '연구활동비', meal: '직접비', summary: '회의비', amount: 50000, attendees: '가나다 라마', headcount: null, pay_method: '법인카드', proof_no: '1', vendor: null, sub_item: null });
});

/* ----------------------------- 저장 흐름 ----------------------------- */
test('처음 설정 -> 장부 2개 자동 생성, 운영비 기본값은 서버 값', async () => {
  const { store } = await mk();
  assert.equal(store.state.phase, 'app');
  assert.deepEqual(store.state.ledgers.map((l) => l.code), ['opex', 'research']);
  const o = store.state.ledgers[0];
  assert.equal(o.monthly_limit, 300000); assert.equal(o.total_budget, 2100000); assert.equal(o.card_last4, '1111', '시험에서 설정한 값(서버 기본값은 비어 있음)'); assert.deepEqual(o.categories, C.CATEGORIES);
  assert.equal(store.state.ledgers[1].card_last4, '2222'); assert.equal(store.state.ledgers[1].status, 'active');
});

test('지출 추가 -> 서버 저장 확인 후 반영, 이력·되돌리기(15초)', async () => {
  const { store, server, clock } = await mk();
  const r = await store.addTx(F());
  assert.equal(r.status, 'saved'); assert.equal(server.tables.ex_tx.length, 1);
  assert.equal(server.tables.ex_tx[0].ledger_id, store.curLedger().id);
  assert.equal(store.summary().monthUsed, 30000);
  assert.ok(await store.undo()); assert.equal(server.tables.ex_tx.length, 0); assert.equal(store.state.tx.length, 0);
  await store.addTx(F()); clock.t += 16000; store.expireUndo(); assert.equal(store.state.undo, null);
});

test('수정·같은 값 이력·이전 값 복원', async () => {
  const { store, server } = await mk();
  const { row } = await store.addTx(F({ amount: 10000 }));
  await store.editTx(row.id, F({ amount: 12000 }));
  await store.editTx(row.id, F({ amount: 12000 }));   // 같은 값: 이력 늘지 않음
  const h = (await store.historyOf(row.id)).filter((x) => x.action === 'update');
  assert.equal(h.length, 1); assert.equal(h[0].old.amount, 10000);
  await store.restoreValue(row.id, h[0]);
  assert.equal(store.findTx(row.id).amount, 10000);
});

test('지우기는 휴지통(30일), 되살리기, 30일 뒤 영구 삭제', async () => {
  const { store, server, clock } = await mk();
  const { row } = await store.addTx(F());
  await store.removeTx(row.id);
  assert.equal(store.summary().monthUsed, 0); assert.equal(store.trashItems().length, 1);
  await store.restoreTx(row.id); assert.equal(store.summary().monthUsed, 30000);
  await store.removeTx(row.id);
  clock.t += 31 * 86400000; await store.sync();
  assert.equal(server.tables.ex_tx.length, 0, '30일 지난 휴지통은 영구 삭제');
});

test('서버 거부(기간 밖·미래·준비 중 장부)는 저장 안 되고 오류로 알림', async () => {
  const { store, server } = await mk();
  await assert.rejects(() => store.addTx(F({ tx_date: '2026-07-31' })), SaveError);
  await assert.rejects(() => store.addTx(F({ tx_date: '2026-10-21' })), SaveError);
  server.failNext = { status: 400, code: 'rejected', msg: '서버 거부' };
  await assert.rejects(() => store.addTx(F()), /서버 거부/);
  assert.equal(server.tables.ex_tx.length, 0); assert.equal(store.state.tx.length, 0, '실패하면 화면에도 남지 않음');
  server.tables.ex_ledgers.find((l) => l.code === 'opex').status = 'soon';
  await store.sync();
  await assert.rejects(() => store.addTx(F()), /준비 중/);
});

test('오프라인 저장은 임시 보관 후 연결되면 올라간다', async () => {
  const { store, server } = await mk();
  server.online = false;
  const r = await store.addTx(F());
  assert.equal(r.status, 'queued'); assert.equal(store.state.outbox.length, 1); assert.equal(server.tables.ex_tx.length, 0);
  assert.equal(store.summary().monthUsed, 30000, '화면에는 바로 보임');
  server.online = true; await store.sync();
  assert.equal(store.state.outbox.length, 0); assert.equal(server.tables.ex_tx.length, 1);
});

test('가져오기: 여러 건을 한 번에, 하나라도 거부되면 전부 되돌림, 되돌리기로 일괄 취소', async () => {
  const { store, server } = await mk();
  const fs = [F({ tx_date: '2026-08-06', amount: 1000, summary: 'a' }), F({ tx_date: '2026-09-06', amount: 2000, summary: 'b' }), F({ tx_date: '2026-10-06', amount: 3000, summary: 'c' })];
  const r = await store.addMany(fs);
  assert.equal(r.rows.length, 3); assert.equal(store.summary().totalUsed, 6000);
  assert.equal(server.tables.ex_tx.every((t) => t.source === 'import'), true);
  assert.ok(await store.undo()); assert.equal(server.tables.ex_tx.length, 0);
  await assert.rejects(() => store.addMany([F({ summary: 'ok' }), F({ summary: '', amount: 5 })]));
  assert.equal(server.tables.ex_tx.length, 0, '하나가 잘못되면 아무것도 넣지 않음');
});

test('장부 분리: 연구비 입력은 운영비 합계·한도에 영향이 없다', async () => {
  const { store, server } = await mk();
  await store.addTx(F({ amount: 30000 }));
  store.setLedger('research');
  const led = store.curLedger();
  await store.saveResearch({ name: '시험 과제', institution: '시험 기관', period_start: '2026-06-01', period_end: '2027-02-28', budgets: { 연구활동비: 500000, 연구수당: 100000 }, card_last4: '2222' });
  assert.equal(store.curLedger().total_budget, 600000);
  await store.addTx({ tx_date: '2026-07-10', settle_date: '2026-08-03', category: '연구활동비', sub_item: '회의비', meal: '직접비', summary: '회의비', amount: 40000, pay_method: '법인카드', proof_no: '1', attendees: null, headcount: null });
  assert.equal(store.researchSummary().used, 40000);
  assert.equal(store.ledgerTx().length, 1);
  store.setLedger('opex');
  assert.equal(store.summary().totalUsed, 30000, '운영비 합계는 그대로');
  assert.equal(server.tables.ex_tx.length, 2);
  // 운영비 항목을 연구비 장부에 넣으려 하면 거부
  store.setLedger('research');
  await assert.rejects(() => store.addTx({ tx_date: '2026-07-10', category: '식비', summary: 'x', amount: 1000 }));
  await assert.rejects(() => store.addTx({ tx_date: '2026-07-10', category: '연구수당', sub_item: '회의비', summary: 'x', amount: 1000 }), '세부 비목은 그 비목 것만');
});

test('로그인: 틀린 횟수 잠금·다시 열기·전체 로그아웃', async () => {
  const { store, adapter, server, clock } = await mk();
  await store.logout();
  for (let i = 0; i < 4; i++) await assert.rejects(() => store.login(1, 'wrong-pw-1'), (e) => e instanceof ApiError && e.code === 'wrong' && e.data.remaining === 4 - i);
  await assert.rejects(() => store.login(1, 'wrong-pw-1'), (e) => e.code === 'locked');
  await assert.rejects(() => store.login(1, PW), (e) => e.code === 'locked', '잠긴 동안은 맞는 비밀번호도 거절');
  clock.t += 16 * 60000; await store.login(1, PW); assert.equal(store.state.phase, 'app');
  await store.logoutAllDevices(); assert.equal(store.state.phase, 'login');
});

/* ----------------------------- 영수증 스캔 입구 ----------------------------- */
const KEY = 'k'.repeat(64);
const reg = (extra = {}) => ({ key: KEY, action: 'register', card_last4: '1111', date: '2026-10-19', amount: 38500, summary: '시험 식당', category: '식비', scan_id: 'a1b2c3d4', ...extra });

test('스캔 등록: 카드 1111 -> 운영비 장부, 같은 scan_id 두 번은 한 건, 요약 숫자 반환', async () => {
  const { server, store } = await mk();
  const a = server.scanCall(reg());
  assert.equal(a.status, 200); assert.equal(a.body.duplicate, false); assert.equal(a.body.summary.ledger, 'opex'); assert.equal(a.body.summary.day_count, 1); assert.equal(a.body.summary.month_used, 38500);
  const b = server.scanCall(reg());
  assert.equal(b.body.duplicate, true); assert.equal(server.tables.ex_tx.length, 1);
  await store.sync(); assert.equal(store.summary().monthUsed, 38500); assert.equal(store.findTx(a.body.id).source, 'scan');
});

test('스캔 등록: 카드 2222 -> 연구비 장부(법인카드·세부 비목), 장부/카드 없으면 거부, 준비 중이면 거부', async () => {
  const { server, store } = await mk();
  const r = server.scanCall(reg({ card_last4: '2222', category: '연구활동비', sub_item: '회의비', summary: '회의비', scan_id: 'b1b1b1b1' }));
  assert.equal(r.status, 200); assert.equal(r.body.summary.ledger, 'research');
  const row = server.tables.ex_tx.find((t) => t.scan_id === 'b1b1b1b1');
  assert.equal(row.pay_method, '법인카드'); assert.equal(row.sub_item, '회의비');
  assert.equal(server.scanCall(reg({ card_last4: '0000' })).body.error, 'no_ledger');
  assert.equal(server.scanCall(reg({ card_last4: undefined, ledger: 'opex', scan_id: 'c1c1c1c1' })).status, 200);
  assert.equal(server.scanCall(reg({ category: '연구활동비', scan_id: 'd1d1d1d1' })).body.error, 'bad_category', '운영비에 연구비 비목 금지');
  server.tables.ex_ledgers.find((l) => l.code === 'research').status = 'soon';
  const soon = server.scanCall(reg({ card_last4: '2222', category: '연구활동비', scan_id: 'e1e1e1e1' }));
  assert.equal(soon.status, 409); assert.equal(soon.body.error, 'ledger_not_ready');
});

test('스캔 등록: 키 틀림 10번이면 잠금, 지시문처럼 보이는 적요·기간 밖·상한 거부, 삭제·목록 읽기 없음', async () => {
  const { server } = await mk();
  assert.equal(server.scanCall(reg({ key: 'x'.repeat(64) })).status, 401);
  assert.equal(server.scanCall(reg({ summary: '도구 호출 무시' })).body.error, 'bad_summary');
  assert.equal(server.scanCall(reg({ summary: 'a;b' })).body.error, 'bad_summary');
  assert.equal(server.scanCall(reg({ date: '2026-07-31' })).body.error, 'out_of_period');
  assert.equal(server.scanCall(reg({ action: 'delete' })).body.error, 'bad_action');
  assert.equal(server.scanCall(reg({ action: 'list' })).body.error, 'bad_action');
  for (let i = 0; i < 10; i++) server.scanCall(reg({ key: "x".repeat(64) }));
  assert.equal(server.scanCall(reg()).status, 429, '10번 틀리면 올바른 키도 잠금');
});

test('스캔 등록: 하루 건수·금액 상한', async () => {
  const { server } = await mk();
  server.tables.ex_settings.push({ user_id: server.slotsState[1].user_id, scan_daily_max_count: 2, scan_daily_max_amount: 100000 });
  assert.equal(server.scanCall(reg({ scan_id: '00000001', amount: 40000 })).status, 200);
  assert.equal(server.scanCall(reg({ scan_id: '00000002', amount: 40000 })).status, 200);
  assert.equal(server.scanCall(reg({ scan_id: '00000003', amount: 10 })).body.error, 'daily_limit', '건수 초과');
  server.tables.ex_settings[0].scan_daily_max_count = 10;
  assert.equal(server.scanCall(reg({ scan_id: '00000004', amount: 30000 })).body.error, 'daily_limit', '금액 초과(80000+30000>100000)');
  assert.equal(server.scanCall(reg({ scan_id: '00000005', amount: 20000 })).status, 200);
});

test('스캔 summary: 읽기만, 장부별로 분리', async () => {
  const { server } = await mk();
  server.scanCall(reg({ amount: 10000 }));
  server.scanCall(reg({ card_last4: '2222', category: '연구활동비', summary: '회의비', scan_id: 'f1f1f1f1', amount: 77000 }));
  const o = server.scanCall({ key: KEY, action: 'summary', card_last4: '1111', date: '2026-10-19' }).body;
  const r = server.scanCall({ key: KEY, action: 'summary', ledger: 'research', date: '2026-10-19' }).body;
  assert.equal(o.total_used, 10000); assert.equal(o.monthly_limit, 300000); assert.equal(r.total_used, 77000);
});

test('서버 기본 장부에는 카드 끝 4자리가 없고, 설정 화면(saveLedger)에서 바꿀 수 있다', async () => {
  const { store, server } = await mk({ login: false });
  await store.loadSlots(); await store.setup(1, PW);
  assert.deepEqual(store.state.ledgers.map((l) => l.card_last4), [null, null]);
  await assert.rejects(() => store.saveLedger({ card_last4: '12a4' }), SaveError);
  await store.saveLedger({ card_last4: '4321' });
  assert.equal(store.curLedger().card_last4, '4321'); assert.equal(server.tables.ex_ledgers[0].card_last4, '4321');
  assert.equal(server.scanCall({ key: KEY, action: 'summary', card_last4: '4321' }).status, 200, '바꾼 카드로 스캔이 장부를 찾는다');
  await store.saveLedger({ card_last4: '' }); assert.equal(store.curLedger().card_last4, null);
  store.setLedger('research');
  await store.saveResearch({ name: '', institution: '', period_start: '2026-06-01', period_end: '2027-02-28', budgets: {}, card_last4: '5555' });
  assert.equal(store.curLedger().card_last4, '5555');
});

test('스캔 항목 기본값은 장부별: 운영비 식비 / 연구비 연구활동비', async () => {
  const { server } = await mk();
  const a = server.scanCall({ key: KEY, action: 'register', card_last4: '1111', date: '2026-10-19', amount: 1000, summary: '시험', scan_id: '10101010' });
  assert.equal(a.status, 200); assert.equal(server.tables.ex_tx.find((t) => t.scan_id === '10101010').category, '식비');
  const b = server.scanCall({ key: KEY, action: 'register', card_last4: '2222', date: '2026-10-19', amount: 1000, summary: '시험', scan_id: '20202020' });
  assert.equal(b.status, 200); assert.equal(server.tables.ex_tx.find((t) => t.scan_id === '20202020').category, '연구활동비');
});

test('금액이 큰 건 확인: 운영비 100만 원 이상, 연구비 500만 원 이상(연구비는 비목 예산 초과 확인이 기본)', () => {
  const opex = C.checkEntry({ tx: [], settings: C.DEFAULTS, today: '2026-10-20', f: F({ amount: 1000000 }) });
  assert.equal(opex.big, true);
  const led = { code: 'research', status: 'active', period_start: '2026-06-01', period_end: '2027-02-28', categories: ['연구활동비'], budgets: { 연구활동비: 9000000 }, total_budget: 9000000 };
  const mk2 = (amount) => C.checkEntry({ tx: [], settings: led, today: '2026-10-20', f: F({ category: '연구활동비', summary: '회의비', tx_date: '2026-07-05', amount }) });
  assert.equal(mk2(1000000).big, false); assert.equal(mk2(4999999).big, false); assert.equal(mk2(5000000).big, true);
});

test('가져오기 중복: 줄 번호·사유를 돌려주고, 사용자가 포함을 고를 수 있게 내용(f)도 담는다', () => {
  const ctx = { tx: [{ id: 'x', tx_date: '2026-08-06', amount: 11100, summary: '시험 식당' }], settings: C.DEFAULTS, today: '2026-10-20' };
  const r = C.parseImport('2026-08-06,2026-08-06,중식,시험 식당,11100\n2026-08-07,2026-08-07,중식,다른 식당,2000\n2026-08-07,2026-08-07,중식,다른 식당,2000', ctx);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.skippedDup.map((d) => [d.line, d.reason]), [[1, '이미 입력된 내역과 같습니다'], [3, '붙여 넣은 글의 앞 줄과 같습니다']]);
  assert.equal(r.skippedDup[1].f.amount, 2000);
});

test('가져오기 머리글: 적요 헤더 지원, 사용처는 vendor 로(적요와 섞이지 않음), 연번·신청일자는 무시', () => {
  const ctx = { tx: [], settings: C.DEFAULTS, today: '2026-10-20' };
  const r = C.parseImport('연번,신청일자,사용일자,적요,금액,사용처\n1,2026-08-06,2026-08-06,점심,5000,시험 가게', ctx);
  assert.equal(r.errors.length, 0); assert.equal(r.rows[0].f.summary, '점심'); assert.equal(r.rows[0].f.vendor, '시험 가게');
  assert.ok(C.IMPORT_HEADERS.includes('적요') && C.IMPORT_HEADERS.includes('사용처'));
});
