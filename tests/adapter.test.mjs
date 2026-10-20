// 실제 서버용 어댑터(createSupabaseAdapter)가 보내는 요청 모양을 가짜 fetch 로 확인합니다. (서버 호출 없음)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseAdapter, NetworkError, ApiError } from '../js/data.js';

const URL_ = 'https://x.supabase.test';
function mk(handler) {
  const calls = [];
  globalThis.fetch = async (u, init = {}) => {
    const url = new URL(u);
    const rec = { path: url.pathname, search: url.search, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(rec);
    return handler(rec, calls);
  };
  return calls;
}
const res = (status, body, headers = {}) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const SES = { slot: 1, user_id: 'u1', access_token: 'A', refresh_token: 'R' };

test('로그인 함수 호출 모양 / 공개 키만 보냄 / 세션 저장', async () => {
  const calls = mk(() => res(200, { slot: 1, access_token: 'A', refresh_token: 'R', user: { id: 'u1' } }));
  const ad = createSupabaseAdapter({ url: URL_, anonKey: 'ANON' });
  const s = await ad.auth.login(1, 'pw');
  assert.equal(calls[0].path, '/functions/v1/ex-auth');
  assert.deepEqual(calls[0].body, { action: 'login', slot: 1, password: 'pw' });
  assert.equal(calls[0].headers.Authorization, 'Bearer ANON');
  assert.equal(s.access_token, 'A'); assert.equal(ad.session.refresh_token, 'R'); assert.equal(ad.session.user_id, 'u1');
});

test('불러오기: 장부가 2개 미만이면 ex_ensure_ledgers 를 한 번 부른 뒤 다시 읽고, 1000행씩 나눠 받는다', async () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i) }));
  let ensured = false;
  const calls = mk((r) => {
    if (r.path === '/rest/v1/rpc/ex_ensure_ledgers') { ensured = true; return res(200, null); }
    if (r.path === '/rest/v1/ex_ledgers') return res(200, ensured ? [{ id: 'a', code: 'opex' }, { id: 'b', code: 'research' }] : []);
    if (r.path === '/rest/v1/ex_tx') return res(200, r.headers.Range === '0-999' ? rows(1000) : rows(5));
    return res(200, []);
  });
  const ad = createSupabaseAdapter({ url: URL_, anonKey: 'ANON' }); ad.setSession({ ...SES });
  const d = await ad.data.loadAll();
  assert.equal(d.tx.length, 1005); assert.equal(d.ledgers.length, 2); assert.equal(d.settings, null);
  assert.equal(calls.filter((c) => c.path === '/rest/v1/rpc/ex_ensure_ledgers').length, 1);
  assert.equal(calls.filter((c) => c.path === '/rest/v1/ex_tx').length, 2);
  assert.ok(calls.every((c) => c.headers.Authorization === 'Bearer A' || c.path.startsWith('/functions')));
});

test('쓰기: 지출은 upsert(on_conflict=id), 설정은 user_id 로, 장부는 PATCH(고치기만), 되돌리기는 rpc', async () => {
  const calls = mk((r) => (r.path.includes('/rpc/') ? new Response(null, { status: 204 }) : res(200, r.body && Array.isArray(r.body) ? r.body : [{ ...(r.body || {}), id: 'L' }])));
  const ad = createSupabaseAdapter({ url: URL_, anonKey: 'ANON' }); ad.setSession({ ...SES });
  await ad.data.upsert('ex_tx', [{ id: 't1', amount: 1 }]);
  assert.equal(calls[0].path, '/rest/v1/ex_tx'); assert.equal(calls[0].search, '?on_conflict=id'); assert.equal(calls[0].headers.Prefer, 'resolution=merge-duplicates,return=representation');
  await ad.data.upsert('ex_settings', [{ receipt_purge_md: '03-01' }]);
  assert.equal(calls[1].search, '?on_conflict=user_id'); assert.equal(calls[1].body[0].user_id, 'u1');
  const row = await ad.data.updateLedger('L', { monthly_limit: 1 });
  assert.equal(calls[2].method, 'PATCH'); assert.equal(calls[2].search, '?id=eq.L'); assert.deepEqual(calls[2].body, { monthly_limit: 1 }); assert.equal(row.id, 'L');
  await ad.data.undoCreate('t1');
  assert.equal(calls[3].path, '/rest/v1/rpc/ex_undo_create'); assert.deepEqual(calls[3].body, { p_id: 't1' });
});

test('서버 사유 번역: 기간 밖/미래 날짜, 5xx 는 네트워크 오류로, 401 이면 토큰 새로 받아 한 번 다시', async () => {
  mk(() => res(400, { message: 'out of period' }));
  const ad = createSupabaseAdapter({ url: URL_, anonKey: 'ANON' }); ad.setSession({ ...SES });
  await assert.rejects(() => ad.data.upsert('ex_tx', [{}]), (e) => e instanceof ApiError && e.code === 'out_of_period');
  mk(() => res(503, { message: 'x' }));
  await assert.rejects(() => ad.data.upsert('ex_tx', [{}]), NetworkError);
  let first = true;
  const calls = mk((r) => {
    if (r.path === '/auth/v1/token') return res(200, { access_token: 'B', refresh_token: 'R2', user: { id: 'u1' } });
    if (first) { first = false; return res(401, { message: 'JWT expired' }); }
    return res(200, [{ id: 'ok' }]);
  });
  const out = await ad.data.upsert('ex_tx', [{ id: 'ok' }]);
  assert.equal(out[0].id, 'ok'); assert.equal(calls.filter((c) => c.path === '/auth/v1/token').length, 1);
});
