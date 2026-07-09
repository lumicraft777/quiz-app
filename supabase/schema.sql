-- ================================================================
-- 蓄電池メーカー比較クイズ - Supabase スキーマ
-- ----------------------------------------------------------------
-- Supabaseダッシュボード → SQL Editor に、このファイルの中身を
-- そのまま貼り付けて実行（Run）してください。
--
-- 設計方針：
-- ・questions テーブルは、script.js の generateKnowledgeQuestions /
--   generatePracticeQuestions が作るオブジェクトと同じ形で保存する
--   （スプレッドシート更新のたびに、別途用意する同期スクリプトで
--   このテーブルを作り直す想定。詳しくはREADME参照）
-- ・ユーザーは「ユーザー名 + 4桁PIN」の軽量アカウント。本格的な
--   メール認証は使わず、他人が同じ名前を使うのを防ぐ最低限の対策。
-- ・全テーブルでRLS（Row Level Security）を有効化し、直接の
--   SELECT/INSERT/UPDATEを禁止。すべて下記のRPC関数経由でのみ
--   操作できるようにすることで、PINハッシュや他人のuser_idが
--   クライアントから直接読み書きされないようにしている。
-- ================================================================

-- PINをハッシュ化するために使う拡張機能
create extension if not exists pgcrypto;

-- ================================================================
-- questions: 生成済みの問題を保存するテーブル
-- ================================================================
create table if not exists questions (
  id text primary key,
  mode text not null check (mode in ('knowledge', 'practice')),
  category text not null,
  difficulty text not null check (difficulty in ('初級', '中級', '上級')),
  question text not null,
  customer_scenario jsonb,
  choices jsonb not null,
  answer text not null,
  explanation text not null,
  choice_explanations jsonb,
  source_manufacturer text,
  source_product text,
  created_at timestamptz not null default now()
);

-- ================================================================
-- users: ユーザー名 + PINで識別する軽量アカウント
-- ================================================================
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  pin_hash text not null,
  best_score int not null default 0,
  best_rate int not null default 0,
  current_streak int not null default 0,
  best_streak int not null default 0,
  total_answered int not null default 0,
  total_correct int not null default 0,
  level int not null default 1,
  exp int not null default 0,
  total_exp int not null default 0,
  created_at timestamptz not null default now()
);

-- ================================================================
-- answer_history: 回答履歴。不正解/正解済みリストもここから導出する
-- （「各問題ごとの最新の回答結果」＝現在の得意/不得意を表す）
-- ================================================================
create table if not exists answer_history (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  question_id text not null references questions(id) on delete cascade,
  correct boolean not null,
  mode text,
  category text,
  answered_at timestamptz not null default now()
);
create index if not exists answer_history_lookup
  on answer_history (user_id, question_id, answered_at desc);

-- ================================================================
-- glossary: 問題文中に出てくる専門用語の辞書（用語集機能で使用）
-- 直接編集する場合はSQL Editorから、または scripts/sync-glossary.js
-- （用語集シートを追加した場合）で更新する
-- ================================================================
create table if not exists glossary (
  term text primary key,
  definition text not null,
  category text,
  created_at timestamptz not null default now()
);

-- ================================================================
-- RLS：直接アクセスを禁止し、RPC関数経由のみ許可する
-- ================================================================
alter table questions enable row level security;
alter table users enable row level security;
alter table answer_history enable row level security;
alter table glossary enable row level security;

-- questions / glossary は機密性が無いため、読み取りのみ全体公開する
drop policy if exists "questions are readable by anyone" on questions;
create policy "questions are readable by anyone"
  on questions for select
  using (true);

drop policy if exists "glossary is readable by anyone" on glossary;
create policy "glossary is readable by anyone"
  on glossary for select
  using (true);

-- users / answer_history にはポリシーを一切作らない
-- （＝anonキーからの直接SELECT/INSERT/UPDATEは全面禁止。
--   下のRPC関数はsecurity definerなので、この制限を越えて動作できる）

-- ================================================================
-- RPC 1: ログイン（未登録ユーザー名なら新規登録、既存ならPIN照合）
-- ================================================================
drop function if exists rpc_login(text, text);
create or replace function rpc_login(p_username text, p_pin text)
returns table (
  id uuid, username text, best_score int, best_rate int,
  current_streak int, best_streak int, total_answered int, total_correct int,
  level int, exp int, total_exp int
)
language plpgsql
security definer
as $$
declare
  v_user users;
begin
  if length(p_pin) < 4 then
    raise exception 'PINは4桁以上で入力してください';
  end if;

  select * into v_user from users u where u.username = p_username;

  if v_user.id is null then
    insert into users (username, pin_hash)
    values (p_username, crypt(p_pin, gen_salt('bf')))
    returning * into v_user;
  else
    if v_user.pin_hash <> crypt(p_pin, v_user.pin_hash) then
      raise exception 'ユーザー名またはPINが正しくありません';
    end if;
  end if;

  return query
    select v_user.id, v_user.username, v_user.best_score, v_user.best_rate,
           v_user.current_streak, v_user.best_streak, v_user.total_answered, v_user.total_correct,
           v_user.level, v_user.exp, v_user.total_exp;
end;
$$;

-- ================================================================
-- RPC 2: 回答結果を記録する（履歴の追加＋連続正解/自己ベスト/累計の更新）
-- ================================================================
create or replace function rpc_record_answer(
  p_user_id uuid, p_question_id text, p_correct boolean,
  p_mode text default null, p_category text default null
)
returns table (
  current_streak int, best_streak int, total_answered int,
  total_correct int, best_score int, best_rate int
)
language plpgsql
security definer
as $$
declare
  v_new_streak int;
begin
  insert into answer_history (user_id, question_id, correct, mode, category)
  values (p_user_id, p_question_id, p_correct, p_mode, p_category);

  select case when p_correct then u.current_streak + 1 else 0 end
  into v_new_streak
  from users u where u.id = p_user_id;

  update users u set
    total_answered = u.total_answered + 1,
    total_correct = u.total_correct + (case when p_correct then 1 else 0 end),
    current_streak = v_new_streak,
    best_streak = greatest(u.best_streak, v_new_streak)
  where u.id = p_user_id;

  return query
    select u.current_streak, u.best_streak, u.total_answered,
           u.total_correct, u.best_score, u.best_rate
    from users u where u.id = p_user_id;
end;
$$;

-- ================================================================
-- RPC 3: セッション終了時に自己ベスト（正答数・正答率）を更新する
-- ================================================================
create or replace function rpc_record_session_result(
  p_user_id uuid, p_score int, p_rate int
)
returns void
language sql
security definer
as $$
  update users set
    best_score = greatest(best_score, p_score),
    best_rate = greatest(best_rate, p_rate)
  where id = p_user_id;
$$;

-- ================================================================
-- RPC 4: 現在の不正解/正解済みリスト（各問題ごとの最新の回答結果）
-- ================================================================
create or replace function rpc_get_answer_status(p_user_id uuid)
returns table (question_id text, correct boolean)
language sql
security definer
as $$
  select distinct on (question_id) question_id, correct
  from answer_history
  where user_id = p_user_id
  order by question_id, answered_at desc;
$$;

-- ================================================================
-- RPC 5: ランキング（全ユーザー横断。PINやIDなど機微な情報は含めない）
-- 並び順は既存どおり正答率→正答数。level/total_expは表示用の追加情報。
-- ================================================================
drop function if exists rpc_get_ranking();
create or replace function rpc_get_ranking()
returns table (
  username text, best_score int, best_rate int,
  total_answered int, total_correct int, current_streak int, best_streak int,
  level int, total_exp int
)
language sql
security definer
as $$
  select username, best_score, best_rate, total_answered, total_correct, current_streak, best_streak,
         level, total_exp
  from users
  order by best_rate desc, best_score desc
  limit 100;
$$;

-- ================================================================
-- RPC 6: 経験値（EXP）を加算し、レベルアップ判定を行う
-- ----------------------------------------------------------------
-- クイズ中はクライアント側でEXPを積算しておき、結果画面表示時に
-- 合計獲得EXPをこの関数へ1回だけ渡す（通信回数を抑えるため）。
-- レベルアップに必要なEXPは「50×現在レベル」で、複数レベル分の
-- EXPが一度に入った場合は複数レベルアップする。Lv.100が上限。
-- ================================================================
create or replace function rpc_apply_exp(p_user_id uuid, p_gained_exp int)
returns table (
  old_level int, new_level int, exp int, total_exp int, next_required_exp int
)
language plpgsql
security definer
as $$
declare
  v_old_level int;
  v_level int;
  v_exp int;
  v_total_exp int;
  v_required int;
begin
  select u.level, u.exp, u.total_exp into v_old_level, v_exp, v_total_exp
  from users u where u.id = p_user_id;

  v_level := v_old_level;
  v_total_exp := v_total_exp + greatest(p_gained_exp, 0);
  v_exp := v_exp + greatest(p_gained_exp, 0);

  while v_level < 100 loop
    v_required := 50 * v_level;
    exit when v_exp < v_required;
    v_exp := v_exp - v_required;
    v_level := v_level + 1;
  end loop;

  if v_level >= 100 then
    v_level := 100;
  end if;

  update users u set level = v_level, exp = v_exp, total_exp = v_total_exp
  where u.id = p_user_id;

  return query
    select v_old_level, v_level, v_exp, v_total_exp,
           (case when v_level >= 100 then null else 50 * v_level end);
end;
$$;
