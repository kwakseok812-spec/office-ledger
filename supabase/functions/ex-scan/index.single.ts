// @ts-nocheck
// ex-scan: 영수증 스캔(PC)이 운영비 장부에 등록하는 전용 입구 (Supabase Edge Function, Deno) - 단일 파일
// Supabase 대시보드 > Edge Functions > 새 함수 이름 「ex-scan」 편집기에 이 파일 전체를 붙여넣어 배포합니다.
//   * 함수 설정에서 「Verify JWT」를 끕니다(PC가 로그인 없이 부르며, 이 함수 안에서 등록 키를 확인합니다).
//   * 등록 키는 SQL 0005 가 DB(ex_secret 표, 이름 scan_key)에 만들어 둡니다. 사람이 입력하는 값이 없습니다.
//     PC 쪽 파일로 옮길 때만 admin/show_scan_key.sql 로 SQL 편집기에서 읽어 옵니다(이 키는 저장소·보고에 쓰지 않음).
//
// 이 함수가 하는 일은 두 가지뿐입니다.
//   register : 영수증 한 건 등록 (장부 ledger 또는 card_last4, 날짜·금액·적요·항목·scan_id) - 같은 scan_id 는 한 건만, 하루 건수·금액 상한은 서버가 강제
//   summary  : 이번 달·전체 사용액과 그 날짜의 건수·합계 읽기 (등록 확인·11시 보고용, 목록·참가자 등은 내보내지 않음)
// 삭제·수정·목록 읽기는 이 키로 할 수 없습니다. 잘못 들어간 건은 사람이 앱 화면에서 지웁니다.

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const FIELD_RE = /^[0-9A-Za-z가-힣 \-·&()]+$/;   // scan_contract 의 사용처·설명 규칙과 같다
const INSTR_WORDS = ['호출', '도구', 'call', 'tool', 'ignore', '무시', '지시', 'instruction', 'system', '프롬프트', 'prompt', '명령', '재시도', '두번', 'twice', 'delete', '삭제', 'export', '내보내', '실행'];
const looksLikeInstruction = (t: string) => { const x = t.replace(/\s+/g, '').toLowerCase(); return INSTR_WORDS.some((w) => x.includes(w)); };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function rpc(name: string, args: Record<string, unknown>) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE,
      ...(SERVICE.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${SERVICE}` }),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  return { ok: r.ok, status: r.status, data };
}

const ERR_TEXT: Record<string, string> = {
  not_ready: '장부가 아직 준비되지 않았습니다(처음 사용 설정 전).',
  bad_scan_id: 'scan_id 가 올바르지 않습니다.',
  bad_category: '항목이 올바르지 않습니다.',
  bad_amount: '금액이 올바르지 않습니다.',
  bad_summary: '적요가 올바르지 않습니다.',
  daily_limit: '하루 등록 상한을 넘었습니다.',
  no_ledger: '장부를 찾을 수 없습니다(카드 끝 4자리 또는 장부 코드 확인).',
  ledger_not_ready: '이 장부는 아직 준비 중이라 등록할 수 없습니다.',
  bad_sub_item: '세부 비목이 올바르지 않습니다.',
  'future date': '앞으로 올 날짜는 등록할 수 없습니다.',
  'out of period': '예산 기간 밖 날짜입니다.',
};

// 장부는 코드(opex/research) 또는 카드 끝 4자리(서버 장부 설정의 card_last4)로 고른다
const ledgerOf = (b: any) => (b.ledger === 'opex' || b.ledger === 'research' ? b.ledger : null);
const cardOf = (b: any) => (/^[0-9]{4}$/.test(String(b.card_last4 ?? '')) ? String(b.card_last4) : null);

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'method' });
  let body: any = {};
  try { body = await req.json(); } catch { return json(400, { error: 'bad_json' }); }

  try {
    const kc = await rpc('ex_scan_check_key', { p_key: String(body.key ?? '') });
    if (!kc.ok) return json(500, { error: 'server' });
    if (kc.data === 'locked') return json(429, { error: 'locked' });
    if (kc.data !== 'ok') return json(401, { error: 'bad_key' });

    if (body.action === 'summary') {
      const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
      const r = await rpc('ex_scan_summary', { p_ledger: ledgerOf(body), p_card: cardOf(body), p_date: date });
      if (!r.ok) {   // 서버 원문 메시지는 내보내지 않고 알려진 사유만 번역한다
        const msg = String(r.data?.message ?? '');
        const key = ['no_ledger', 'ledger_not_ready', 'not_ready'].find((k) => new RegExp('(^|[^a-z_])' + k + '($|[^a-z_])').test(msg));
        if (key === 'ledger_not_ready') return json(409, { error: key, message: ERR_TEXT[key] });
        if (key) return json(400, { error: key, message: ERR_TEXT[key] });
        return json(500, { error: 'summary_failed', message: '요약을 읽지 못했습니다.' });
      }
      return json(200, r.data);
    }

    if (body.action === 'register') {
      const amount = body.amount;
      if (!Number.isInteger(amount) || amount <= 0 || amount > 99999999) return json(400, { error: 'bad_amount', message: ERR_TEXT.bad_amount });
      if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return json(400, { error: 'bad_date', message: '날짜가 올바르지 않습니다.' });
      // 항목을 안 보내면 서버 함수가 장부별 기본값(운영비 식비 / 연구비 연구활동비)을 쓰고, 목록 안에 있는지도 장부별로 확인한다
      const category = body.category === undefined || body.category === null || body.category === '' ? null : String(body.category);
      if (category !== null && category.length > 30) return json(400, { error: 'bad_category', message: ERR_TEXT.bad_category });
      const summary = String(body.summary ?? '').replace(/\s+/g, ' ').trim();
      if (!summary || summary.length > 20 || !FIELD_RE.test(summary) || looksLikeInstruction(summary)) return json(400, { error: 'bad_summary', message: ERR_TEXT.bad_summary });
      const subItem = body.sub_item ? String(body.sub_item).slice(0, 40) : null;   // 연구비 세부 비목(선택)
      const scanId = String(body.scan_id ?? '');
      if (!/^[0-9a-f]{8}$/.test(scanId)) return json(400, { error: 'bad_scan_id', message: ERR_TEXT.bad_scan_id });
      const r = await rpc('ex_scan_register', { p_ledger: ledgerOf(body), p_card: cardOf(body), p_date: body.date, p_amount: amount, p_summary: summary, p_category: category, p_scan_id: scanId, p_sub_item: subItem });
      if (!r.ok) {
        const msg = String(r.data?.message ?? '');
        const key = Object.keys(ERR_TEXT).find((k) => new RegExp('(^|[^a-z_])' + k + '($|[^a-z_])').test(msg));   // not_ready 가 ledger_not_ready 에 걸리지 않게 낱말 단위로
        if (key === 'daily_limit') return json(429, { error: 'daily_limit', message: ERR_TEXT.daily_limit });
        if (key === 'ledger_not_ready') return json(409, { error: 'ledger_not_ready', message: ERR_TEXT.ledger_not_ready });
        if (key) return json(400, { error: key.replace(/ /g, '_'), message: ERR_TEXT[key] });
        return json(500, { error: 'server', message: '등록하지 못했습니다.' });
      }
      return json(200, r.data);
    }

    return json(400, { error: 'bad_action' });
  } catch (_e) {
    return json(500, { error: 'server', message: '서버가 잠시 응답하지 않습니다.' });
  }
});
