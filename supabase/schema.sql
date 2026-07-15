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
  last_active_date date,
  streak_days int not null default 0,
  review_correct_count int not null default 0,
  today_best_score int not null default 0,
  today_best_rate int not null default 0,
  today_best_date date,
  onboarding_completed boolean not null default true,
  goal_tags text[],
  goal_reason text,
  commitment_cadence text,
  resolve_percent int,
  current_position text,
  future_identity text,
  first_area text,
  contract_goal text,
  -- 覚悟0%を正直に選んだプレイヤー用の隠しフラグ（ZERO TO ONE称号の条件に使う）
  started_from_zero_resolve boolean not null default false,
  -- 初回登録時の「現在地チェック」診断結果（3問の判定）
  diagnostic_correct_count int,
  diagnostic_level text,
  diagnostic_strengths text[],
  diagnostic_growth text[],
  diagnostic_completed_at timestamptz,
  created_at timestamptz not null default now()
);

-- 装備中の称号（実際に装備できるかどうかはrpc_set_equipped_badge側で
-- user_badgesを見て検証するため、ここではFK制約は付けない）
alter table users add column if not exists equipped_badge_key text;

-- ================================================================
-- badges: 称号マスタの「器」を先に確保する
-- （この後のランキングRPCなどがb.title/b.is_secret/b.tierを参照するため、
--   テーブルと列の存在だけ先に保証する。RLS・シードデータ・各列の
--   詳しい説明は後方の「称号・バッジ」セクションを参照）
-- ================================================================
create table if not exists badges (
  key text primary key,
  title text not null,
  description text not null,
  sort_order int not null default 0
);
alter table badges add column if not exists is_secret boolean not null default false;
alter table badges add column if not exists tier text not null default 'bronze';

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
  is_review boolean not null default false,
  answered_at timestamptz not null default now()
);
create index if not exists answer_history_lookup
  on answer_history (user_id, question_id, answered_at desc);
-- 週間/月間ランキングが「直近7日/30日」の絞り込みで全件走査しないための時系列インデックス
create index if not exists answer_history_answered_at
  on answer_history (answered_at desc);

-- ================================================================
-- quiz_sessions: PLAYER LOG（個人学習記録）機能のためのセッション単位の記録。
-- 1回の任務プレイ（開始〜結果画面 or 途中退出）を1行として保存する。
-- 集計の高速化用ではなく、日別サマリー・セッション履歴・継続学習日数の
-- 計算に使う一次データ（answer_historyと並ぶソースオブトゥルース）。
-- ================================================================
create table if not exists quiz_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  mode text,
  category text,
  difficulty text,
  selected_count text,
  answered_count int not null default 0,
  correct_count int not null default 0,
  incorrect_count int not null default 0,
  earned_exp int not null default 0,
  level_before int,
  level_after int,
  completed boolean not null default false,
  exited_early boolean not null default false
);
create index if not exists quiz_sessions_user_date
  on quiz_sessions (user_id, started_at desc);

-- answer_historyの各行がどのセッション内の回答かを紐づける
-- （将来の「問題ごとの回答履歴」機能のための下地。nullを許容し、
--   セッション作成に失敗しても回答記録そのものは止めない）
alter table answer_history add column if not exists session_id uuid references quiz_sessions(id) on delete set null;
create index if not exists answer_history_session on answer_history (session_id);

-- ================================================================
-- diagnostic_answers: 初回登録の「現在地チェック」（3問診断）の回答記録。
-- 通常のクイズ（answer_history）とは完全に分け、正答率・ランキング・
-- 通常のEXPには一切混ぜない。
-- ================================================================
create table if not exists diagnostic_answers (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  question_id text,
  selected_answer text,
  is_correct boolean,
  category text,
  difficulty text,
  answered_at timestamptz not null default now(),
  diagnostic_version int not null default 1
);
create index if not exists diagnostic_answers_user on diagnostic_answers (user_id);
alter table diagnostic_answers enable row level security;
-- ポリシーなし（RPC経由のみ）

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
-- products: 製品詳細パネル機能で使う製品カタログ（メーカー×シリーズ単位）
-- 問題文・選択肢中の製品名をタップした際に表示する主な特徴・注意点を保持する。
-- 直接編集する場合はSQL Editorから、または scripts/sync-questions.js
-- （問題同期と同時に products テーブルも更新する）で更新する
-- ================================================================
create table if not exists products (
  maker text not null,
  series text not null,
  feature text,
  demerit text,
  created_at timestamptz not null default now(),
  primary key (maker, series)
);

-- ================================================================
-- RLS：直接アクセスを禁止し、RPC関数経由のみ許可する
-- ================================================================
alter table questions enable row level security;
alter table users enable row level security;
alter table answer_history enable row level security;
alter table glossary enable row level security;
alter table products enable row level security;
alter table quiz_sessions enable row level security;
-- quiz_sessionsにもポリシーを作らない（＝直接アクセス禁止、RPC経由のみ）

-- questions / glossary / products は機密性が無いため、読み取りのみ全体公開する
drop policy if exists "questions are readable by anyone" on questions;
create policy "questions are readable by anyone"
  on questions for select
  using (true);

drop policy if exists "glossary is readable by anyone" on glossary;
create policy "glossary is readable by anyone"
  on glossary for select
  using (true);

drop policy if exists "products are readable by anyone" on products;
create policy "products are readable by anyone"
  on products for select
  using (true);

-- users / answer_history にはポリシーを一切作らない
-- （＝anonキーからの直接SELECT/INSERT/UPDATEは全面禁止。
--   下のRPC関数はsecurity definerなので、この制限を越えて動作できる）

-- ================================================================
-- RPC 1: ログイン（既存プレイヤーのみ。未登録IDは自動登録せず、
--   「このプレイヤーは登録されていません」で明確に失敗させる。
--   新規登録は rpc_register_player 経由の別フローに一本化した）
-- ================================================================
drop function if exists rpc_login(text, text);
create or replace function rpc_login(p_username text, p_pin text)
returns table (
  id uuid, username text, best_score int, best_rate int,
  current_streak int, best_streak int, total_answered int, total_correct int,
  level int, exp int, total_exp int, streak_days int,
  today_best_score int, today_best_rate int,
  onboarding_completed boolean, goal_reason text,
  goal_tags text[], contract_goal text, first_area text,
  diagnostic_level text, diagnostic_growth text[], diagnostic_strengths text[],
  equipped_badge_key text, equipped_badge_title text
)
language plpgsql
security definer
as $$
declare
  v_user users;
  v_today date := current_date;
  v_badge_title text;
begin
  if length(p_pin) < 4 then
    raise exception 'PINは4桁以上で入力してください';
  end if;

  select * into v_user from users u where u.username = p_username;

  if v_user.id is null then
    raise exception 'このプレイヤーは登録されていません';
  end if;

  if v_user.pin_hash <> crypt(p_pin, v_user.pin_hash) then
    raise exception 'ユーザー名またはPINが正しくありません';
  end if;

  -- 連続ログイン日数（学習ストリーク）を計算する。同日中の複数回ログインでは増えない
  if v_user.last_active_date is null or v_user.last_active_date < v_today - 1 then
    v_user.streak_days := 1;
  elsif v_user.last_active_date = v_today - 1 then
    v_user.streak_days := v_user.streak_days + 1;
  end if;

  -- 「本日の自己ベスト」は日付が変わっていたらリセットする
  if v_user.today_best_date is null or v_user.today_best_date < v_today then
    v_user.today_best_score := 0;
    v_user.today_best_rate := 0;
    v_user.today_best_date := v_today;
  end if;

  update users u set
    last_active_date = v_today,
    streak_days = v_user.streak_days,
    today_best_score = v_user.today_best_score,
    today_best_rate = v_user.today_best_rate,
    today_best_date = v_user.today_best_date
  where u.id = v_user.id;

  select b.title into v_badge_title from badges b where b.key = v_user.equipped_badge_key;

  return query
    select v_user.id, v_user.username, v_user.best_score, v_user.best_rate,
           v_user.current_streak, v_user.best_streak, v_user.total_answered, v_user.total_correct,
           v_user.level, v_user.exp, v_user.total_exp, v_user.streak_days,
           v_user.today_best_score, v_user.today_best_rate,
           v_user.onboarding_completed, v_user.goal_reason,
           v_user.goal_tags, v_user.contract_goal, v_user.first_area,
           v_user.diagnostic_level, v_user.diagnostic_growth, v_user.diagnostic_strengths,
           v_user.equipped_badge_key, v_badge_title;
end;
$$;

-- 新規登録フロー STEP1（プレイヤー名決め）でのリアルタイム重複チェック用。
-- この時点ではまだアカウントを作らない（本登録は rpc_register_player で行う）
create or replace function rpc_check_username_available(p_username text)
returns boolean
language sql
security definer
as $$
  select not exists(select 1 from users u where u.username = p_username);
$$;

-- ================================================================
-- RPC: 新規プレイヤー登録（初回登録フロー「PLAYER CONTRACT」確定時に
--   1回だけ呼ぶ。アカウント作成・儀式で集めた回答・現在地チェックの
--   診断結果・診断の個別回答を、すべて1つのトランザクションで保存する）
-- ================================================================
drop function if exists rpc_register_player(text, text, text[], text, text, int, text, text, boolean, int, text, text[], text[], jsonb);
create or replace function rpc_register_player(
  p_username text, p_pin text,
  p_goal_tags text[], p_goal_reason text, p_commitment_cadence text, p_resolve_percent int,
  p_current_position text, p_contract_goal text, p_started_from_zero_resolve boolean,
  p_diagnostic_correct_count int, p_diagnostic_level text,
  p_diagnostic_strengths text[], p_diagnostic_growth text[],
  p_diagnostic_answers jsonb
)
returns table (
  id uuid, username text, best_score int, best_rate int,
  current_streak int, best_streak int, total_answered int, total_correct int,
  level int, exp int, total_exp int, streak_days int,
  today_best_score int, today_best_rate int,
  onboarding_completed boolean, goal_reason text,
  goal_tags text[], contract_goal text, first_area text,
  diagnostic_level text, diagnostic_growth text[], diagnostic_strengths text[],
  equipped_badge_key text, equipped_badge_title text
)
language plpgsql
security definer
as $$
declare
  v_user users;
  v_today date := current_date;
begin
  if exists(select 1 from users u where u.username = p_username) then
    raise exception 'このプレイヤー名はすでに使用されています';
  end if;
  if length(p_pin) < 4 then
    raise exception 'PINは4桁以上で入力してください';
  end if;

  insert into users (
    username, pin_hash, last_active_date, streak_days, today_best_date, onboarding_completed,
    goal_tags, goal_reason, commitment_cadence, resolve_percent,
    current_position, contract_goal, started_from_zero_resolve,
    diagnostic_correct_count, diagnostic_level, diagnostic_strengths, diagnostic_growth, diagnostic_completed_at
  )
  values (
    p_username, crypt(p_pin, gen_salt('bf')), v_today, 1, v_today, true,
    p_goal_tags, nullif(trim(p_goal_reason), ''), p_commitment_cadence, greatest(0, least(100, p_resolve_percent)),
    p_current_position, nullif(trim(p_contract_goal), ''), p_started_from_zero_resolve,
    p_diagnostic_correct_count, p_diagnostic_level, p_diagnostic_strengths, p_diagnostic_growth, v_today
  )
  returning * into v_user;

  insert into diagnostic_answers (user_id, question_id, selected_answer, is_correct, category, difficulty, diagnostic_version)
  select v_user.id, x.question_id, x.selected_answer, x.is_correct, x.category, x.difficulty, 1
  from jsonb_to_recordset(p_diagnostic_answers) as x(
    question_id text, selected_answer text, is_correct boolean, category text, difficulty text
  );

  return query
    select v_user.id, v_user.username, v_user.best_score, v_user.best_rate,
           v_user.current_streak, v_user.best_streak, v_user.total_answered, v_user.total_correct,
           v_user.level, v_user.exp, v_user.total_exp, v_user.streak_days,
           v_user.today_best_score, v_user.today_best_rate,
           v_user.onboarding_completed, v_user.goal_reason,
           v_user.goal_tags, v_user.contract_goal, v_user.first_area,
           v_user.diagnostic_level, v_user.diagnostic_growth, v_user.diagnostic_strengths,
           v_user.equipped_badge_key, null::text;
end;
$$;

-- ================================================================
-- RPC: 最初の攻略領域を保存する
-- （儀式短縮に伴い、攻略領域の選択は儀式後のメイン画面ポップアップへ分離した）
-- ================================================================
create or replace function rpc_set_first_area(p_user_id uuid, p_first_area text)
returns void
language sql
security definer
as $$
  update users u set first_area = p_first_area where u.id = p_user_id;
$$;

-- ================================================================
-- RPC: 初回登録の儀式で集めた内容を保存する
-- （現在地／変えたい未来／理由／未来像／攻略領域／継続方法／覚悟／契約の一文）
-- ================================================================
drop function if exists rpc_save_onboarding(uuid, text[], text, text, int);
create or replace function rpc_save_onboarding(
  p_user_id uuid, p_goal_tags text[], p_goal_reason text,
  p_commitment_cadence text, p_resolve_percent int,
  p_current_position text, p_future_identity text,
  p_first_area text, p_contract_goal text
)
returns void
language sql
security definer
as $$
  update users u set
    goal_tags = p_goal_tags,
    goal_reason = nullif(trim(p_goal_reason), ''),
    commitment_cadence = p_commitment_cadence,
    resolve_percent = greatest(0, least(100, p_resolve_percent)),
    current_position = p_current_position,
    future_identity = p_future_identity,
    first_area = p_first_area,
    contract_goal = nullif(trim(p_contract_goal), ''),
    onboarding_completed = true
  where u.id = p_user_id;
$$;

-- ================================================================
-- RPC 2: 回答結果を記録する（履歴の追加＋連続正解/自己ベスト/累計の更新）
-- ================================================================
create or replace function rpc_record_answer(
  p_user_id uuid, p_question_id text, p_correct boolean,
  p_mode text default null, p_category text default null, p_is_review boolean default false,
  p_session_id uuid default null
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
  insert into answer_history (user_id, question_id, correct, mode, category, is_review, session_id)
  values (p_user_id, p_question_id, p_correct, p_mode, p_category, p_is_review, p_session_id);

  select case when p_correct then u.current_streak + 1 else 0 end
  into v_new_streak
  from users u where u.id = p_user_id;

  update users u set
    total_answered = u.total_answered + 1,
    total_correct = u.total_correct + (case when p_correct then 1 else 0 end),
    current_streak = v_new_streak,
    best_streak = greatest(u.best_streak, v_new_streak),
    review_correct_count = u.review_correct_count + (case when p_is_review and p_correct then 1 else 0 end)
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
drop function if exists rpc_record_session_result(uuid, int, int);
create or replace function rpc_record_session_result(
  p_user_id uuid, p_score int, p_rate int
)
returns table (today_best_score int, today_best_rate int)
language plpgsql
security definer
as $$
declare
  v_today date := current_date;
  v_today_score int;
  v_today_rate int;
  v_today_date date;
begin
  select u.today_best_score, u.today_best_rate, u.today_best_date
  into v_today_score, v_today_rate, v_today_date
  from users u where u.id = p_user_id;

  -- 「本日の自己ベスト」は日付が変わっていたらリセットしてから更新する
  if v_today_date is null or v_today_date < v_today then
    v_today_score := p_score;
    v_today_rate := p_rate;
  else
    v_today_score := greatest(v_today_score, p_score);
    v_today_rate := greatest(v_today_rate, p_rate);
  end if;

  update users u set
    best_score = greatest(u.best_score, p_score),
    best_rate = greatest(u.best_rate, p_rate),
    today_best_score = v_today_score,
    today_best_rate = v_today_rate,
    today_best_date = v_today
  where u.id = p_user_id;

  return query select v_today_score, v_today_rate;
end;
$$;

-- ================================================================
-- PLAYER LOG（個人学習記録）関連RPC
-- ----------------------------------------------------------------
-- クイズ開始時にセッション行を作り（rpc_start_player_log_session）、
-- 各回答はrpc_record_answerのp_session_idで紐づけ、結果画面表示 or
-- 途中退出のタイミングでセッション行を確定させる
-- （rpc_finish_player_log_session）。月間カレンダー・日別詳細・
-- セッション履歴・継続学習日数は、すべてquiz_sessions／
-- answer_historyを元データとしてその場で集計する（別途の同期が
-- 必要な非正規化テーブルは持たない）。
-- ================================================================
create or replace function rpc_start_player_log_session(
  p_session_id uuid, p_user_id uuid, p_mode text,
  p_category text, p_difficulty text, p_selected_count text
)
returns void
language sql
security definer
as $$
  insert into quiz_sessions (id, user_id, mode, category, difficulty, selected_count)
  values (p_session_id, p_user_id, p_mode, p_category, p_difficulty, p_selected_count);
$$;

create or replace function rpc_finish_player_log_session(
  p_session_id uuid, p_answered_count int, p_correct_count int, p_incorrect_count int,
  p_earned_exp int, p_level_before int, p_level_after int,
  p_completed boolean, p_exited_early boolean
)
returns void
language sql
security definer
as $$
  update quiz_sessions qs set
    ended_at = now(),
    answered_count = p_answered_count,
    correct_count = p_correct_count,
    incorrect_count = p_incorrect_count,
    earned_exp = p_earned_exp,
    level_before = p_level_before,
    level_after = p_level_after,
    completed = p_completed,
    exited_early = p_exited_early
  where qs.id = p_session_id;
$$;

-- 月間カレンダー用：指定年月の日ごとの活動量
create or replace function rpc_get_player_log_month(p_user_id uuid, p_year int, p_month int)
returns table (
  study_date date, answered_count int, correct_count int,
  incorrect_count int, earned_exp int, session_count int, leveled_up boolean
)
language sql
security definer
as $$
  select (qs.started_at at time zone 'Asia/Tokyo')::date as study_date,
         sum(qs.answered_count)::int,
         sum(qs.correct_count)::int,
         sum(qs.incorrect_count)::int,
         sum(qs.earned_exp)::int,
         count(*)::int,
         bool_or(coalesce(qs.level_after, 0) > coalesce(qs.level_before, 0))
  from quiz_sessions qs
  where qs.user_id = p_user_id
    and qs.answered_count > 0
    and date_trunc('month', qs.started_at at time zone 'Asia/Tokyo') = make_date(p_year, p_month, 1)
  group by 1
  order by 1;
$$;

-- 選択日の合計（問題数・正誤・EXP・学習時間・セッション件数）
create or replace function rpc_get_player_log_day_summary(p_user_id uuid, p_date date)
returns table (
  answered_count int, correct_count int, incorrect_count int, earned_exp int,
  study_seconds int, session_count int, completed_session_count int, exited_early_count int,
  first_started_at timestamptz, last_ended_at timestamptz
)
language sql
security definer
as $$
  select
    coalesce(sum(qs.answered_count), 0)::int,
    coalesce(sum(qs.correct_count), 0)::int,
    coalesce(sum(qs.incorrect_count), 0)::int,
    coalesce(sum(qs.earned_exp), 0)::int,
    coalesce(sum(extract(epoch from (coalesce(qs.ended_at, qs.started_at) - qs.started_at))), 0)::int,
    count(*)::int,
    count(*) filter (where qs.completed)::int,
    count(*) filter (where qs.exited_early)::int,
    min(qs.started_at),
    max(coalesce(qs.ended_at, qs.started_at))
  from quiz_sessions qs
  where qs.user_id = p_user_id
    and (qs.started_at at time zone 'Asia/Tokyo')::date = p_date;
$$;

-- 選択日のジャンル別成績（answer_historyが一次データ）
create or replace function rpc_get_player_log_day_categories(p_user_id uuid, p_date date)
returns table (category text, answered_count int, correct_count int)
language sql
security definer
as $$
  select coalesce(ah.category, '未分類'),
         count(*)::int,
         count(*) filter (where ah.correct)::int
  from answer_history ah
  where ah.user_id = p_user_id
    and (ah.answered_at at time zone 'Asia/Tokyo')::date = p_date
  group by 1
  order by 2 desc;
$$;

-- 選択日の難易度別成績（questionsとjoinしてdifficultyを取得する）
create or replace function rpc_get_player_log_day_difficulties(p_user_id uuid, p_date date)
returns table (difficulty text, answered_count int, correct_count int)
language sql
security definer
as $$
  select q.difficulty,
         count(*)::int,
         count(*) filter (where ah.correct)::int
  from answer_history ah
  join questions q on q.id = ah.question_id
  where ah.user_id = p_user_id
    and (ah.answered_at at time zone 'Asia/Tokyo')::date = p_date
  group by q.difficulty
  order by case q.difficulty when '初級' then 1 when '中級' then 2 when '上級' then 3 else 4 end;
$$;

-- 選択日のセッション履歴
create or replace function rpc_get_player_log_day_sessions(p_user_id uuid, p_date date)
returns table (
  id uuid, started_at timestamptz, ended_at timestamptz, mode text, category text,
  difficulty text, answered_count int, correct_count int, incorrect_count int,
  earned_exp int, completed boolean, exited_early boolean
)
language sql
security definer
as $$
  select qs.id, qs.started_at, qs.ended_at, qs.mode, qs.category, qs.difficulty,
         qs.answered_count, qs.correct_count, qs.incorrect_count, qs.earned_exp,
         qs.completed, qs.exited_early
  from quiz_sessions qs
  where qs.user_id = p_user_id
    and (qs.started_at at time zone 'Asia/Tokyo')::date = p_date
  order by qs.started_at asc;
$$;

-- 過去に学習履歴がある年月の一覧（年月ピッカー用）
create or replace function rpc_get_player_log_months(p_user_id uuid)
returns table (year int, month int)
language sql
security definer
as $$
  select extract(year from d)::int, extract(month from d)::int
  from (
    select distinct date_trunc('month', qs.started_at at time zone 'Asia/Tokyo') as d
    from quiz_sessions qs
    where qs.user_id = p_user_id and qs.answered_count > 0
  ) x
  order by 1, 2;
$$;

-- ヘッダー用の概況（継続学習日数・累計学習日数・累計回答数）。
-- 「学習日」の判定は1問以上回答した日のみで、ログインだけの日は含めない
create or replace function rpc_get_player_log_overview(p_user_id uuid)
returns table (current_streak int, best_streak int, total_study_days int, total_answered int)
language plpgsql
security definer
as $$
declare
  v_dates date[];
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_current int := 0;
  v_best int := 0;
  v_run int := 0;
  v_prev date;
  v_total_answered int;
  i int;
begin
  select u.total_answered into v_total_answered from users u where u.id = p_user_id;

  select array_agg(d order by d) into v_dates
  from (
    select distinct (qs.started_at at time zone 'Asia/Tokyo')::date as d
    from quiz_sessions qs
    where qs.user_id = p_user_id and qs.answered_count > 0
  ) x;

  if v_dates is null then
    return query select 0, 0, 0, coalesce(v_total_answered, 0);
    return;
  end if;

  v_prev := null;
  for i in 1 .. array_length(v_dates, 1) loop
    if v_prev is not null and v_dates[i] = v_prev + 1 then
      v_run := v_run + 1;
    else
      v_run := 1;
    end if;
    if v_run > v_best then v_best := v_run; end if;
    v_prev := v_dates[i];
  end loop;

  if v_dates[array_length(v_dates, 1)] >= v_today - 1 then
    v_current := 1;
    for i in reverse array_length(v_dates, 1) - 1 .. 1 loop
      if v_dates[i] = v_dates[i + 1] - 1 then
        v_current := v_current + 1;
      else
        exit;
      end if;
    end loop;
  end if;

  return query select v_current, v_best, array_length(v_dates, 1), coalesce(v_total_answered, 0);
end;
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
-- 表示は「上位5名＋（圏外なら）自分の行」。rank列で実際の順位を返し、
-- is_self=trueの行がリクエストしたプレイヤー自身。
-- ================================================================
drop function if exists rpc_get_ranking();
drop function if exists rpc_get_ranking(uuid);
create or replace function rpc_get_ranking(p_user_id uuid default null)
returns table (
  rank int, username text, best_score int, best_rate int,
  total_answered int, total_correct int, current_streak int, best_streak int,
  level int, total_exp int, equipped_badge_title text, equipped_badge_tier text, is_self boolean
)
language sql
security definer
as $$
  with ranked as (
    select row_number() over (order by u.best_rate desc, u.best_score desc)::int as rank,
           u.id, u.username, u.best_score, u.best_rate, u.total_answered, u.total_correct,
           u.current_streak, u.best_streak, u.level, u.total_exp, b.title, b.tier
    from users u
    left join badges b on b.key = u.equipped_badge_key
  )
  select r.rank, r.username, r.best_score, r.best_rate, r.total_answered, r.total_correct,
         r.current_streak, r.best_streak, r.level, r.total_exp, r.title, r.tier, (r.id = p_user_id)
  from ranked r
  where r.rank <= 5 or r.id = p_user_id
  order by r.rank;
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

-- ================================================================
-- badges: 称号・バッジのマスタ定義
-- （テーブル本体と列の追加は、ランキングRPCより先に実行する必要が
--   あるためファイル前方の「badges: 称号マスタの器」ブロックにある。
--   is_secret＝解放するまで？？？表示する隠しフラグ、
--   tier＝レア度：bronze < silver < gold < legend < secret < master）
-- ================================================================
alter table badges enable row level security;
drop policy if exists "badges are readable by anyone" on badges;
create policy "badges are readable by anyone" on badges for select using (true);

-- 称号の定義はこのシードが正（再実行すると文言・並び順・隠しフラグ・レア度が最新化される）
insert into badges (key, title, description, sort_order, is_secret, tier) values
  -- 解答数・成長の道のり
  ('first_correct', 'はじめの一歩', '初めて1問正解した', 1, false, 'bronze'),
  ('trainee_30', '訓練兵', '累計30問以上に解答した', 2, false, 'bronze'),
  ('conqueror_100', '攻略者', '累計100問以上に解答した', 3, false, 'silver'),
  ('conqueror_300', '歴戦の攻略者', '累計300問以上に解答した', 4, false, 'gold'),
  ('answers_1000', '千戦錬磨', '累計1000問以上に解答した', 5, false, 'legend'),
  ('correct_200', '精鋭の証', '累計200問以上に正解した', 6, false, 'gold'),
  -- コンボ
  ('combo_10', '集中モード', '10問連続正解を達成した', 7, false, 'bronze'),
  ('combo_20', '連撃マスター', '最大20連続正解を達成した', 8, false, 'silver'),
  ('combo_30', '怒涛の連撃', '最大30連続正解を達成した', 9, false, 'gold'),
  ('combo_50', 'ゾーンの支配者', '最大50連続正解を達成した', 10, false, 'legend'),
  -- 完全制圧
  ('perfect_clear', '完全制圧者', '正答率100%で任務を完了した', 11, false, 'silver'),
  ('perfect_3', '常勝無敗', '5問以上の任務を正答率100%で3回完了した', 12, false, 'gold'),
  -- 上級・復習・克服
  ('advanced_5', '上級アドバイザー', '上級問題に5問正解した', 13, false, 'bronze'),
  ('advanced_20', '上級を統べる者', '上級問題に20問正解した', 14, false, 'gold'),
  ('review_master', '復習の鬼', '復習モードで5問正解した', 15, false, 'bronze'),
  ('review_20', '弱点ハンター', '復習モードで20問正解した', 16, false, 'silver'),
  ('comeback_master', '再起の達人', '苦手だった問題をすべて復習し尽くした', 17, false, 'gold'),
  -- 網羅・二刀流
  ('all_rounder', 'オールラウンダー', '全エリアを1回以上プレイした', 18, false, 'gold'),
  ('dual_master', '文武両道', '基礎任務と判断任務の両方で10問以上正解した', 19, false, 'silver'),
  -- 継続
  ('streak_3', '習慣化の入口', '3日間連続で学習した', 20, false, 'bronze'),
  ('streak_7', '継続の達人', '7日間連続でログインした', 21, false, 'silver'),
  ('streak_14', '二週間の誓い', '14日間連続で学習した', 22, false, 'gold'),
  ('streak_30', '鉄の意志', '30日間連続で学習した', 23, false, 'legend'),
  -- レベル・出撃回数
  ('level_10', '新星', 'レベル10に到達した', 24, false, 'bronze'),
  ('level_30', '歴戦の勇士', 'レベル30に到達した', 25, false, 'gold'),
  ('level_50', '仮想空間の英雄', 'レベル50に到達した', 26, false, 'legend'),
  ('sessions_50', '歴戦の出撃', '任務に50回出撃した', 27, false, 'silver'),
  -- 隠し称号（解放するまで？？？表示）
  ('zero_to_one', 'ZERO TO ONE', '覚悟0％から、最初の一歩を記録した', 90, true, 'secret'),
  ('night_owl', '真夜中の修行者', '深夜0時〜4時の間に任務へ挑んだ', 91, true, 'secret'),
  ('early_bird', '夜明けの狩人', '早朝4時〜7時の間に任務へ挑んだ', 92, true, 'secret'),
  ('persistence', '七転八起', '3回以上間違えた問題に、ついに正解した', 93, true, 'secret'),
  ('speedster', '電光石火', '10問以上の任務を3分以内に完了した', 94, true, 'secret'),
  ('all_miss', 'どん底を見た者', '5問以上の任務で全問不正解でも、記録を残した', 95, true, 'secret'),
  ('lucky_777', 'ラッキーセブン', '累計解答数777問に到達した', 96, true, 'secret'),
  ('world_master', 'ワールドマスター', 'すべての問題に1回以上正解した', 97, true, 'secret'),
  -- ゲームマスター専用の特別称号（プレイヤー名で自動付与される唯一の称号）
  ('game_master', 'ゲームマスター', 'この仮想訓練空間の創造主であることの証', 99, true, 'master')
on conflict (key) do update set
  title = excluded.title,
  description = excluded.description,
  sort_order = excluded.sort_order,
  is_secret = excluded.is_secret,
  tier = excluded.tier;

-- user_badges: 誰がどのバッジを解放済みか
create table if not exists user_badges (
  user_id uuid not null references users(id) on delete cascade,
  badge_key text not null references badges(key) on delete cascade,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, badge_key)
);
alter table user_badges enable row level security;
-- 直接アクセスは禁止。rpc_get_badges / rpc_check_badges 経由のみ

-- ================================================================
-- daily_missions: デイリーミッションのマスタ定義
-- ================================================================
create table if not exists daily_missions (
  key text primary key,
  title text not null,
  description text not null,
  mode_filter text, -- 'knowledge' | 'practice' | 'review' | null(モード問わず合計)
  target_count int not null,
  reward_exp int not null,
  sort_order int not null default 0
);
alter table daily_missions enable row level security;
drop policy if exists "daily_missions are readable by anyone" on daily_missions;
create policy "daily_missions are readable by anyone" on daily_missions for select using (true);

-- ミッションの定義はこのシードが正（再実行すると文言・報酬EXPが最新化される）
insert into daily_missions (key, title, description, mode_filter, target_count, reward_exp, sort_order) values
  ('daily_knowledge_5', '基礎任務を5問解く', '基礎任務（知識問題）を今日中に5問解答しよう', 'knowledge', 5, 25, 1),
  ('daily_review_3', '要再挑戦リストに3問挑む', '要再挑戦リストの問題を復習モードで3問解答しよう', 'review', 3, 30, 3),
  ('daily_total_10', '今日の任務で10問解答する', '任務の種類を問わず、今日中に合計10問解答しよう', null, 10, 35, 4)
on conflict (key) do update set
  title = excluded.title,
  description = excluded.description,
  mode_filter = excluded.mode_filter,
  target_count = excluded.target_count,
  reward_exp = excluded.reward_exp,
  sort_order = excluded.sort_order;

-- 判断任務のデイリーミッションは廃止（実践提案問題は問題数が少なく、
-- 毎日のノルマとしては重いため）。過去の受取記録もカスケードで消える
delete from daily_missions where key = 'daily_practice_3';

-- 「報酬を受け取り済みか」だけを記録する（進捗自体はanswer_historyから毎回計算する）
create table if not exists user_daily_mission_claims (
  user_id uuid not null references users(id) on delete cascade,
  mission_key text not null references daily_missions(key) on delete cascade,
  mission_date date not null,
  claimed_at timestamptz not null default now(),
  primary key (user_id, mission_key, mission_date)
);
alter table user_daily_mission_claims enable row level security;

-- ================================================================
-- 称号・バッジRPC
-- ================================================================
drop function if exists rpc_get_badges(uuid);
create or replace function rpc_get_badges(p_user_id uuid)
returns table (
  key text, title text, description text, sort_order int, is_secret boolean, tier text,
  unlocked boolean, unlocked_at timestamptz
)
language sql
security definer
as $$
  select b.key, b.title, b.description, b.sort_order, b.is_secret, b.tier,
         (ub.user_id is not null) as unlocked, ub.unlocked_at
  from badges b
  left join user_badges ub on ub.badge_key = b.key and ub.user_id = p_user_id
  order by b.sort_order;
$$;

-- 現在の永続データ（users/answer_history/questions）だけを根拠に判定し、
-- 新たに条件を満たしたバッジだけを付与して返す（クライアントの自己申告は信用しない）
create or replace function rpc_check_badges(p_user_id uuid)
returns table (key text, title text, description text)
language plpgsql
security definer
as $$
declare
  v_user users;
  v_categories_played int;
  v_categories_total int;
  v_ever_wrong int;
  v_currently_wrong int;
  v_advanced_correct int;
  v_knowledge_correct int;
  v_practice_correct int;
  v_has_night boolean;
  v_has_early boolean;
  v_persistence boolean;
  v_sessions int;
  v_perfect_sessions int;
  v_speed boolean;
  v_all_miss boolean;
  v_correct_distinct int;
  v_questions_total int;
begin
  select * into v_user from users u where u.id = p_user_id;
  if v_user.id is null then return; end if;

  select count(distinct category) into v_categories_played from answer_history where user_id = p_user_id;
  select count(distinct category) into v_categories_total from questions;
  select count(*) into v_ever_wrong from answer_history where user_id = p_user_id and correct = false;
  select count(*) into v_currently_wrong from (
    select distinct on (question_id) question_id, correct
    from answer_history where user_id = p_user_id
    order by question_id, answered_at desc
  ) latest where latest.correct = false;
  select count(*) into v_advanced_correct
  from answer_history ah join questions q on q.id = ah.question_id
  where ah.user_id = p_user_id and ah.correct and q.difficulty = '上級';

  -- 文武両道・深夜/早朝の隠し称号・全問制覇の判定材料（時刻は日本時間で判定）
  select count(*) filter (where ah.mode = 'knowledge' and ah.correct),
         count(*) filter (where ah.mode = 'practice' and ah.correct),
         coalesce(bool_or(extract(hour from ah.answered_at at time zone 'Asia/Tokyo') between 0 and 3), false),
         coalesce(bool_or(extract(hour from ah.answered_at at time zone 'Asia/Tokyo') between 4 and 6), false),
         count(distinct ah.question_id) filter (where ah.correct)
  into v_knowledge_correct, v_practice_correct, v_has_night, v_has_early, v_correct_distinct
  from answer_history ah where ah.user_id = p_user_id;

  select count(*) into v_questions_total from questions;

  -- 七転八起：3回以上間違えたことのある問題に、正解した経験があるか
  select exists (
    select 1 from (
      select ah.question_id,
             count(*) filter (where not ah.correct) as wrong_n,
             bool_or(ah.correct) as ever_correct
      from answer_history ah where ah.user_id = p_user_id
      group by ah.question_id
    ) t where t.wrong_n >= 3 and t.ever_correct
  ) into v_persistence;

  -- 出撃回数・常勝無敗・電光石火・どん底の判定材料（quiz_sessionsから）
  select count(*),
         count(*) filter (where qs.completed and qs.answered_count >= 5 and qs.correct_count = qs.answered_count),
         coalesce(bool_or(qs.completed and qs.answered_count >= 10 and qs.ended_at is not null
                          and qs.ended_at - qs.started_at <= interval '3 minutes'), false),
         coalesce(bool_or(qs.answered_count >= 5 and qs.correct_count = 0), false)
  into v_sessions, v_perfect_sessions, v_speed, v_all_miss
  from quiz_sessions qs where qs.user_id = p_user_id;

  return query
  with newly_inserted as (
    insert into user_badges (user_id, badge_key)
    select p_user_id, k from (values
      -- 解答数・成長
      ('first_correct', v_user.total_correct >= 1),
      ('trainee_30', v_user.total_answered >= 30),
      ('conqueror_100', v_user.total_answered >= 100),
      ('conqueror_300', v_user.total_answered >= 300),
      ('answers_1000', v_user.total_answered >= 1000),
      ('correct_200', v_user.total_correct >= 200),
      -- コンボ
      ('combo_10', v_user.best_streak >= 10),
      ('combo_20', v_user.best_streak >= 20),
      ('combo_30', v_user.best_streak >= 30),
      ('combo_50', v_user.best_streak >= 50),
      -- 完全制圧
      ('perfect_clear', v_user.best_rate = 100),
      ('perfect_3', v_perfect_sessions >= 3),
      -- 上級・復習・克服
      ('advanced_5', v_advanced_correct >= 5),
      ('advanced_20', v_advanced_correct >= 20),
      ('review_master', v_user.review_correct_count >= 5),
      ('review_20', v_user.review_correct_count >= 20),
      ('comeback_master', v_ever_wrong > 0 and v_currently_wrong = 0),
      -- 網羅・二刀流
      ('all_rounder', v_categories_total > 0 and v_categories_played >= v_categories_total),
      ('dual_master', v_knowledge_correct >= 10 and v_practice_correct >= 10),
      -- 継続
      ('streak_3', v_user.streak_days >= 3),
      ('streak_7', v_user.streak_days >= 7),
      ('streak_14', v_user.streak_days >= 14),
      ('streak_30', v_user.streak_days >= 30),
      -- レベル・出撃回数
      ('level_10', v_user.level >= 10),
      ('level_30', v_user.level >= 30),
      ('level_50', v_user.level >= 50),
      ('sessions_50', v_sessions >= 50),
      -- 隠し称号
      -- 初回登録で覚悟0%を選んだ正直なプレイヤーが、3日間学習を続けたら贈られる
      ('zero_to_one', v_user.started_from_zero_resolve and v_user.streak_days >= 3),
      ('night_owl', v_has_night),
      ('early_bird', v_has_early),
      ('persistence', v_persistence),
      ('speedster', v_speed),
      ('all_miss', v_all_miss),
      ('lucky_777', v_user.total_answered >= 777),
      ('world_master', v_questions_total > 0 and v_correct_distinct >= v_questions_total),
      -- ゲームマスター：このプレイヤー名でログインした瞬間に付与される特別称号
      ('game_master', v_user.username = '吉沢')
    ) as conds(k, ok)
    where ok
    on conflict (user_id, badge_key) do nothing
    returning badge_key
  )
  select b.key, b.title, b.description
  from newly_inserted ni
  join badges b on b.key = ni.badge_key;
end;
$$;

-- 称号を装備する（nullを渡せば解除）。未解放の称号は装備できないようサーバー側で検証する
create or replace function rpc_set_equipped_badge(p_user_id uuid, p_badge_key text)
returns table (equipped_badge_key text, equipped_badge_title text)
language plpgsql
security definer
as $$
begin
  if p_badge_key is not null and not exists (
    select 1 from user_badges ub where ub.user_id = p_user_id and ub.badge_key = p_badge_key
  ) then
    raise exception 'この称号はまだ解放されていません';
  end if;

  update users u set equipped_badge_key = p_badge_key where u.id = p_user_id;

  return query
    select u.equipped_badge_key, b.title
    from users u
    left join badges b on b.key = u.equipped_badge_key
    where u.id = p_user_id;
end;
$$;

-- ================================================================
-- デイリーミッションRPC
-- ================================================================
create or replace function rpc_get_daily_missions(p_user_id uuid)
returns table (
  key text, title text, description text, target_count int, reward_exp int,
  progress int, completed boolean, claimed boolean
)
language sql
security definer
as $$
  select
    dm.key, dm.title, dm.description, dm.target_count, dm.reward_exp,
    least(coalesce(cnt.n, 0), dm.target_count) as progress,
    coalesce(cnt.n, 0) >= dm.target_count as completed,
    (c.user_id is not null) as claimed
  from daily_missions dm
  left join lateral (
    select count(*) as n
    from answer_history ah
    where ah.user_id = p_user_id
      and ah.answered_at::date = current_date
      and (dm.mode_filter is null or
           (dm.mode_filter = 'review' and ah.is_review) or
           (dm.mode_filter <> 'review' and ah.mode = dm.mode_filter))
  ) cnt on true
  left join user_daily_mission_claims c
    on c.user_id = p_user_id and c.mission_key = dm.key and c.mission_date = current_date
  order by dm.sort_order;
$$;

create or replace function rpc_claim_daily_mission(p_user_id uuid, p_mission_key text)
returns table (
  old_level int, new_level int, exp int, total_exp int, next_required_exp int, reward_exp int
)
language plpgsql
security definer
as $$
declare
  v_target int;
  v_reward int;
  v_progress int;
  v_already_claimed boolean;
  v_old_level int; v_level int; v_exp int; v_total_exp int; v_required int;
begin
  select dm.target_count, dm.reward_exp into v_target, v_reward
  from daily_missions dm where dm.key = p_mission_key;
  if v_target is null then
    raise exception 'ミッションが見つかりません';
  end if;

  select exists(
    select 1 from user_daily_mission_claims
    where user_id = p_user_id and mission_key = p_mission_key and mission_date = current_date
  ) into v_already_claimed;
  if v_already_claimed then
    raise exception 'このミッションは既に受け取り済みです';
  end if;

  select count(*) into v_progress
  from answer_history ah, daily_missions dm
  where dm.key = p_mission_key
    and ah.user_id = p_user_id
    and ah.answered_at::date = current_date
    and (dm.mode_filter is null or
         (dm.mode_filter = 'review' and ah.is_review) or
         (dm.mode_filter <> 'review' and ah.mode = dm.mode_filter));

  if v_progress < v_target then
    raise exception 'ミッションの達成条件を満たしていません';
  end if;

  insert into user_daily_mission_claims (user_id, mission_key, mission_date)
  values (p_user_id, p_mission_key, current_date);

  select u.level, u.exp, u.total_exp into v_old_level, v_exp, v_total_exp
  from users u where u.id = p_user_id;

  v_level := v_old_level;
  v_total_exp := v_total_exp + v_reward;
  v_exp := v_exp + v_reward;
  while v_level < 100 loop
    v_required := 50 * v_level;
    exit when v_exp < v_required;
    v_exp := v_exp - v_required;
    v_level := v_level + 1;
  end loop;
  if v_level >= 100 then v_level := 100; end if;

  update users u set level = v_level, exp = v_exp, total_exp = v_total_exp
  where u.id = p_user_id;

  return query select v_old_level, v_level, v_exp, v_total_exp,
    (case when v_level >= 100 then null else 50 * v_level end), v_reward;
end;
$$;

-- ================================================================
-- 複数ランキングRPC（既存のrpc_get_ranking＝総合攻略者ボードは変更しない）
-- ================================================================
-- 「毎日触れているか」を可視化するための継続日数ランキング。
-- streak_daysが同じ場合は直近ログインの新しい順にする
-- 各ランキング共通仕様：rank列（実際の順位）を付けて「上位5名＋（圏外なら）自分」
-- だけを返す。is_self=trueがリクエストしたプレイヤー自身の行。
-- 対象条件（streak_days > 0 など）を満たしていない場合、自分の行は返らない。
drop function if exists rpc_get_streak_ranking();
drop function if exists rpc_get_streak_ranking(uuid);
create or replace function rpc_get_streak_ranking(p_user_id uuid default null)
returns table (rank int, username text, streak_days int, last_active_date date, level int, total_exp int, equipped_badge_title text, equipped_badge_tier text, is_self boolean)
language sql
security definer
as $$
  with ranked as (
    select row_number() over (order by u.streak_days desc, u.last_active_date desc nulls last)::int as rank,
           u.id, u.username, u.streak_days, u.last_active_date, u.level, u.total_exp, b.title, b.tier
    from users u
    left join badges b on b.key = u.equipped_badge_key
    where u.streak_days > 0
  )
  select r.rank, r.username, r.streak_days, r.last_active_date, r.level, r.total_exp, r.title, r.tier, (r.id = p_user_id)
  from ranked r
  where r.rank <= 5 or r.id = p_user_id
  order by r.rank;
$$;

drop function if exists rpc_get_weekly_ranking();
drop function if exists rpc_get_weekly_ranking(uuid);
create or replace function rpc_get_weekly_ranking(p_user_id uuid default null)
returns table (rank int, username text, weekly_correct int, weekly_answered int, level int, total_exp int, equipped_badge_title text, equipped_badge_tier text, is_self boolean)
language sql
security definer
as $$
  with agg as (
    select u.id, u.username,
           count(*) filter (where ah.correct)::int as weekly_correct,
           count(*)::int as weekly_answered,
           u.level, u.total_exp, b.title, b.tier
    from answer_history ah
    join users u on u.id = ah.user_id
    left join badges b on b.key = u.equipped_badge_key
    where ah.answered_at >= now() - interval '7 days'
    group by u.id, u.username, u.level, u.total_exp, b.title, b.tier
  ), ranked as (
    select row_number() over (order by a.weekly_correct desc, a.weekly_answered desc)::int as rank, a.*
    from agg a
  )
  select r.rank, r.username, r.weekly_correct, r.weekly_answered, r.level, r.total_exp, r.title, r.tier, (r.id = p_user_id)
  from ranked r
  where r.rank <= 5 or r.id = p_user_id
  order by r.rank;
$$;

drop function if exists rpc_get_monthly_ranking();
drop function if exists rpc_get_monthly_ranking(uuid);
create or replace function rpc_get_monthly_ranking(p_user_id uuid default null)
returns table (rank int, username text, monthly_correct int, monthly_answered int, level int, total_exp int, equipped_badge_title text, equipped_badge_tier text, is_self boolean)
language sql
security definer
as $$
  with agg as (
    select u.id, u.username,
           count(*) filter (where ah.correct)::int as monthly_correct,
           count(*)::int as monthly_answered,
           u.level, u.total_exp, b.title, b.tier
    from answer_history ah
    join users u on u.id = ah.user_id
    left join badges b on b.key = u.equipped_badge_key
    where ah.answered_at >= now() - interval '30 days'
    group by u.id, u.username, u.level, u.total_exp, b.title, b.tier
  ), ranked as (
    select row_number() over (order by a.monthly_correct desc, a.monthly_answered desc)::int as rank, a.*
    from agg a
  )
  select r.rank, r.username, r.monthly_correct, r.monthly_answered, r.level, r.total_exp, r.title, r.tier, (r.id = p_user_id)
  from ranked r
  where r.rank <= 5 or r.id = p_user_id
  order by r.rank;
$$;

drop function if exists rpc_get_combo_ranking();
drop function if exists rpc_get_combo_ranking(uuid);
create or replace function rpc_get_combo_ranking(p_user_id uuid default null)
returns table (rank int, username text, best_streak int, level int, total_exp int, equipped_badge_title text, equipped_badge_tier text, is_self boolean)
language sql
security definer
as $$
  with ranked as (
    select row_number() over (order by u.best_streak desc)::int as rank,
           u.id, u.username, u.best_streak, u.level, u.total_exp, b.title, b.tier
    from users u
    left join badges b on b.key = u.equipped_badge_key
    where u.best_streak > 0
  )
  select r.rank, r.username, r.best_streak, r.level, r.total_exp, r.title, r.tier, (r.id = p_user_id)
  from ranked r
  where r.rank <= 5 or r.id = p_user_id
  order by r.rank;
$$;

drop function if exists rpc_get_suppression_ranking();
drop function if exists rpc_get_suppression_ranking(uuid);
create or replace function rpc_get_suppression_ranking(p_user_id uuid default null)
returns table (rank int, username text, best_rate int, level int, total_exp int, equipped_badge_title text, equipped_badge_tier text, is_self boolean)
language sql
security definer
as $$
  with ranked as (
    select row_number() over (order by u.best_rate desc, u.username asc)::int as rank,
           u.id, u.username, u.best_rate, u.level, u.total_exp, b.title, b.tier
    from users u
    left join badges b on b.key = u.equipped_badge_key
    where u.total_answered > 0
  )
  select r.rank, r.username, r.best_rate, r.level, r.total_exp, r.title, r.tier, (r.id = p_user_id)
  from ranked r
  where r.rank <= 5 or r.id = p_user_id
  order by r.rank;
$$;

drop function if exists rpc_get_mission_count_ranking();
drop function if exists rpc_get_mission_count_ranking(uuid);
create or replace function rpc_get_mission_count_ranking(p_user_id uuid default null)
returns table (rank int, username text, total_answered int, level int, total_exp int, equipped_badge_title text, equipped_badge_tier text, is_self boolean)
language sql
security definer
as $$
  with ranked as (
    select row_number() over (order by u.total_answered desc)::int as rank,
           u.id, u.username, u.total_answered, u.level, u.total_exp, b.title, b.tier
    from users u
    left join badges b on b.key = u.equipped_badge_key
    where u.total_answered > 0
  )
  select r.rank, r.username, r.total_answered, r.level, r.total_exp, r.title, r.tier, (r.id = p_user_id)
  from ranked r
  where r.rank <= 5 or r.id = p_user_id
  order by r.rank;
$$;

drop function if exists rpc_get_review_ranking();
drop function if exists rpc_get_review_ranking(uuid);
create or replace function rpc_get_review_ranking(p_user_id uuid default null)
returns table (rank int, username text, review_correct_count int, level int, total_exp int, equipped_badge_title text, equipped_badge_tier text, is_self boolean)
language sql
security definer
as $$
  with ranked as (
    select row_number() over (order by u.review_correct_count desc)::int as rank,
           u.id, u.username, u.review_correct_count, u.level, u.total_exp, b.title, b.tier
    from users u
    left join badges b on b.key = u.equipped_badge_key
    where u.review_correct_count > 0
  )
  select r.rank, r.username, r.review_correct_count, r.level, r.total_exp, r.title, r.tier, (r.id = p_user_id)
  from ranked r
  where r.rank <= 5 or r.id = p_user_id
  order by r.rank;
$$;
