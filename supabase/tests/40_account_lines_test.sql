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
  -- 物件ごとに科目が違う：ビル（11）は BM・PM、ホテル（201）は客室清掃。端数が出る金額
  (1100912, 11, 600601, 'K社', '総合管理', '月次', '当月払い', '月額', 100001, 10000, '課税10%', 5310, 3140, null, '自動更新', '2028-09-01'),
  -- 年払い（前払い）の明細：月割額を明細の割合で分ける
  (1100913, 11, 600602, 'L社', '年間保守', '年次', '年払い', '年額', 120000, 12000, '課税10%', 5310, 1550, '1', '自動更新', '2028-09-01');
update ct_contracts set annual_payment_month = 9, annual_start_month = 9 where contract_no = 1100913;

insert into ct_contract_items (contract_id, item_name, amount_excl, sort, pl_account_code, pl_sub_code, property_code)
  select id, 'BM', 22000, 0, 5310, null::text, null::integer from ct_contracts where contract_no = 1100911 union all
  select id, 'PM', 15000, 1, 5300, '2', null from ct_contracts where contract_no = 1100911 union all
  select id, 'BM', 50000, 0, 5310, null, 11 from ct_contracts where contract_no = 1100912 union all
  select id, 'PM', 30000, 1, 5300, null, 11 from ct_contracts where contract_no = 1100912 union all
  select id, '客室清掃', 20001, 2, 5320, null, 201 from ct_contracts where contract_no = 1100912 union all
  -- 科目の無い行は計上に使わない
  select id, 'メモ行', 999, 3, null, null, null from ct_contracts where contract_no = 1100912 union all
  select id, 'ビル分', 90000, 0, 5310, null, 11 from ct_contracts where contract_no = 1100913 union all
  select id, 'ホテル分', 30000, 1, 5320, null, 201 from ct_contracts where contract_no = 1100913;

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

  -- 物件ごとに違う科目：明細の1行 ＝ 計上1行（ビル BM・PM、ホテル 客室清掃）。メモ行は使わない
  select string_agg(dr_dept || ':' || dr_account || ':' || dr_amount, ' ' order by dr_dept, dr_account) into t
    from ct_journal_entries where contract_no = 1100912 and entry_type = 'accrual' and period = '2028-09-01';
  if t <> '11:5300:30000 11:5310:50000 201:5320:20001' then raise exception '物件×科目の計上が不正: %', t; end if;
  select sum(dr_tax_amount) into v from ct_journal_entries where contract_no = 1100912 and entry_type = 'accrual' and period = '2028-09-01';
  if v <> 10000 then raise exception '物件×科目の消費税合計が不正: %', v; end if;
  -- 年払いの明細：9月は月割 10,000 を 3:1 で、ビル 7,500・ホテル 2,500
  select string_agg(dr_dept || ':' || dr_account || ':' || dr_amount, ' ' order by dr_dept) into t
    from ct_journal_entries where contract_no = 1100913 and entry_type = 'accrual' and period = '2028-10-01';
  if t <> '11:5310:7500 201:5320:2500' then raise exception '年払いの明細の計上が不正: %', t; end if;
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
  select string_agg(item_name || ':' || property_code, ' ' order by sort) into t from ct_contract_items
   where contract_id = (select ct_create_revision(id, '2028-11-01') from ct_contracts where contract_no = 1100912 and version = 1);
  if t <> 'BM:11 PM:11 客室清掃:201 メモ行:' and t is distinct from 'BM:11 PM:11 客室清掃:201' then raise exception '改定で明細の物件が引き継がれていない: %', t; end if;
end $$;

reset role;
\echo 'ACCOUNT LINES TESTS PASSED'
