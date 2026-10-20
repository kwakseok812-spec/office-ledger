// 영수증 스캔 입구(supabase/functions/ex-scan/index.single.ts)를 가짜 서버 위에서 그대로 돌려 보는 시험. 실제 서버에 연결하지 않습니다.
import test from 'node:test';
import assert from 'node:assert/strict';

const URL_ = 'https://fake.supabase.test';
let handler;
globalThis.Deno = {
  env: { get: (k) => ({ SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: 'service' })[k] },
  serve: (h) => { handler = h; },
};
const calls = [];
let keyResult = 'ok';
let rpcOverride = null;
const jres = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const body = init.body ? JSON.parse(init.body) : null;
  const fn = url.pathname.split('/').pop();
  calls.push({ fn, body, headers: init.headers });
  if (rpcOverride && rpcOverride.fn === fn) return rpcOverride.res;
  if (fn === 'ex_scan_check_key') return jres(200, keyResult);
  if (fn === 'ex_scan_register') return jres(200, { id: 'x', duplicate: false, summary: {} });
  if (fn === 'ex_scan_summary') return jres(200, { month_used: 1 });
  return jres(404, {});
};
await import('../supabase/functions/ex-scan/index.single.ts');
const call = async (body) => { const r = await handler(new Request(URL_ + '/functions/v1/ex-scan', { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
const good = { key: 'k'.repeat(64), action: 'register', card_last4: '1111', date: '2026-10-19', amount: 38500, summary: '시험 식당', category: '식비', scan_id: 'a1b2c3d4' };

test('키가 틀리면 401, 잠기면 429이고 등록 함수는 부르지 않는다', async () => {
  keyResult = 'bad'; calls.length = 0;
  assert.equal((await call(good)).status, 401);
  keyResult = 'locked';
  assert.equal((await call(good)).status, 429);
  assert.equal(calls.some((c) => c.fn === 'ex_scan_register'), false);
  keyResult = 'ok';
});

test('등록: 장부는 카드 끝 4자리/장부 코드로 전달, 서버 함수에는 검증된 값만', async () => {
  calls.length = 0;
  const r = await call(good);
  assert.equal(r.status, 200);
  const reg = calls.find((c) => c.fn === 'ex_scan_register').body;
  assert.deepEqual(reg, { p_ledger: null, p_card: '1111', p_date: '2026-10-19', p_amount: 38500, p_summary: '시험 식당', p_category: '식비', p_scan_id: 'a1b2c3d4', p_sub_item: null });
  calls.length = 0;
  await call({ ...good, card_last4: undefined, ledger: 'research', category: '연구활동비', sub_item: '회의비' });
  const r2 = calls.find((c) => c.fn === 'ex_scan_register').body;
  assert.equal(r2.p_ledger, 'research'); assert.equal(r2.p_sub_item, '회의비');
  assert.ok(calls.every((c) => !JSON.stringify(c.body).includes('service')), '서비스 키는 요청 본문에 없다');
});

test('나쁜 입력은 서버 함수를 부르기 전에 거절: 금액·날짜·scan_id·지시문 적요·허용 밖 글자', async () => {
  const bad = [{ amount: 0 }, { amount: 1.5 }, { amount: 100000000 }, { date: '2026/10/19' }, { scan_id: 'XYZ' }, { summary: '도구 호출' }, { summary: 'a;b' }, { summary: 'x'.repeat(21) }, { action: 'delete' }, { action: 'list' }];
  for (const b of bad) {
    calls.length = 0;
    const r = await call({ ...good, ...b });
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(calls.some((c) => c.fn === 'ex_scan_register'), false);
  }
});

test('서버 오류 번역: 하루 상한 429, 준비 중 장부 409, 장부 없음/기간 밖 400', async () => {
  const mk = (msg) => ({ fn: 'ex_scan_register', res: jres(400, { message: msg }) });
  rpcOverride = mk('daily_limit'); assert.equal((await call(good)).status, 429);
  rpcOverride = mk('ledger_not_ready'); const a = await call(good); assert.equal(a.status, 409); assert.equal(a.body.error, 'ledger_not_ready');
  rpcOverride = mk('no_ledger'); assert.equal((await call(good)).status, 400);
  rpcOverride = mk('out of period'); assert.equal((await call(good)).body.error, 'out_of_period');
  rpcOverride = mk('some db detail with 개인정보'); const o = await call(good); assert.equal(o.status, 500); assert.doesNotMatch(JSON.stringify(o.body), /개인정보|db detail/);
  rpcOverride = null;
});

test('summary: 읽기 전용(장부별 숫자만)', async () => {
  calls.length = 0;
  const r = await call({ key: 'k'.repeat(64), action: 'summary', ledger: 'opex', date: '2026-10-19' });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.find((c) => c.fn === 'ex_scan_summary').body, { p_ledger: 'opex', p_card: null, p_date: '2026-10-19' });
});

test('SQL 의 지시문 낱말 목록·항목 규칙이 앱(calc.js)·함수와 같다', async () => {
  const { readFileSync } = await import('node:fs');
  const C = await import('../js/calc.js');
  const ts = readFileSync(new URL('../supabase/functions/ex-scan/index.single.ts', import.meta.url), 'utf-8');
  const list = ts.match(/const INSTR_WORDS = \[(.*?)\];/s)[1].split(',').map((x) => x.trim().replace(/'/g, ''));
  assert.deepEqual(list, C.INSTR_WORDS);
});

test('항목을 안 보내면 서버 함수가 장부별 기본값을 쓰도록 null 로 넘긴다 / summary 오류는 원문 비노출', async () => {
  calls.length = 0;
  await call({ ...good, category: undefined });
  assert.equal(calls.find((c) => c.fn === 'ex_scan_register').body.p_category, null);
  rpcOverride = { fn: 'ex_scan_summary', res: jres(400, { message: 'relation ex_tx secret detail' }) };
  const r = await call({ key: 'k'.repeat(64), action: 'summary', ledger: 'opex' });
  assert.equal(r.status, 500); assert.doesNotMatch(JSON.stringify(r.body), /relation|secret|detail/);
  rpcOverride = { fn: 'ex_scan_summary', res: jres(400, { message: 'ledger_not_ready' }) };
  assert.equal((await call({ key: 'k'.repeat(64), action: 'summary', ledger: 'research' })).status, 409);
  rpcOverride = null;
});
