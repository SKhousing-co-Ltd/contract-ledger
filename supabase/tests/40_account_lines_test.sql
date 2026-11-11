-- 科目明細（1つの契約を複数の損益科目に分けて計上）の検証（架空データ）
-- 30_withholding_test.sql の後に実行する。物件 11・201、期間 2028-09〜2028-10 を使う。
\set ON_ERROR_STOP 1
reset role;
insert into ct_accounts (code, name, bs_pl, normal_side, is_accrual) values
  (5300, '管理費(PM)Ⅰ', 'PL', '借方', false), (5320, '支払手数料Ⅰ', 'PL', '借方', false)
on conflict (code) do nothing;

insert into ct_contracts (contract_no, property_code, vendor_code, vendor_name, contract_name, billing_cycle, payment_timing,
  amount_basis, amount_excl, tax_amount, tax_code, pl_account_code, counter_account_code, counter_sub_code, renewal_type, service_start)
values
  -- 吉田と同じ形：BM 22,000（5310）＋ PM 15,000（5300）
  (1100911, 11, 600600, 'Jビル管理', '管理業務委託', '月次', '翌月払い', '月額', 37000, 3700, '課税10%', 5310, 3150, '9', '自動更新', '2028-09-01'),
  -- 按分（物件 11 と 201 を 2:1）× 科目 3つ。端数が出る金額
  (1100912, 11, 600601, 'K社', '総合管理', '月次', '当月払い', '月額', 100001, 10000, '課税10%', 5310, 3140, null, '自動更新', '2028-09-01');

insert into ct_contract_items (contract_id, item_name, amount_excl, sort, pl_account_code, pl_sub_code)
  select id, 'BM', 22000, 0, 5310, null from ct_contracts where contract_no = 1100911 union all
  select id, 'PM', 15000, 1, 5300, '2' from ct_contracts where contract_no = 1100911 union all
  select id, '清掃', 50000, 0, 5310, null from ct_contracts where contract_no = 1100912 union all
  select id, '管理', 30000, 1, 5300, null from ct_contracts where contract_no = 1100912 union all
  select id, '手数料', 20001, 2, 5320, null from ct_contracts where contract_no = 1100912 union all
  -- 科目の無い内訳行は計上に使わない
  select id, 'メモ行', 999, 3, null, null from ct_contracts where contract_no = 1100912;
insert into ct_contract_allocations (contract_id, property_code, amount_excl)
  select id, 11, 66667 from ct_contracts where contract_no = 1100912 union all
  select id, 201, 33334 from ct_contracts where contract_no = 1100912;

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select ct_generate_month(d::date) from generate_series('2028-09-01'::date, '2028-10-01', '1 month') d;

do $$
declare v numeric; t text;
begin
  -- 吉田型：計上は科目ごとに2行、支払は1行
  select string_agg(dr_account || ':' || coalesce(dr_sub_code, '') || ':' || dr_amount || '+' || dr_tax_amount, ' ' order by dr_account) into t
    from ct_journal_entries where contract_no = 1100911 and entry_type = 'accrual' and period = '2028-09-01';
  if t <> '5300:2:15000+1500 5310::22000+2200' then raise exception '科目明細の計上が不正: %', t; end if;
  select count(*) into v from ct_journal_entries where contract_no = 1100911 and entry_type = 'payment' and period = '2028-10-01';
  if v <> 1 then raise exception '科目明細の支払が1行でない: %', v; end if;
  select dr_amount into v from ct_journal_entries where contract_no = 1100911 and entry_type = 'payment' and period = '2028-10-01';
  if v <> 40700 then raise exception '科目明細の支払額が不正: %', v; end if;
  select string_agg(description, ' / ' order by dr_account) into t from ct_journal_entries where contract_no = 1100911 and entry_type = 'accrual' and period = '2028-09-01';
  if t not like '%（PM）%' or t not like '%（BM）%' then raise exception '摘要に明細名が入っていない: %', t; end if;

  -- 按分 × 科目：2物件 × 3科目 = 6行。合計は契約金額と一致（端数込み）
  select count(*), sum(dr_amount), sum(dr_tax_amount) into v, t, t from ct_journal_entries where contract_no = 1100912 and entry_type = 'accrual' and period = '2028-09-01';
  if v <> 6 then raise exception '按分×科目の行数が不正: %', v; end if;
  select sum(dr_amount) into v from ct_journal_entries where contract_no = 1100912 and entry_type = 'accrual' and period = '2028-09-01';
  if v <> 100001 then raise exception '按分×科目の税抜合計が不正: %', v; end if;
  select sum(dr_tax_amount) into v from ct_journal_entries where contract_no = 1100912 and entry_type = 'accrual' and period = '2028-09-01';
  if v <> 10000 then raise exception '按分×科目の消費税合計が不正: %', v; end if;
  select sum(dr_amount) into v from ct_journal_entries where contract_no = 1100912 and entry_type = 'accrual' and period = '2028-09-01' and dr_dept = 201;
  if v <> 33334 then raise exception '物件201の配分が不正: %', v; end if;
  select count(*) into v from ct_journal_entries where contract_no = 1100912 and entry_type = 'accrual' and period = '2028-09-01' and dr_account = 5320;
  if v <> 2 then raise exception '科目5320の行数が不正: %', v; end if;
  -- 未払金は当月払いで 0
  select coalesce(sum(closing), 0) into v from ct_accrual_balances('2028-09-01', '2028-10-01') where contract_no = 1100912 and period = '2028-10-01';
  if v <> 0 then raise exception '按分×科目の未払金残高が不正: %', v; end if;
end $$;

-- 改定で科目明細を引き継ぐ
do $$
declare v_new bigint; t text;
begin
  select ct_create_revision(id, '2028-11-01') into v_new from ct_contracts where contract_no = 1100911 and version = 1;
  select string_agg(item_name || ':' || pl_account_code || ':' || coalesce(pl_sub_code, ''), ' ' order by sort) into t from ct_contract_items where contract_id = v_new;
  if t <> 'BM:5310: PM:5300:2' then raise exception '改定で科目明細が引き継がれていない: %', t; end if;
end $$;

reset role;
\echo 'ACCOUNT LINES TESTS PASSED'
