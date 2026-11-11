-- 支払パターン別の検証（架空データ）：半年払い・前月払い・翌々月払い・支払区分未設定・枝番改定
-- 10_accounting_test.sql の後に実行する。物件 12、期間 2027-10〜2028-04 を使う。
\set ON_ERROR_STOP 1
reset role;
insert into ct_properties (code, name, kind, accounting_only) values (12, 'テストビル2', 'ビル', false);

insert into ct_contracts (contract_no, property_code, vendor_name, contract_name, billing_cycle, payment_timing,
  annual_payment_month, annual_start_month, amount_basis, amount_excl, tax_amount, tax_code,
  pl_account_code, counter_account_code, renewal_type, service_start)
values
  -- 半年払い（一括）：10月・4月に半年分を前払い
  (1200001, 12, 'D社', '点検料（半年払）', '半年', '年払い', 10, 10, '一括', 60001, 6000, '課税10%', 5310, 1550, '自動更新', null),
  -- 前月払い：11月開始、10月に11月分を支払
  (1200002, 12, 'E社', '駐車場（前月払）', '月次', '前月払い', null, null, '月額', 30000, 3000, '課税10%', 5310, 1550, '自動更新', '2027-11-01'),
  -- 翌々月払い
  (1200003, 12, 'F社', '清掃（翌々月払）', '月次', '翌々月払い', null, null, '月額', 20000, 2000, '課税10%', 5310, 3150, '自動更新', '2027-10-01'),
  -- 支払区分なし
  (1200004, 12, 'G社', '支払区分なし', '月次', null, null, null, '月額', 1000, 100, '課税10%', 5310, 3150, '自動更新', '2027-10-01'),
  -- 枝番改定：2028年1月から金額変更
  (1200005, 12, 'H社', '警備（改定あり）', '月次', '翌月払い', null, null, '月額', 10000, 1000, '課税10%', 5310, 3150, '自動更新', '2027-10-01');

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);

-- 改定：新しい枝番の金額を変更
do $$
declare v_new bigint; v_note text; v_method text;
begin
  update ct_contracts set trade_note = '窓口：警備課', payment_method = '口座振替' where contract_no = 1200005 and version = 1;
  select ct_create_revision(id, '2028-01-01') into v_new from ct_contracts where contract_no = 1200005 and version = 1;
  update ct_contracts set amount_excl = 20000, tax_amount = 2000 where id = v_new;
  -- 改定しても備考（取引・管理）は引き継ぐ
  select trade_note into v_note from ct_contracts_v where id = v_new;
  if v_note is distinct from '窓口：警備課' then raise exception '改定で備考（取引・管理）が引き継がれていない: %', v_note; end if;
  select payment_method into v_method from ct_contracts_v where id = v_new;
  if v_method is distinct from '口座振替' then raise exception '改定で支払方法が引き継がれていない: %', v_method; end if;
end $$;

select ct_generate_month(d::date) from generate_series('2027-10-01'::date, '2028-04-01', '1 month') d;

do $$
declare v numeric; t text;
begin
  -- 半年：初月で端数調整（60001 → 10001 + 10000×5）
  select amount_excl into v from ct_calc_month('2027-10-01') where contract_no = 1200001;
  if v <> 10001 then raise exception '半年の初月調整が不正: %', v; end if;
  select amount_excl into v from ct_calc_month('2027-11-01') where contract_no = 1200001;
  if v <> 10000 then raise exception '半年の月額が不正: %', v; end if;
  select amount_excl into v from ct_calc_month('2028-04-01') where contract_no = 1200001;
  if v <> 10001 then raise exception '半年の2期目初月が不正: %', v; end if;
  -- 半年：支払は10月と4月の2回
  select count(*) into v from ct_journal_entries where contract_no = 1200001 and entry_type = 'payment';
  if v <> 2 then raise exception '半年の支払回数が不正: %', v; end if;
  -- 半年：10月末の前払費用 = 66001 − 11001 = 55000、3月末で0、4月末で再び55000
  select closing into v from ct_accrual_balances('2027-10-01', '2028-04-01') where contract_no = 1200001 and period = '2027-10-01';
  if v <> 55000 then raise exception '半年の前払費用(10月)が不正: %', v; end if;
  select closing into v from ct_accrual_balances('2027-10-01', '2028-04-01') where contract_no = 1200001 and period = '2028-03-01';
  if v <> 0 then raise exception '半年の前払費用(3月)が不正: %', v; end if;
  select closing into v from ct_accrual_balances('2027-10-01', '2028-04-01') where contract_no = 1200001 and period = '2028-04-01';
  if v <> 55000 then raise exception '半年の前払費用(4月)が不正: %', v; end if;

  -- 前月払い：開始前月(10月)に11月分を支払い、以後も月末に翌月分が残る
  select closing into v from ct_accrual_balances('2027-10-01', '2028-04-01') where contract_no = 1200002 and period = '2027-10-01';
  if v <> 33000 then raise exception '前月払いの前払費用(10月)が不正: %', v; end if;
  select closing into v from ct_accrual_balances('2027-10-01', '2028-04-01') where contract_no = 1200002 and period = '2027-12-01';
  if v <> 33000 then raise exception '前月払いの前払費用(12月)が不正: %', v; end if;

  -- 翌々月払い：未払費用は10月22000、11月以降44000
  select closing into v from ct_accrual_balances('2027-10-01', '2028-04-01') where contract_no = 1200003 and period = '2027-10-01';
  if v <> 22000 then raise exception '翌々月払いの未払費用(10月)が不正: %', v; end if;
  select closing into v from ct_accrual_balances('2027-10-01', '2028-04-01') where contract_no = 1200003 and period = '2028-01-01';
  if v <> 44000 then raise exception '翌々月払いの未払費用(1月)が不正: %', v; end if;

  -- 支払区分なし：計上はされるが確認事項が出る
  select issues into t from ct_calc_month('2027-10-01') where contract_no = 1200004;
  if t is null or t not like '支払区分未設定%' then raise exception '支払区分未設定の確認事項が出ていない: %', t; end if;
  select issues into t from ct_contracts_v where contract_no = 1200004;
  if t is null or t not like '%支払区分未設定%' then raise exception '一覧ビューに支払区分未設定が出ていない: %', t; end if;

  -- 改定：12月は旧金額、1月は新金額で計上。1月の支払は12月分（旧金額）
  select sum(cr_amount) into v from ct_journal_entries where contract_no = 1200005 and entry_type = 'accrual' and period = '2027-12-01';
  if v <> 11000 then raise exception '改定前の計上が不正: %', v; end if;
  select sum(cr_amount) into v from ct_journal_entries where contract_no = 1200005 and entry_type = 'accrual' and period = '2028-01-01';
  if v <> 22000 then raise exception '改定後の計上が不正: %', v; end if;
  select sum(dr_amount) into v from ct_journal_entries where contract_no = 1200005 and entry_type = 'payment' and period = '2028-01-01';
  if v <> 11000 then raise exception '改定月の支払が不正: %', v; end if;
  -- 改定：未払費用は常に1か月分
  select closing into v from ct_accrual_balances('2027-10-01', '2028-04-01') where contract_no = 1200005 and period = '2028-02-01';
  if v <> 22000 then raise exception '改定後の未払費用が不正: %', v; end if;
end $$;

reset role;
\echo 'PAYMENT PATTERN TESTS PASSED'
