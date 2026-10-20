// demo.js - 서버 없이 눌러 보는 시험 화면용 가짜 서버와 가짜 데이터. 주소 끝에 ?mock=1 (이 PC에서만 열림)
// 가짜 데이터만 씁니다. 실제 사용처·금액·사람 이름은 이 저장소 어디에도 넣지 않습니다.
import { MemoryServer, createMemoryAdapter } from './data.js';

export const DEMO_PASSWORD = 'demo2468';

export async function makeDemo({ populate = true, now = () => Date.now() } = {}) {
  const server = new MemoryServer({ now });
  const adapter = createMemoryAdapter(server);
  if (!populate) return { server, adapter };       // 비어 있는 처음 상태(처음 사용 설정부터 눌러 보기)
  await adapter.auth.setup(1, DEMO_PASSWORD);
  adapter.setSession(null);
  // 시험 데이터를 서버에 직접 넣는다
  const s = await adapter.auth.login(1, DEMO_PASSWORD);
  server.ensureLedgers(s.access_token);
  const uid = s.user_id;
  const led = server.tables.ex_ledgers.find((l) => l.code === 'opex');
  const base = [
    ['2026-08-04', '중식', '가나 식당', 11100, '시험인 외 2명', 3],
    ['2026-08-27', '석식', '다라 식당', 22200, '시험인 외 1명', 2],
    ['2026-09-08', '중식', '마바 식당', 33300, '시험인 외 4명', 5],
    ['2026-09-16', '석식', '사아 식당', 44400, '시험인 외 6명', 7],
    ['2026-09-25', '중식', '자차 식당', 55500, '시험인 외 3명', 4],
    ['2026-10-05', '중식', '카타 식당', 66600, '시험인 외 2명', 3],
    ['2026-10-13', '석식', '파하 식당', 77700, '시험인 외 1명', 2],
  ];

  for (const [d, meal, summary, amount, attendees, headcount] of base) {
    server.upsert('ex_tx', s.access_token, [{ ledger_id: led.id, tx_date: d, settle_date: d, category: '식비', meal, summary, amount, attendees, headcount, source: 'import', user_id: uid }]);
  }
  adapter.setSession(null);
  return { server, adapter };
}
