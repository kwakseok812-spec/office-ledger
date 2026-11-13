// 엑셀 생성기 시험(O-0855 B-03): 가짜 자료만 사용. 만들어진 파일은 tests/xlsx_check.py 가 openpyxl 로 열어 다시 검사한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as C from '../js/calc.js';
import { buildReportXlsx, buildReportSheets, reportFileName, excelDate } from '../js/xlsx.js';

const OUT = process.env.XLSX_OUT || '';
const opex = { code: 'opex', name: '보직자 운영비', period_start: '2026-08-01', period_end: '2027-02-28', monthly_limit: 300000, total_budget: 2100000, categories: ['식비'] };
const research = { code: 'research', name: '교내과제 연구비', period_start: '2026-06-01', period_end: '2027-02-28', monthly_limit: null, total_budget: null, categories: ['연구활동비', '재료비'], subitems: { 연구활동비: ['회의비'] } };
let id = 0;
const tx = (o) => ({ id: `t${++id}`, deleted_at: null, created_at: `2026-11-0${(id % 9) + 1}T00:00:00Z`, settle_date: null, ...o });
const T_OPEX = [
  tx({ tx_date: '2026-11-03', category: '식비', meal: '중식', summary: '가나 식당', amount: 11100, attendees: '시험인 외 2명', headcount: 3 }),
  tx({ tx_date: '2026-11-03', category: '식비', meal: '석식', summary: 'A&B <식당> "따옴표" \'작은\'', amount: 22200, attendees: '시험인 외 1명', headcount: null }),
  tx({ tx_date: '2026-11-10', settle_date: '2026-11-12', category: '식비', meal: '중식', summary: '줄바꿈\n있는 적요', amount: 9999999, attendees: '', headcount: 7 }),
  tx({ tx_date: '2026-10-05', category: '식비', meal: '중식', summary: '지난달', amount: 5000, attendees: 'x', headcount: 1 }),
  tx({ tx_date: '2026-11-20', category: '식비', meal: '중식', summary: '지운 것', amount: 777777, deleted_at: '2026-11-21T00:00:00Z' }),
];
const T_RES = [
  tx({ tx_date: '2026-11-04', category: '연구활동비', sub_item: '회의비', summary: '시험 회의', amount: 120000, proof_no: 'P-1', pay_method: '법인카드', attendees: '가 외 3명' }),
  tx({ tx_date: '2026-11-09', category: '재료비', summary: '시험 재료', amount: 345600, proof_no: '', pay_method: '계좌이체' }),
];
const dump = (name, r) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), r.bytes); } };

test('운영비 11월: 화면 정산서와 같은 건수·합계', () => {
  const r = buildReportXlsx({ led: opex, tx: T_OPEX, ym: '2026-11' });
  const rows = C.reportRows(T_OPEX, '2026-11', opex);
  assert.equal(r.count, 3);                       // 지운 것·다른 달은 빠짐
  assert.equal(r.used, C.sumAmount(rows));        // 화면 합계와 같은 함수
  assert.equal(r.used, 11100 + 22200 + 9999999);
  assert.equal(r.name, 'ledger_opex_2026-11.xlsx');
  assert.deepEqual([...r.bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]); // zip
  dump('ledger_opex_2026-11.xlsx', r);
});
test('연구비 11월', () => {
  const r = buildReportXlsx({ led: research, tx: T_RES, ym: '2026-11' });
  assert.equal(r.count, 2); assert.equal(r.used, 465600);
  dump('ledger_research_2026-11.xlsx', r);
});
test('내역 없는 달도 만들어진다(합계 0)', () => {
  const r = buildReportXlsx({ led: opex, tx: T_OPEX, ym: '2026-12' });
  assert.equal(r.count, 0); assert.equal(r.used, 0);
  dump('ledger_opex_2026-12_empty.xlsx', r);
});
test('월별 합계 시트 = 기간 전체 합계', () => {
  const { sheets } = buildReportSheets({ led: opex, tx: T_OPEX, ym: '2026-11' });
  const b = sheets[1].rows; const last = b[b.length - 1];
  assert.equal(last[2].v, 11100 + 22200 + 9999999 + 5000);
});
test('날짜 번호: 1900 체계', () => { assert.equal(excelDate('2026-11-14'), 46340); assert.equal(excelDate('1900-03-01'), 61); });
test('파일 이름은 영문·숫자만', () => { assert.match(reportFileName(research, '2026-11'), /^[A-Za-z0-9_.-]+$/); });
