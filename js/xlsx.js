// xlsx.js - 정산서를 엑셀(.xlsx) 파일로 만드는 작은 생성기 (O-0855 B-03). 외부 라이브러리 없음.
// 압축 없이 묶는 zip(CRC32 직접 계산) + 시트 XML. 서버와 무관하게 화면이 이미 받은 자료로만 만든다.
import * as C from './calc.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/* ---------- zip (store) ---------- */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zip(files) { // files: [{ name, data: Uint8Array }]
  const enc = new TextEncoder(); const parts = []; const central = []; let off = 0;
  const DOS_TIME = 0; const DOS_DATE = (46 << 9) | (1 << 5) | 1; // 2026-01-01 00:00 고정(같은 자료는 같은 파일)
  for (const f of files) {
    const name = enc.encode(f.name); const crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, DOS_TIME, true); lh.setUint16(12, DOS_DATE, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, DOS_TIME, true); ch.setUint16(14, DOS_DATE, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, f.data.length, true); ch.setUint32(24, f.data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, x) => s + x.length, 0)); let p = 0;
  for (const x of all) { out.set(x, p); p += x.length; }
  return out;
}

/* ---------- 시트 XML ---------- */
const XE = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 칸 모양 = styles.xml 의 cellXfs 번호
const ST = { default: 0, title: 1, hdr: 2, text: 3, int: 4, date: 5, sumLabel: 6, sumInt: 7, metaLabel: 8, metaInt: 9, count: 10, wrap: 11, metaText: 12 };
export const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
/** 'YYYY-MM-DD' → 엑셀 날짜 번호(1900 날짜 체계) */
export function excelDate(ymd) { const [y, m, d] = String(ymd).split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000) + 25569; }

// 칸 = { v, st, kind, f? }  kind 'n' 숫자 / 's' 글자. f 가 있으면 식(v 는 저장해 두는 계산값)
const S = (v, st = 'text') => ({ v, st, kind: 's' });
const N = (v, st = 'int') => ({ v, st, kind: 'n' });
const D = (ymd, st = 'date') => ({ v: excelDate(ymd), st, kind: 'n' });
const F = (f, v, st) => ({ f, v, st, kind: 'n' });

function sheetXml(sh) {
  const rows = sh.rows.map((cells, r) => {
    const cs = cells.map((c, i) => {
      if (c == null || (c.v == null && !c.f)) return '';
      const ref = colName(i) + (r + 1); const s = ST[c.st] ?? 0;
      if (c.f) return `<c r="${ref}" s="${s}"><f>${XE(c.f)}</f><v>${c.v}</v></c>`;
      if (c.kind === 'n') return `<c r="${ref}" s="${s}"><v>${c.v}</v></c>`;
      if (c.v === '') return `<c r="${ref}" s="${s}"/>`;
      return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${XE(c.v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cs}</row>`;
  }).join('');
  const cols = sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const view = sh.freezeRow
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sh.freezeRow}" topLeftCell="A${sh.freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${view}<sheetFormatPr defaultRowHeight="18"/><cols>${cols}</cols><sheetData>${rows}</sheetData><pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup orientation="landscape"/></worksheet>`;
}
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="14"/><name val="맑은 고딕"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE9EDF3"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF9AA3AF"/></left><right style="thin"><color rgb="FF9AA3AF"/></right><top style="thin"><color rgb="FF9AA3AF"/></top><bottom style="thin"><color rgb="FF9AA3AF"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="13">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="3" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** sheets: [{ name, rows:[[칸...]], widths:[...], freezeRow }] → Uint8Array(.xlsx 파일 내용) */
export function buildXlsx(sheets) {
  const enc = new TextEncoder(); const T = (s) => enc.encode(s);
  const NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = [
    { name: '[Content_Types].xml', data: T(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`) },
    { name: '_rels/.rels', data: T(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: T(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS}"><sheets>${sheets.map((s, i) => `<sheet name="${XE(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: T(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${NS}/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: T(STYLES) },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: T(sheetXml(s)) })),
  ];
  return zip(files);
}

/* ---------- 월 정산서 → 시트 두 장 ---------- */
export const ledgerKind = (led) => (C.isResearch(led) ? '연구비' : '운영비');
export function reportFileName(led, ym) { return `ledger_${led && led.code ? led.code : 'ledger'}_${ym}.xlsx`; }

/** 화면 「월 정산서」와 같은 표·같은 합계. tx = 장부의 전체 지출(store.ledgerTx()), led = 장부 설정, ym = 'YYYY-MM' */
export function buildReportSheets({ led, tx, ym }) {
  const res = C.isResearch(led);
  const e = C.effective(led);
  const rows = C.reportRows(tx, ym, led);
  const used = C.sumAmount(rows);
  const [y, m] = ym.split('-').map(Number);
  const cols = res ? C.RESEARCH_REPORT_COLUMNS : C.REPORT_COLUMNS;
  const ncol = cols.length;
  const amtCol = 4; // 「금액」은 두 표 모두 다섯 번째 칸(E)
  const HEAD = res ? 8 : 10; // 표 머리 줄 번호(1부터)
  const first = HEAD + 1; const last = HEAD + rows.length; const foot = last + 1;
  const sumRef = rows.length ? `SUM(${colName(amtCol)}${first}:${colName(amtCol)}${last})` : '0';
  const A = [];
  A.push([S(`${led.name} ${y}년 ${m}월 정산서`, 'title')]);
  A.push([S('구분', 'metaLabel'), S(ledgerKind(led), 'metaText')]);
  A.push([S('정산 월', 'metaLabel'), S(`${y}년 ${m}월`, 'metaText')]);
  A.push([S('예산 기간', 'metaLabel'), S(`${e.period_start} ~ ${e.period_end}`, 'metaText')]);
  A.push([S('건수', 'metaLabel'), N(rows.length, 'metaInt')]);
  A.push([S('합계(원)', 'metaLabel'), F(`${colName(amtCol)}${foot}`, used, 'metaInt')]);
  if (!res) {
    A.push([S('월 한도(원)', 'metaLabel'), N(e.monthly_limit, 'metaInt')]);
    A.push([S('월 한도 대비', 'metaLabel'), S(used <= e.monthly_limit ? `${C.fmtNum(e.monthly_limit - used)}원 남음` : `${C.fmtNum(used - e.monthly_limit)}원 초과`, 'metaText')]);
  }
  while (A.length < HEAD - 1) A.push([]);
  A.push(cols.map((c) => S(c, 'hdr')));
  for (const t of rows) {
    const sd = t.settle_date || t.tx_date;
    A.push(res
      ? [D(t.tx_date), D(sd), S(t.sub_item ? `${t.category}\n${t.sub_item}` : t.category, 'wrap'), S(t.summary, 'wrap'), N(t.amount), S(t.proof_no || ''), S(t.pay_method || ''), S(t.attendees || '', 'wrap')]
      : [D(t.tx_date), D(sd), S(t.meal || ''), S(t.summary, 'wrap'), N(t.amount), S(t.attendees || '', 'wrap'), t.headcount != null ? N(t.headcount, 'count') : S('', 'text')]);
  }
  const footer = cols.map(() => S('', 'sumLabel'));
  footer[0] = S(`합계 (${rows.length}건)`, 'sumLabel');
  footer[amtCol] = F(sumRef, used, 'sumInt');
  A.push(footer);
  const sheet1 = { name: `정산서 ${ym}`, rows: A, freezeRow: 0, widths: res ? [13, 13, 18, 30, 14, 14, 12, 24] : [13, 13, 8, 30, 14, 26, 8] };
  // 시트 2: 월별 합계(홈 화면 월별 차트와 같은 값)
  const months = C.monthsOf(led);
  const per = months.map((mo) => { const r = C.monthTx(tx, mo.ym, led); return { ym: mo.ym, n: r.length, sum: C.sumAmount(r) }; });
  const B = [[S(`${led.name} 월별 합계`, 'title')], [], [S('월', 'hdr'), S('건수', 'hdr'), S('금액(원)', 'hdr')]];
  per.forEach((p) => B.push([S(p.ym, 'text'), N(p.n, 'count'), N(p.sum)]));
  const b1 = 4; const b2 = 3 + per.length;
  B.push([S('기간 합계', 'sumLabel'), F(per.length ? `SUM(B${b1}:B${b2})` : '0', per.reduce((s, p) => s + p.n, 0), 'sumInt'), F(per.length ? `SUM(C${b1}:C${b2})` : '0', per.reduce((s, p) => s + p.sum, 0), 'sumInt')]);
  const sheet2 = { name: '월별 합계', rows: B, freezeRow: 3, widths: [14, 10, 16] };
  return { sheets: [sheet1, sheet2], used, count: rows.length };
}
export function buildReportXlsx(args) { const r = buildReportSheets(args); return { bytes: buildXlsx(r.sheets), used: r.used, count: r.count, name: reportFileName(args.led, args.ym) }; }
