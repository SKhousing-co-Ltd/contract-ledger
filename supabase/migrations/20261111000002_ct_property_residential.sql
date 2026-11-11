-- =====================================================================
-- 物件に「住宅」フラグを追加
--   区分（kind）は物件別一覧などの集計に使うためそのまま（例：吉田・中之島は「ビル」）。
--   住宅フラグが立った物件は、原価（5000番台）の課税仕入の消費税コードを共通対応（11）にする（仕訳CSV）。
--   区分「寮・社宅」も同じ扱い（ct_settings の csv_common_kinds）。
-- =====================================================================

alter table public.ct_properties add column if not exists is_residential boolean not null default false;
comment on column public.ct_properties.is_residential is '住宅（原価の課税仕入を共通対応にする）。区分とは別に持つ';
