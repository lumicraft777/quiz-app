/* ================================================================
   蓄電池メーカー比較クイズ - script.js（Supabase連携版）
   ----------------------------------------------------------------
   このファイルは大きく4つのパートに分かれています。
   [パート1] Supabase設定・共通リクエスト関数
   [パート2] 画面制御・クイズ進行ロジック（アプリ本体）
   [パート3] ユーザー管理（ユーザー名+PIN・Supabase RPC経由）
   [パート4] 演出・効果音（ゲーム的な楽しさのための仕掛け）

   ★ 問題データはSupabaseの questions テーブルから読み込みます。
     スプレッドシートは「元データ」として引き続き使いますが、
     ブラウザは直接読みに行きません。スプレッドシートを更新したら、
     scripts/sync-questions.js を実行してSupabase側を更新してください
     （詳しくはREADME参照）。
   ★ 自己ベスト・連続正解数・不正解/正解済みリストなどの成績は、
     ユーザー名＋4桁PINで識別するSupabaseの users / answer_history
     テーブルに保存されます（他人が同じ名前を使ってもPINが違えば
     ログインできません）。
   ================================================================ */


/* ================================================================
   [パート1] Supabase設定・共通リクエスト関数
   ================================================================ */

const SUPABASE_URL = "https://ossmlptnlcmopjhzwegn.supabase.co";
// publishable key（旧: anon key）。RLSで保護されているため、
// このキーがブラウザに露出しても安全な設計になっている。
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_t1-i-dCF-KDCmBBKrCzWjw_wZ5fu4G-";

async function supabaseFetch(pathAndQuery, options) {
  return fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...options,
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      "Content-Type": "application/json",
      ...(options && options.headers)
    }
  });
}

// Supabaseのrpc（データベース関数）を呼び出す共通ヘルパー
async function supabaseRpc(fnName, params) {
  const res = await supabaseFetch(`rpc/${fnName}`, {
    method: "POST",
    body: JSON.stringify(params || {})
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data && data.message) || `${fnName} の呼び出しに失敗しました`;
    throw new Error(message);
  }
  return data;
}

// 配列をシャッフルして新しい配列を返す（元の配列は壊さない）
function shuffleArray(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}


/* ================================================================
   用語集（辞書機能）
   ----------------------------------------------------------------
   ・Supabaseの glossary テーブルから全用語を読み込み、クライアント側に
     保持しておく（件数が少ないので毎回全件取得でよい）
   ・画面左上の📖ボタンから検索パネルを開ける
   ・問題文・選択肢・解説文などに用語集の単語が含まれていれば、
     自動的に下線付きでハイライトし、タップすると辞書パネルが開く
   ================================================================ */

let glossaryTerms = []; // [{ term, definition, category }]

async function loadGlossary() {
  try {
    const res = await supabaseFetch("glossary?select=term,definition,category&order=term.asc");
    if (res.ok) glossaryTerms = await res.json();
  } catch (err) {
    // 用語集が読めなくてもクイズ本体は問題なく遊べるようにする
    console.error("用語集の読み込みに失敗しました:", err.message);
  }
}

function setupDictionary() {
  document.getElementById("btn-dictionary-toggle").addEventListener("click", () => openDictionary());
  document.getElementById("btn-dictionary-close").addEventListener("click", closeDictionary);
  document.getElementById("dictionary-panel").addEventListener("click", (e) => {
    if (e.target.id === "dictionary-panel") closeDictionary(); // 背景クリックで閉じる
  });
  document.getElementById("dictionary-search").addEventListener("input", (e) => {
    renderDictionaryResults(e.target.value);
  });
}

// prefillTerm を渡すと、その用語で検索した状態でパネルを開く
// （問題文中の用語をタップしたときに使う）
function openDictionary(prefillTerm) {
  const panel = document.getElementById("dictionary-panel");
  const searchInput = document.getElementById("dictionary-search");
  searchInput.value = prefillTerm || "";
  renderDictionaryResults(searchInput.value, prefillTerm);
  panel.hidden = false;
  if (!prefillTerm) searchInput.focus();
}

function closeDictionary() {
  document.getElementById("dictionary-panel").hidden = true;
}

function renderDictionaryResults(query, highlightTerm) {
  const resultsEl = document.getElementById("dictionary-results");
  const emptyEl = document.getElementById("dictionary-empty-text");
  resultsEl.innerHTML = "";

  const trimmed = (query || "").trim();
  const filtered = trimmed
    ? glossaryTerms.filter((g) => g.term.includes(trimmed) || g.definition.includes(trimmed))
    : glossaryTerms;

  if (filtered.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  filtered.forEach((g) => {
    const item = document.createElement("div");
    item.className = "dictionary-item" + (g.term === highlightTerm ? " is-highlighted" : "");

    const termEl = document.createElement("p");
    termEl.className = "dictionary-term";
    termEl.textContent = g.term;

    const defEl = document.createElement("p");
    defEl.className = "dictionary-definition";
    defEl.textContent = g.definition;

    item.appendChild(termEl);
    item.appendChild(defEl);
    resultsEl.appendChild(item);
  });
}

// テキストを指定したコンテナ要素に描画する。用語集に登録された単語が
// 含まれていれば、その部分だけクリック可能なspanに置き換える。
// innerHTMLは使わず必ずDOM操作で組み立てるため、問題文に特殊文字が
// 含まれていても安全。
function renderTextWithGlossary(container, text) {
  container.innerHTML = "";
  appendTextWithGlossary(container, text);
}

// renderTextWithGlossaryと同じことをするが、コンテナの中身を消さずに
// 末尾へ追記する（「理由：」のような固定ラベルの後に続けたい場合に使う）
function appendTextWithGlossary(container, text) {
  if (!text) return;
  if (glossaryTerms.length === 0) {
    container.appendChild(document.createTextNode(text));
    return;
  }

  // 長い用語を優先してマッチさせる（「全負荷」が「全負荷対応」の
  // 一部として誤ってハイライトされないようにするため）
  const sortedTerms = [...glossaryTerms].sort((a, b) => b.term.length - a.term.length);
  const chars = Array.from(text); // サロゲートペアを考慮して1文字ずつ扱う
  let cursor = 0;
  let buffer = "";

  const flushBuffer = () => {
    if (buffer) {
      container.appendChild(document.createTextNode(buffer));
      buffer = "";
    }
  };

  while (cursor < chars.length) {
    let matched = null;
    for (const g of sortedTerms) {
      const termChars = Array.from(g.term);
      if (termChars.length > 0 && chars.slice(cursor, cursor + termChars.length).join("") === g.term) {
        matched = g;
        break;
      }
    }
    if (matched) {
      flushBuffer();
      const span = document.createElement("span");
      span.className = "glossary-term";
      span.textContent = matched.term;
      span.addEventListener("click", (e) => {
        e.stopPropagation(); // 選択肢ボタンなどの親要素のクリックに巻き込まれないようにする
        openDictionary(matched.term);
      });
      container.appendChild(span);
      cursor += Array.from(matched.term).length;
    } else {
      buffer += chars[cursor];
      cursor++;
    }
  }
  flushBuffer();
}


/* ================================================================
   経験値（EXP）・レベル機能
   ----------------------------------------------------------------
   ・「学習が積み上がっている」実感を持たせるための仕組み。正解だけ
     でなく不正解でも（学習したこととして）EXPが入る。
   ・クイズ中はセッション内でEXPをローカル積算するだけにしておき、
     結果画面表示時にまとめてSupabaseへ反映する（通信回数を抑える）。
   ・レベルアップの計算式・称号一覧は仕様どおり。
   ================================================================ */

// レベルアップに必要なEXP（Lv.n → Lv.n+1 に必要な量）
function getRequiredExp(level) {
  return 50 * level;
}

// 5レベルごとに変わる称号一覧（固有名詞は含めない）
const LEVEL_TITLES = [
  { min: 1, max: 4, title: "新人アドバイザー" },
  { min: 5, max: 9, title: "商品理解トレーニー" },
  { min: 10, max: 14, title: "基礎提案アドバイザー" },
  { min: 15, max: 19, title: "比較提案アドバイザー" },
  { min: 20, max: 24, title: "蓄電池コンサル" },

  { min: 25, max: 29, title: "停電対策コンサル" },
  { min: 30, max: 34, title: "スマートハウスアドバイザー" },
  { min: 35, max: 39, title: "家庭エネルギーアドバイザー" },
  { min: 40, max: 44, title: "提案判断リーダー" },
  { min: 45, max: 49, title: "営業提案リーダー" },

  { min: 50, max: 54, title: "蓄電池提案プロ" },
  { min: 55, max: 59, title: "スマートハウス提案プロ" },
  { min: 60, max: 64, title: "家庭条件分析プロ" },
  { min: 65, max: 69, title: "電力提案プロ" },
  { min: 70, max: 74, title: "提案設計エキスパート" },

  { min: 75, max: 79, title: "営業判断エキスパート" },
  { min: 80, max: 84, title: "スマートライフコンサルタント" },
  { min: 85, max: 89, title: "エネルギー提案マイスター" },
  { min: 90, max: 94, title: "スマートハウスマイスター" },
  { min: 95, max: 99, title: "営業提案マスター" },

  { min: 100, max: 100, title: "スマートハウス営業王" }
];

function getLevelTitle(level) {
  const matched = LEVEL_TITLES.find((item) => level >= item.min && level <= item.max);
  return matched ? matched.title : "新人アドバイザー";
}

// コンボ到達時の一発ボーナスEXP（セッション内で同じ段階は1回だけ付与）
const COMBO_BONUS_EXP = { 3: 5, 5: 10, 10: 25, 15: 40, 20: 60 };

// ---- EXPゲージのDOM組み立て（スタート/クイズ/結果画面で共通利用） ----
function buildExpGaugeElement(level, exp, totalExp) {
  const wrap = document.createElement("div");
  wrap.className = "exp-gauge";

  const header = document.createElement("div");
  header.className = "exp-gauge-header";

  const levelSpan = document.createElement("span");
  levelSpan.className = "exp-gauge-level";
  levelSpan.textContent = `Lv.${level}`;

  const titleSpan = document.createElement("span");
  titleSpan.className = "exp-gauge-title";
  titleSpan.textContent = getLevelTitle(level);

  header.appendChild(levelSpan);
  header.appendChild(titleSpan);

  const track = document.createElement("div");
  track.className = "exp-gauge-track";
  const fill = document.createElement("div");
  fill.className = "exp-gauge-fill";
  track.appendChild(fill);

  const footer = document.createElement("div");
  footer.className = "exp-gauge-footer";

  if (level >= 100) {
    const maxSpan = document.createElement("span");
    maxSpan.className = "exp-gauge-max";
    maxSpan.textContent = "MAX LEVEL";
    header.appendChild(maxSpan);
    fill.style.width = "100%";
    footer.textContent = `累計EXP：${totalExp.toLocaleString()} EXP`;
  } else {
    const required = getRequiredExp(level);
    const rate = Math.min(100, Math.floor((exp / required) * 100));
    fill.style.width = `${rate}%`;
    const remaining = Math.max(0, required - exp);
    footer.textContent = `EXP ${exp} / ${required}（次のレベルまであと${remaining}EXP）`;
  }

  wrap.appendChild(header);
  wrap.appendChild(track);
  wrap.appendChild(footer);
  return wrap;
}

// 指定したコンテナ要素にEXPゲージを描画する（無ければ何もしない＝一部画面のみでもOK）
function renderExpGaugeInto(containerId, level, exp, totalExp) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";
  container.appendChild(buildExpGaugeElement(level ?? 1, exp ?? 0, totalExp ?? 0));
}

// ログイン中ユーザーのEXPゲージを、表示対象の全画面に反映する
function refreshAllExpGauges() {
  if (!currentUserRecord) return;
  const { level, exp, totalExp } = currentUserRecord;
  ["exp-gauge-start", "exp-gauge-quiz", "exp-gauge-result"].forEach((id) => {
    renderExpGaugeInto(id, level, exp, totalExp);
  });
}

// ---- 連続ログイン（学習ストリーク）表示 ----
function renderStreakBanner() {
  const el = document.getElementById("streak-days-banner");
  if (!el || !currentUserRecord) return;
  const days = currentUserRecord.streakDays || 0;
  if (days >= 2) {
    el.textContent = `🔥 ${days}日連続ログイン中！今日も任務を開始してストリークを継続しよう`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// ---- 称号（バッジ）表示 ----
function renderBadges(badges) {
  const card = document.getElementById("badges-card");
  const grid = document.getElementById("badges-grid");
  const titleText = document.getElementById("current-title-text");
  if (!card || !grid) return;
  grid.innerHTML = "";

  const unlocked = badges.filter((b) => b.unlocked);
  titleText.textContent = unlocked.length > 0
    ? `解放済み：${unlocked.length} / ${badges.length}`
    : `まだ称号がありません。任務を攻略して解放しよう`;

  badges.forEach((b) => {
    const item = document.createElement("div");
    item.className = "badge-item" + (b.unlocked ? " unlocked" : " locked");
    const icon = document.createElement("span");
    icon.className = "badge-item-icon";
    icon.textContent = b.unlocked ? "🎖️" : "🔒";
    const title = document.createElement("span");
    title.className = "badge-item-title";
    title.textContent = b.title;
    const desc = document.createElement("span");
    desc.className = "badge-item-desc";
    desc.textContent = b.description;
    item.appendChild(icon);
    item.appendChild(title);
    item.appendChild(desc);
    grid.appendChild(item);
  });

  card.hidden = badges.length === 0;
}

// onClosed：閉じるボタンが押された後（フェードアウト完了後）に呼ばれるコールバック
function showBadgeUnlockOverlay(badge, onClosed) {
  const overlay = document.getElementById("badge-unlock-overlay");
  if (!overlay) return;
  document.getElementById("badge-unlock-title").textContent = badge.title;
  document.getElementById("badge-unlock-desc").textContent = badge.description;

  overlay.hidden = false;
  void overlay.offsetWidth;
  overlay.classList.add("show");
  playLevelUpSound(false);
  launchConfetti(70);

  const closeBtn = document.getElementById("btn-badge-unlock-close");
  const close = () => {
    overlay.classList.remove("show");
    closeBtn.removeEventListener("click", close);
    setTimeout(() => {
      overlay.hidden = true;
      if (onClosed) onClosed();
    }, 300);
  };
  closeBtn.addEventListener("click", close);
}

// 複数の称号が同時に解放された場合、1つずつ順番に見せる
function showBadgeUnlockQueue(badges) {
  if (!badges || badges.length === 0) return;
  let i = 0;
  const showNext = () => {
    if (i >= badges.length) return;
    const badge = badges[i];
    i++;
    showBadgeUnlockOverlay(badge, showNext);
  };
  showNext();
}

// ---- デイリーミッション表示 ----
// 1件分のミッション行DOMを組み立てる（一覧全体用・達成済みのみの一覧用の両方で使う）
function buildMissionItemEl(m) {
  const item = document.createElement("div");
  item.className = "mission-item" + (m.completed ? " completed" : "");

  const main = document.createElement("div");
  main.className = "mission-item-main";

  const header = document.createElement("div");
  header.className = "mission-item-header";
  const title = document.createElement("span");
  title.className = "mission-item-title";
  title.textContent = m.title;
  const reward = document.createElement("span");
  reward.className = "mission-item-reward";
  reward.textContent = `+${m.reward_exp} EXP`;
  header.appendChild(title);
  header.appendChild(reward);

  const track = document.createElement("div");
  track.className = "mission-progress-track";
  const fill = document.createElement("div");
  fill.className = "mission-progress-fill";
  fill.style.width = `${Math.min(100, Math.round((m.progress / m.target_count) * 100))}%`;
  track.appendChild(fill);

  main.appendChild(header);
  main.appendChild(track);
  item.appendChild(main);

  if (m.claimed) {
    const doneLabel = document.createElement("span");
    doneLabel.className = "mission-claimed-label";
    doneLabel.textContent = "受取済";
    item.appendChild(doneLabel);
  } else if (m.completed) {
    const claimBtn = document.createElement("button");
    claimBtn.type = "button";
    claimBtn.className = "mission-claim-btn";
    claimBtn.textContent = "受け取る";
    claimBtn.dataset.missionKey = m.key;
    item.appendChild(claimBtn);
  } else {
    const countLabel = document.createElement("span");
    countLabel.className = "mission-item-count";
    countLabel.textContent = `${m.progress}/${m.target_count}`;
    item.appendChild(countLabel);
  }

  return item;
}

// 今日のミッションは、スマホでログイン直後すぐに任務選択・開始まで
// 進めるよう、デフォルトは1行サマリーのみの折りたたみ表示にしている
// （タップで展開）。加えて、達成済み（未受取含む）のミッションだけを
// 称号カードのすぐ上にも表示し、報酬の受け取り漏れに気づきやすくする。
function renderDailyMissions(missions) {
  const card = document.getElementById("daily-missions-card");
  const list = document.getElementById("daily-missions-list");
  const summaryText = document.getElementById("mission-summary-text");
  const achievedCard = document.getElementById("achieved-missions-card");
  const achievedList = document.getElementById("achieved-missions-list");
  if (!card || !list) return;
  list.innerHTML = "";

  const completedCount = missions.filter((m) => m.completed).length;
  summaryText.textContent = `今日のミッション（${completedCount} / ${missions.length}達成）`;

  missions.forEach((m) => {
    list.appendChild(buildMissionItemEl(m));
  });
  card.hidden = missions.length === 0;

  if (achievedCard && achievedList) {
    achievedList.innerHTML = "";
    const achieved = missions.filter((m) => m.completed);
    achieved.forEach((m) => {
      achievedList.appendChild(buildMissionItemEl(m));
    });
    achievedCard.hidden = achieved.length === 0;
  }
}

// ミッションカードの折りたたみ・展開トグル
function setupMissionsToggle() {
  const toggleBtn = document.getElementById("btn-missions-toggle");
  const card = document.getElementById("daily-missions-card");
  const list = document.getElementById("daily-missions-list");
  if (!toggleBtn || !card || !list) return;
  toggleBtn.addEventListener("click", () => {
    const expanded = card.classList.toggle("expanded");
    list.hidden = !expanded;
  });
}

// ミッション報酬受け取りのクリック処理（一覧全体用・達成済みのみの一覧用、
// どちらのリストで押されても同じロジックで処理する）
async function handleMissionClaimClick(e) {
  const btn = e.target.closest(".mission-claim-btn");
  if (!btn || !currentUserRecord) return;
  btn.disabled = true;
  try {
    const result = await claimDailyMission(currentUserRecord.id, btn.dataset.missionKey);
    currentUserRecord.level = result.new_level;
    currentUserRecord.exp = result.exp;
    currentUserRecord.totalExp = result.total_exp;
    refreshAllExpGauges();
    const missions = await fetchDailyMissions(currentUserRecord.id);
    renderDailyMissions(missions);
    if (result.new_level > result.old_level) {
      showLevelUpOverlay(
        result.old_level, result.new_level,
        getLevelTitle(result.old_level), getLevelTitle(result.new_level),
        getLevelTitle(result.old_level) !== getLevelTitle(result.new_level),
        result.reward_exp
      );
    }
  } catch (err) {
    console.error("ミッション報酬の受け取りに失敗しました:", err.message);
    btn.disabled = false;
  }
}

// ミッションカードのクリックはリストごとに1つだけイベント委譲で登録する
// （ミッション一覧はログイン・任務完了のたびに再描画されるため）
function setupDailyMissionsClickHandler() {
  const list = document.getElementById("daily-missions-list");
  const achievedList = document.getElementById("achieved-missions-list");
  if (list) list.addEventListener("click", handleMissionClaimClick);
  if (achievedList) achievedList.addEventListener("click", handleMissionClaimClick);
}


/* ================================================================
   [パート2] 画面制御・クイズ進行ロジック（アプリ本体）
   ================================================================ */

// カテゴリの表示順（データに存在するものだけが実際に表示される）
const CATEGORY_ORDER = [
  "基礎知識",
  "保証", "容量", "電池材料", "停電対策", "V2H", "太陽光連携",
  "営業トーク", "メーカー比較", "メリット/デメリット",
  "電気代削減", "初期費用", "EV/V2H", "保証・安心", "設置スペース", "営業トーク判断"
];

// 「不正解問題」「正解問題」はカテゴリ一覧の中に混ぜて選べるようにする特別な
// 擬似カテゴリ。実際のカテゴリタグではなく、現在のユーザーの不正解/正解済み
// リストへのID一致で絞り込む。
const WRONG_CATEGORY = "要再挑戦リスト";
const CORRECT_CATEGORY = "正解問題";

// アプリの状態（グローバル管理・現在のセッションに関するものだけ）
const state = {
  mode: null,        // "knowledge" | "practice" | "mix"
  category: "全エリア",
  level: "全レベル",  // "全レベル" | "初級" | "中級" | "上級"（出題の難易度フィルタ。EXPのユーザーレベルとは別物）
  countOption: null, // "5" | "10" | "20" | "all"
  sessionQuestions: [],
  currentIndex: 0,
  userAnswers: [],   // { question, chosenText, correct }（今回セッション分の一覧表示用）
  selectedChoice: null,
  isReviewSession: false,
  dataLoaded: false,

  // ---- EXP関連（このセッション内だけで完結し、結果画面でまとめてサーバーへ反映する） ----
  sessionExp: 0,             // 今回のセッションで積算した獲得EXP
  sessionCombo: 0,           // EXPボーナス判定用のセッション内連続正解数（連続正解バッジ用のcurrentStreakとは別管理）
  maxSessionCombo: 0,        // 今回のセッションで到達した最大コンボ数（任務結果画面「最大連撃数」用）
  comboBonusesGranted: new Set(), // このセッション内で既に付与済みのコンボ段階（3/5/10/15/20）
  tenQuestionBonusGranted: false  // 「10問連続プレイ」ボーナスを既に付与したか
};

// このセッション中に自己ベストの連続正解記録を更新したかどうか
// （結果画面で「自己ベスト更新」バナーを出すかどうかの判定に使う）
let newStreakRecordThisSession = false;

let knowledgeQuestions = [];
let practiceQuestions = [];


/* ================================================================
   [パート3] ユーザー管理（ユーザー名＋PIN・Supabase RPC経由）
   ----------------------------------------------------------------
   ・自己ベスト・連続正解数・不正解/正解済みリストは、Supabaseの
     users / answer_history テーブルに保存される（ユーザー名＋PINで
     識別。他人が同じ名前を使ってもPINが違えばログインできない）
   ・「現在の不正解/正解済みリスト」は、answer_historyの各問題ごとの
     最新の回答結果から毎回計算し直す（サーバー側のrpc_get_answer_status）。
     ローカルに保存する情報はなく、ユーザー名＋PINさえ分かれば
     どの端末・ブラウザからでも同じ記録にアクセスできる。
   ================================================================ */

// 次回のユーザー名入力を補完するためだけに使う（PINは保存しない）
const LAST_USERNAME_KEY = "batteryQuiz_lastUsername";

// 現在ログイン中のユーザーの成績データ（ユーザー未確定の間はnull）
// { id, userName, bestScore, bestRate, currentStreak, bestStreak,
//   totalAnswered, totalCorrect, wrongQuestionIds: [], correctQuestionIds: [] }
let currentUserRecord = null;

// localStorageの読み書きはブラウザ設定等で失敗することがあるため、
// 必ずtry/catchで包み、失敗してもアプリの動作は継続させる
function safeLocalStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}
function safeLocalStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    // 容量オーバー等で保存に失敗しても、アプリの動作自体は継続する
  }
}

function addToListUnique(list, id) {
  if (!list.includes(id)) list.push(id);
}
function removeFromList(list, id) {
  const idx = list.indexOf(id);
  if (idx !== -1) list.splice(idx, 1);
}

// ユーザー名＋PINでログインする（未登録の名前ならそのPINで新規登録される）。
// 失敗（PIN不一致など）時は例外を投げるので、呼び出し側でメッセージ表示する。
async function loginUser(username, pin) {
  const rows = await supabaseRpc("rpc_login", { p_username: username, p_pin: pin });
  const row = rows[0];

  const statusRows = await supabaseRpc("rpc_get_answer_status", { p_user_id: row.id });

  return {
    id: row.id,
    userName: row.username,
    bestScore: row.best_score,
    bestRate: row.best_rate,
    currentStreak: row.current_streak,
    bestStreak: row.best_streak,
    totalAnswered: row.total_answered,
    totalCorrect: row.total_correct,
    level: row.level,
    exp: row.exp,
    totalExp: row.total_exp,
    streakDays: row.streak_days,
    wrongQuestionIds: statusRows.filter((r) => !r.correct).map((r) => r.question_id),
    correctQuestionIds: statusRows.filter((r) => r.correct).map((r) => r.question_id)
  };
}

// 1問回答するたびに呼ぶ。通信の完了を待たずに画面が反応できるよう、
// 不正解/正解済みリストはこちら側でも即座に更新する（楽観的更新）。
// 連続正解数・累計はサーバー側の計算結果（RPCの戻り値）を正として上書きする。
// 各問題は常に「直近の回答結果」だけを反映するよう、2つのリストは排他的にする。
async function recordAnswerForUser(question, isCorrect) {
  if (!currentUserRecord) return;
  const record = currentUserRecord;

  if (isCorrect) {
    removeFromList(record.wrongQuestionIds, question.id);
    addToListUnique(record.correctQuestionIds, question.id);
  } else {
    addToListUnique(record.wrongQuestionIds, question.id);
    removeFromList(record.correctQuestionIds, question.id);
  }

  try {
    const rows = await supabaseRpc("rpc_record_answer", {
      p_user_id: record.id,
      p_question_id: question.id,
      p_correct: isCorrect,
      p_mode: question.mode,
      p_category: question.category,
      p_is_review: state.isReviewSession
    });
    const row = rows[0];
    record.currentStreak = row.current_streak;
    if (row.best_streak > record.bestStreak) {
      record.bestStreak = row.best_streak;
      newStreakRecordThisSession = true;
    }
    record.totalAnswered = row.total_answered;
    record.totalCorrect = row.total_correct;
  } catch (err) {
    // ネットワーク不調等で保存に失敗しても、その場のクイズ体験は止めない
    console.error("回答の記録に失敗しました:", err.message);
  }
}

// セッション終了時（結果画面表示時）に呼ぶ：自己ベストをサーバーに保存する。
// 通信を待たずに結果画面の演出を出したいので、呼び出し側では await せず
// 発火するだけにする（＝fire-and-forget。失敗してもこの関数内でログするのみ）。
async function recordSessionResultForUser(userId, correctCount, rate) {
  try {
    await supabaseRpc("rpc_record_session_result", {
      p_user_id: userId,
      p_score: correctCount,
      p_rate: rate
    });
  } catch (err) {
    console.error("自己ベストの保存に失敗しました:", err.message);
  }
}

// ランキング（全ユーザー横断）を取得する
async function fetchRanking() {
  return supabaseRpc("rpc_get_ranking", {});
}

// 攻略者ボードの種類ごとに異なるRPCを呼ぶ（総合以外は既存のソートロジックには一切触れない）
const RANKING_FETCHERS = {
  overall: () => supabaseRpc("rpc_get_ranking", {}),
  weekly: () => supabaseRpc("rpc_get_weekly_ranking", {}),
  combo: () => supabaseRpc("rpc_get_combo_ranking", {}),
  suppression: () => supabaseRpc("rpc_get_suppression_ranking", {}),
  missions: () => supabaseRpc("rpc_get_mission_count_ranking", {}),
  review: () => supabaseRpc("rpc_get_review_ranking", {})
};

// ---- 称号（バッジ） ----
async function fetchBadges(userId) {
  return supabaseRpc("rpc_get_badges", { p_user_id: userId });
}

// 現在の永続データだけを根拠にサーバー側で判定し、新たに解放された称号を返す
async function checkAndGrantBadges(userId) {
  try {
    return await supabaseRpc("rpc_check_badges", { p_user_id: userId });
  } catch (err) {
    console.error("称号判定に失敗しました:", err.message);
    return [];
  }
}

// ---- デイリーミッション ----
async function fetchDailyMissions(userId) {
  return supabaseRpc("rpc_get_daily_missions", { p_user_id: userId });
}

async function claimDailyMission(userId, missionKey) {
  const rows = await supabaseRpc("rpc_claim_daily_mission", { p_user_id: userId, p_mission_key: missionKey });
  return rows[0];
}


/* ================================================================
   [パート4] 演出・効果音（ゲーム的な楽しさのための仕掛け）
   ----------------------------------------------------------------
   ・正解/不正解を選択肢の色でその場でフィードバック
   ・連続正解（ストリーク）をトースト通知＋紙吹雪で盛り上げる
   ・Web Audio APIでその場で音を合成（音声ファイルは使わない）
   ・結果画面のスコアをカウントアップ演出
   ================================================================ */

const SOUND_PREF_KEY = "batteryQuiz_soundEnabled";

let soundEnabled = true;
let audioCtx = null;

// ---- 効果音（Web Audio APIでその場で音を生成する。外部音源ファイル不要） ----
function loadSoundPreference() {
  const saved = localStorage.getItem(SOUND_PREF_KEY);
  soundEnabled = saved === null ? true : saved === "true";
  updateSoundToggleUI();
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem(SOUND_PREF_KEY, String(soundEnabled));
  updateSoundToggleUI();
}

function updateSoundToggleUI() {
  const btn = document.getElementById("btn-sound-toggle");
  if (btn) btn.textContent = soundEnabled ? "🔊" : "🔇";
}

// AudioContextはユーザー操作（クリック）の後でないと開始できないブラウザが多いため、
// 実際に音を鳴らすタイミングで初めて生成・再開する
function ensureAudioContext() {
  if (!soundEnabled) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

// 指定した周波数・長さの音を1つ鳴らす（sine波などをオシレーターで合成）
function playTone(freq, startOffset, duration, waveType, volume) {
  const ctx = ensureAudioContext();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = waveType || "sine";
  osc.frequency.value = freq;

  const startTime = ctx.currentTime + startOffset;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(volume, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
}

function playCorrectSound() {
  playTone(660, 0, 0.12, "sine", 0.18);
  playTone(880, 0.09, 0.18, "sine", 0.18);
}

function playWrongSound() {
  playTone(220, 0, 0.22, "sawtooth", 0.12);
}

// 連続正解数が多いほど、鳴らす音符の数が増えて盛り上がる
function playStreakSound(streak) {
  const notes = [523.25, 659.25, 783.99, 987.77, 1174.66]; // ド・ミ・ソ・シ・レ
  const n = Math.min(streak, notes.length);
  for (let i = 0; i < n; i++) {
    playTone(notes[i], i * 0.09, 0.16, "triangle", 0.15);
  }
}

function playFanfare() {
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((freq, i) => playTone(freq, i * 0.12, 0.32, "triangle", 0.2));
}

// ---- 紙吹雪演出 ----
const CONFETTI_COLORS = ["#ff7a3d", "#1e6f5c", "#ffd166", "#4d96ff", "#ff5252", "#35b38a"];

function launchConfetti(count) {
  count = count || 40;
  const pieces = [];
  const frag = document.createDocumentFragment();

  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "confetti-piece";
    const duration = 1.6 + Math.random() * 1.2;
    const delay = Math.random() * 0.3;
    el.style.left = `${Math.random() * 100}vw`;
    el.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    el.style.setProperty("--rot", `${360 + Math.random() * 360}deg`);
    el.style.animation = `confetti-fall ${duration}s cubic-bezier(0.25,0.46,0.45,0.94) ${delay}s forwards`;
    if (Math.random() > 0.5) el.style.borderRadius = "50%";
    frag.appendChild(el);
    pieces.push(el);
  }

  document.body.appendChild(frag);
  setTimeout(() => pieces.forEach((p) => p.remove()), 3200);
}

// ---- 連続正解（ストリーク）のトースト通知 ----
let streakToastTimer = null;

function showStreakToast(streak) {
  const toast = document.getElementById("streak-toast");
  if (!toast) return;

  toast.textContent = `🔥 ${streak}コンボ！`;
  toast.hidden = false;
  void toast.offsetWidth; // 再アニメーションさせるための強制リフロー
  toast.classList.add("show");

  clearTimeout(streakToastTimer);
  streakToastTimer = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => { toast.hidden = true; }, 300);
  }, 1400);
}

// ---- レベルアップ演出（既存の紙吹雪より派手にする） ----
function playLevelUpSound(isTitleUpgrade) {
  const notes = isTitleUpgrade
    ? [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98] // ド・ミ・ソ・ド・ミ・ソ（1オクターブ上まで駆け上がる）
    : [659.25, 783.99, 987.77, 1318.51]; // ミ・ソ・シ・ミ
  notes.forEach((freq, i) => playTone(freq, i * 0.1, 0.35, "triangle", 0.22));
}

function showLevelUpOverlay(oldLevel, newLevel, oldTitle, newTitle, isTitleUpgrade, expGained) {
  const overlay = document.getElementById("levelup-overlay");
  if (!overlay) return;

  document.getElementById("levelup-heading").textContent = isTitleUpgrade
    ? "🏆 TITLE UPGRADE！🏆"
    : "⭐ LEVEL UP！⭐";
  document.getElementById("levelup-old").textContent = `Lv.${oldLevel} ${oldTitle}`;
  document.getElementById("levelup-new").textContent = `Lv.${newLevel} ${newTitle}`;
  document.getElementById("levelup-exp").textContent = `+${expGained} EXP 獲得`;
  document.getElementById("levelup-subtext").hidden = !isTitleUpgrade;

  overlay.hidden = false;
  void overlay.offsetWidth;
  overlay.classList.add("show");

  playLevelUpSound(isTitleUpgrade);
  launchConfetti(isTitleUpgrade ? 140 : 100);

  const closeBtn = document.getElementById("btn-levelup-close");
  const close = () => {
    overlay.classList.remove("show");
    setTimeout(() => { overlay.hidden = true; }, 300);
    closeBtn.removeEventListener("click", close);
  };
  closeBtn.addEventListener("click", close);
}

function updateStreakBadge() {
  const badge = document.getElementById("streak-badge");
  if (!badge) return;
  const streak = currentUserRecord ? currentUserRecord.currentStreak : 0;
  if (streak >= 2) {
    badge.textContent = `🔥 ${streak}コンボ`;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

// ---- 数値のカウントアップ演出（結果画面のスコア表示用） ----
function animateCountUp(el, endValue, formatFn, duration) {
  const startTime = performance.now();
  function tick(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out
    const current = Math.round(endValue * eased);
    el.textContent = formatFn(current);
    if (progress < 1) requestAnimationFrame(tick);
    else el.textContent = formatFn(endValue);
  }
  requestAnimationFrame(tick);
}

// スタート画面に「現在ログイン中のユーザー」の自己ベストだけを表示する
// （他のユーザーの記録は読み込まない・表示しない）
function renderBestRecordOnStart() {
  const el = document.getElementById("best-record-text");
  if (!el) return;
  if (!currentUserRecord) {
    el.textContent = "";
    return;
  }
  const r = currentUserRecord;
  if (r.bestRate === 0 && r.bestStreak === 0) {
    el.textContent = "";
    return;
  }
  const parts = [];
  if (r.bestRate > 0) parts.push(`自己ベスト正答率 ${r.bestRate}%`);
  if (r.bestStreak > 0) parts.push(`最大コンボ ${r.bestStreak}`);
  el.textContent = `🏆 ${r.userName}さんの自己ベスト：` + parts.join(" ／ ");
}

// スタート画面のストリーク・称号・デイリーミッションをまとめて再取得・再描画する
// （ログイン時、および任務完了後のスタート画面復帰時に呼ぶ）
async function refreshHomeExtras() {
  if (!currentUserRecord) return;
  renderStreakBanner();
  try {
    const [badges, missions] = await Promise.all([
      fetchBadges(currentUserRecord.id),
      fetchDailyMissions(currentUserRecord.id)
    ]);
    renderBadges(badges);
    renderDailyMissions(missions);
  } catch (err) {
    console.error("称号・ミッション情報の取得に失敗しました:", err.message);
  }
}

// 結果に応じた一言メッセージ
function getResultMessage(rate) {
  if (rate === 100) return "🎉 完全制圧！ミッションを完璧に突破した。";
  if (rate >= 80) return "✨ 任務完了。優秀な攻略だった。";
  if (rate >= 60) return "👍 任務完了。あと一歩でエキスパートクラス。";
  if (rate >= 40) return "💪 再挑戦推奨。解析ログで弱点を潰そう。";
  return "📚 適応中。まずは基礎エリアから立て直そう。";
}

// ---- 起動時の初期化 ----
async function initApp() {
  loadSoundPreference();
  document.getElementById("btn-sound-toggle").addEventListener("click", toggleSound);
  setupUserScreen();
  setupStartScreen();
  setupDictionary();
  setupDailyMissionsClickHandler();
  setupMissionsToggle();
  setupRankingTabs();
  showScreen("screen-user");
  loadGlossary(); // 用語集はクイズ体験をブロックしないよう並行して読み込む
  await loadAllData(); // ユーザー入力中にバックグラウンドで読み込みを進めておく
}

// ---- ユーザー入力画面 ----
function setupUserScreen() {
  const nameInput = document.getElementById("username-input");
  const pinInput = document.getElementById("pin-input");

  // 前回使ったユーザー名だけ補完しておく（PINはセキュリティ上保存せず毎回入力）
  const lastUsername = safeLocalStorageGet(LAST_USERNAME_KEY);
  if (lastUsername) nameInput.value = lastUsername;

  document.getElementById("btn-user-start").addEventListener("click", () => {
    startAsUser(nameInput.value, pinInput.value);
  });
  pinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") startAsUser(nameInput.value, pinInput.value);
  });

  document.getElementById("btn-switch-user").addEventListener("click", () => {
    pinInput.value = "";
    document.getElementById("username-warning").textContent = "";
    showScreen("screen-user");
  });
}

// 入力されたユーザー名＋PINでログインし（未登録ならそのPINで新規登録）、
// そのプレイヤー専用の成績データをSupabaseから読み込む
async function startAsUser(rawName, rawPin) {
  const trimmedName = String(rawName || "").trim();
  const trimmedPin = String(rawPin || "").trim();
  const warningEl = document.getElementById("username-warning");

  if (!trimmedName) {
    warningEl.textContent = "プレイヤーIDを入力してください。";
    return;
  }
  if (!/^\d{4,}$/.test(trimmedPin)) {
    warningEl.textContent = "認証キーは4桁以上の数字で入力してください。";
    return;
  }

  const startBtn = document.getElementById("btn-user-start");
  const connectingOverlay = document.getElementById("dive-connecting-overlay");
  const connectingText = document.getElementById("dive-connecting-text");
  const syncPlayer = document.getElementById("dive-sync-player");
  warningEl.textContent = "";
  startBtn.disabled = true;

  syncPlayer.textContent = trimmedName;
  connectingText.textContent = "仮想訓練空間へ接続中...";
  connectingOverlay.hidden = false;
  void connectingOverlay.offsetWidth;
  connectingOverlay.classList.add("show", "syncing");

  // 意識が仮想空間へ同期していく中間演出。最低でもこの時間は見せるが、
  // オーバーレイをタップすればいつでもスキップできる
  const syncDurationOrSkip = waitOrSkip(connectingOverlay, 2200);

  try {
    const [userRecord] = await Promise.all([
      loginUser(trimmedName, trimmedPin),
      syncDurationOrSkip
    ]);
    currentUserRecord = userRecord;
    safeLocalStorageSet(LAST_USERNAME_KEY, trimmedName);

    document.getElementById("current-user-label").textContent = `プレイヤー：${currentUserRecord.userName}`;
    renderBestRecordOnStart();
    refreshAllExpGauges();
    refreshHomeExtras();
    updateDataStatusDetail();
    if (state.mode) populateCategorySelect(); // 「要再挑戦リスト」「正解問題」カテゴリの有無を再評価する
    validateStartButton();

    // 中間演出（リング・ノイズ・スキャンライン）を終え、「接続完了」を
    // 一瞬見せてから任務端末（スタート画面）へ遷移する
    connectingOverlay.classList.remove("syncing");
    connectingText.textContent = "接続完了。任務端末を起動します。";
    await waitOrSkip(connectingOverlay, 600);
    showScreen("screen-start");
    connectingOverlay.classList.remove("show");
    setTimeout(() => { connectingOverlay.hidden = true; }, 300);
  } catch (err) {
    connectingOverlay.classList.remove("show", "syncing");
    setTimeout(() => { connectingOverlay.hidden = true; }, 300);
    warningEl.textContent =
      err.message === "ユーザー名またはPINが正しくありません"
        ? "認証エラー：プレイヤーIDまたは認証キーを確認してください。"
        : (err.message || "認証エラー：接続に失敗しました。もう一度お試しください。");
  } finally {
    startBtn.disabled = false;
  }
}

// 指定したミリ秒が経過するか、要素がタップ（クリック）されるまで待つ。
// ダイブ演出の「タップでスキップ」を実現するための小さなヘルパー
function waitOrSkip(el, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener("click", finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    el.addEventListener("click", finish);
  });
}

// Supabaseの questions テーブルから、事前生成済みの問題を読み込む。
// スプレッドシート自体はもう直接読みに行かない
// （scripts/sync-questions.js が定期的にSupabaseへ反映する運用）。
async function loadAllData() {
  const statusText = document.getElementById("data-status-text");
  const reloadBtn = document.getElementById("btn-reload-data");

  statusText.textContent = "任務データを同期中…";
  statusText.className = "status-loading";
  reloadBtn.hidden = true;
  state.dataLoaded = false;
  validateStartButton();
  updateDataStatusDetail();

  try {
    const res = await supabaseFetch("questions?select=*");
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const rows = await res.json();

    if (rows.length === 0) {
      statusText.textContent =
        "任務データがまだありません。scripts/sync-questions.js を実行してSupabaseに任務を登録してください。";
      statusText.className = "status-warning";
      reloadBtn.hidden = false;
      return;
    }

    knowledgeQuestions = rows.filter((r) => r.mode === "knowledge").map(questionFromRow);
    practiceQuestions = rows.filter((r) => r.mode === "practice").map(questionFromRow);

    statusText.textContent = "任務データ同期完了";
    statusText.className = "status-ok";
    reloadBtn.hidden = false;
    state.dataLoaded = true;
    validateStartButton();
    updateDataStatusDetail();

    // モード選択済みならカテゴリ一覧を更新する
    if (state.mode) populateCategorySelect();
  } catch (err) {
    statusText.textContent =
      `読み込みに失敗しました：${err.message}。ネット接続を確認して「再読み込み」を押してください。`;
    statusText.className = "status-error";
    reloadBtn.hidden = false;
    updateDataStatusDetail();
  }
}

// questionsテーブルの行（snake_case）→ アプリ内部の問題オブジェクト（camelCase）に変換
function questionFromRow(row) {
  return {
    id: row.id,
    mode: row.mode,
    category: row.category,
    difficulty: row.difficulty,
    question: row.question,
    customerScenario: row.customer_scenario || "",
    choices: row.choices,
    answer: row.answer,
    explanation: row.explanation,
    choiceExplanations: row.choice_explanations || {},
    sourceManufacturer: row.source_manufacturer,
    sourceProduct: row.source_product
  };
}

// データ読み込み状況の詳細（問題数の内訳・不正解リスト数）を
// クイズ開始ボタン下の小さいカードに表示する。目立たせすぎない位置づけ。
function updateDataStatusDetail() {
  const list = document.getElementById("data-status-detail");
  if (!list) return;
  list.innerHTML = "";

  if (!state.dataLoaded) {
    list.hidden = true;
    return;
  }

  const items = [
    `任務数：${knowledgeQuestions.length + practiceQuestions.length}件`,
    `基礎任務：${knowledgeQuestions.length}件`,
    `判断任務：${practiceQuestions.length}件`,
    `要再挑戦リスト：${currentUserRecord ? currentUserRecord.wrongQuestionIds.length : 0}件`
  ];
  items.forEach((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    list.appendChild(li);
  });
  list.hidden = false;
}

function setupStartScreen() {
  const modeButtons = document.querySelectorAll("#mode-select .option-btn");
  modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      modeButtons.forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      state.mode = btn.dataset.mode;
      populateCategorySelect();
      validateStartButton();
    });
  });

  const countButtons = document.querySelectorAll("#count-select .option-btn");
  countButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      countButtons.forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      state.countOption = btn.dataset.count;
      validateStartButton();
    });
  });

  const levelButtons = document.querySelectorAll("#level-select .option-btn");
  levelButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      levelButtons.forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      state.level = btn.dataset.level;
    });
  });

  document.getElementById("category-select").addEventListener("change", (e) => {
    state.category = e.target.value;
  });

  document.getElementById("btn-start").addEventListener("click", beginQuizSession);
  document.getElementById("btn-reload-data").addEventListener("click", loadAllData);
  document.getElementById("btn-answer").addEventListener("click", submitAnswer);
  document.getElementById("btn-quit-early").addEventListener("click", quitQuizEarly);
  document.getElementById("btn-next").addEventListener("click", goToNextQuestion);
  document.getElementById("btn-restart").addEventListener("click", resetToStart);
  document.getElementById("btn-review-wrong").addEventListener("click", startReviewSession);

  document.getElementById("btn-show-ranking").addEventListener("click", () => {
    showScreen("screen-ranking");
    renderRankingScreen();
  });
  document.getElementById("btn-ranking-back").addEventListener("click", () => {
    showScreen("screen-start");
  });
}

// 現在選択中の攻略者ボードの種類（タブ）
let currentRankingType = "overall";

const RANKING_SUBCOPY = {
  overall: "制圧率が高い順に表示しています（上位100名）",
  weekly: "直近7日間の正解数が多い順に表示しています（上位100名）",
  combo: "最大コンボ数が多い順に表示しています（上位100名）",
  suppression: "制圧率が高い順に表示しています（上位100名）",
  missions: "累計解答数が多い順に表示しています（上位100名）",
  review: "要再挑戦リストの復習正解数が多い順に表示しています（上位100名）"
};

function setupRankingTabs() {
  const tabButtons = document.querySelectorAll("#ranking-tabs .ranking-tab-btn");
  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabButtons.forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      currentRankingType = btn.dataset.ranking;
      document.getElementById("ranking-sub").textContent = RANKING_SUBCOPY[currentRankingType] || "";
      renderRankingScreen();
    });
  });
}

// 攻略者ボードのタブごとに、表示する見出し行・詳細行の中身を組み立てる
function buildRankingStatsLines(type, row) {
  const levelLine = `Lv.${row.level ?? 1} ${getLevelTitle(row.level ?? 1)} ／ 累計EXP ${(row.total_exp ?? 0).toLocaleString()}`;
  switch (type) {
    case "weekly":
      return {
        headline: `今週の正解数 ${row.weekly_correct}問`,
        detail: [`今週の解答数 ${row.weekly_answered}問`, levelLine]
      };
    case "combo":
      return {
        headline: `最大コンボ ${row.best_streak}`,
        detail: [levelLine]
      };
    case "suppression":
      return {
        headline: `制圧率 ${row.best_rate}%`,
        detail: [levelLine]
      };
    case "missions":
      return {
        headline: `累計解答数 ${row.total_answered}問`,
        detail: [levelLine]
      };
    case "review":
      return {
        headline: `復習正解数 ${row.review_correct_count}問`,
        detail: [levelLine]
      };
    default:
      return {
        headline: `正答率 ${row.best_rate}%`,
        detail: [
          levelLine,
          `正答数 ${row.best_score}問 ／ コンボ ${row.current_streak}（最高${row.best_streak}） ／ 累計 ${row.total_answered}問`
        ]
      };
  }
}

// ランキング画面の描画（全ユーザー横断。ユーザー名以外の個人情報は表示しない）
async function renderRankingScreen() {
  const listEl = document.getElementById("ranking-list");
  const emptyEl = document.getElementById("ranking-empty-text");
  const errorEl = document.getElementById("ranking-error-text");

  listEl.innerHTML = "";
  emptyEl.hidden = true;
  errorEl.hidden = true;

  try {
    const fetcher = RANKING_FETCHERS[currentRankingType] || RANKING_FETCHERS.overall;
    const rows = await fetcher();

    if (rows.length === 0) {
      emptyEl.hidden = false;
      return;
    }

    rows.forEach((row, idx) => {
      const item = document.createElement("div");
      item.className = "ranking-row" + (idx < 3 ? " is-top3" : "");

      const rank = document.createElement("span");
      rank.className = "ranking-rank";
      rank.textContent = `${idx + 1}`;

      const name = document.createElement("span");
      name.className = "ranking-name";
      name.textContent = row.username;

      const { headline, detail } = buildRankingStatsLines(currentRankingType, row);
      const stats = document.createElement("span");
      stats.className = "ranking-stats";
      const bEl = document.createElement("b");
      bEl.textContent = headline;
      stats.appendChild(bEl);
      detail.forEach((line) => {
        stats.appendChild(document.createElement("br"));
        stats.appendChild(document.createTextNode(line));
      });

      item.appendChild(rank);
      item.appendChild(name);
      item.appendChild(stats);
      listEl.appendChild(item);
    });
  } catch (err) {
    errorEl.textContent = `攻略者ボードの取得に失敗しました：${err.message}`;
    errorEl.hidden = false;
  }
}

// カテゴリ一覧は「実際に生成された問題」から動的に作る。
// 将来スプレッドシートに新ジャンルのシートを追加しても、
// 問題さえ生成されればカテゴリが自動的に選択肢に現れます。
// 「不正解問題」「正解問題」は、現在のユーザーの不正解/正解済みリストに
// 該当モードの問題が1問でもある場合だけ選択肢に追加する（無ければ出さない）。
function populateCategorySelect() {
  const select = document.getElementById("category-select");
  select.innerHTML = "";

  let pool;
  if (state.mode === "knowledge") pool = knowledgeQuestions;
  else if (state.mode === "practice") pool = practiceQuestions;
  else pool = knowledgeQuestions.concat(practiceQuestions);

  const present = new Set(pool.map((q) => q.category));
  const ordered = CATEGORY_ORDER.filter((c) => present.has(c));
  // 表示順リストにないカテゴリ（将来の新ジャンル）も末尾に追加する
  present.forEach((c) => { if (!ordered.includes(c)) ordered.push(c); });

  const options = ["全エリア"];

  const wrongIds = currentUserRecord ? currentUserRecord.wrongQuestionIds : [];
  const correctIds = currentUserRecord ? currentUserRecord.correctQuestionIds : [];
  const wrongCountInPool = pool.filter((q) => wrongIds.includes(q.id)).length;
  const correctCountInPool = pool.filter((q) => correctIds.includes(q.id)).length;
  if (wrongCountInPool > 0) options.push(WRONG_CATEGORY);
  if (correctCountInPool > 0) options.push(CORRECT_CATEGORY);

  options.push(...ordered);

  options.forEach((cat) => {
    const opt = document.createElement("option");
    opt.value = cat;
    if (cat === WRONG_CATEGORY) opt.textContent = `要再挑戦リスト（${wrongCountInPool}問）`;
    else if (cat === CORRECT_CATEGORY) opt.textContent = `正解問題（${correctCountInPool}問）`;
    else opt.textContent = cat;
    select.appendChild(opt);
  });
  state.category = "全エリア";
}

function validateStartButton() {
  const btn = document.getElementById("btn-start");
  btn.disabled = !(state.mode && state.countOption && state.dataLoaded && currentUserRecord);
}

// ---- 出題プールを組み立ててセッションを開始する ----
function beginQuizSession() {
  const pool = buildFilteredPool(state.mode, state.category, state.level);

  if (pool.length === 0) {
    document.getElementById("start-warning").textContent =
      "選択した条件に合う任務がありません。エリアやレベルを変更してください。";
    return;
  }
  document.getElementById("start-warning").textContent = "";

  const n = state.countOption === "all" ? pool.length : Math.min(Number(state.countOption), pool.length);
  state.sessionQuestions = pickSessionQuestions(pool, n, state.mode);
  state.currentIndex = 0;
  state.userAnswers = [];
  state.isReviewSession = state.category === WRONG_CATEGORY || state.category === CORRECT_CATEGORY;
  newStreakRecordThisSession = false;
  resetSessionExpTracking();

  showScreen("screen-quiz");
  renderQuestion();
}

// このセッションのEXP積算・コンボボーナス・10問ボーナスの付与状況をリセットする
// （通常のクイズ開始・不正解/正解問題の復習開始のどちらからも呼ぶ）
function resetSessionExpTracking() {
  state.sessionExp = 0;
  state.sessionCombo = 0;
  state.maxSessionCombo = 0;
  state.comboBonusesGranted = new Set();
  state.tenQuestionBonusGranted = false;
}

function buildFilteredPool(mode, category, level) {
  let pool;
  if (mode === "knowledge") pool = knowledgeQuestions;
  else if (mode === "practice") pool = practiceQuestions;
  else pool = knowledgeQuestions.concat(practiceQuestions);

  if (category === WRONG_CATEGORY) {
    const wrongIds = currentUserRecord ? currentUserRecord.wrongQuestionIds : [];
    pool = pool.filter((q) => wrongIds.includes(q.id));
  } else if (category === CORRECT_CATEGORY) {
    const correctIds = currentUserRecord ? currentUserRecord.correctQuestionIds : [];
    pool = pool.filter((q) => correctIds.includes(q.id));
  } else if (category && category !== "全エリア") {
    pool = pool.filter((q) => q.category === category);
  }

  if (level && level !== "全レベル") {
    pool = pool.filter((q) => q.difficulty === level);
  }

  return pool;
}

// ---- 途中退出：それまでに回答した分だけで結果画面を表示する ----
function quitQuizEarly() {
  if (state.userAnswers.length === 0) {
    alert("まだ1問も回答していません。1問以上回答してから終了してください。");
    return;
  }
  const ok = confirm(`ここまで${state.userAnswers.length}問回答済みです。ここで終了して結果を見ますか？`);
  if (!ok) return;

  showScreen("screen-result");
  renderResultScreen();
}

// ミックスモードでは知識問題・実践提案問題が偏りすぎないように抽出する
function pickSessionQuestions(pool, n, mode) {
  let selected;

  if (mode === "mix") {
    const kPool = shuffleArray(pool.filter((q) => q.mode === "knowledge"));
    const pPool = shuffleArray(pool.filter((q) => q.mode === "practice"));
    const halfN = Math.ceil(n / 2);
    let picked = kPool.slice(0, halfN).concat(pPool.slice(0, n - halfN));
    if (picked.length < n) {
      const remaining = shuffleArray(kPool.slice(halfN).concat(pPool.slice(n - halfN)));
      picked = picked.concat(remaining.slice(0, n - picked.length));
    }
    selected = shuffleArray(picked).slice(0, n);
  } else {
    selected = shuffleArray(pool).slice(0, n);
  }

  return reduceConsecutiveMakerRepeats(selected);
}

// 同じメーカーが3問以上連続しないよう、簡易的に並び替える
function reduceConsecutiveMakerRepeats(list) {
  const arr = list.slice();
  for (let i = 2; i < arr.length; i++) {
    const m0 = arr[i - 2].sourceManufacturer;
    const m1 = arr[i - 1].sourceManufacturer;
    const m2 = arr[i].sourceManufacturer;
    if (m0 && m0 === m1 && m1 === m2) {
      for (let j = i + 1; j < arr.length; j++) {
        if (arr[j].sourceManufacturer !== m2) {
          [arr[i], arr[j]] = [arr[j], arr[i]];
          break;
        }
      }
    }
  }
  return arr;
}

// ---- クイズ画面の描画 ----
function renderQuestion() {
  const q = state.sessionQuestions[state.currentIndex];
  state.selectedChoice = null;

  document.getElementById("quiz-progress").textContent =
    `問題 ${state.currentIndex + 1} / ${state.sessionQuestions.length}`;
  document.getElementById("quiz-mode-badge").textContent =
    q.mode === "knowledge" ? "基礎任務" : "判断任務";
  document.getElementById("quiz-category-badge").textContent = q.category;
  document.getElementById("quiz-difficulty-badge").textContent = q.difficulty;
  updateStreakBadge();
  if (currentUserRecord) {
    renderExpGaugeInto("exp-gauge-quiz", currentUserRecord.level, currentUserRecord.exp, currentUserRecord.totalExp);
  }

  const progressPct = Math.round((state.currentIndex / state.sessionQuestions.length) * 100);
  document.getElementById("quiz-progress-bar").style.width = `${progressPct}%`;

  renderTextWithGlossary(document.getElementById("question-text"), q.question);

  // 実践提案モードの場合はお客様状況カードを表示する
  const customerCard = document.getElementById("customer-card");
  if (q.mode === "practice" && q.customerScenario && typeof q.customerScenario === "object") {
    customerCard.hidden = false;
    renderCustomerCard(q.customerScenario, "customer-card-list");
  } else {
    customerCard.hidden = true;
  }

  renderChoices(q.choices);
  document.getElementById("btn-answer").disabled = true;
}

// お客様状況カード：customerScenarioのキーと値をそのまま項目として表示する。
// クイズ画面・解説画面の両方から使うため、表示先のリストIDを引数で受け取る。
function renderCustomerCard(scenario, listId) {
  const list = document.getElementById(listId);
  list.innerHTML = "";

  Object.entries(scenario).forEach(([label, value]) => {
    if (!value) return;
    const li = document.createElement("li");
    const b = document.createElement("b");
    b.textContent = `${label}：`;
    li.appendChild(b);
    const valueSpan = document.createElement("span");
    renderTextWithGlossary(valueSpan, value);
    li.appendChild(valueSpan);
    list.appendChild(li);
  });
}

function renderChoices(choices) {
  const container = document.getElementById("choices-list");
  container.innerHTML = "";
  const letters = ["A", "B", "C", "D"];

  choices.forEach((choiceText, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice-btn";
    btn.dataset.choiceText = choiceText; // 回答確定時に正誤判定・色分けするために保持

    const letterSpan = document.createElement("span");
    letterSpan.className = "choice-letter";
    letterSpan.textContent = letters[idx] || "?";

    const textSpan = document.createElement("span");
    renderTextWithGlossary(textSpan, choiceText);

    btn.appendChild(letterSpan);
    btn.appendChild(textSpan);

    btn.addEventListener("click", () => {
      container.querySelectorAll(".choice-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      state.selectedChoice = choiceText;
      document.getElementById("btn-answer").disabled = false;
    });

    container.appendChild(btn);
  });
}

// 選択肢ボタンに正誤アイコンを追加する（✓/✗）
function addResultIcon(btn, icon) {
  const span = document.createElement("span");
  span.className = "result-icon";
  span.textContent = icon;
  btn.appendChild(span);
}

// ---- 回答を確定して解説画面へ ----
// 選択肢がその場で正誤の色に光ってから解説画面に切り替わるよう、
// 少しだけ間（0.7秒）を置く。この「即時フィードバック」がゲームらしい
// 気持ちよさ（ドーパミン）を生む一番のポイントになる。
function submitAnswer() {
  const q = state.sessionQuestions[state.currentIndex];
  const chosenText = state.selectedChoice;
  const isCorrect = chosenText === q.answer;

  document.getElementById("btn-answer").disabled = true;

  const buttons = document.querySelectorAll("#choices-list .choice-btn");
  buttons.forEach((btn) => {
    btn.disabled = true;
    const label = btn.dataset.choiceText;
    if (label === q.answer) {
      btn.classList.add("correct-flash");
      addResultIcon(btn, "✓");
    } else if (label === chosenText) {
      btn.classList.add("incorrect-flash");
      addResultIcon(btn, "✗");
    } else {
      btn.classList.add("dim-choice");
    }
  });

  // 連続正解数はサーバーへの通信を待たずにその場で楽観的に更新し、
  // 音・トースト・紙吹雪の演出がすぐに出るようにする。
  // 実際の保存（不正解/正解済みリスト・サーバー側の集計）は非同期で進める
  // （recordAnswerForUser内でPromiseの失敗もキャッチ済みなのでawait不要）。
  if (currentUserRecord) {
    currentUserRecord.currentStreak = isCorrect ? currentUserRecord.currentStreak + 1 : 0;
  }
  recordAnswerForUser(q, isCorrect);
  updateStreakBadge();

  const streak = currentUserRecord ? currentUserRecord.currentStreak : 0;
  if (isCorrect) {
    if (streak >= 2) {
      // 連続正解中は、単発の正解音より盛り上がる上昇アルペジオを鳴らす
      playStreakSound(streak);
      showStreakToast(streak);
    } else {
      playCorrectSound();
    }
    if (streak >= 3 && streak % 3 === 0) {
      launchConfetti(24);
    }
  } else {
    playWrongSound();
  }

  state.userAnswers.push({ question: q, chosenText, correct: isCorrect });

  accrueSessionExp(isCorrect);

  setTimeout(() => {
    renderExplainScreen(q, chosenText, isCorrect);
    showScreen("screen-explain");
  }, 700);
}

// このセッション内で積算するだけのEXP計算（サーバーへの反映は結果画面でまとめて行う）。
// 正解/不正解の基本EXP・解説を読む分・コンボボーナス・10問連続プレイボーナスをここで加算する。
function accrueSessionExp(isCorrect) {
  let gained = 0;

  // 基本EXP：正解（復習問題なら+15、通常は+10）／不正解でも「学習した」として+3
  gained += isCorrect ? (state.isReviewSession ? 15 : 10) : 3;
  // 解説画面は回答後に必ず表示されるため、この時点で「解説まで読んだ」分を加算する
  gained += 5;

  if (isCorrect) {
    state.sessionCombo++;
    if (state.sessionCombo > state.maxSessionCombo) state.maxSessionCombo = state.sessionCombo;
    const bonus = COMBO_BONUS_EXP[state.sessionCombo];
    // コンボボーナスは同じセッション内で同じ段階に達しても1回だけ付与する
    if (bonus && !state.comboBonusesGranted.has(state.sessionCombo)) {
      gained += bonus;
      state.comboBonusesGranted.add(state.sessionCombo);
    }
  } else {
    state.sessionCombo = 0;
  }

  state.sessionExp += gained;

  // 10問連続プレイボーナス（セッション内で1回だけ）
  if (state.userAnswers.length === 10 && !state.tenQuestionBonusGranted) {
    state.sessionExp += 20;
    state.tenQuestionBonusGranted = true;
  }
}

function renderExplainScreen(q, chosenText, isCorrect) {
  const banner = document.getElementById("result-banner");
  banner.textContent = isCorrect ? "正解！" : "不正解";
  banner.className = "result-banner " + (isCorrect ? "correct" : "incorrect");

  // クイズ画面から離れても分かるよう、問題文（＋実践提案モードならお客様状況）を再掲する
  renderTextWithGlossary(document.getElementById("explain-question-text"), q.question);
  const explainCustomerCard = document.getElementById("explain-customer-card");
  if (q.mode === "practice" && q.customerScenario && typeof q.customerScenario === "object") {
    explainCustomerCard.hidden = false;
    renderCustomerCard(q.customerScenario, "explain-customer-card-list");
  } else {
    explainCustomerCard.hidden = true;
  }

  document.getElementById("explain-user-answer").textContent = chosenText;
  document.getElementById("explain-correct-answer").textContent = q.answer;
  renderTextWithGlossary(document.getElementById("explain-text"), q.explanation);

  renderChoiceBreakdown(q, chosenText);
}

// 選択肢ごとの比較（正解/不正解・理由・営業判断のポイント）を描画する。
// クイズ画面で表示したのと同じ順番（q.choices）・同じ文字（A/B/C/D）を使う。
function renderChoiceBreakdown(q, chosenText) {
  const container = document.getElementById("choice-breakdown-list");
  container.innerHTML = "";
  const letters = ["A", "B", "C", "D"];

  q.choices.forEach((choiceText, idx) => {
    const info = (q.choiceExplanations && q.choiceExplanations[choiceText]) || null;
    const isCorrectChoice = choiceText === q.answer;
    const isUserChoice = choiceText === chosenText;

    const item = document.createElement("div");
    item.className =
      "choice-breakdown-item " +
      (isCorrectChoice ? "is-correct" : "is-incorrect") +
      (isUserChoice ? " is-user-choice" : "");

    const header = document.createElement("div");
    header.className = "choice-breakdown-header";

    const letterSpan = document.createElement("span");
    letterSpan.className = "choice-breakdown-letter";
    letterSpan.textContent = letters[idx] || "?";

    const textSpan = document.createElement("span");
    textSpan.className = "choice-breakdown-text";
    renderTextWithGlossary(textSpan, choiceText);

    const badgeSpan = document.createElement("span");
    badgeSpan.className = "choice-breakdown-badge " + (isCorrectChoice ? "badge-correct" : "badge-incorrect");
    badgeSpan.textContent = (isCorrectChoice ? "正解" : "不正解") + (isUserChoice ? " / あなたの回答" : "");

    header.appendChild(letterSpan);
    header.appendChild(textSpan);
    header.appendChild(badgeSpan);
    item.appendChild(header);

    const reasonP = document.createElement("p");
    reasonP.className = "choice-breakdown-reason";
    reasonP.appendChild(document.createTextNode("理由："));
    appendTextWithGlossary(reasonP, info && info.reason ? info.reason : "情報がありません。");
    item.appendChild(reasonP);

    if (info && info.salesPoint) {
      const spP = document.createElement("p");
      spP.className = "choice-breakdown-salespoint";
      spP.appendChild(document.createTextNode("営業判断のポイント："));
      appendTextWithGlossary(spP, info.salesPoint);
      item.appendChild(spP);
    }

    container.appendChild(item);
  });
}

// ---- 次の問題へ進む／終了して結果画面へ ----
function goToNextQuestion() {
  state.currentIndex++;
  if (state.currentIndex >= state.sessionQuestions.length) {
    showScreen("screen-result");
    renderResultScreen();
  } else {
    showScreen("screen-quiz");
    renderQuestion();
  }
}

// ---- 任務結果画面の描画（表示するのは現在ログイン中のプレイヤーの成績のみ） ----
async function renderResultScreen() {
  const total = state.userAnswers.length;
  const correctCount = state.userAnswers.filter((a) => a.correct).length;
  const rate = total > 0 ? Math.round((correctCount / total) * 100) : 0;
  const damageCount = total - correctCount;
  // 任務達成率：予定していた問題数のうち実際に回答できた割合（途中中断すると100%未満になる）
  const plannedTotal = state.sessionQuestions.length;
  const completionRate = plannedTotal > 0 ? Math.round((total / plannedTotal) * 100) : 0;

  // 各種スコアは0からカウントアップさせて演出する
  const scoreEl = document.getElementById("result-score");
  const rateEl = document.getElementById("result-rate");
  const completionRateEl = document.getElementById("result-completion-rate");
  const damageCountEl = document.getElementById("result-damage-count");
  const maxComboEl = document.getElementById("result-max-combo");
  animateCountUp(scoreEl, correctCount, (v) => `${v} / ${total}`, 700);
  animateCountUp(rateEl, rate, (v) => `${v}%`, 700);
  animateCountUp(completionRateEl, completionRate, (v) => `${v}%`, 700);
  animateCountUp(damageCountEl, damageCount, (v) => `${v}`, 700);
  animateCountUp(maxComboEl, state.maxSessionCombo, (v) => `${v}`, 700);

  document.getElementById("result-message").textContent = getResultMessage(rate);

  const knowledgeAnswers = state.userAnswers.filter((a) => a.question.mode === "knowledge");
  const practiceAnswers = state.userAnswers.filter((a) => a.question.mode === "practice");
  document.getElementById("result-knowledge-rate").textContent = formatRate(knowledgeAnswers);
  document.getElementById("result-practice-rate").textContent = formatRate(practiceAnswers);

  // 自己ベスト更新チェックはローカルで即座に行い（通信を待たず演出を出す）、
  // サーバーへの保存は非同期で進める（fire-and-forget）
  let isNewRecord = newStreakRecordThisSession;
  if (currentUserRecord) {
    if (correctCount > currentUserRecord.bestScore) {
      currentUserRecord.bestScore = correctCount;
      isNewRecord = true;
    }
    if (rate > currentUserRecord.bestRate) {
      currentUserRecord.bestRate = rate;
      isNewRecord = true;
    }
    // 称号判定がサーバー側の最新値（best_rate等）を参照するため、ここはawaitする
    await recordSessionResultForUser(currentUserRecord.id, correctCount, rate);
  }
  document.getElementById("new-record-banner").hidden = !isNewRecord;

  // 経験値（EXP）はセッション中クライアント側で積算しておき、結果画面表示時に
  // まとめてサーバーへ反映する（通信回数を抑えるため。反映はここで1回のみawaitする）
  document.getElementById("result-exp-gained").textContent = `+${state.sessionExp} EXP 獲得！`;
  if (currentUserRecord) {
    const beforeLevel = currentUserRecord.level;
    const beforeTitle = getLevelTitle(beforeLevel);
    renderExpGaugeInto("exp-gauge-result", currentUserRecord.level, currentUserRecord.exp, currentUserRecord.totalExp);

    if (state.sessionExp > 0) {
      try {
        const [expResult] = await supabaseRpc("rpc_apply_exp", {
          p_user_id: currentUserRecord.id,
          p_gained_exp: state.sessionExp
        });
        currentUserRecord.level = expResult.new_level;
        currentUserRecord.exp = expResult.exp;
        currentUserRecord.totalExp = expResult.total_exp;

        // ゲージのアニメーションを見せるため、少し間を置いてから新しい値で再描画する
        setTimeout(() => {
          renderExpGaugeInto("exp-gauge-result", currentUserRecord.level, currentUserRecord.exp, currentUserRecord.totalExp);
        }, 100);
        refreshAllExpGauges();

        if (expResult.new_level > beforeLevel) {
          const afterTitle = getLevelTitle(expResult.new_level);
          const titleChanged = afterTitle !== beforeTitle;
          setTimeout(() => {
            showLevelUpOverlay(beforeLevel, expResult.new_level, beforeTitle, afterTitle, titleChanged, state.sessionExp);
          }, 900);
        }
      } catch (err) {
        console.error("EXP反映に失敗しました:", err.message);
      }
    }

    // 称号（バッジ）の自動判定。EXP反映・自己ベスト保存が終わった後の
    // 最新の永続データ（サーバー側の値）だけを根拠に判定する
    const newBadges = await checkAndGrantBadges(currentUserRecord.id);
    if (newBadges.length > 0) {
      setTimeout(() => showBadgeUnlockQueue(newBadges), 2000);
    }
    refreshHomeExtras(); // 次にスタート画面へ戻ったときのため、称号・ミッション表示を更新しておく
  }

  // 高得点・自己ベスト更新時は紙吹雪でお祝いする
  if (rate === 100) {
    playFanfare();
    setTimeout(() => launchConfetti(80), 150);
  } else if (isNewRecord || rate >= 80) {
    setTimeout(() => launchConfetti(isNewRecord ? 60 : 40), 150);
  }

  // 「あなたの記録」カード：現在のユーザーの成績だけを表示する
  if (currentUserRecord) {
    const r = currentUserRecord;
    const totalRate = r.totalAnswered > 0 ? Math.round((r.totalCorrect / r.totalAnswered) * 100) : 0;
    document.getElementById("result-current-streak").textContent = `${r.currentStreak}問`;
    document.getElementById("result-best-streak").textContent = `${r.bestStreak}問`;
    document.getElementById("result-best-score").textContent = `${r.bestScore}問`;
    document.getElementById("result-best-rate").textContent = `${r.bestRate}%`;
    document.getElementById("result-total-answered").textContent = `${r.totalAnswered}問`;
    document.getElementById("result-total-correct").textContent = `${r.totalCorrect}問`;
    document.getElementById("result-total-rate").textContent = `${totalRate}%`;
    document.getElementById("result-wrong-count").textContent = `${r.wrongQuestionIds.length}問`;
    document.getElementById("result-correct-count").textContent = `${r.correctQuestionIds.length}問`;
  }

  const wrongList = document.getElementById("wrong-list");
  wrongList.innerHTML = "";
  const wrongAnswers = state.userAnswers.filter((a) => !a.correct);

  if (wrongAnswers.length === 0) {
    document.getElementById("no-wrong-text").hidden = false;
  } else {
    document.getElementById("no-wrong-text").hidden = true;
    wrongAnswers.forEach((a) => {
      const li = document.createElement("li");
      const modeTag = document.createElement("span");
      modeTag.className = "wrong-q-mode";
      modeTag.textContent = a.question.mode === "knowledge" ? "基礎" : "判断";
      li.appendChild(modeTag);
      li.appendChild(document.createTextNode(a.question.question));
      wrongList.appendChild(li);
    });
  }

  document.getElementById("btn-review-wrong").disabled =
    !currentUserRecord || currentUserRecord.wrongQuestionIds.length === 0;
}

function formatRate(answers) {
  if (answers.length === 0) return "該当なし";
  const correct = answers.filter((a) => a.correct).length;
  const rate = Math.round((correct / answers.length) * 100);
  return `${correct}/${answers.length}（${rate}%）`;
}

// ---- 不正解問題だけを復習する（ユーザーごとの永続リストから出題） ----
function startReviewSession() {
  if (!currentUserRecord || currentUserRecord.wrongQuestionIds.length === 0) return;

  const allQuestions = knowledgeQuestions.concat(practiceQuestions);
  const wrongQuestions = allQuestions.filter((q) => currentUserRecord.wrongQuestionIds.includes(q.id));
  if (wrongQuestions.length === 0) return;

  state.sessionQuestions = shuffleArray(wrongQuestions);
  state.currentIndex = 0;
  state.userAnswers = [];
  state.isReviewSession = true;
  newStreakRecordThisSession = false;
  resetSessionExpTracking();

  showScreen("screen-quiz");
  renderQuestion();
}

// ---- 最初からやり直す（ユーザーはログインしたまま） ----
function resetToStart() {
  state.mode = null;
  state.category = "全エリア";
  state.level = "全レベル";
  state.countOption = null;
  state.sessionQuestions = [];
  state.currentIndex = 0;
  state.userAnswers = [];
  state.isReviewSession = false;

  document.querySelectorAll("#mode-select .option-btn, #count-select .option-btn, #level-select .option-btn").forEach((b) =>
    b.classList.remove("selected")
  );
  // レベルは「全レベル」がデフォルト選択状態に戻る
  document.querySelector('#level-select .option-btn[data-level="全レベル"]').classList.add("selected");

  document.getElementById("btn-start").disabled = true;
  document.getElementById("start-warning").textContent = "";
  renderBestRecordOnStart();
  refreshAllExpGauges();
  refreshHomeExtras();
  updateDataStatusDetail();

  showScreen("screen-start");
}

// ---- 画面切り替えの共通関数 ----
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  // ダイブ画面（ログイン画面）専用の背景演出は、position:fixedが画面切り替えの
  // transformアニメーションに閉じ込められないよう#screen-userの外に置いているため、
  // ここでscreen-userがアクティブな間だけ表示する
  const diveBg = document.getElementById("dive-bg");
  if (diveBg) diveBg.hidden = id !== "screen-user";
  // ダイブ画面表示中は上下左右のスワイプでページ自体が動かないようにする
  // （端末のオーバースクロール／ラバーバンドで背景の白が見えるのを防ぐ）
  document.documentElement.classList.toggle("dive-active", id === "screen-user");
  document.body.classList.toggle("dive-active", id === "screen-user");
}

// ---- アプリ起動 ----
window.addEventListener("DOMContentLoaded", initApp);
