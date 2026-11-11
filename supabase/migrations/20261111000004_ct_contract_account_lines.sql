-- =====================================================================
-- 1つの契約を複数の損益科目に分けて計上する（科目明細）
--   契約の内訳（ct_contract_items）に損益科目・補助科目を持たせる。
--   科目を入れた内訳の行があれば、月次計上の計上仕訳をその行の金額比で科目ごとに分ける（行数の上限なし）。
--   按分（物件）と組み合わせた場合は「物件ごと → 科目ごと」に分ける。端数は最大の行で調整。
--   支払・源泉税の仕訳は契約1本のまま。科目のない内訳の行は従来どおり管理用（計上には使わない）。
-- =====================================================================

alter table public.ct_contract_items add column if not exists pl_account_code integer references public.ct_accounts(code);
alter table public.ct_contract_items add column if not exists pl_sub_code text;
comment on column public.ct_contract_items.pl_account_code is '損益科目。入っている行があれば計上をこの行の金額比で科目別に分ける';

create or replace function public.ct_create_revision(p_contract_id bigint, p_new_start date) returns bigint
language plpgsql security invoker set search_path = public as $$
declare
  r      ct_contracts;
  v_ver  integer;
  v_id   bigint;
begin
  select * into r from ct_contracts where id = p_contract_id;
  if not found then raise exception '契約が見つかりません'; end if;
  if p_new_start is null then raise exception '新しい開始日を指定してください'; end if;
  if r.service_start is not null and p_new_start <= r.service_start then
    raise exception '新しい開始日は現在の枝番の開始日より後にしてください';
  end if;
  select max(version) + 1 into v_ver from ct_contracts where contract_no = r.contract_no;

  insert into ct_contracts (
    contract_no, version, is_active, status, txn_type, property_code, vendor_code, vendor_name,
    contract_name, department, person_in_charge, trade_note, signed_date, service_start, service_end, cancel_date,
    renewal_type, renewal_notice, notice_months, renewal_term_months, first_billing_date, billing_cycle, payment_timing, payment_method, withholding_amount,
    annual_payment_month, annual_period_note, amount_basis, amount_excl, tax_amount, note, tax_code,
    invoice_type, recognition_method, rounding, journal_date_rule, pl_account_code, pl_sub_code,
    counter_account_code, counter_sub_code, annual_start_month, accounting_only, ringi_no,
    contract_url, note2)
  values (
    r.contract_no, v_ver, true, '契約中', r.txn_type, r.property_code, r.vendor_code, r.vendor_name,
    r.contract_name, r.department, r.person_in_charge, r.trade_note, null, p_new_start, r.service_end, null,
    r.renewal_type, r.renewal_notice, r.notice_months, r.renewal_term_months, null, r.billing_cycle, r.payment_timing, r.payment_method, r.withholding_amount,
    r.annual_payment_month, r.annual_period_note, r.amount_basis, r.amount_excl, r.tax_amount, r.note, r.tax_code,
    r.invoice_type, r.recognition_method, r.rounding, r.journal_date_rule, r.pl_account_code, r.pl_sub_code,
    r.counter_account_code, r.counter_sub_code, r.annual_start_month, r.accounting_only, null,
    r.contract_url, r.note2)
  returning id into v_id;

  insert into ct_contract_allocations (contract_id, property_code, label, amount_excl, sort)
    select v_id, property_code, label, amount_excl, sort from ct_contract_allocations where contract_id = p_contract_id;
  insert into ct_contract_items (contract_id, item_name, amount_excl, note, sort, pl_account_code, pl_sub_code)
    select v_id, item_name, amount_excl, note, sort, pl_account_code, pl_sub_code from ct_contract_items where contract_id = p_contract_id;

  update ct_contracts
     set status = '解約済', cancel_date = coalesce(cancel_date, p_new_start - 1)
   where id = p_contract_id;

  return v_id;
end $$;

create or replace function public.ct_generate_month(p_period date) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  m          date := date_trunc('month', p_period)::date;
  m_end      date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_cash     integer;
  v_auto_pay boolean;
  r          record;
  a          record;
  v_date     date;
  v_n_alloc  integer;
  v_sum_alloc numeric;
  v_rest_ex  numeric;
  v_rest_tx  numeric;
  v_ex       numeric;
  v_tx       numeric;
  v_i        integer;
  v_lag      integer;
  li         record;
  v_n_line   integer;
  v_sum_line numeric;
  v_rest_ex2 numeric;
  v_rest_tx2 numeric;
  v_ex2      numeric;
  v_tx2      numeric;
  v_j        integer;
  v_desc     text;
  v_wh       numeric;
  v_wh_acc   integer;
  v_wh_sub   text;
  n_accrual  integer := 0;
  n_withholding integer := 0;
  n_payment  integer := 0;
  n_skipped  integer := 0;
begin
  if not (public.ct_is_accounting() and public.ct_can_edit()) then
    raise exception '月次仕訳の生成は総務経理部の編集権限が必要です';
  end if;
  if exists (select 1 from ct_periods where period = m and status = 'closed') then
    raise exception '% は締め済みです', to_char(m, 'YYYY年MM月');
  end if;

  select value::integer into v_cash from ct_settings where key = 'cash_account';
  v_auto_pay := coalesce((select value from ct_settings where key = 'auto_payment'), 'true') = 'true';
  v_wh_acc := coalesce((select nullif(value, '')::integer from ct_settings where key = 'withholding_account'), 3180);
  v_wh_sub := (select nullif(value, '') from ct_settings where key = 'withholding_sub_code');

  delete from ct_journal_entries where period = m and source = 'auto' and exported_at is null;

  -- (1) 費用・収益の計上
  for r in select * from ct_calc_month(m) where judgement in ('計上', '実績入力済') loop
    if exists (select 1 from ct_journal_entries e where e.period = m and e.source = 'auto'
                 and e.entry_type = 'accrual' and e.contract_id = r.contract_id) then
      n_skipped := n_skipped + 1;  -- 出力済みのため残す
      continue;
    end if;
    v_date := case when r.journal_date_rule = '月初' then m else m_end end;

    select count(*), coalesce(sum(amount_excl), 0) into v_n_alloc, v_sum_alloc
      from ct_contract_allocations where contract_id = r.contract_id;
    select count(*), coalesce(sum(amount_excl), 0) into v_n_line, v_sum_line
      from ct_contract_items where contract_id = r.contract_id and pl_account_code is not null and coalesce(amount_excl, 0) <> 0;
    if v_sum_line = 0 then v_n_line := 0; end if;

    v_rest_ex := r.amount_excl;
    v_rest_tx := r.tax_amount;
    v_i := 0;
    for a in
      select property_code as dept, amount_excl as w from ct_contract_allocations
       where contract_id = r.contract_id and v_n_alloc > 0 and v_sum_alloc <> 0
      union all
      select r.property_code, 1 where v_n_alloc = 0 or v_sum_alloc = 0
      order by 2 asc  -- 最後（最大）の行で端数を吸収
    loop
      v_i := v_i + 1;
      if v_i = greatest(v_n_alloc, 1) or v_sum_alloc = 0 then
        v_ex := v_rest_ex; v_tx := v_rest_tx;
      else
        v_ex := trunc(r.amount_excl * a.w / v_sum_alloc);
        v_tx := trunc(r.tax_amount  * a.w / v_sum_alloc);
      end if;
      v_rest_ex := v_rest_ex - v_ex;
      v_rest_tx := v_rest_tx - v_tx;

      -- 物件ごとの金額を、科目明細（科目のある内訳行）の金額比で科目ごとに分ける。明細が無ければ契約の科目で1行
      v_rest_ex2 := v_ex;
      v_rest_tx2 := v_tx;
      v_j := 0;
      for li in
        select i.pl_account_code as acc, i.pl_sub_code as sub, i.item_name as nm, i.amount_excl as w
          from ct_contract_items i
         where i.contract_id = r.contract_id and v_n_line > 0 and i.pl_account_code is not null and coalesce(i.amount_excl, 0) <> 0
        union all
        select r.pl_account_code, r.pl_sub_code, null::text, 1::numeric where v_n_line = 0
        order by 4 asc  -- 最後（最大）の行で端数を吸収
      loop
        v_j := v_j + 1;
        if v_j = greatest(v_n_line, 1) then
          v_ex2 := v_rest_ex2; v_tx2 := v_rest_tx2;
        else
          v_ex2 := trunc(v_ex * li.w / v_sum_line);
          v_tx2 := trunc(v_tx * li.w / v_sum_line);
        end if;
        v_rest_ex2 := v_rest_ex2 - v_ex2;
        v_rest_tx2 := v_rest_tx2 - v_tx2;
        v_desc := concat_ws(' ', r.description, case when li.nm is not null then '（' || li.nm || '）' end);

        if r.txn_type = '収益' then
          insert into ct_journal_entries (period, entry_date, entry_type, source, contract_id, contract_no,
            dr_account, dr_sub_code, dr_dept, dr_vendor, dr_amount, dr_tax_amount, dr_tax_code,
            cr_account, cr_sub_code, cr_dept, cr_vendor, cr_amount, cr_tax_amount, cr_tax_code, description)
          values (m, v_date, 'accrual', 'auto', r.contract_id, r.contract_no,
            r.counter_account_code, r.counter_sub_code, r.property_code, r.vendor_code, v_ex2 + v_tx2, 0, null,
            li.acc, li.sub, a.dept, r.vendor_code, v_ex2, v_tx2, r.tax_code, v_desc);
        else
          insert into ct_journal_entries (period, entry_date, entry_type, source, contract_id, contract_no,
            dr_account, dr_sub_code, dr_dept, dr_vendor, dr_amount, dr_tax_amount, dr_tax_code,
            cr_account, cr_sub_code, cr_dept, cr_vendor, cr_amount, cr_tax_amount, cr_tax_code, description)
          values (m, v_date, 'accrual', 'auto', r.contract_id, r.contract_no,
            li.acc, li.sub, a.dept, r.vendor_code, v_ex2, v_tx2, r.tax_code,
            r.counter_account_code, r.counter_sub_code, r.property_code, r.vendor_code, v_ex2 + v_tx2, 0, null,
            v_desc);
        end if;
        n_accrual := n_accrual + 1;
      end loop;
    end loop;

    -- 預り源泉税（2行目）：相手科目 ／ 預り金。按分があっても契約の物件で1行
    v_wh := ct_withholding_of(r.contract_id);
    if v_wh > 0 and not exists (select 1 from ct_journal_entries e where e.period = m and e.source = 'auto'
                                  and e.entry_type = 'withholding' and e.contract_id = r.contract_id) then
      insert into ct_journal_entries (period, entry_date, entry_type, source, contract_id, contract_no,
        dr_account, dr_sub_code, dr_dept, dr_vendor, dr_amount, dr_tax_amount, dr_tax_code,
        cr_account, cr_sub_code, cr_dept, cr_vendor, cr_amount, cr_tax_amount, cr_tax_code, description)
      values (m, v_date, 'withholding', 'auto', r.contract_id, r.contract_no,
        r.counter_account_code, r.counter_sub_code, r.property_code, r.vendor_code, v_wh, 0, null,
        v_wh_acc, v_wh_sub, r.property_code, r.vendor_code, v_wh, 0, null,
        concat_ws(' ', r.description, '源泉税'));
      n_withholding := n_withholding + 1;
    end if;
  end loop;

  -- (2) 支払（入金）予定：経過勘定の取崩し
  if v_auto_pay and v_cash is not null then
    -- 月次契約：当月に支払う分（支払月のずれ分だけ前後の月の計上額）
    for v_lag in select unnest(array[-1, 0, 1, 2]) loop
      for r in
        select * from ct_calc_month((m - make_interval(months => v_lag))::date) c
         where c.judgement in ('計上', '実績入力済') and c.billing_cycle = '月次'
           and ct_payment_lag(c.payment_timing) = v_lag
      loop
        if exists (select 1 from ct_journal_entries e where e.period = m and e.source = 'auto'
                     and e.entry_type = 'payment' and e.contract_id = r.contract_id) then
          continue;
        end if;
        perform public.ct_insert_payment(m, m_end, r.contract_id, r.contract_no, r.txn_type,
          r.counter_account_code, r.counter_sub_code, r.property_code, r.vendor_code, v_cash,
          r.amount_incl - ct_withholding_of(r.contract_id),  -- 源泉税を差し引いた振込額
          concat_ws(' ', r.property_name, r.contract_name,
                    to_char((m - make_interval(months => v_lag))::date, 'YYYY"年"FMMM"月分"'),
                    case when r.txn_type = '収益' then '入金' else '支払' end));
        n_payment := n_payment + 1;
      end loop;
    end loop;

    -- 年次・半年契約：支払月に1期間分（税込）を支払
    for r in
      select * from ct_calc_month(m) c
       where c.judgement = '計上' and c.billing_cycle in ('年次', '半年')
         and ct_is_cycle_payment_month(c.billing_cycle, c.annual_payment_month, m)
    loop
      if exists (select 1 from ct_journal_entries e where e.period = m and e.source = 'auto'
                   and e.entry_type = 'payment' and e.contract_id = r.contract_id) then
        continue;
      end if;
      perform public.ct_insert_payment(m, m_end, r.contract_id, r.contract_no, r.txn_type,
        r.counter_account_code, r.counter_sub_code, r.property_code, r.vendor_code, v_cash, r.contract_amount_incl,
        concat_ws(' ', r.property_name, r.contract_name, case r.billing_cycle when '半年' then '半年分' else '年額' end,
                  case when r.txn_type = '収益' then '入金' else '支払' end));
      n_payment := n_payment + 1;
    end loop;
  end if;

  return jsonb_build_object('accrual', n_accrual, 'withholding', n_withholding, 'payment', n_payment, 'kept_exported', n_skipped);
end $$;
