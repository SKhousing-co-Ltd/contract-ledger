-- 預り源泉税（2行目の仕訳）と相手科目の補助科目の検証（架空データ）
-- 20_payment_patterns_test.sql の後に実行する。物件 11、期間 2028-05〜2028-07 を使う。
\set ON_ERROR_STOP 1
reset role;
insert into ct_accounts (code, name, bs_pl, normal_side, is_accrual) values (3180, '預り金', 'BS', '貸方', false)
on conflict (code) do nothing;

insert into ct_contracts (contract_no, property_code, vendor_code, vendor_name, contract_name, billing_cycle, payment_timing,
  amount_basis, amount_excl, tax_amount, tax_code, pl_account_code, counter_account_code, counter_sub_code, renewal_type,
  service_start, withholding_amount)
values
  -- 顧問料：当月払い・未払金。源泉税 30,630（300,000 × 10.21%）
  (1100901, 11, 902600, 'G税理士事務所', '顧問料', '月次', '当月払い', '月額', 300000, 30000, '課税10%', 6310, 3140, null, '自動更新', '2028-05-01', 30630),
  -- 源泉税なし・翌月払い・未払費用（補助 9）
  (1100902, 11, 403300, 'H社', '保守料', '月次', '翌月払い', '月額', 10000, 1000, '課税10%', 5310, 3150, '9', '自動更新', '2028-05-01', null),
  -- 前払費用の契約に源泉税を入れても2行目は作らない（相手科目が資産のため）
  (1100903, 11, 902601, 'I社', '前払の報酬', '月次', '前月払い', '月額', 50000, 5000, '課税10%', 6310, 1550, '1', '自動更新', '2028-06-01', 5105);

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select ct_generate_month(d::date) from generate_series('2028-05-01'::date, '2028-07-01', '1 month') d;

do $$
declare v numeric; t text;
begin
  -- 2行目：未払金 ／ 預り金（補助 1）30,630
  select count(*) into v from ct_journal_entries where contract_no = 1100901 and entry_type = 'withholding';
  if v <> 3 then raise exception '源泉税の仕訳の件数が不正: %', v; end if;
  select dr_account || '>' || cr_account || ' sub ' || coalesce(cr_sub_code, '') || ' ' || dr_amount into t
    from ct_journal_entries where contract_no = 1100901 and entry_type = 'withholding' and period = '2028-05-01';
  if t <> '3140>3180 sub 1 30630' then raise exception '源泉税の仕訳が不正: %', t; end if;
  -- 支払は差し引き後の振込額 330,000 − 30,630 = 299,370
  select dr_amount into v from ct_journal_entries where contract_no = 1100901 and entry_type = 'payment' and period = '2028-05-01';
  if v <> 299370 then raise exception '源泉税を差し引いた支払額が不正: %', v; end if;
  -- 未払金は毎月 0 に戻る
  select closing into v from ct_accrual_balances('2028-05-01', '2028-07-01') where contract_no = 1100901 and account_code = 3140 and period = '2028-07-01';
  if coalesce(v, 0) <> 0 then raise exception '源泉税ありの未払金残高が不正: %', v; end if;
  -- 源泉税なしの契約は1行のまま、補助科目 9 が計上・支払の両方に入る
  select count(*) into v from ct_journal_entries where contract_no = 1100902 and entry_type = 'withholding';
  if v <> 0 then raise exception '源泉税なしの契約に2行目ができた: %', v; end if;
  select cr_sub_code into t from ct_journal_entries where contract_no = 1100902 and entry_type = 'accrual' and period = '2028-05-01';
  if t is distinct from '9' then raise exception '計上の補助科目が不正: %', t; end if;
  select dr_sub_code into t from ct_journal_entries where contract_no = 1100902 and entry_type = 'payment' and period = '2028-06-01';
  if t is distinct from '9' then raise exception '支払の補助科目が不正: %', t; end if;
  -- 前払費用の契約は源泉税の2行目を作らず、支払も税込のまま
  select count(*) into v from ct_journal_entries where contract_no = 1100903 and entry_type = 'withholding';
  if v <> 0 then raise exception '前払の契約に源泉税の仕訳ができた: %', v; end if;
  select dr_amount into v from ct_journal_entries where contract_no = 1100903 and entry_type = 'payment' and period = '2028-06-01';
  if v <> 55000 then raise exception '前払の支払額が不正: %', v; end if;
end $$;

-- 改定（新しい枝番）で源泉税を引き継ぐ
do $$
declare v_new bigint; v numeric;
begin
  select ct_create_revision(id, '2028-08-01') into v_new from ct_contracts where contract_no = 1100901 and version = 1;
  select withholding_amount into v from ct_contracts where id = v_new;
  if v is distinct from 30630 then raise exception '改定で源泉税が引き継がれていない: %', v; end if;
end $$;

reset role;
\echo 'WITHHOLDING TESTS PASSED'
