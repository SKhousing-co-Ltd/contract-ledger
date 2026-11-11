-- =====================================================================
-- 契約に「支払方法」を追加（月末総振・クレジット・口座振替・振込）
--   選択肢は ct_code_values（分類 payment_method）で管理し、マスタ画面から追加・並べ替えできる。
--   支払方法は管理用の項目で、計上・仕訳のロジックには使わない。
-- ct_contracts_v は c.* を含むため作り直す。ct_create_revision は新しい列もコピーするよう作り直す。
-- =====================================================================

alter table public.ct_contracts add column if not exists payment_method text;
comment on column public.ct_contracts.payment_method is '支払方法（ct_code_values の payment_method）';

insert into public.ct_code_values (category, value, sort) values
  ('payment_method', '月末総振', 1),
  ('payment_method', 'クレジット', 2),
  ('payment_method', '口座振替', 3),
  ('payment_method', '振込', 4)
on conflict do nothing;

drop view if exists public.ct_contracts_v;
create or replace view public.ct_contracts_v with (security_invoker = true) as
select
  c.*,
  p.name  as property_name,
  p.kind  as property_kind,
  pa.name as pl_account_name,
  ca.name as counter_account_name,
  case
    when c.amount_basis = '月額' then c.amount_excl
    when c.amount_basis in ('年額', '一括') and c.billing_cycle = '半年' then round(c.amount_excl / 6.0)
    when c.amount_basis in ('年額', '一括') then round(c.amount_excl / 12.0)
  end as monthly_excl,
  case
    when c.amount_basis = '月額' then c.amount_excl * 12
    when c.amount_basis in ('年額', '一括') and c.billing_cycle = '半年' then c.amount_excl * 2
    when c.amount_basis in ('年額', '一括') then c.amount_excl
  end as annual_excl,
  (select count(*) from public.ct_contract_allocations a where a.contract_id = c.id) as allocation_count,
  case
    when not c.is_active then '対象外'
    when c.status in ('解約予定', '解約済') and c.cancel_date is null then '要設定'
    when c.amount_excl is null or c.pl_account_code is null or c.counter_account_code is null
      or c.amount_basis in ('従量', '手入力')
      or (c.billing_cycle in ('年次', '半年') and (c.annual_payment_month is null or c.annual_start_month is null))
      then '要設定'
    else '対象'
  end as calc_target,
  nullif(concat_ws('／',
    case when c.status in ('解約予定', '解約済') and c.cancel_date is null then '解約日未入力' end,
    case when c.amount_excl is null and coalesce(c.amount_basis, '') not in ('従量', '手入力') then '金額未入力' end,
    case when c.pl_account_code is null then '損益科目未入力' end,
    case when c.counter_account_code is null then '相手科目未入力' end,
    case when c.amount_basis in ('従量', '手入力') then '従量・手入力は毎月の実績入力が必要' end,
    case when c.billing_cycle in ('年次', '半年') and c.annual_payment_month is null then '年払月未入力' end,
    case when c.billing_cycle in ('年次', '半年') and c.annual_start_month is null then '年払対象開始月未入力' end,
    case when coalesce(c.billing_cycle, '月次') = '月次' and c.is_active
              and public.ct_payment_lag(c.payment_timing) is null then '支払区分未設定（支払仕訳が作られません）' end
  ), '') as issues
from public.ct_contracts c
left join public.ct_properties p  on p.code  = c.property_code
left join public.ct_accounts   pa on pa.code = c.pl_account_code
left join public.ct_accounts   ca on ca.code = c.counter_account_code;

revoke all on public.ct_contracts_v from anon;
grant select on public.ct_contracts_v to authenticated;

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
    renewal_type, renewal_notice, notice_months, renewal_term_months, first_billing_date, billing_cycle, payment_timing, payment_method,
    annual_payment_month, annual_period_note, amount_basis, amount_excl, tax_amount, note, tax_code,
    invoice_type, recognition_method, rounding, journal_date_rule, pl_account_code, pl_sub_code,
    counter_account_code, counter_sub_code, annual_start_month, accounting_only, ringi_no,
    contract_url, note2)
  values (
    r.contract_no, v_ver, true, '契約中', r.txn_type, r.property_code, r.vendor_code, r.vendor_name,
    r.contract_name, r.department, r.person_in_charge, r.trade_note, null, p_new_start, r.service_end, null,
    r.renewal_type, r.renewal_notice, r.notice_months, r.renewal_term_months, null, r.billing_cycle, r.payment_timing, r.payment_method,
    r.annual_payment_month, r.annual_period_note, r.amount_basis, r.amount_excl, r.tax_amount, r.note, r.tax_code,
    r.invoice_type, r.recognition_method, r.rounding, r.journal_date_rule, r.pl_account_code, r.pl_sub_code,
    r.counter_account_code, r.counter_sub_code, r.annual_start_month, r.accounting_only, null,
    r.contract_url, r.note2)
  returning id into v_id;

  insert into ct_contract_allocations (contract_id, property_code, label, amount_excl, sort)
    select v_id, property_code, label, amount_excl, sort from ct_contract_allocations where contract_id = p_contract_id;
  insert into ct_contract_items (contract_id, item_name, amount_excl, note, sort)
    select v_id, item_name, amount_excl, note, sort from ct_contract_items where contract_id = p_contract_id;

  update ct_contracts
     set status = '解約済', cancel_date = coalesce(cancel_date, p_new_start - 1)
   where id = p_contract_id;

  return v_id;
end $$;
