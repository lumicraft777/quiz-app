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
let productCatalog = []; // [{ maker, series, feature, demerit }]

// 用語集・製品名のハイライト対象をまとめたインデックス（毎回組み立て直さないようキャッシュする）
// [{ matchText, kind: "glossary"|"product", glossary, product }]
let highlightTermIndex = [];

function rebuildHighlightTermIndex() {
  const terms = glossaryTerms.map((g) => ({ matchText: g.term, kind: "glossary", glossary: g }));
  productCatalog.forEach((p) => {
    if (!p.maker || !p.series) return;
    // 問題文では「メーカー「シリーズ」」、選択肢では「メーカー シリーズ」の
    // 2通りの表記が使われるため、両方をハイライト対象に登録する
    terms.push({ matchText: `${p.maker}「${p.series}」`, kind: "product", product: p });
    terms.push({ matchText: `${p.maker} ${p.series}`, kind: "product", product: p });
  });
  // 長い文字列を優先してマッチさせる（部分一致による誤ハイライトを防ぐ）
  highlightTermIndex = terms.sort((a, b) => b.matchText.length - a.matchText.length);
}

async function loadGlossary() {
  try {
    const res = await supabaseFetch("glossary?select=term,definition,category&order=term.asc");
    if (res.ok) glossaryTerms = await res.json();
  } catch (err) {
    // 用語集が読めなくてもクイズ本体は問題なく遊べるようにする
    console.error("用語集の読み込みに失敗しました:", err.message);
  } finally {
    rebuildHighlightTermIndex();
  }
}

async function loadProducts() {
  try {
    const res = await supabaseFetch("products?select=maker,series,feature,demerit&order=maker.asc");
    if (res.ok) productCatalog = await res.json();
  } catch (err) {
    // 製品情報が読めなくてもクイズ本体は問題なく遊べるようにする
    console.error("製品情報の読み込みに失敗しました:", err.message);
  } finally {
    rebuildHighlightTermIndex();
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

function setupProductDetail() {
  document.getElementById("btn-product-detail-close").addEventListener("click", closeProductDetail);
  document.getElementById("product-detail-panel").addEventListener("click", (e) => {
    if (e.target.id === "product-detail-panel") closeProductDetail(); // 背景クリックで閉じる
  });
}

function openProductDetail(product) {
  document.getElementById("product-detail-name").textContent = `${product.maker} ${product.series}`;
  document.getElementById("product-detail-feature").textContent = product.feature || "情報がありません。";
  document.getElementById("product-detail-demerit").textContent = product.demerit || "情報がありません。";
  document.getElementById("product-detail-panel").hidden = false;
}

function closeProductDetail() {
  document.getElementById("product-detail-panel").hidden = true;
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
  if (highlightTermIndex.length === 0) {
    container.appendChild(document.createTextNode(text));
    return;
  }

  // 長い用語を優先してマッチさせる（「全負荷」が「全負荷対応」の
  // 一部として誤ってハイライトされないようにするため）
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
    for (const t of highlightTermIndex) {
      const termChars = Array.from(t.matchText);
      if (termChars.length > 0 && chars.slice(cursor, cursor + termChars.length).join("") === t.matchText) {
        matched = t;
        break;
      }
    }
    if (matched) {
      flushBuffer();
      const span = document.createElement("span");
      span.className = matched.kind === "product" ? "product-term" : "glossary-term";
      span.textContent = matched.matchText;
      span.addEventListener("click", (e) => {
        e.stopPropagation(); // 選択肢ボタンなどの親要素のクリックに巻き込まれないようにする
        if (matched.kind === "product") openProductDetail(matched.product);
        else openDictionary(matched.glossary.term);
      });
      container.appendChild(span);
      cursor += Array.from(matched.matchText).length;
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
  levelSpan.textContent = `プレイヤーLv.${level}`;

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

// 初回登録の現在地チェック結果（伸ばせる分野）に基づく、おすすめ問題カード。
// ポップアップにはせず、他の機能を自由に使える通常のカードとして表示する
function renderRecommendCard() {
  const card = document.getElementById("recommend-card");
  if (!card || !currentUserRecord) return;
  const growth = currentUserRecord.diagnosticGrowth || [];
  if (growth.length === 0) { card.hidden = true; return; }

  const category = growth[0];
  const pool = knowledgeQuestions.filter((q) => q.category === category && q.difficulty === "初級");
  if (pool.length === 0) { card.hidden = true; return; }

  document.getElementById("recommend-title").textContent = category;
  document.getElementById("recommend-desc").textContent = `初級・${Math.min(5, pool.length)}問`;
  card.dataset.category = category;
  card.hidden = false;
}

// ---- 称号（バッジ）表示 ----
function renderBadges(badges) {
  const card = document.getElementById("badges-card");
  const grid = document.getElementById("badges-grid");
  const titleText = document.getElementById("current-title-text");
  if (!card || !grid) return;
  grid.innerHTML = "";

  const unlocked = badges.filter((b) => b.unlocked);
  const equippedKey = currentUserRecord ? currentUserRecord.equippedBadgeKey : null;
  if (unlocked.length === 0) {
    titleText.textContent = "まだ称号がありません。任務を攻略して解放しよう";
  } else {
    titleText.textContent = equippedKey
      ? `装備中の称号：${currentUserRecord.equippedBadgeTitle}（タップで解除／変更できます）`
      : `解放済み：${unlocked.length} / ${badges.length}（タップして攻略者ボードに表示する称号を選ぼう）`;
  }

  badges.forEach((b) => {
    const item = document.createElement("div");
    const isEquipped = b.unlocked && b.key === equippedKey;
    item.className = "badge-item" + (b.unlocked ? " unlocked" : " locked") + (isEquipped ? " equipped" : "");
    const icon = document.createElement("span");
    icon.className = "badge-item-icon";
    icon.textContent = b.unlocked ? (isEquipped ? "⭐" : "🎖️") : "🔒";
    const title = document.createElement("span");
    title.className = "badge-item-title";
    title.textContent = b.title;
    const desc = document.createElement("span");
    desc.className = "badge-item-desc";
    desc.textContent = b.description;
    item.appendChild(icon);
    item.appendChild(title);
    item.appendChild(desc);
    if (b.unlocked) {
      item.classList.add("tappable");
      item.setAttribute("role", "button");
      item.setAttribute("tabindex", "0");
      item.addEventListener("click", () => toggleEquipBadge(b.key, isEquipped));
    }
    grid.appendChild(item);
  });

  card.hidden = badges.length === 0;
}

// 称号の装備／解除を切り替える（既に装備中のものをタップしたら解除する）
async function toggleEquipBadge(badgeKey, isCurrentlyEquipped) {
  if (!currentUserRecord) return;
  playSelectSound();
  const nextKey = isCurrentlyEquipped ? null : badgeKey;
  try {
    const rows = await supabaseRpc("rpc_set_equipped_badge", {
      p_user_id: currentUserRecord.id,
      p_badge_key: nextKey
    });
    const row = rows[0];
    currentUserRecord.equippedBadgeKey = row.equipped_badge_key || null;
    currentUserRecord.equippedBadgeTitle = row.equipped_badge_title || null;
    const badges = await fetchBadges(currentUserRecord.id);
    renderBadges(badges);
  } catch (err) {
    console.error("称号の装備に失敗しました:", err.message);
  }
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
  playDeepImpactSound();
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
// 本日の残り時間（23:59:59まで）を「HH:MM:SS」で返す。
// 未達成ミッション＝緊急クエストの「残り時間」表示に使う
function getTimeUntilMidnightText() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const diffMs = Math.max(0, midnight - now);
  const h = Math.floor(diffMs / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  const s = Math.floor((diffMs % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function buildMissionItemEl(m) {
  const item = document.createElement("div");
  // 未達成のミッションは「緊急クエスト」として、通常より緊張感のある見た目にする
  const isEmergency = !m.completed;
  item.className = "mission-item" + (m.completed ? " completed" : " emergency");

  const main = document.createElement("div");
  main.className = "mission-item-main";

  const header = document.createElement("div");
  header.className = "mission-item-header";
  const title = document.createElement("span");
  title.className = "mission-item-title";
  title.textContent = (isEmergency ? "⚠ " : "") + m.title;
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

  if (isEmergency) {
    const countdown = document.createElement("div");
    countdown.className = "mission-item-countdown";
    countdown.textContent = `残り時間：${getTimeUntilMidnightText()}`;
    main.appendChild(countdown);
  }

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
  const incompleteCount = missions.length - completedCount;
  if (incompleteCount > 0) {
    summaryText.textContent = `⚠ 緊急クエスト（${incompleteCount}件）／ 達成 ${completedCount}/${missions.length}`;
    card.classList.add("has-emergency");
    // 初回登録で宣言した目的を再掲し、「未来の自分との約束」として意識づける
    const goal = currentUserRecord &&
      ((currentUserRecord.goalTags && currentUserRecord.goalTags[0]) || currentUserRecord.contractGoal);
    if (goal) {
      const goalLine = document.createElement("p");
      goalLine.className = "mission-goal-line";
      goalLine.textContent = `未来のあなたとの約束が、未完了のまま残っています。目的：「${goal}」`;
      list.appendChild(goalLine);
    }
  } else {
    summaryText.textContent = `今日のミッション（${completedCount} / ${missions.length}達成）`;
    card.classList.remove("has-emergency");
  }

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
  "基礎知識", "太陽光発電", "システム設計・発電量計算", "機器・部品の知識", "施工・設置の知識", "系統連系と電力制度", "関係法規", "維持管理・O&M", "販売・提案・環境",
  "保証", "容量", "電池材料", "停電対策", "V2H", "太陽光連携",
  "営業トーク", "メーカー比較", "メリット/デメリット",
  "電気代削減", "初期費用", "EV/V2H", "保証・安心", "設置スペース", "営業トーク判断"
];

// エリア選択チップの表示名（章番号プレフィックス）を決めるためのジャンル分け。
// 製品データに依存しない座学系カテゴリは章ごとのジャンルに、
// 具体的な製品（型番・スペック・営業トーク等）に関するカテゴリは「製品問題」。
// ここに載っていないカテゴリ（将来の新カテゴリ）は「製品問題」扱いにする。
const CATEGORY_GENRE = {
  "基礎知識": "1章 基礎知識",
  "太陽光発電": "1章 基礎知識",
  "システム設計・発電量計算": "2章 システム設計・発電量計算",
  "機器・部品の知識": "3章 機器・部品の知識",
  "施工・設置の知識": "4章 施工・設置の知識",
  "系統連系と電力制度": "5章 系統連系と電力制度",
  "関係法規": "6章 関係法規",
  "維持管理・O&M": "7章 維持管理・O&M",
  "販売・提案・環境": "8章 販売・提案・環境"
};
function genreOfCategory(cat) {
  return CATEGORY_GENRE[cat] || "製品問題";
}
// エリア選択の表示名：個別に上書き指定がある場合はそれを使う
// （例：「基礎知識」は入門レベルの内容であることが分かるよう「入門」と表示）。
// それ以外は、所属ジャンルが「N章 ...」であればカテゴリ名の頭に同じ「N章」を
// 付けて表示する（例：「太陽光発電」→「1章 太陽光発電」）。
// 製品問題ジャンルのカテゴリは章番号を付けずそのまま表示する。
const CATEGORY_DISPLAY_OVERRIDE = {
  "基礎知識": "入門"
};
function categoryDisplayLabel(cat) {
  if (CATEGORY_DISPLAY_OVERRIDE[cat]) return CATEGORY_DISPLAY_OVERRIDE[cat];
  const genre = genreOfCategory(cat);
  const m = genre.match(/^(\d+章)/);
  return m ? `${m[1]} ${cat}` : cat;
}

// 「不正解問題」「正解問題」はカテゴリ一覧の中に混ぜて選べるようにする特別な
// 擬似カテゴリ。実際のカテゴリタグではなく、現在のユーザーの不正解/正解済み
// リストへのID一致で絞り込む。
const WRONG_CATEGORY = "要再挑戦リスト";
const CORRECT_CATEGORY = "正解問題";

// アプリの状態（グローバル管理・現在のセッションに関するものだけ）
const state = {
  mode: null,        // "knowledge" | "practice" | "mix"
  categories: new Set(), // 選択中のエリア（複数選択可）。空＝「全エリア」（絞り込みなし）
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
  tenQuestionBonusGranted: false, // 「10問連続プレイ」ボーナスを既に付与したか

  // ---- PLAYER LOG（個人学習記録）関連 ----
  currentSessionId: null, // quiz_sessions側の行ID。beginQuizSession()で発行しrecordAnswerForUser()に渡す
  exitedEarly: false       // 今回のセッションが途中退出で終わったか（renderResultScreen側で参照後リセットする）
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
    todayBestScore: row.today_best_score,
    todayBestRate: row.today_best_rate,
    onboardingCompleted: row.onboarding_completed,
    goalReason: row.goal_reason,
    goalTags: row.goal_tags || [],
    contractGoal: row.contract_goal || "",
    firstArea: row.first_area || "",
    diagnosticLevel: row.diagnostic_level || "",
    diagnosticGrowth: row.diagnostic_growth || [],
    diagnosticStrengths: row.diagnostic_strengths || [],
    equippedBadgeKey: row.equipped_badge_key || null,
    equippedBadgeTitle: row.equipped_badge_title || null,
    wrongQuestionIds: statusRows.filter((r) => !r.correct).map((r) => r.question_id),
    correctQuestionIds: statusRows.filter((r) => r.correct).map((r) => r.question_id)
  };
}

// 新規プレイヤー登録：PLAYER CONTRACT確定時に1回だけ呼ぶ。この時点で
// 初めてアカウントが作られ、儀式で集めた回答・現在地チェックの診断結果
// すべてを1つのRPCでまとめて保存する
async function registerPlayer(s) {
  const rows = await supabaseRpc("rpc_register_player", {
    p_username: s.username,
    p_pin: s.pin,
    p_goal_tags: Array.from(s.goalTags),
    p_goal_reason: s.reason,
    p_commitment_cadence: getEffectiveCadence(s),
    p_resolve_percent: s.resolve,
    p_current_position: s.diagnosticLevel,
    p_contract_goal: s.contractGoal,
    p_started_from_zero_resolve: s.startedFromZeroResolve,
    p_diagnostic_correct_count: s.diagnosticCorrectCount,
    p_diagnostic_level: s.diagnosticLevel,
    p_diagnostic_strengths: s.diagnosticStrengths,
    p_diagnostic_growth: s.diagnosticGrowth,
    p_diagnostic_answers: s.diagnosticAnswers
  });
  const row = rows[0];
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
    todayBestScore: row.today_best_score,
    todayBestRate: row.today_best_rate,
    onboardingCompleted: row.onboarding_completed,
    goalReason: row.goal_reason,
    goalTags: row.goal_tags || [],
    contractGoal: row.contract_goal || "",
    firstArea: row.first_area || "",
    diagnosticLevel: row.diagnostic_level || "",
    diagnosticGrowth: row.diagnostic_growth || [],
    diagnosticStrengths: row.diagnostic_strengths || [],
    equippedBadgeKey: row.equipped_badge_key || null,
    equippedBadgeTitle: row.equipped_badge_title || null,
    wrongQuestionIds: [],
    correctQuestionIds: []
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
      p_is_review: state.isReviewSession,
      p_session_id: state.currentSessionId
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
    const rows = await supabaseRpc("rpc_record_session_result", {
      p_user_id: userId,
      p_score: correctCount,
      p_rate: rate
    });
    return rows[0];
  } catch (err) {
    console.error("自己ベストの保存に失敗しました:", err.message);
    return null;
  }
}

/* ================================================================
   PLAYER LOG（個人学習記録）
   ----------------------------------------------------------------
   ・クイズ開始時にセッション行を作り（startPlayerLogSession）、
   　結果画面表示 or 途中退出のタイミングでセッション行を確定させる
   　（finishPlayerLogSession）。失敗してもクイズ体験自体は止めない
   　（fire-and-forget寄りの扱い。ただしセッションIDは各回答の
   　p_session_idに使うため、開始だけは軽くawaitして採番を待つ）。
   ================================================================ */

function generateSessionId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function startPlayerLogSession(userId, mode, category, difficulty, selectedCount) {
  const id = generateSessionId();
  try {
    await supabaseRpc("rpc_start_player_log_session", {
      p_session_id: id,
      p_user_id: userId,
      p_mode: mode,
      p_category: category,
      p_difficulty: difficulty,
      p_selected_count: String(selectedCount)
    });
  } catch (err) {
    console.error("学習セッションの開始記録に失敗しました:", err.message);
  }
  return id;
}

async function finishPlayerLogSession(sessionId, info) {
  if (!sessionId) return;
  try {
    await supabaseRpc("rpc_finish_player_log_session", {
      p_session_id: sessionId,
      p_answered_count: info.answeredCount,
      p_correct_count: info.correctCount,
      p_incorrect_count: info.incorrectCount,
      p_earned_exp: info.earnedExp,
      p_level_before: info.levelBefore,
      p_level_after: info.levelAfter,
      p_completed: info.completed,
      p_exited_early: info.exitedEarly
    });
  } catch (err) {
    console.error("学習セッションの終了記録に失敗しました:", err.message);
  }
}

function fetchPlayerLogMonth(userId, year, month) {
  return supabaseRpc("rpc_get_player_log_month", { p_user_id: userId, p_year: year, p_month: month });
}
function fetchPlayerLogDaySummary(userId, date) {
  return supabaseRpc("rpc_get_player_log_day_summary", { p_user_id: userId, p_date: date }).then((r) => r[0]);
}
function fetchPlayerLogDayCategories(userId, date) {
  return supabaseRpc("rpc_get_player_log_day_categories", { p_user_id: userId, p_date: date });
}
function fetchPlayerLogDayDifficulties(userId, date) {
  return supabaseRpc("rpc_get_player_log_day_difficulties", { p_user_id: userId, p_date: date });
}
function fetchPlayerLogDaySessions(userId, date) {
  return supabaseRpc("rpc_get_player_log_day_sessions", { p_user_id: userId, p_date: date });
}
function fetchPlayerLogMonths(userId) {
  return supabaseRpc("rpc_get_player_log_months", { p_user_id: userId });
}
function fetchPlayerLogOverview(userId) {
  return supabaseRpc("rpc_get_player_log_overview", { p_user_id: userId }).then((r) => r[0]);
}

// ランキング（全ユーザー横断）を取得する
async function fetchRanking() {
  return supabaseRpc("rpc_get_ranking", {});
}

// 攻略者ボードの種類ごとに異なるRPCを呼ぶ（総合以外は既存のソートロジックには一切触れない）
// 各ランキングは「上位5名＋（圏外なら）自分の行」だけがサーバーから返る。
// 自分の順位を出すため、ログイン中のユーザーIDを毎回渡す
function rankingParams() {
  return { p_user_id: currentUserRecord ? currentUserRecord.id : null };
}
const RANKING_FETCHERS = {
  overall: () => supabaseRpc("rpc_get_ranking", rankingParams()),
  streak: () => supabaseRpc("rpc_get_streak_ranking", rankingParams()),
  weekly: () => supabaseRpc("rpc_get_weekly_ranking", rankingParams()),
  monthly: () => supabaseRpc("rpc_get_monthly_ranking", rankingParams()),
  combo: () => supabaseRpc("rpc_get_combo_ranking", rankingParams()),
  suppression: () => supabaseRpc("rpc_get_suppression_ranking", rankingParams()),
  missions: () => supabaseRpc("rpc_get_mission_count_ranking", rankingParams()),
  review: () => supabaseRpc("rpc_get_review_ranking", rankingParams())
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

// ---- ダイブ演出用の効果音（仮想訓練空間へ意識が同期していく没入感を出す） ----
// 上昇していくノコギリ波のアルペジオで「エネルギーが高まっていく」感じを出す
function playDiveSyncSound() {
  playDeepImpactSound();
  const notes = [130.81, 164.81, 196.0, 246.94, 329.63, 392.0, 493.88];
  notes.forEach((freq, i) => playTone(freq, 0.15 + i * 0.11, 0.5, "sawtooth", 0.045));
  // 低音のうねりを重ねて厚みを出す
  playTone(65.41, 0.15, 1.1, "sine", 0.08);
}

// 重低音の「ドゥーン」に、速さを感じる高音のトランジェントを重ねたインパクト音。
// 緊急クエストや、レベルアップ・称号解放などの重要な演出の合図に使う
function playDeepImpactSound() {
  playTone(48, 0, 0.7, "sine", 0.4);
  playTone(36, 0.02, 0.85, "triangle", 0.32);
  playTone(1400, 0, 0.05, "sawtooth", 0.09);
  playTone(2000, 0.03, 0.04, "sawtooth", 0.07);
}

// 接続完了時の確認音（澄んだ2音のチャイム）
function playDiveCompleteSound() {
  playTone(659.25, 0, 0.16, "sine", 0.2);
  playTone(1046.5, 0.1, 0.4, "sine", 0.22);
}

// 選択肢をタップした瞬間の認識音。装飾のない短い純音のクリックで、
// 「システムが入力を検知した」ことだけを冷静に伝える
function playSelectSound() {
  playTone(1567.98, 0, 0.045, "sine", 0.12);
  playTone(2093.0, 0.028, 0.05, "sine", 0.07);
}

// 選択を「確定」した瞬間のアクノリッジ音。低→高の二音で
// 「受理・記録した」ことを示す、戦略システム風の応答音
function playConfirmSound() {
  playTone(1046.5, 0, 0.07, "triangle", 0.16);
  playTone(1567.98, 0.07, 0.12, "triangle", 0.14);
}

// ---- 紙吹雪演出 ----
const CONFETTI_COLORS = ["#22e3ff", "#ff31d8", "#3dffa0", "#7b2ff7", "#f2c94c", "#7ef1ff"];

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

  playDeepImpactSound();
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
  if (r.todayBestRate === 0 && r.bestStreak === 0) {
    el.textContent = "";
    return;
  }
  const parts = [];
  if (r.todayBestRate > 0) parts.push(`本日の自己ベスト正答率 ${r.todayBestRate}%`);
  if (r.bestStreak > 0) parts.push(`最大コンボ ${r.bestStreak}`);
  el.textContent = `🏆 ${r.userName}さんの記録：` + parts.join(" ／ ");
}

// スタート画面のストリーク・称号・デイリーミッションをまとめて再取得・再描画する
// （ログイン時、および任務完了後のスタート画面復帰時に呼ぶ）
async function refreshHomeExtras() {
  if (!currentUserRecord) return;
  renderStreakBanner();
  renderRecommendCard();
  refreshPlayerLogHomeCard();
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

// 未攻略データ（要再挑戦リスト）や今回の成績をもとに、次に挑むべきミッションを提案する
function getRecommendedMissionText(rate, wrongCount, difficultyFilter) {
  if (wrongCount > 0) {
    return "🧭 次の推奨ミッション：要再挑戦リストに挑戦して未攻略データを潰そう";
  }
  if (rate === 100) {
    if (difficultyFilter === "初級") return "🧭 次の推奨ミッション：中級エリアに挑戦してみよう";
    if (difficultyFilter === "中級") return "🧭 次の推奨ミッション：上級エリアに挑戦してみよう";
    return "🧭 次の推奨ミッション：別のエリアで力試しをしよう";
  }
  if (rate < 60) {
    return "🧭 次の推奨ミッション：同じエリアをもう一度攻略しよう";
  }
  return "🧭 次の推奨ミッション：新しいエリアに挑戦しよう";
}

/* ================================================================
   背景演出：デジタルトンネル
   ----------------------------------------------------------------
   ・画面中央付近の消失点に向かって、発光ライン（青/シアン基調＋
     少数の黄緑アクセント）と光の粒子が流れ続け、「仮想空間を高速で
     前進している」感覚を演出する。
   ・大半のラインは奥（消失点）から手前へ流れて画面外へ通り過ぎ、
     一部は画面端から出現して中央の奥へ吸い込まれるように消える。
   ・折れ曲がるワイヤー・交点の発光ノード・明滅する光点・高速で
     横切る光の断片を重ね、機械的すぎないランダムな複雑さを出す。
   ・各要素は個別にフェードイン/アウトしながら再生成されるため、
     全体がリセットされた瞬間は見えない（＝継ぎ目のないループ）。
   ・端末負荷を抑えるため要素数は画面サイズに応じて控えめにし、
     タブ非表示中は描画を停止する。prefers-reduced-motion環境では
     アニメーションせず静止画を1枚だけ描く。
   ================================================================ */

const cyberTunnel = {
  canvas: null,
  ctx: null,
  w: 0,
  h: 0,
  cx: 0,
  cy: 0,
  scale: 0,
  streaks: [],
  wires: [],
  dots: [],
  frags: [],
  lastTime: 0,
  rafId: null,
  reduced: false
};

// 青とシアンを基本色に、黄緑は少なめのアクセントとして使う
function pickTunnelColor() {
  const r = Math.random();
  if (r < 0.08) return "170, 255, 80";   // 黄緑（重要な信号のように目立たせる）
  if (r < 0.55) return "34, 227, 255";   // シアン
  return "64, 130, 255";                 // 青
}

// 奥行き方向へ流れるライン。zは奥行き（大きいほど遠い）。
// inward=trueのものは画面端から出現して中央の奥へ吸い込まれる
function spawnTunnelStreak(scatterZ) {
  let x = 0;
  let y = 0;
  // 消失点のド真ん中から生えると不自然なので、中心から少し離す
  do {
    x = (Math.random() * 2 - 1) * 1.5;
    y = (Math.random() * 2 - 1) * 1.0;
  } while (Math.sqrt(x * x + y * y) < 0.2);

  const inward = Math.random() < 0.3;
  return {
    x,
    y,
    z: scatterZ ? 0.5 + Math.random() * 8 : (inward ? 0.4 + Math.random() * 0.6 : 6 + Math.random() * 3.5),
    len: 0.3 + Math.random() * 0.9,           // 奥行き方向の線の長さ
    speed: 1.1 + Math.random() * 2.4,         // 移動速度（ランダム）
    inward,
    color: pickTunnelColor(),
    flicker: Math.random() < 0.18,            // 一部だけ明滅させる
    phase: Math.random() * Math.PI * 2
  };
}

// 不規則に折れ曲がるデジタルワイヤー（画面座標で描く回路状のパターン）
function spawnTunnelWire(w, h) {
  const points = [];
  let x = Math.random() * w;
  let y = Math.random() * h;
  let angle = Math.random() * Math.PI * 2;
  points.push({ x, y });
  const segments = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < segments; i++) {
    const len = 40 + Math.random() * 150;
    x += Math.cos(angle) * len;
    y += Math.sin(angle) * len;
    points.push({ x, y });
    // 30〜90度の範囲でランダムに折れ曲がる
    angle += (Math.random() < 0.5 ? -1 : 1) * (Math.PI / 6 + Math.random() * (Math.PI / 3));
  }
  return {
    points,
    color: pickTunnelColor(),
    life: 0,
    ttl: 4 + Math.random() * 5   // 表示時間もランダム（フェードイン→保持→アウト）
  };
}

// ランダムに点灯する小さな光点
function spawnTunnelDot(w, h) {
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    color: pickTunnelColor(),
    phase: Math.random() * Math.PI * 2,
    speed: 0.6 + Math.random() * 1.8,
    size: 1 + Math.random() * 1.6
  };
}

// 高速で通過する短い光の断片（斜めに横切って消える）
function spawnTunnelFrag(w, h) {
  const fromLeft = Math.random() < 0.5;
  const angle = (fromLeft ? 0 : Math.PI) + (Math.random() * 0.9 - 0.45);
  const speed = 900 + Math.random() * 900;
  return {
    x: fromLeft ? -40 : w + 40,
    y: Math.random() * h,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    len: 40 + Math.random() * 80,
    color: pickTunnelColor(),
    life: 0,
    ttl: 0.5 + Math.random() * 0.7,
    delay: Math.random() * 6   // 常に飛び交わないよう、次の出現まで間を置く
  };
}

function resizeCyberTunnel() {
  const t = cyberTunnel;
  // Retina等ではdprをそのまま使うと描画面積が跳ね上がり負荷が大きいため1.2に制限する
  const dpr = Math.min(window.devicePixelRatio || 1, 1.2);
  t.w = window.innerWidth;
  t.h = window.innerHeight;
  t.canvas.width = Math.round(t.w * dpr);
  t.canvas.height = Math.round(t.h * dpr);
  t.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  t.cx = t.w / 2;
  t.cy = t.h * 0.46; // 消失点は中央より少し上（.cyber-bg-coreの位置と揃える）
  t.scale = Math.min(t.w, t.h) * 0.9;

  // アプリ全体が重くならないよう要素数を抑える（あくまで控えめなアンビエント演出とする）
  const streakCount = Math.max(14, Math.min(26, Math.round((t.w * t.h) / 70000)));
  t.streaks = Array.from({ length: streakCount }, () => spawnTunnelStreak(true));
  t.wires = Array.from({ length: 2 }, () => {
    const wire = spawnTunnelWire(t.w, t.h);
    wire.life = Math.random() * wire.ttl; // 初期状態から表示タイミングをばらす
    return wire;
  });
  t.dots = Array.from({ length: 9 }, () => spawnTunnelDot(t.w, t.h));
  t.frags = Array.from({ length: 2 }, () => spawnTunnelFrag(t.w, t.h));
}

function drawCyberTunnelFrame(dt, time) {
  const t = cyberTunnel;
  const ctx = t.ctx;
  ctx.clearRect(0, 0, t.w, t.h);
  ctx.lineCap = "round";

  // ---- 奥行き方向へ流れる発光ライン ----
  t.streaks.forEach((s) => {
    s.z += (s.inward ? s.speed : -s.speed) * dt;
    if (!s.inward && s.z < 0.35) Object.assign(s, spawnTunnelStreak(false));
    else if (s.inward && s.z > 9.5) Object.assign(s, spawnTunnelStreak(false));

    const k1 = t.scale / s.z;
    const k2 = t.scale / (s.z + s.len);
    const x1 = t.cx + s.x * k1;
    const y1 = t.cy + s.y * k1;
    const x2 = t.cx + s.x * k2;
    const y2 = t.cy + s.y * k2;

    // 手前ほど太く明るく、奥ほど細く暗く（消失点の光へ収束していく）
    let alpha = Math.min(0.7, 0.85 / s.z);
    if (s.inward) alpha *= Math.max(0, 1.4 - s.z * 0.15);
    if (s.flicker) alpha *= 0.55 + 0.45 * Math.sin(time * 6 + s.phase);
    if (alpha <= 0.01) return;
    const width = Math.min(2.2, Math.max(0.4, 2.0 / s.z));

    // 描画コストを抑えるため一度描きのみにする（二重描きのグローは行わない）
    ctx.strokeStyle = `rgba(${s.color}, ${alpha})`;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  });

  // ---- 不規則に交差するデジタルワイヤー＋交点の発光ノード ----
  t.wires.forEach((wire, i) => {
    wire.life += dt;
    if (wire.life >= wire.ttl) {
      t.wires[i] = spawnTunnelWire(t.w, t.h);
      return;
    }
    // フェードイン(15%)→保持（緩やかに明滅）→フェードアウト(25%)
    const progress = wire.life / wire.ttl;
    let alpha;
    if (progress < 0.15) alpha = progress / 0.15;
    else if (progress > 0.75) alpha = (1 - progress) / 0.25;
    else alpha = 0.85 + 0.15 * Math.sin(time * 2 + i);
    alpha *= 0.3;

    ctx.strokeStyle = `rgba(${wire.color}, ${alpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    wire.points.forEach((p, j) => {
      if (j === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    // 折れ曲がり点＝ノードとして小さく発光させる
    ctx.fillStyle = `rgba(${wire.color}, ${Math.min(1, alpha * 2.4)})`;
    wire.points.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  // ---- ランダムに明滅する光点 ----
  t.dots.forEach((d) => {
    const alpha = 0.12 + 0.3 * (0.5 + 0.5 * Math.sin(time * d.speed + d.phase));
    ctx.fillStyle = `rgba(${d.color}, ${alpha})`;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.size, 0, Math.PI * 2);
    ctx.fill();
  });

  // ---- 高速で通過する短い光の断片 ----
  t.frags.forEach((f, i) => {
    if (f.delay > 0) {
      f.delay -= dt;
      return;
    }
    f.life += dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    if (f.life >= f.ttl || f.x < -120 || f.x > t.w + 120) {
      t.frags[i] = spawnTunnelFrag(t.w, t.h);
      return;
    }
    const alpha = 0.5 * Math.sin((f.life / f.ttl) * Math.PI);
    const norm = Math.sqrt(f.vx * f.vx + f.vy * f.vy);
    ctx.strokeStyle = `rgba(${f.color}, ${alpha})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(f.x, f.y);
    ctx.lineTo(f.x - (f.vx / norm) * f.len, f.y - (f.vy / norm) * f.len);
    ctx.stroke();
  });
}

// 単なる背景の飾りであり操作の主役ではないため、60fpsではなく
// 約24fpsに間引いて描画する。UI操作の有無には一切連動させず、
// 常に一定のゆるいペースで独立して流れ続けるだけにする
const CYBER_TUNNEL_FRAME_INTERVAL = 1 / 24;

function cyberTunnelLoop(timestamp) {
  const t = cyberTunnel;
  if (!t.lastTime) t.lastTime = timestamp;
  // タブ復帰直後などの巨大なdtで要素がワープしないよう上限を設ける
  const dt = Math.min((timestamp - t.lastTime) / 1000, 0.05);
  t.frameAccum = (t.frameAccum || 0) + dt;
  t.lastTime = timestamp;
  if (t.frameAccum >= CYBER_TUNNEL_FRAME_INTERVAL) {
    drawCyberTunnelFrame(t.frameAccum, timestamp / 1000);
    t.frameAccum = 0;
  }
  t.rafId = requestAnimationFrame(cyberTunnelLoop);
}

function startCyberTunnel() {
  const t = cyberTunnel;
  if (t.rafId !== null) return;
  if (t.reduced) {
    // 「動きを減らす」設定中はアニメーションせず、静止画を1枚だけ描く
    drawCyberTunnelFrame(0, 1);
    return;
  }
  t.lastTime = 0;
  t.rafId = requestAnimationFrame(cyberTunnelLoop);
}

function stopCyberTunnel() {
  if (cyberTunnel.rafId !== null) {
    cancelAnimationFrame(cyberTunnel.rafId);
    cyberTunnel.rafId = null;
  }
}

// 入力欄フォーカス時にiOS等が画面をズームし、フォーカスを外した後も
// ズームしたままになってしまう端末があるため、入力欄からフォーカスが
// 外れるたびにviewportメタタグを一度再適用してズームを1倍へ強制的に
// リセットする（font-sizeを16px以上にする対策だけでは防ぎきれない
// ケースへの保険）
function setupViewportZoomGuard() {
  const viewport = document.querySelector('meta[name="viewport"]');
  if (!viewport) return;
  const baseContent = viewport.getAttribute("content");
  document.addEventListener("focusout", (e) => {
    if (!e.target.matches || !e.target.matches("input, textarea, select")) return;
    viewport.setAttribute("content", baseContent + ", maximum-scale=1.0");
    setTimeout(() => { viewport.setAttribute("content", baseContent); }, 80);
  }, true);
}

function setupCyberTunnelBackground() {
  const canvas = document.getElementById("cyber-tunnel-canvas");
  if (!canvas || !canvas.getContext) return;
  cyberTunnel.canvas = canvas;
  cyberTunnel.ctx = canvas.getContext("2d");
  if (!cyberTunnel.ctx) return;

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  cyberTunnel.reduced = motionQuery.matches;
  // 設定変更に追従する（古いSafari向けにaddListenerもフォールバック）
  const onMotionChange = (e) => {
    cyberTunnel.reduced = e.matches;
    stopCyberTunnel();
    startCyberTunnel();
  };
  if (motionQuery.addEventListener) motionQuery.addEventListener("change", onMotionChange);
  else if (motionQuery.addListener) motionQuery.addListener(onMotionChange);

  window.addEventListener("resize", () => {
    resizeCyberTunnel();
    if (cyberTunnel.reduced) drawCyberTunnelFrame(0, 1);
  });

  // タブが非表示の間は描画を止めて無駄な負荷をかけない
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCyberTunnel();
    else startCyberTunnel();
  });

  resizeCyberTunnel();
  startCyberTunnel();
}

// ---- 起動時の初期化 ----
async function initApp() {
  loadSoundPreference();
  setupCyberTunnelBackground();
  setupViewportZoomGuard();
  document.getElementById("btn-sound-toggle").addEventListener("click", toggleSound);
  setupUserScreen();
  setupStartScreen();
  setupDictionary();
  setupProductDetail();
  setupOnboarding();
  setupPlayerLog();
  setupDailyMissionsClickHandler();
  setupMissionsToggle();
  setupAreaCard();
  setupRankingTabs();
  showScreen("screen-user");
  loadGlossary(); // 用語集はクイズ体験をブロックしないよう並行して読み込む
  loadProducts(); // 製品詳細情報も同様に並行して読み込む
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

  document.getElementById("btn-new-player").addEventListener("click", () => {
    playSelectSound();
    startNewRegistration();
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
  playDiveSyncSound();

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
    if (state.mode) renderAreaChips(); // 「要再挑戦リスト」「正解問題」エリアの有無を再評価する
    validateStartButton();

    // 中間演出（リング・ノイズ・スキャンライン）を終え、「接続完了」を
    // 一瞬見せたあと、粒子（リング・HUD）が中心へ収束→画面が白転し、
    // その裏でスタート画面へ切り替えてから白がフェードして
    // 「目を開けたらメイン画面にいる」ような没入感で遷移する
    await playDiveRevealTransition("接続完了。任務端末を起動します。", "screen-start");
  } catch (err) {
    connectingOverlay.classList.remove("show", "syncing");
    setTimeout(() => { connectingOverlay.hidden = true; }, 300);
    if (err.message === "このプレイヤーは登録されていません") {
      warningEl.textContent = "入力されたプレイヤーは登録されていません。初めて利用する場合は、新規プレイヤー登録へ進んでください。";
    } else if (err.message === "ユーザー名またはPINが正しくありません") {
      warningEl.textContent = "認証エラー：プレイヤーIDまたは認証キーを確認してください。";
    } else {
      warningEl.textContent = err.message || "認証エラー：接続に失敗しました。もう一度お試しください。";
    }
  } finally {
    startBtn.disabled = false;
  }
}

/* ================================================================
   初回登録：「人生の操作権を取り戻すログイン儀式」
   ----------------------------------------------------------------
   ・新規プレイヤー（rpc_loginでonboarding_completed=falseが返った場合）
     のみ、スタート画面より先にこの儀式を通す。2回目以降のログインでは
     一切表示しない。
   ・設計の核：目的を思い出す → 現状を認識する → 自分で選択する →
     未来を宣言する → 最初の一歩を踏み出す。
     「学習内容」より先に「変えたい未来（現実の目的）」を聞き、
     覚悟%だけでなく現実的な継続ペースも自分で選ばせる。
   ・どの覚悟の数値も否定しない（正直に始めても成長できる世界にする）。
   ・進行はrunOnboardingSequence()が1本のasync関数として制御する。
     メッセージ演出はすべてタップで早送りできる。
   ================================================================ */

const ONBOARDING_GOALS = [
  "営業成績を上げたい",
  "お客様から信頼される存在になりたい",
  "自信を持って話せるようになりたい",
  "商品知識を身につけたい",
  "質問にすぐ答えられるようになりたい",
  "仲間や家族に成長した姿を見せたい",
  "収入を上げ、人生の選択肢を増やしたい",
  "自分との約束を守れる人になりたい",
  "誰にも負けない実力を身につけたい",
  "その他"
];

const ONBOARDING_CADENCE_OPTIONS = [
  "毎日5分",
  "毎日10分",
  "毎日1ミッション",
  "週3回",
  "自分で設定する"
];

// 現在地チェック（3問診断）の正解数→現在地ラベルの対応
const DIAGNOSTIC_LEVELS = ["基礎からスタート", "基礎を構築中", "実践準備中", "実践力を強化する段階"];

const REGISTRATION_DRAFT_KEY = "batteryQuiz_registrationDraft";

let onboardingState = null;

function showOnboardingStep(stepName) {
  document.querySelectorAll(".onb-step").forEach((el) => {
    el.hidden = el.dataset.onbStep !== stepName;
  });
}

// 選択肢リスト（縦並び・単一選択）を組み立てる。preselectedValueを渡すと
// 途中データからの再開時に選択済み状態を復元できる
function buildOnbSelectList(containerId, options, onSelect, preselectedValue) {
  const list = document.getElementById(containerId);
  list.innerHTML = "";
  options.forEach((label) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "onb-cadence-option" + (label === preselectedValue ? " selected" : "");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      list.querySelectorAll(".onb-cadence-option").forEach((el) => el.classList.remove("selected"));
      btn.classList.add("selected");
      playSelectSound();
      onSelect(label);
    });
    list.appendChild(btn);
  });
}

// チップ型の選択肢（multi=trueなら複数選択）を組み立てる。preselectedを渡すと
// 途中データからの再開時に選択済み状態を復元できる
function buildOnbChips(containerId, options, multi, onChange, preselected) {
  const grid = document.getElementById(containerId);
  grid.innerHTML = "";
  const selected = new Set(preselected || []);
  options.forEach((label) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "onb-goal-chip" + (selected.has(label) ? " selected" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => {
      if (multi) {
        if (selected.has(label)) {
          selected.delete(label);
          chip.classList.remove("selected");
        } else {
          selected.add(label);
          chip.classList.add("selected");
        }
      } else {
        selected.clear();
        grid.querySelectorAll(".onb-goal-chip").forEach((el) => el.classList.remove("selected"));
        selected.add(label);
        chip.classList.add("selected");
      }
      playSelectSound();
      onChange(selected);
    });
    grid.appendChild(chip);
  });
}

// 行のまとまり（グループ）を1画面ずつフェードイン表示する。
// 各グループはタップで早送りでき、最後のグループのあとは
// 「タップで進む」ヒントを出してクリックを待つ。
function renderOnbLines(container, lines, emphasis) {
  container.innerHTML = "";
  lines.forEach((text, i) => {
    const p = document.createElement("p");
    p.className = "onb-prologue-line" + (emphasis ? " emphasis" : "");
    p.style.animationDelay = `${i * 0.5}s`;
    p.textContent = text;
    container.appendChild(p);
  });
}

async function playOnbMessage(groups) {
  showOnboardingStep("message");
  const container = document.getElementById("onb-message-lines");
  const hint = document.getElementById("onb-message-hint");
  const stepEl = document.querySelector('[data-onb-step="message"]');
  hint.hidden = true;
  for (const g of groups) {
    renderOnbLines(container, g.lines, g.emphasis);
    if (g.impact) {
      // 重低音とともに、背景の粒子（デジタルトンネル）を一瞬停止させる
      playDeepImpactSound();
      stopCyberTunnel();
      setTimeout(startCyberTunnel, 1500);
    }
    await waitOrSkip(stepEl, g.hold || (g.lines.length * 500 + 1500));
  }
  hint.hidden = false;
  await new Promise((resolve) => stepEl.addEventListener("click", resolve, { once: true }));
  hint.hidden = true;
}

// 指定ボタンがクリックされる（かつvalidateを通る）まで待つ。
// 確定が受理された瞬間にアクノリッジ音を鳴らし、
// 「システム側が認識した」ことをユーザーへ伝える
function waitForOnbButton(btnId, validate) {
  return new Promise((resolve) => {
    const btn = document.getElementById(btnId);
    const handler = () => {
      if (validate && !validate()) return;
      btn.removeEventListener("click", handler);
      playConfirmSound();
      resolve();
    };
    btn.addEventListener("click", handler);
  });
}

// 複数ボタンのうち、どれが押されたかを待つ（100%再確認・0%隠し演出などの分岐用）
function waitForOnbChoice(btnIds) {
  return new Promise((resolve) => {
    const entries = btnIds.map((id) => {
      const btn = document.getElementById(id);
      const handler = () => {
        entries.forEach(([b, h]) => b.removeEventListener("click", h));
        playConfirmSound();
        resolve(id);
      };
      btn.addEventListener("click", handler);
      return [btn, handler];
    });
  });
}

/* ================================================================
   初回登録フロー：入口とドラフト（途中データ）の永続化
   ----------------------------------------------------------------
   ・「初めての方はこちら」からのみ開始する（既存プレイヤーのログインは
     rpc_loginが常にonboarding_completed=trueの既存アカウントを返す
     ため、この画面には一切遷移しない）。
   ・PLAYER CONTRACT確定（＝アカウント実作成）より前に離脱した場合に
     備え、各ステップ完了時点の入力内容をlocalStorageへ保存する。
     再度「初めての方はこちら」を押すと、続きから再開するか選べる。
   ================================================================ */

function initOnboardingState() {
  onboardingState = {
    stepIndex: 0, // 0=未着手 1=account完了 2=goals完了 3=diagnostic完了 4=reason完了 5=cadence完了 6=resolve完了
    username: "",
    pin: "",
    goalTags: new Set(),
    reason: "",
    diagnosticAnswers: [],
    diagnosticCorrectCount: 0,
    diagnosticLevel: "",
    diagnosticStrengths: [],
    diagnosticGrowth: [],
    cadence: null,
    cadenceCustomText: "",
    resolve: 50,
    startedFromZeroResolve: false,
    contractGoal: ""
  };
}

function saveRegistrationDraft() {
  if (!onboardingState) return;
  try {
    const serializable = { ...onboardingState, goalTags: Array.from(onboardingState.goalTags) };
    localStorage.setItem(REGISTRATION_DRAFT_KEY, JSON.stringify(serializable));
  } catch (err) {
    console.error("登録データの一時保存に失敗しました:", err.message);
  }
}

function loadRegistrationDraft() {
  try {
    const raw = localStorage.getItem(REGISTRATION_DRAFT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    data.goalTags = new Set(data.goalTags || []);
    return data;
  } catch (err) {
    return null;
  }
}

function clearRegistrationDraft() {
  try { localStorage.removeItem(REGISTRATION_DRAFT_KEY); } catch (err) { /* noop */ }
}

// 継続方法の表示・保存に使う実効値（「自分で設定する」を選んだ場合は自由入力の文言を使う）
function getEffectiveCadence(s) {
  if (s.cadence === "自分で設定する" && s.cadenceCustomText) return s.cadenceCustomText;
  return s.cadence || "";
}

function updateOnboardingResolveDisplay() {
  const s = onboardingState;
  document.getElementById("onb-resolve-value").textContent = `RESOLVE：${s.resolve}%`;
  const affirmEl = document.getElementById("onb-resolve-affirm");
  if (s.resolve === 0 || s.resolve === 100) {
    affirmEl.textContent = "";
  } else if (s.resolve <= 50) {
    affirmEl.textContent = "覚悟は、最初から高い必要はありません。";
  } else {
    affirmEl.textContent = "前へ進む意思、確かに受け取りました。";
  }
}

function setupOnboarding() {
  // スライダーの表示更新だけは常設リスナーで行う（他の進行は
  // runOnboardingSequence()が都度waitForOnbButtonで待ち受ける）
  document.getElementById("onb-resolve-slider").addEventListener("input", (e) => {
    if (!onboardingState) return;
    onboardingState.resolve = Number(e.target.value);
    updateOnboardingResolveDisplay();
  });

  // 継続方法「自分で設定する」を選んだ時だけ自由入力欄を出す
  document.getElementById("onb-cadence-custom-input").addEventListener("input", (e) => {
    if (!onboardingState) return;
    onboardingState.cadenceCustomText = e.target.value;
  });
}

// 「初めての方はこちら」から呼ばれる入口。途中データがあれば再開/やり直しを選ばせる
async function startNewRegistration() {
  showScreen("screen-onboarding");
  document.querySelectorAll(".onb-step").forEach((el) => { el.hidden = true; });

  const draft = loadRegistrationDraft();
  if (draft && draft.stepIndex > 0) {
    onboardingState = draft;
    showOnboardingStep("resume-draft");
    const choice = await waitForOnbChoice(["onb-resume-continue", "onb-resume-restart"]);
    if (choice === "onb-resume-restart") {
      clearRegistrationDraft();
      initOnboardingState();
    }
  } else {
    initOnboardingState();
  }
  runOnboardingSequence();
}

async function runOnboardingSequence() {
  const s = onboardingState;

  if (s.stepIndex === 0) {
    await playOnbMessage([
      { lines: ["ここから、", "あなたの成長記録が始まります。"], emphasis: true }
    ]);
  }

  if (s.stepIndex < 1) { await runAccountStep(s); s.stepIndex = 1; saveRegistrationDraft(); }
  if (s.stepIndex < 2) { await runGoalsStep(s); s.stepIndex = 2; saveRegistrationDraft(); }
  if (s.stepIndex < 3) { await runDiagnosticStep(s); s.stepIndex = 3; saveRegistrationDraft(); }
  if (s.stepIndex < 4) { await runReasonStep(s); s.stepIndex = 4; saveRegistrationDraft(); }
  if (s.stepIndex < 5) { await runCadenceStep(s); s.stepIndex = 5; saveRegistrationDraft(); }
  if (s.stepIndex < 6) { await runResolveStep(s); s.stepIndex = 6; saveRegistrationDraft(); }

  // PLAYER CONTRACT確定時に、初めてアカウントが実際に作られる
  await runContractStep(s);

  await playOnbRegistration(s);
  await playOnbSpeech(s);
  await playOnboardingFinaleTransition(s);
}

// STEP 1：プレイヤー名・認証キーを決める（重複チェックはここでのみ行う）
async function runAccountStep(s) {
  showOnboardingStep("account");
  const nameInput = document.getElementById("onb-account-name");
  const pinInput = document.getElementById("onb-account-pin");
  const pinConfirmInput = document.getElementById("onb-account-pin-confirm");
  const nameWarn = document.getElementById("onb-account-name-warn");
  const warn = document.getElementById("onb-account-warn");
  const btn = document.getElementById("onb-account-next");
  nameInput.value = s.username || "";
  pinInput.value = "";
  pinConfirmInput.value = "";
  nameWarn.textContent = "";
  warn.textContent = "";

  await new Promise((resolve) => {
    const handler = async () => {
      warn.textContent = "";
      nameWarn.textContent = "";
      const name = nameInput.value.trim();
      const pin = pinInput.value.trim();
      const pinConfirm = pinConfirmInput.value.trim();
      if (!name) { warn.textContent = "プレイヤー名を入力してください。"; return; }
      if (!/^\d{4,}$/.test(pin)) { warn.textContent = "認証キーは4桁以上の数字で入力してください。"; return; }
      if (pin !== pinConfirm) { warn.textContent = "認証キーが一致しません。もう一度入力してください。"; return; }

      btn.disabled = true;
      try {
        const available = await supabaseRpc("rpc_check_username_available", { p_username: name });
        if (available === false) {
          nameWarn.textContent = "このプレイヤー名はすでに使用されています。別の名前を設定してください。";
          btn.disabled = false;
          return;
        }
      } catch (err) {
        warn.textContent = "確認に失敗しました。もう一度お試しください。";
        btn.disabled = false;
        return;
      }

      s.username = name;
      s.pin = pin;
      btn.removeEventListener("click", handler);
      btn.disabled = false;
      playConfirmSound();
      resolve();
    };
    btn.addEventListener("click", handler);
  });
}

// STEP 2：目指す未来（現実世界で変えたいこと）を複数選択させる
async function runGoalsStep(s) {
  showOnboardingStep("goals");
  document.getElementById("onb-goals-player").textContent = `PLAYER：${s.username}`;
  const nextBtn = document.getElementById("onb-goals-next");
  nextBtn.disabled = s.goalTags.size === 0;
  buildOnbChips("onb-goal-grid", ONBOARDING_GOALS, true, (selected) => {
    s.goalTags = selected;
    nextBtn.disabled = selected.size === 0;
  }, s.goalTags);

  await waitForOnbButton("onb-goals-next", () => s.goalTags.size > 0);
  await playOnbMessage([
    { lines: ["目指す未来を記録しました。"] },
    { lines: ["次に、今のあなたの現在地を確認します。"] }
  ]);
}

// knowledgeQuestions/practiceQuestionsの読み込みが遅延している場合に備え、
// 現在地チェック開始前に少しだけデータの到着を待つ
async function waitForQuestionDataReady(maxMs) {
  const start = Date.now();
  while (knowledgeQuestions.length === 0 && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

function pickRandomFrom(arr) {
  return arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : null;
}

// 現在地チェック用の3問を選ぶ：①基礎知識の初級問題 ②説明・対応寄りの中級問題
// ③実践判断（提案）問題。既存の問題プールから流用し、専用の問題は作らない
function pickDiagnosticQuestions() {
  const usedIds = new Set();
  const pickUnique = (pool) => {
    const candidates = pool.filter((q) => !usedIds.has(q.id));
    const picked = pickRandomFrom(candidates.length > 0 ? candidates : pool);
    if (picked) usedIds.add(picked.id);
    return picked;
  };

  const q1 =
    pickUnique(knowledgeQuestions.filter((q) => q.difficulty === "初級" && q.category === "基礎知識")) ||
    pickUnique(knowledgeQuestions.filter((q) => q.difficulty === "初級")) ||
    pickUnique(knowledgeQuestions);

  const q2 =
    pickUnique(knowledgeQuestions.filter((q) => q.difficulty !== "上級" && ["営業トーク", "メリット/デメリット"].includes(q.category))) ||
    pickUnique(knowledgeQuestions.filter((q) => q.difficulty === "中級")) ||
    pickUnique(knowledgeQuestions);

  const q3 =
    pickUnique(practiceQuestions) ||
    pickUnique(knowledgeQuestions);

  return [q1, q2, q3].filter(Boolean);
}

// STEP 3：現在地チェック（実際に3問へ回答して現在地を判定する）
async function runDiagnosticStep(s) {
  showOnboardingStep("diagnostic");
  document.getElementById("onb-diag-intro").hidden = false;
  document.getElementById("onb-diag-quiz").hidden = true;

  await waitForOnbButton("onb-diag-start-btn");
  await waitForQuestionDataReady(6000);

  const questions = pickDiagnosticQuestions();
  s.diagnosticAnswers = [];

  document.getElementById("onb-diag-intro").hidden = true;
  document.getElementById("onb-diag-quiz").hidden = false;

  for (let i = 0; i < questions.length; i++) {
    await runDiagnosticQuestion(questions[i], i, questions.length, s);
  }

  const correctCount = s.diagnosticAnswers.filter((a) => a.is_correct).length;
  s.diagnosticCorrectCount = correctCount;
  s.diagnosticLevel = DIAGNOSTIC_LEVELS[correctCount] || DIAGNOSTIC_LEVELS[0];
  s.diagnosticStrengths = s.diagnosticAnswers.filter((a) => a.is_correct).map((a) => a.category);
  s.diagnosticGrowth = s.diagnosticAnswers.filter((a) => !a.is_correct).map((a) => a.category);

  showOnboardingStep("diagnostic-result");
  document.getElementById("onb-diag-result-score").textContent = `3問中 ${correctCount}問正解`;
  document.getElementById("onb-diag-result-level").textContent = s.diagnosticLevel;
  document.getElementById("onb-diag-result-strengths").textContent =
    s.diagnosticStrengths.length > 0 ? s.diagnosticStrengths.join("、") : "ー";
  document.getElementById("onb-diag-result-growth").textContent =
    s.diagnosticGrowth.length > 0 ? s.diagnosticGrowth.join("、") : "ー";
  await waitForOnbButton("onb-diag-result-next");
}

// 現在地チェックの1問分（選択→回答→フィードバック→次へ）を1つのPromiseにまとめる
function runDiagnosticQuestion(question, index, total, s) {
  return new Promise((resolve) => {
    document.getElementById("onb-diag-progress").textContent = `QUESTION ${index + 1} / ${total}`;
    document.getElementById("onb-diag-question").textContent = question.question;
    const diagCustomerCard = document.getElementById("onb-diag-customer-card");
    if (question.mode === "practice" && question.customerScenario && typeof question.customerScenario === "object") {
      diagCustomerCard.hidden = false;
      renderCustomerCard(question.customerScenario, "onb-diag-customer-card-list");
    } else {
      diagCustomerCard.hidden = true;
    }
    const choicesEl = document.getElementById("onb-diag-choices");
    choicesEl.innerHTML = "";
    const feedbackEl = document.getElementById("onb-diag-feedback");
    feedbackEl.hidden = true;
    const answerBtn = document.getElementById("onb-diag-answer-btn");
    const nextBtn = document.getElementById("onb-diag-next-btn");
    answerBtn.hidden = false;
    answerBtn.disabled = true;
    nextBtn.hidden = true;

    let selected = null;
    const choiceEls = [];
    question.choices.forEach((choiceText) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "onb-diag-choice";
      btn.textContent = choiceText;
      btn.addEventListener("click", () => {
        if (answerBtn.hidden) return; // 回答済みなら選び直せない
        selected = choiceText;
        choiceEls.forEach((el) => el.classList.remove("selected"));
        btn.classList.add("selected");
        playSelectSound();
        answerBtn.disabled = false;
      });
      choiceEls.push(btn);
      choicesEl.appendChild(btn);
    });

    const handleAnswer = () => {
      if (!selected) return;
      playConfirmSound();
      const isCorrect = selected === question.answer;
      choiceEls.forEach((el) => {
        el.disabled = true;
        if (el.textContent === question.answer) el.classList.add("correct");
        else if (el.textContent === selected && !isCorrect) el.classList.add("incorrect");
      });
      feedbackEl.hidden = false;
      feedbackEl.textContent = isCorrect
        ? "正解です。この分野の基本が身についています。"
        : "ここは、これから伸ばせるポイントです。";
      if (question.explanation) {
        const short = question.explanation.length > 120
          ? question.explanation.slice(0, 120) + "…"
          : question.explanation;
        feedbackEl.textContent += `\n${short}`;
      }
      s.diagnosticAnswers.push({
        question_id: question.id,
        selected_answer: selected,
        is_correct: isCorrect,
        category: question.category,
        difficulty: question.difficulty
      });
      answerBtn.hidden = true;
      nextBtn.hidden = false;
      answerBtn.removeEventListener("click", handleAnswer);
    };
    answerBtn.addEventListener("click", handleAnswer);

    nextBtn.addEventListener("click", function onNext() {
      nextBtn.removeEventListener("click", onNext);
      playSelectSound();
      resolve();
    });
  });
}

// STEP 4：学び続ける理由（本人の言葉で残す。継続の核）
async function runReasonStep(s) {
  showOnboardingStep("reason");
  const input = document.getElementById("onb-reason-input");
  const warn = document.getElementById("onb-reason-warn");
  input.value = s.reason || "";
  warn.textContent = "";
  await waitForOnbButton("onb-reason-next", () => {
    s.reason = input.value.trim();
    if (!s.reason) {
      warn.textContent = "一言でも大丈夫です。あなた自身の言葉で残してください。";
      return false;
    }
    return true;
  });
}

// STEP 5：継続方法（「自分で設定する」は自由入力に対応）
async function runCadenceStep(s) {
  showOnboardingStep("cadence");
  const nextBtn = document.getElementById("onb-cadence-next");
  const customWrap = document.getElementById("onb-cadence-custom-wrap");
  const customInput = document.getElementById("onb-cadence-custom-input");
  customWrap.hidden = s.cadence !== "自分で設定する";
  customInput.value = s.cadenceCustomText || "";
  nextBtn.disabled = !s.cadence;

  buildOnbSelectList("onb-cadence-list", ONBOARDING_CADENCE_OPTIONS, (v) => {
    s.cadence = v;
    customWrap.hidden = v !== "自分で設定する";
    nextBtn.disabled = false;
  }, s.cadence);

  await waitForOnbButton("onb-cadence-next", () => !!s.cadence);
  if (s.cadence === "自分で設定する") {
    s.cadenceCustomText = customInput.value.trim();
  }
  await playOnbMessage([
    { lines: ["未来のあなたと、", "現在のあなたが交わす約束です。"], emphasis: true }
  ]);
}

// STEP 6：覚悟の確認（どの数値も否定しない。0%/100%だけ特別な分岐がある）
async function runResolveStep(s) {
  document.getElementById("onb-resolve-player").textContent = `識別名を確認\nPLAYER：${s.username}`;
  showOnboardingStep("resolve");
  document.getElementById("onb-resolve-slider").value = String(s.resolve);
  updateOnboardingResolveDisplay();

  for (;;) {
    await waitForOnbButton("onb-resolve-next");
    if (s.resolve === 0) {
      showOnboardingStep("resolve-zero");
      const proceed = await runZeroResolveSequence(s);
      if (!proceed) { showOnboardingStep("resolve"); continue; }
      s.startedFromZeroResolve = true;
      break;
    }
    if (s.resolve >= 100) {
      showOnboardingStep("resolve-confirm");
      const choice = await waitForOnbChoice(["onb-resolve-yes", "onb-resolve-back"]);
      if (choice === "onb-resolve-back") { showOnboardingStep("resolve"); continue; }
      break;
    }
    break;
  }

  if (s.resolve > 0 && s.resolve < 100) {
    if (s.resolve <= 50) {
      await playOnbMessage([
        { lines: ["覚悟は、最初から高い必要はありません。"] },
        { lines: ["行動するたびに、", "覚悟は強くなっていきます。"], emphasis: true }
      ]);
    } else {
      await playOnbMessage([
        { lines: ["前へ進む意思を確認しました。"] },
        { lines: ["その覚悟を、", "これから一つずつ行動へ変えていきましょう。"], emphasis: true }
      ]);
    }
  } else if (s.resolve >= 100) {
    await playOnbMessage([
      { lines: ["その覚悟、", "確かに記録しました。"], emphasis: true }
    ]);
  }
  // resolve===0の場合は隠し演出の中で既に締めのメッセージを見せているため、ここでは何も追加しない
}

// 覚悟0%を選んだ場合だけの隠し演出。ユーザーを否定せず、正直な回答として歓迎する
async function runZeroResolveSequence(s) {
  const stepEl = document.querySelector('[data-onb-step="resolve-zero"]');
  const container = document.getElementById("onb-zero-lines");
  const choices = document.getElementById("onb-zero-choices");
  choices.hidden = true;
  container.innerHTML = "";

  stopCyberTunnel(); // 通常の背景の動きを一度止める

  const groups = [
    { lines: ["RESOLVE：0%"], emphasis: true },
    { lines: ["正直な回答を確認しました。"] },
    { lines: ["始める理由が見つからない日もあります。", "自信を持てないまま進む日もあります。"] },
    { lines: ["それでも、ここまで来たという行動は、", "すでに記録されています。"] },
    { lines: ["覚悟0%から始まる記録を、", "このシステムは歓迎します。"], emphasis: true, impact: true }
  ];
  for (const g of groups) {
    renderOnbLines(container, g.lines, g.emphasis);
    if (g.impact) playDeepImpactSound();
    await waitOrSkip(stepEl, g.lines.length * 600 + 1400);
  }

  startCyberTunnel();
  choices.hidden = false;
  const choice = await waitForOnbChoice(["onb-zero-confirm", "onb-zero-back"]);
  return choice === "onb-zero-confirm";
}

// PLAYER CONTRACT：確定した瞬間に、初めてサーバーへアカウントを作成する
async function runContractStep(s) {
  document.getElementById("onb-contract-player").textContent = `PLAYER：${s.username}`;
  const input = document.getElementById("onb-contract-input");
  const warn = document.getElementById("onb-contract-warn");
  input.value = s.contractGoal || s.reason || "";
  warn.textContent = "";
  showOnboardingStep("contract");

  const submitBtn = document.getElementById("onb-contract-submit");
  await new Promise((resolve) => {
    const handler = async () => {
      s.contractGoal = input.value.trim();
      submitBtn.disabled = true;
      warn.textContent = "";
      try {
        const userRecord = await registerPlayer(s);
        currentUserRecord = userRecord;
        safeLocalStorageSet(LAST_USERNAME_KEY, s.username);
        document.getElementById("current-user-label").textContent = `プレイヤー：${currentUserRecord.userName}`;
        clearRegistrationDraft();
        submitBtn.removeEventListener("click", handler);
        playConfirmSound();
        resolve();
      } catch (err) {
        warn.textContent = err.message || "登録に失敗しました。もう一度お試しください。";
        submitBtn.disabled = false;
      }
    };
    submitBtn.addEventListener("click", handler);
  });
}

// プレイヤー登録演出：入力内容→システムログ→操作権移行の順に表示する
async function playOnbRegistration(s) {
  const name = s.username;
  showOnboardingStep("registration");
  const stepEl = document.querySelector('[data-onb-step="registration"]');
  const box = document.getElementById("onb-registration-lines");
  box.innerHTML = "";

  // 新しい行が追加されるたびに、その行が見える位置まで画面を追従させる
  const scrollToLatest = (el) => {
    el.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  const addLine = async (text, cls, hold) => {
    const p = document.createElement("p");
    p.className = cls;
    p.textContent = text;
    box.appendChild(p);
    scrollToLatest(p);
    await waitOrSkip(stepEl, hold);
  };

  await addLine("PLAYER REGISTRATION START", "onb-reg-header", 900);

  const destination = Array.from(s.goalTags)[0] || "";
  const fields = [
    ["PLAYER", name],
    ["CURRENT POSITION", s.diagnosticLevel],
    ["DESTINATION", destination],
    ["REASON", s.reason],
    ["DAILY COMMITMENT", getEffectiveCadence(s)],
    ["RESOLVE", `${s.resolve}%`]
  ];
  for (const [label, value] of fields) {
    const wrap = document.createElement("div");
    wrap.className = "onb-reg-field";
    const l = document.createElement("p");
    l.className = "onb-reg-label";
    l.textContent = label;
    const v = document.createElement("p");
    v.className = "onb-reg-value";
    v.textContent = value || "—";
    const c = document.createElement("p");
    c.className = "onb-reg-confirmed";
    c.textContent = "CONFIRMED";
    wrap.appendChild(l);
    wrap.appendChild(v);
    wrap.appendChild(c);
    box.appendChild(wrap);
    scrollToLatest(wrap);
    playTone(880, 0, 0.05, "square", 0.05); // 1件登録されるたびの小さな確定音
    await waitOrSkip(stepEl, 450);
  }

  await waitOrSkip(stepEl, 500);
  const sysLines = [
    "Player Identity Confirmed...",
    "Current Position Analyzed...",
    "Purpose Verified...",
    "Commitment Registered...",
    "Growth Record Initialized...",
    "All Systems Ready."
  ];
  for (const line of sysLines) {
    await addLine(line, "onb-reg-sys", 480);
  }

  await waitOrSkip(stepEl, 400);
  playDeepImpactSound();
  await addLine(`人生の操作権を、\nPLAYER ${name}へ移行します。`, "onb-reg-final", 2000);
}

// 最終演説：設計者からプレイヤーへの短い言葉。締めにMISSION STARTボタンを出す
async function playOnbSpeech(s) {
  const name = s.username;
  showOnboardingStep("speech");
  const stepEl = document.querySelector('[data-onb-step="speech"]');
  const container = document.getElementById("onb-speech-lines");

  const groups = [
    { lines: [`PLAYER ${name}。`] },
    { lines: ["ここから記録されるのは、", "正解した回数だけではありません。"] },
    { lines: ["分からなかった問題。", "間違えた選択。", "それでも、もう一度挑戦した行動。"] },
    { lines: ["そのすべてが、", "あなたの経験値になります。"], emphasis: true },
    { lines: ["今の現在地が、", "あなたの限界ではありません。"] },
    { lines: ["今日から、", "あなた自身の成長を始めてください。"], emphasis: true }
  ];
  for (const g of groups) {
    renderOnbLines(container, g.lines, g.emphasis);
    await waitOrSkip(stepEl, g.lines.length * 550 + 1200);
  }

  container.innerHTML = "";
  const btn = document.getElementById("onb-mission-start");
  btn.hidden = false;
  playDiveCompleteSound();
  await waitForOnbButton("onb-mission-start");
  btn.hidden = true;
}

// メイン画面への移行演出：MISSION START→粒子の中に本人の言葉が
// 一瞬ずつ浮かぶ→収束→重低音→白転（WELCOMEメッセージ）→メイン画面
async function playOnboardingFinaleTransition(s) {
  const name = s.username;
  const overlay = document.getElementById("dive-connecting-overlay");
  const text = document.getElementById("dive-connecting-text");
  const player = document.getElementById("dive-sync-player");
  const whiteoutText = document.getElementById("dive-whiteout-text");

  player.textContent = name;
  text.textContent = "MISSION START";
  overlay.hidden = false;
  void overlay.offsetWidth;
  overlay.classList.add("show", "syncing");
  playDiveSyncSound();
  await waitOrSkip(overlay, 1000);

  // 登録した「目指す未来」「理由」「継続方法」が粒子の中に一瞬ずつ表示される
  const flashes = [Array.from(s.goalTags)[0], s.reason, getEffectiveCadence(s)].filter(Boolean);
  for (const line of flashes) {
    text.textContent = line;
    await waitOrSkip(overlay, 900);
  }

  overlay.classList.remove("syncing");
  overlay.classList.add("converging");
  playDeepImpactSound();
  await waitOrSkip(overlay, 450);

  overlay.classList.add("whiteout");
  whiteoutText.innerHTML = "";
  ["WELCOME,", `PLAYER ${name}.`].forEach((line, i) => {
    const p = document.createElement("p");
    p.style.animationDelay = `${i * 0.5}s`;
    p.textContent = line;
    whiteoutText.appendChild(p);
  });
  whiteoutText.hidden = false;
  await waitOrSkip(overlay, 2200);
  whiteoutText.hidden = true;

  showScreen("screen-start");
  refreshHomeExtras(); // 目的・診断結果入りでミッションカード等を再描画する
  overlay.classList.remove("show", "converging", "whiteout");
  setTimeout(() => { overlay.hidden = true; }, 350);
}

// 接続完了演出（粒子収束→白転→画面切り替え）。ログイン時・初回登録完了時の
// 両方から呼べるよう共通化した。「目を開けたらメイン画面にいる」没入感を狙う
async function playDiveRevealTransition(message, targetScreenId) {
  const connectingOverlay = document.getElementById("dive-connecting-overlay");
  const connectingText = document.getElementById("dive-connecting-text");
  connectingText.textContent = message;
  connectingOverlay.hidden = false;
  void connectingOverlay.offsetWidth;
  connectingOverlay.classList.add("show");
  playDiveCompleteSound();
  await waitOrSkip(connectingOverlay, 500);
  connectingOverlay.classList.add("converging");
  playDeepImpactSound();
  await waitOrSkip(connectingOverlay, 450);
  connectingOverlay.classList.add("whiteout");
  await waitOrSkip(connectingOverlay, 320);
  showScreen(targetScreenId); // 白転で覆われている間に瞬時に切り替える
  connectingOverlay.classList.remove("show", "converging", "whiteout", "syncing");
  setTimeout(() => { connectingOverlay.hidden = true; }, 350);
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

    // モード選択済みならエリア一覧を更新する
    if (state.mode) renderAreaChips();
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
      playSelectSound();
      renderAreaChips();
      validateStartButton();
    });
  });

  const countButtons = document.querySelectorAll("#count-select .option-btn");
  countButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      countButtons.forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      state.countOption = btn.dataset.count;
      playSelectSound();
      validateStartButton();
    });
  });

  const levelButtons = document.querySelectorAll("#level-select .option-btn");
  levelButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      levelButtons.forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      state.level = btn.dataset.level;
      playSelectSound();
    });
  });

  document.getElementById("btn-recommend-start").addEventListener("click", () => {
    const category = document.getElementById("recommend-card").dataset.category;
    if (!category) return;
    playSelectSound();
    document.querySelector('[data-mode="knowledge"]')?.click(); // renderAreaChips()がここで走る
    const chip = document.querySelector(`#category-chip-container .area-chip[data-value="${CSS.escape(category)}"]`);
    if (chip) {
      document.querySelectorAll("#category-chip-container .area-chip").forEach((b) => b.classList.remove("selected"));
      chip.classList.add("selected");
      state.categories = new Set([category]);
      updateAreaSummary();
    }
    document.querySelector('[data-level="初級"]')?.click();
    document.querySelector('[data-count="5"]')?.click();
    validateStartButton();
    document.getElementById("btn-start")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  document.getElementById("btn-start").addEventListener("click", beginQuizSession);
  document.getElementById("btn-reload-data").addEventListener("click", loadAllData);
  document.getElementById("btn-answer").addEventListener("click", submitAnswer);
  document.getElementById("btn-quit-early").addEventListener("click", quitQuizEarly);
  document.getElementById("btn-next").addEventListener("click", goToNextQuestion);
  document.getElementById("btn-restart").addEventListener("click", resetToStart);
  document.getElementById("btn-review-wrong").addEventListener("click", startReviewSession);

  document.getElementById("btn-show-ranking").addEventListener("click", () => {
    playSelectSound();
    showScreen("screen-ranking");
    renderRankingScreen();
  });
  document.getElementById("btn-ranking-back").addEventListener("click", () => {
    showScreen("screen-start");
  });
  // 画面上部にも戻るボタンを置き、下までスクロールしなくても戻れるようにする
  document.getElementById("btn-ranking-back-top").addEventListener("click", () => {
    showScreen("screen-start");
  });
}

/* ================================================================
   PLAYER LOG画面（個人学習記録）
   ----------------------------------------------------------------
   ・月間カレンダー＋選択日の詳細（サマリー／ジャンル別／難易度別／
   　セッション履歴）を表示する、他プレイヤーからは見えない個人専用画面。
   ・表示のたびに現在の状態から過去を推測するのではなく、
   　quiz_sessions／answer_historyという一次データをRPC経由で
   　都度集計して描画する（データが古くなる/ズレる心配がない）。
   ================================================================ */

const PL_MONTH_EN = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"
];
const PL_WEEKDAY_JP = ["日", "月", "火", "水", "木", "金", "土"];
const PL_MODE_LABEL = { knowledge: "基礎任務", practice: "判断任務", mix: "混成任務" };

const playerLogState = {
  year: null,
  month: null,
  selectedDate: null, // "YYYY-MM-DD"
  monthData: []
};

function plPad2(n) { return String(n).padStart(2, "0"); }
function plDateKey(y, m, d) { return `${y}-${plPad2(m)}-${plPad2(d)}`; }
function plTodayKey() {
  const now = new Date();
  return plDateKey(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function setupPlayerLog() {
  document.getElementById("btn-show-player-log").addEventListener("click", () => {
    playSelectSound();
    openPlayerLog();
  });
  document.getElementById("btn-open-player-log").addEventListener("click", openPlayerLog);
  document.getElementById("btn-player-log-back-top").addEventListener("click", () => showScreen("screen-start"));

  document.getElementById("pl-cal-prev").addEventListener("click", () => {
    let { year, month } = playerLogState;
    month -= 1;
    if (month < 1) { month = 12; year -= 1; }
    loadPlayerLogMonth(year, month);
  });
  document.getElementById("pl-cal-next").addEventListener("click", () => {
    let { year, month } = playerLogState;
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    loadPlayerLogMonth(year, month);
  });

  document.getElementById("pl-cal-title").addEventListener("click", () => {
    const panel = document.getElementById("pl-month-picker");
    if (panel.hidden) {
      populatePlayerLogMonthPicker();
      panel.hidden = false;
    } else {
      panel.hidden = true;
    }
  });
  document.getElementById("pl-picker-go").addEventListener("click", () => {
    const y = Number(document.getElementById("pl-picker-year").value);
    const m = Number(document.getElementById("pl-picker-month").value);
    document.getElementById("pl-month-picker").hidden = true;
    playSelectSound();
    loadPlayerLogMonth(y, m);
  });

  document.querySelectorAll("#pl-day-tabs .pl-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#pl-day-tabs .pl-tab-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      playSelectSound();
      const tab = btn.dataset.pltab;
      document.querySelectorAll(".pl-tab-panel").forEach((p) => {
        p.hidden = p.dataset.pltabPanel !== tab;
      });
    });
  });

  document.getElementById("pl-day-start-btn").addEventListener("click", () => showScreen("screen-start"));
  document.getElementById("pl-day-retry-btn").addEventListener("click", () => {
    if (playerLogState.selectedDate) loadPlayerLogDayDetail(playerLogState.selectedDate);
  });
}

function populatePlayerLogMonthPicker() {
  const yearSel = document.getElementById("pl-picker-year");
  const monthSel = document.getElementById("pl-picker-month");
  if (yearSel.options.length === 0) {
    const nowYear = new Date().getFullYear();
    for (let y = nowYear - 5; y <= nowYear; y++) {
      const opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = `${y}年`;
      yearSel.appendChild(opt);
    }
    for (let m = 1; m <= 12; m++) {
      const opt = document.createElement("option");
      opt.value = String(m);
      opt.textContent = `${m}月`;
      monthSel.appendChild(opt);
    }
  }
  yearSel.value = String(playerLogState.year);
  monthSel.value = String(playerLogState.month);
}

// PLAYER LOG画面を開く。初回表示時の選択日は
// 「今日学習済みなら今日 → 今月に学習日があれば直近の学習日 →
// 　記録のある最新の月へ切り替えてその最新の学習日 → それも無ければ今日」の順に決める
async function openPlayerLog() {
  if (!currentUserRecord) return;
  showScreen("screen-player-log");
  document.getElementById("pl-month-picker").hidden = true;

  loadPlayerLogOverview();

  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth() + 1;
  await loadPlayerLogMonth(y, m);

  const todayKey = plTodayKey();
  const todayRow = playerLogState.monthData.find((r) => r.study_date === todayKey);
  if (todayRow && todayRow.answered_count > 0) {
    playerLogState.selectedDate = todayKey;
  } else {
    const pastRows = playerLogState.monthData.filter((r) => r.study_date <= todayKey && r.answered_count > 0);
    if (pastRows.length > 0) {
      playerLogState.selectedDate = pastRows[pastRows.length - 1].study_date;
    } else {
      try {
        const months = await fetchPlayerLogMonths(currentUserRecord.id);
        if (months.length > 0) {
          const latest = months[months.length - 1];
          if (latest.year !== y || latest.month !== m) {
            await loadPlayerLogMonth(latest.year, latest.month);
          }
        }
      } catch (err) {
        console.error("学習記録月一覧の取得に失敗しました:", err.message);
      }
      const rows = playerLogState.monthData.filter((r) => r.answered_count > 0);
      playerLogState.selectedDate = rows.length > 0 ? rows[rows.length - 1].study_date : todayKey;
    }
  }

  renderPlayerLogCalendar();
  loadPlayerLogDayDetail(playerLogState.selectedDate);
}

async function loadPlayerLogOverview() {
  if (!currentUserRecord) return null;
  try {
    const ov = await fetchPlayerLogOverview(currentUserRecord.id);
    document.getElementById("pl-overview-current-streak").textContent = `${ov.current_streak} DAYS`;
    document.getElementById("pl-overview-best-streak").textContent = `${ov.best_streak} DAYS`;
    document.getElementById("pl-overview-total-days").textContent = `${ov.total_study_days} DAYS`;
    document.getElementById("pl-overview-total-answered").textContent = `${ov.total_answered.toLocaleString()}`;
    return ov;
  } catch (err) {
    console.error("学習概況の取得に失敗しました:", err.message);
    return null;
  }
}

async function loadPlayerLogMonth(year, month) {
  playerLogState.year = year;
  playerLogState.month = month;
  document.getElementById("pl-cal-title").textContent = `＜ ${year}年${month}月 ＞`;
  document.getElementById("pl-month-report-title").textContent = `${PL_MONTH_EN[month - 1]} REPORT`;
  try {
    playerLogState.monthData = await fetchPlayerLogMonth(currentUserRecord.id, year, month);
  } catch (err) {
    console.error("月間学習記録の取得に失敗しました:", err.message);
    playerLogState.monthData = [];
  }
  renderPlayerLogMonthReport();
  renderPlayerLogCalendar();
}

function renderPlayerLogMonthReport() {
  const rows = playerLogState.monthData;
  const answered = rows.reduce((s, r) => s + r.answered_count, 0);
  const correct = rows.reduce((s, r) => s + r.correct_count, 0);
  const exp = rows.reduce((s, r) => s + r.earned_exp, 0);
  const rate = answered > 0 ? Math.round((correct / answered) * 1000) / 10 : null;
  document.getElementById("pl-mr-days").textContent = `${rows.length}日`;
  document.getElementById("pl-mr-answered").textContent = `${answered}問`;
  document.getElementById("pl-mr-rate").textContent = rate === null ? "記録なし" : `${rate}%`;
  document.getElementById("pl-mr-exp").textContent = `+${exp.toLocaleString()}`;
}

function plVolClass(count) {
  if (count <= 0) return "vol-0";
  if (count < 5) return "vol-1";
  if (count < 10) return "vol-2";
  if (count < 20) return "vol-3";
  return "vol-4";
}

function renderPlayerLogCalendar() {
  const grid = document.getElementById("pl-cal-grid");
  grid.innerHTML = "";
  const { year, month } = playerLogState;
  const rowsByDate = {};
  playerLogState.monthData.forEach((r) => { rowsByDate[r.study_date] = r; });

  const firstDay = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const jsDow = firstDay.getDay(); // 0=日 .. 6=土
  const leadBlanks = (jsDow + 6) % 7; // 月曜始まりに変換
  const todayKey = plTodayKey();

  for (let i = 0; i < leadBlanks; i++) {
    const blank = document.createElement("div");
    blank.className = "pl-cal-cell empty";
    grid.appendChild(blank);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const key = plDateKey(year, month, d);
    const row = rowsByDate[key];
    const count = row ? row.answered_count : 0;
    const isFuture = key > todayKey;

    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = `pl-cal-cell ${plVolClass(count)}`;
    if (isFuture) cell.classList.add("future");
    if (key === todayKey) cell.classList.add("today");
    if (key === playerLogState.selectedDate) cell.classList.add("selected");

    const dayNum = document.createElement("span");
    dayNum.className = "pl-cal-day-num";
    dayNum.textContent = String(d);
    cell.appendChild(dayNum);

    if (count > 0) {
      const cnt = document.createElement("span");
      cnt.className = "pl-cal-day-count";
      cnt.textContent = `${count}問`;
      cell.appendChild(cnt);
    }
    if (row && row.leveled_up) {
      const dot = document.createElement("span");
      dot.className = "pl-cal-levelup-dot";
      cell.appendChild(dot);
    }

    if (!isFuture) {
      cell.addEventListener("click", () => {
        playSelectSound();
        playerLogState.selectedDate = key;
        renderPlayerLogCalendar();
        loadPlayerLogDayDetail(key);
      });
    }
    grid.appendChild(cell);
  }
}

function plFormatDateLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return `${y}年${m}月${d}日 ${PL_WEEKDAY_JP[dow]}曜日`;
}

function plFormatStudyDuration(seconds) {
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin}分`;
  const h = Math.floor(totalMin / 60);
  const mi = totalMin % 60;
  return `${h}時間${mi}分`;
}

function plFormatTimeHM(iso) {
  const d = new Date(iso);
  return `${plPad2(d.getHours())}:${plPad2(d.getMinutes())}`;
}

async function loadPlayerLogDayDetail(dateKeyStr) {
  const loadingEl = document.getElementById("pl-day-loading");
  const errorEl = document.getElementById("pl-day-error");
  const emptyEl = document.getElementById("pl-day-empty");
  const contentEl = document.getElementById("pl-day-content");

  document.getElementById("pl-day-date").textContent = plFormatDateLabel(dateKeyStr);
  loadingEl.hidden = false;
  errorEl.hidden = true;
  emptyEl.hidden = true;
  contentEl.hidden = true;

  try {
    const [summary, categories, difficulties, sessions] = await Promise.all([
      fetchPlayerLogDaySummary(currentUserRecord.id, dateKeyStr),
      fetchPlayerLogDayCategories(currentUserRecord.id, dateKeyStr),
      fetchPlayerLogDayDifficulties(currentUserRecord.id, dateKeyStr),
      fetchPlayerLogDaySessions(currentUserRecord.id, dateKeyStr)
    ]);
    loadingEl.hidden = true;

    if (!summary || summary.answered_count === 0) {
      emptyEl.hidden = false;
      document.getElementById("pl-day-start-btn").hidden = dateKeyStr !== plTodayKey();
      return;
    }

    contentEl.hidden = false;
    renderPlayerLogDaySummary(summary);
    renderBreakdownList("pl-category-list", categories, "category");
    renderBreakdownList("pl-difficulty-list", difficulties, "difficulty");
    renderPlayerLogDaySessions(sessions);
  } catch (err) {
    console.error("学習記録の取得に失敗しました:", err.message);
    loadingEl.hidden = true;
    errorEl.hidden = false;
  }
}

function renderPlayerLogDaySummary(s) {
  const rate = s.answered_count > 0 ? Math.round((s.correct_count / s.answered_count) * 1000) / 10 : null;
  document.getElementById("pl-day-answered").textContent = `${s.answered_count}問`;
  document.getElementById("pl-day-correct").textContent = `${s.correct_count}問`;
  document.getElementById("pl-day-incorrect").textContent = `${s.incorrect_count}問`;
  document.getElementById("pl-day-rate").textContent = rate === null ? "記録なし" : `${rate}%`;
  document.getElementById("pl-day-time").textContent = plFormatStudyDuration(s.study_seconds);
  document.getElementById("pl-day-exp").textContent = `+${s.earned_exp} EXP`;
}

// ジャンル別・難易度別で共通の内訳リスト（項目名・正解率バー・n/n問正解）を組み立てる
function renderBreakdownList(containerId, rows, labelKey) {
  const wrap = document.getElementById(containerId);
  wrap.innerHTML = "";
  if (rows.length === 0) {
    const p = document.createElement("p");
    p.className = "muted-text";
    p.textContent = "この日のデータはありません。";
    wrap.appendChild(p);
    return;
  }
  rows.forEach((r) => {
    wrap.appendChild(buildBreakdownRow(r[labelKey], r.answered_count, r.correct_count));
  });
}

function buildBreakdownRow(label, answered, correct) {
  const rate = answered > 0 ? Math.round((correct / answered) * 1000) / 10 : 0;
  const row = document.createElement("div");
  row.className = "pl-breakdown-row";

  const head = document.createElement("div");
  head.className = "pl-breakdown-row-head";
  const nameEl = document.createElement("span");
  nameEl.className = "pl-breakdown-name";
  nameEl.textContent = label;
  const rateEl = document.createElement("span");
  rateEl.className = "pl-breakdown-rate";
  rateEl.textContent = `${rate}%`;
  head.appendChild(nameEl);
  head.appendChild(rateEl);

  const track = document.createElement("div");
  track.className = "pl-breakdown-bar-track";
  const fill = document.createElement("div");
  fill.className = "pl-breakdown-bar-fill";
  fill.style.width = `${Math.min(100, rate)}%`;
  track.appendChild(fill);

  const sub = document.createElement("p");
  sub.className = "pl-breakdown-sub";
  sub.textContent = `${correct} / ${answered}問正解`;

  row.appendChild(head);
  row.appendChild(track);
  row.appendChild(sub);
  return row;
}

function renderPlayerLogDaySessions(rows) {
  const wrap = document.getElementById("pl-session-list");
  wrap.innerHTML = "";
  if (rows.length === 0) {
    const p = document.createElement("p");
    p.className = "muted-text";
    p.textContent = "この日のセッション記録はありません。";
    wrap.appendChild(p);
    return;
  }
  rows.forEach((r, i) => {
    const item = document.createElement("div");
    item.className = "pl-session-item";

    const head = document.createElement("p");
    head.className = "pl-session-head";
    const timeRange = `${plFormatTimeHM(r.started_at)}〜${r.ended_at ? plFormatTimeHM(r.ended_at) : "-"}`;
    head.textContent = `SESSION ${plPad2(i + 1)}　${timeRange}`;
    if (r.exited_early) {
      const tag = document.createElement("span");
      tag.className = "pl-session-tag";
      tag.textContent = "途中退出";
      head.appendChild(tag);
    }

    const meta = document.createElement("p");
    meta.className = "pl-session-meta";
    const modeLabel = PL_MODE_LABEL[r.mode] || r.mode || "任務";
    const parts = [modeLabel];
    if (r.category && r.category !== "全エリア") parts.push(r.category);
    if (r.difficulty && r.difficulty !== "全レベル") parts.push(r.difficulty);
    meta.textContent = parts.join("／");

    const result = document.createElement("p");
    result.className = "pl-session-result";
    result.textContent = `${r.answered_count}問中${r.correct_count}問正解／獲得EXP：+${r.earned_exp}`;

    item.appendChild(head);
    item.appendChild(meta);
    item.appendChild(result);
    wrap.appendChild(item);
  });
}

// スタート画面のPLAYER LOG導線カード（今日の実績＋連続学習日数）を更新する
async function refreshPlayerLogHomeCard() {
  const card = document.getElementById("player-log-home-card");
  if (!currentUserRecord || !card) return;
  card.hidden = false;
  const todayKey = plTodayKey();
  try {
    const [summary, overview] = await Promise.all([
      fetchPlayerLogDaySummary(currentUserRecord.id, todayKey),
      fetchPlayerLogOverview(currentUserRecord.id)
    ]);
    const answered = summary ? summary.answered_count : 0;
    const correct = summary ? summary.correct_count : 0;
    const exp = summary ? summary.earned_exp : 0;
    const rate = answered > 0 ? Math.round((correct / answered) * 1000) / 10 : null;
    document.getElementById("pl-home-today-count").textContent = `${answered}問`;
    document.getElementById("pl-home-today-rate").textContent = rate === null ? "-" : `${rate}%`;
    document.getElementById("pl-home-today-exp").textContent = `+${exp} EXP`;
    document.getElementById("pl-home-streak").textContent = overview ? `${overview.current_streak}日` : "-";
  } catch (err) {
    console.error("PLAYER LOGホームカードの取得に失敗しました:", err.message);
  }
}

// 現在選択中の攻略者ボードの種類（タブ）
let currentRankingType = "overall";

const RANKING_SUBCOPY = {
  overall: "正答率が高い順に表示しています（上位100名）",
  streak: "毎日欠かさずログインしている日数が多い順に表示しています（上位100名）",
  weekly: "直近7日間の正解数が多い順に表示しています（上位100名）",
  monthly: "直近30日間の正解数が多い順に表示しています（上位100名）",
  combo: "最大コンボ数が多い順に表示しています（上位100名）",
  suppression: "正答率が高い順に表示しています（上位100名）",
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
      playSelectSound();
      document.getElementById("ranking-sub").textContent = RANKING_SUBCOPY[currentRankingType] || "";
      renderRankingScreen();
    });
  });
}

// 順位ごとの見た目（1位=金・2位=銀・3位=銅のふち、カードの大きさは1→2→3→4位の順に
// 小さくなり、4位以降はすべて同じ最小サイズにして視覚的にメリハリを付ける）
function buildRankingRowRankClass(rank) {
  const rankClass = rank === 1 ? "rank-gold" : rank === 2 ? "rank-silver" : rank === 3 ? "rank-bronze" : "";
  const sizeClass = `rank-size-${Math.min(rank, 4)}`;
  return `${rankClass} ${sizeClass}`.trim();
}

// "YYYY-MM-DD" 形式の日付文字列を「M月D日」に変換する（欠損時は「-」）
function formatDateJp(dateStr) {
  if (!dateStr) return "-";
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "-";
  return `${Number(m[2])}月${Number(m[3])}日`;
}

// 攻略者ボードのタブごとに、表示する見出し行・詳細行の中身を組み立てる
function buildRankingStatsLines(type, row) {
  const levelLine = `Lv.${row.level ?? 1} ${getLevelTitle(row.level ?? 1)} ／ 累計EXP ${(row.total_exp ?? 0).toLocaleString()}`;
  switch (type) {
    case "streak":
      return {
        headline: `連続ログイン ${row.streak_days}日`,
        detail: [`最終ログイン：${formatDateJp(row.last_active_date)}`, levelLine]
      };
    case "weekly":
      return {
        headline: `今週の正解数 ${row.weekly_correct}問`,
        detail: [`今週の解答数 ${row.weekly_answered}問`, levelLine]
      };
    case "monthly":
      return {
        headline: `今月の正解数 ${row.monthly_correct}問`,
        detail: [`今月の解答数 ${row.monthly_answered}問`, levelLine]
      };
    case "combo":
      return {
        headline: `最大コンボ ${row.best_streak}`,
        detail: [levelLine]
      };
    case "suppression":
      return {
        headline: `正答率 ${row.best_rate}%`,
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
      // 上位5名の下に圏外の自分の行が続く場合、順位が飛ぶことを「⋯」で示す
      const prevRank = idx > 0 ? rows[idx - 1].rank : 0;
      if (row.rank > prevRank + 1) {
        const gap = document.createElement("div");
        gap.className = "ranking-gap";
        gap.textContent = "⋯";
        listEl.appendChild(gap);
      }

      const item = document.createElement("div");
      item.className = "ranking-row " + buildRankingRowRankClass(row.rank);
      if (row.is_self) item.classList.add("ranking-row-self");

      const rank = document.createElement("span");
      rank.className = "ranking-rank";
      rank.textContent = `${row.rank}`;

      const name = document.createElement("span");
      name.className = "ranking-name";
      name.textContent = row.username;
      if (row.is_self) {
        const selfTag = document.createElement("span");
        selfTag.className = "ranking-self-tag";
        selfTag.textContent = "YOU";
        name.appendChild(selfTag);
      }
      if (row.equipped_badge_title) {
        const titleTag = document.createElement("span");
        titleTag.className = "ranking-title-tag";
        titleTag.textContent = row.equipped_badge_title;
        name.appendChild(titleTag);
      }

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

// エリア一覧は「実際に生成された問題」から動的に作る。
// 将来スプレッドシートに新ジャンルのシートを追加しても、
// 問題さえ生成されればエリアが自動的にチップとして現れます。
// 「不正解問題」「正解問題」は、現在のユーザーの不正解/正解済みリストに
// 該当モードの問題が1問でもある場合だけチップとして追加する（無ければ出さない）。
//
// 1章〜8章の座学系エリアは章ごとの見出しでグルーピングせず、フラットな
// チップとして横並びに表示する（「入門」「1章 太陽光発電」も同列）。
// 製品ベースのエリア（保証・容量・停電対策など）だけ「製品問題」の
// 見出しでまとめる。複数エリアを同時選択可能（トグル式チップ）。
function renderAreaChips() {
  const container = document.getElementById("category-chip-container");
  container.innerHTML = "";
  // 前回の選択は保持する（毎回選び直す手間を省く）。再構築後に、
  // 現在のモードでも存在するチップだけ選択状態を復元する
  const previousSelection = state.categories instanceof Set ? state.categories : new Set();
  state.categories = new Set();

  let pool;
  if (state.mode === "knowledge") pool = knowledgeQuestions;
  else if (state.mode === "practice") pool = practiceQuestions;
  else pool = knowledgeQuestions.concat(practiceQuestions);

  const present = new Set(pool.map((q) => q.category));
  const ordered = CATEGORY_ORDER.filter((c) => present.has(c));
  // 表示順リストにないカテゴリ（将来の新ジャンル）も末尾に追加する
  present.forEach((c) => { if (!ordered.includes(c)) ordered.push(c); });

  const wrongIds = currentUserRecord ? currentUserRecord.wrongQuestionIds : [];
  const correctIds = currentUserRecord ? currentUserRecord.correctQuestionIds : [];
  const wrongCountInPool = pool.filter((q) => wrongIds.includes(q.id)).length;
  const correctCountInPool = pool.filter((q) => correctIds.includes(q.id)).length;

  const allChip = makeAreaChip("全エリア", "全エリア", "area-chip-all selected");

  const topGrid = document.createElement("div");
  topGrid.className = "area-chip-grid";
  topGrid.appendChild(allChip);
  if (wrongCountInPool > 0) topGrid.appendChild(makeAreaChip(WRONG_CATEGORY, `要再挑戦リスト（${wrongCountInPool}問）`));
  if (correctCountInPool > 0) topGrid.appendChild(makeAreaChip(CORRECT_CATEGORY, `正解問題（${correctCountInPool}問）`));
  container.appendChild(topGrid);

  const flatGrid = document.createElement("div");
  flatGrid.className = "area-chip-grid";
  ordered
    .filter((cat) => genreOfCategory(cat) !== "製品問題")
    .forEach((cat) => flatGrid.appendChild(makeAreaChip(cat, categoryDisplayLabel(cat))));
  if (flatGrid.children.length > 0) container.appendChild(flatGrid);

  const productCats = ordered.filter((cat) => genreOfCategory(cat) === "製品問題");
  if (productCats.length > 0) {
    const label = document.createElement("p");
    label.className = "area-chip-section-label";
    label.textContent = "製品問題";
    container.appendChild(label);
    const productGrid = document.createElement("div");
    productGrid.className = "area-chip-grid";
    productCats.forEach((cat) => productGrid.appendChild(makeAreaChip(cat, cat)));
    container.appendChild(productGrid);
  }

  // 前回選択していたエリアを復元する（モード変更で消えたチップの分は選択から外れる）
  previousSelection.forEach((v) => {
    if (v === "全エリア") return;
    const btn = container.querySelector(`.area-chip[data-value="${CSS.escape(v)}"]`);
    if (btn) {
      state.categories.add(v);
      btn.classList.add("selected");
    }
  });
  if (state.categories.size > 0) allChip.classList.remove("selected");
  updateAreaSummary();
}

// エリアカードのヘッダーに、現在の選択内容を1行で要約表示する
function updateAreaSummary() {
  const summary = document.getElementById("area-selected-summary");
  if (!summary) return;
  if (!state.categories || state.categories.size === 0) {
    summary.textContent = "全エリア";
  } else if (state.categories.size <= 2) {
    summary.textContent = Array.from(state.categories)
      .map((v) => categoryDisplayLabel(v)).join("、");
  } else {
    summary.textContent = `${state.categories.size}エリア選択中`;
  }
}

// エリアカードの折りたたみトグルと、選択リセットボタン
function setupAreaCard() {
  const card = document.getElementById("area-card");
  const toggleBtn = document.getElementById("btn-area-toggle");
  const resetBtn = document.getElementById("btn-area-reset");
  if (!card || !toggleBtn || !resetBtn) return;

  toggleBtn.addEventListener("click", () => {
    playSelectSound();
    card.classList.toggle("expanded");
  });

  resetBtn.addEventListener("click", () => {
    playSelectSound();
    state.categories = new Set();
    const container = document.getElementById("category-chip-container");
    container.querySelectorAll(".area-chip").forEach((b) => b.classList.remove("selected"));
    const allBtn = container.querySelector(".area-chip-all");
    if (allBtn) allBtn.classList.add("selected");
    updateAreaSummary();
  });
}

// エリアチップ1個を生成する（クリックでトグル選択。「全エリア」は他の選択を全解除する特別扱い）
function makeAreaChip(value, label, extraClass) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = extraClass ? `area-chip ${extraClass}` : "area-chip";
  btn.textContent = label;
  btn.dataset.value = value;
  btn.addEventListener("click", () => toggleAreaChip(value, btn));
  return btn;
}

function toggleAreaChip(value, btnEl) {
  playSelectSound();
  const container = document.getElementById("category-chip-container");
  const allBtn = container.querySelector(".area-chip-all");

  if (value === "全エリア") {
    state.categories.clear();
    container.querySelectorAll(".area-chip").forEach((b) => b.classList.remove("selected"));
    allBtn.classList.add("selected");
    updateAreaSummary();
    return;
  }

  allBtn.classList.remove("selected");
  if (state.categories.has(value)) {
    state.categories.delete(value);
    btnEl.classList.remove("selected");
  } else {
    state.categories.add(value);
    btnEl.classList.add("selected");
  }
  if (state.categories.size === 0) {
    allBtn.classList.add("selected");
  }
  updateAreaSummary();
}

// PLAYER LOGへの記録・セッション表示用に、選択中エリアを1つの文字列にまとめる
function categoryLabelForLog(categories) {
  if (!categories || categories.size === 0) return "全エリア";
  return Array.from(categories).join("、");
}

function validateStartButton() {
  const btn = document.getElementById("btn-start");
  btn.disabled = !(state.mode && state.countOption && state.dataLoaded && currentUserRecord);
}

// ---- 出題プールを組み立ててセッションを開始する ----
async function beginQuizSession() {
  const pool = buildFilteredPool(state.mode, state.categories, state.level);

  if (pool.length === 0) {
    document.getElementById("start-warning").textContent =
      "選択した条件に合う任務がありません。エリアやレベルを変更してください。";
    return;
  }
  document.getElementById("start-warning").textContent = "";
  playConfirmSound(); // 任務条件の確定をシステムが受理したことを伝える

  const n = state.countOption === "all" ? pool.length : Math.min(Number(state.countOption), pool.length);
  state.sessionQuestions = pickSessionQuestions(pool, n, state.mode);
  state.currentIndex = 0;
  state.userAnswers = [];
  state.isReviewSession = state.categories.has(WRONG_CATEGORY) || state.categories.has(CORRECT_CATEGORY);
  state.exitedEarly = false;
  newStreakRecordThisSession = false;
  resetSessionExpTracking();

  // PLAYER LOG用のセッション行を作る（各回答のsession_idに使うため開始を待つ）
  state.currentSessionId = currentUserRecord
    ? await startPlayerLogSession(currentUserRecord.id, state.mode, categoryLabelForLog(state.categories), state.level, state.countOption)
    : null;

  showScreen("screen-quiz");
  renderQuestion();
  showGoalConnectionToast(); // 今日の一歩を、初回登録時の「変えたい未来」に接続する
}

// 任務開始時に、初回登録で宣言した目的とのつながりを一言だけ表示する
// （初回登録前のユーザーや目的未登録の場合は何も出さない）
function showGoalConnectionToast() {
  if (!currentUserRecord) return;
  const goal =
    (currentUserRecord.goalTags && currentUserRecord.goalTags[0]) ||
    currentUserRecord.contractGoal || "";
  if (!goal) return;
  const toast = document.getElementById("streak-toast");
  if (!toast) return;
  toast.textContent = `今日の一歩は「${goal}」という目的に接続されています`;
  toast.hidden = false;
  void toast.offsetWidth;
  toast.classList.add("show");
  clearTimeout(streakToastTimer);
  streakToastTimer = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => { toast.hidden = true; }, 300);
  }, 2800);
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

// categoriesは選択中エリアのSet（複数可）。空Set＝「全エリア」で絞り込みなし。
// 選択された各エリアに該当する問題の和集合（OR条件）を返す。
function buildFilteredPool(mode, categories, level) {
  let pool;
  if (mode === "knowledge") pool = knowledgeQuestions;
  else if (mode === "practice") pool = practiceQuestions;
  else pool = knowledgeQuestions.concat(practiceQuestions);

  if (categories && categories.size > 0) {
    const wrongIds = currentUserRecord ? currentUserRecord.wrongQuestionIds : [];
    const correctIds = currentUserRecord ? currentUserRecord.correctQuestionIds : [];
    pool = pool.filter((q) => {
      for (const cat of categories) {
        if (cat === WRONG_CATEGORY) { if (wrongIds.includes(q.id)) return true; }
        else if (cat === CORRECT_CATEGORY) { if (correctIds.includes(q.id)) return true; }
        else if (q.category === cat) return true;
      }
      return false;
    });
  }

  if (level && level !== "全レベル") {
    pool = pool.filter((q) => q.difficulty === level);
  }

  return pool;
}

// ---- 途中退出：それまでに回答した分だけで結果画面を表示する ----
function quitQuizEarly() {
  const answeredCount = state.userAnswers.length;
  const message = answeredCount === 0
    ? "まだ1問も回答していませんが、ここで任務を中断しますか？"
    : `ここまで${answeredCount}問回答済みです。ここで任務を中断して結果を見ますか？`;
  const ok = confirm(message);
  if (!ok) return;

  state.exitedEarly = true;
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
      playSelectSound();
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
  document.getElementById("result-next-mission").textContent = getRecommendedMissionText(
    rate,
    currentUserRecord ? currentUserRecord.wrongQuestionIds.length : 0,
    state.level
  );

  const knowledgeAnswers = state.userAnswers.filter((a) => a.question.mode === "knowledge");
  const practiceAnswers = state.userAnswers.filter((a) => a.question.mode === "practice");
  document.getElementById("result-knowledge-rate").textContent = formatRate(knowledgeAnswers);
  document.getElementById("result-practice-rate").textContent = formatRate(practiceAnswers);

  // 自己ベスト更新チェックはローカルで即座に行い（通信を待たず演出を出す）。
  // 「自己ベスト」表示は当日のみ・毎日リセットする仕様のため、当日の記録
  // （todayBestScore/todayBestRate）を基準に判定する。全期間の記録
  // （bestScore/bestRate）は称号判定・攻略者ボード用に引き続き保持する。
  let isNewRecord = newStreakRecordThisSession;
  if (currentUserRecord) {
    if (correctCount > currentUserRecord.bestScore) currentUserRecord.bestScore = correctCount;
    if (rate > currentUserRecord.bestRate) currentUserRecord.bestRate = rate;
    if (correctCount > currentUserRecord.todayBestScore) {
      currentUserRecord.todayBestScore = correctCount;
      isNewRecord = true;
    }
    if (rate > currentUserRecord.todayBestRate) {
      currentUserRecord.todayBestRate = rate;
      isNewRecord = true;
    }
    // 称号判定がサーバー側の最新値（best_rate等）を参照するため、ここはawaitする
    const sessionResult = await recordSessionResultForUser(currentUserRecord.id, correctCount, rate);
    if (sessionResult) {
      currentUserRecord.todayBestScore = sessionResult.today_best_score;
      currentUserRecord.todayBestRate = sessionResult.today_best_rate;
    }
  }
  document.getElementById("new-record-banner").hidden = !isNewRecord;

  // 経験値（EXP）はセッション中クライアント側で積算しておき、結果画面表示時に
  // まとめてサーバーへ反映する（通信回数を抑えるため。反映はここで1回のみawaitする）
  document.getElementById("result-exp-gained").textContent = `+${state.sessionExp} EXP 獲得！`;
  let expLevelBefore = currentUserRecord ? currentUserRecord.level : null;
  let expLevelAfter = expLevelBefore;
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
        expLevelAfter = expResult.new_level;

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

    // PLAYER LOG用のセッション行を確定させる（途中退出でも回答済み分・獲得EXPは記録する）
    finishPlayerLogSession(state.currentSessionId, {
      answeredCount: total,
      correctCount,
      incorrectCount: damageCount,
      earnedExp: state.sessionExp,
      levelBefore: expLevelBefore,
      levelAfter: expLevelAfter,
      completed: !state.exitedEarly,
      exitedEarly: state.exitedEarly
    });
    state.currentSessionId = null;
    state.exitedEarly = false;
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
    document.getElementById("result-best-score").textContent = `${r.todayBestScore}問`;
    document.getElementById("result-best-rate").textContent = `${r.todayBestRate}%`;
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
  // 任務モード・エリア・レベル・任務規模の選択はあえてリセットしない。
  // 「同じ条件でもう一度」が最頻の使い方なので、毎回選び直す手間を省く
  // （エリアはヘッダーのリセットボタンでいつでも全解除できる）
  state.sessionQuestions = [];
  state.currentIndex = 0;
  state.userAnswers = [];
  state.isReviewSession = false;

  // 要再挑戦リスト・正解問題の問題数が任務結果で変わるため、
  // チップを再構築する（選択状態はrenderAreaChips内で復元される）
  if (state.mode) renderAreaChips();

  validateStartButton();
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
  // デジタルトンネル背景（#cyber-bg）は全画面共通。ログイン画面では
  // 半透明の#dive-bgが上に重なり、トンネルがうっすら透けて見える
  // ダイブ画面・初回登録儀式の表示中は、スワイプや入力欄フォーカスで
  // ページ自体が上下に動かないよう画面全体を固定する（儀式の内容が
  // 収まらない端末では、儀式画面の内側だけ縦スクロールできる）
  const lockPage = (id === "screen-user" || id === "screen-onboarding");
  document.documentElement.classList.toggle("dive-active", lockPage);
  document.body.classList.toggle("dive-active", lockPage);

  // ログイン画面・初回登録儀式の間は没入感を優先し、ワールド辞典アイコンを隠す
  const dictToggle = document.getElementById("btn-dictionary-toggle");
  if (dictToggle) dictToggle.hidden = (id === "screen-user" || id === "screen-onboarding");
}

// ---- アプリ起動 ----
window.addEventListener("DOMContentLoaded", initApp);
