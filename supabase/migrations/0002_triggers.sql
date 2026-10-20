-- 쓰기 전 점검(시각·날짜·소유자·기간 보호)과 이력 기록

create or replace function public.ex_before_write() returns trigger
language plpgsql set search_path = public as $$
declare
  led ex_ledgers%rowtype;
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;      -- 만든 시각·주인·출처는 바꿀 수 없음
    new.user_id    := old.user_id;
    new.ledger_id  := old.ledger_id;       -- 어느 장부인지는 바꿀 수 없음
    new.source     := old.source;
    new.scan_id    := old.scan_id;
  end if;
  new.summary   := btrim(new.summary);
  new.attendees := nullif(btrim(coalesce(new.attendees, '')), '');
  new.meal      := nullif(btrim(coalesce(new.meal, '')), '');
  new.sub_item  := nullif(btrim(coalesce(new.sub_item, '')), '');
  new.pay_method := nullif(btrim(coalesce(new.pay_method, '')), '');
  new.proof_no  := nullif(btrim(coalesce(new.proof_no, '')), '');
  new.vendor    := nullif(btrim(coalesce(new.vendor, '')), '');
  if new.settle_date is null then new.settle_date := new.tx_date; end if;
  -- 지우지 않는 기록만: 준비 중 장부 금지, 앞으로 올 날짜 금지(한국 날짜), 장부 기간 밖 금지, 분류는 장부 목록 안에서
  if new.deleted_at is null then
    select * into led from public.ex_ledgers where id = new.ledger_id and user_id = new.user_id;
    if not found then raise exception 'no ledger' using errcode = '23503'; end if;
    if led.status <> 'active' then raise exception 'ledger not ready' using errcode = '22023'; end if;
    if new.tx_date > (now() at time zone 'Asia/Seoul')::date then
      raise exception 'future date' using errcode = '22008';
    end if;
    if new.tx_date < led.period_start or new.tx_date > led.period_end then
      raise exception 'out of period' using errcode = '22008';
    end if;
    if not (led.categories ? new.category) then
      raise exception 'bad category' using errcode = '22023';
    end if;
    if new.sub_item is not null and not (coalesce(led.subitems -> new.category, '[]'::jsonb) ? new.sub_item) then
      raise exception 'bad sub item' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists ex_tx_before on public.ex_tx;
create trigger ex_tx_before before insert or update on public.ex_tx for each row execute function public.ex_before_write();

create or replace function public.ex_ledgers_before() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.user_id := old.user_id; new.code := old.code; new.card_last4 := old.card_last4; new.created_at := old.created_at; end if;
  return new;
end $$;
drop trigger if exists ex_ledgers_before on public.ex_ledgers;
create trigger ex_ledgers_before before insert or update on public.ex_ledgers for each row execute function public.ex_ledgers_before();

create or replace function public.ex_settings_before() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.user_id := old.user_id; end if;
  return new;
end $$;
drop trigger if exists ex_settings_before on public.ex_settings;
create trigger ex_settings_before before insert or update on public.ex_settings for each row execute function public.ex_settings_before();

create or replace function public.ex_log_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare o jsonb; n jsonb;
begin
  n := jsonb_build_object('tx_date', new.tx_date, 'settle_date', new.settle_date, 'category', new.category, 'sub_item', new.sub_item, 'meal', new.meal, 'pay_method', new.pay_method, 'proof_no', new.proof_no, 'vendor', new.vendor,
        'summary', new.summary, 'amount', new.amount, 'attendees', new.attendees, 'headcount', new.headcount, 'deleted_at', new.deleted_at);
  if tg_op = 'UPDATE' then
    o := jsonb_build_object('tx_date', old.tx_date, 'settle_date', old.settle_date, 'category', old.category, 'sub_item', old.sub_item, 'meal', old.meal, 'pay_method', old.pay_method, 'proof_no', old.proof_no, 'vendor', old.vendor,
        'summary', old.summary, 'amount', old.amount, 'attendees', old.attendees, 'headcount', old.headcount, 'deleted_at', old.deleted_at);
    if o = n then return null; end if;
  end if;
  insert into public.ex_history (user_id, entity_id, action, old, new)
  values (new.user_id, new.id, case when tg_op = 'INSERT' then 'create' else 'update' end, o, n);
  return null;
end $$;
drop trigger if exists ex_tx_hist on public.ex_tx;
create trigger ex_tx_hist after insert or update on public.ex_tx for each row execute function public.ex_log_history();
