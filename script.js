/* ================================================================
   蓄電池メーカー比較クイズ - script.js（スプレッドシート連携版）
   ----------------------------------------------------------------
   このファイルは大きく5つのパートに分かれています。
   [パート1] 設定（スプレッドシートID・シート構成）
   [パート2] スプレッドシート読み込み・CSVパース・列名マッピング
   [パート3] 知識問題の自動生成ロジック
   [パート4] 実践提案問題の自動生成ロジック
   [パート5] 画面制御・クイズ進行ロジック（アプリ本体）

   ★ データはすべてGoogleスプレッドシートから読み込みます。
     アプリ内にはデータを一切埋め込んでいません。
     スプレッドシートを編集 → アプリを再読み込みするだけで
     問題が最新データから自動生成されます。

   ★ 注意：Googleの仕様上、file:// で直接HTMLを開くと
     スプレッドシートの読み込みがブロックされます（CORS制限）。
     必ずローカルサーバー経由（http://localhost/...）で開いてください。
     例：フォルダ内で  python -m http.server 8000  を実行し
         http://localhost:8000 をブラウザで開く
   ================================================================ */


/* ================================================================
   [パート1] 設定
   ================================================================ */

// 読み込むGoogleスプレッドシートのID（URLの /d/ と /edit の間の文字列）
const SPREADSHEET_ID = "13746scYc9hBgqWgvCyXuCS9olrbaxWqsIvDpLiwjtBw";

// 読み込むシートの一覧。
// 将来「屋根の特徴」「地域ごとの補助金」「エコキュート」など
// 別ジャンルのシートを追加したくなったら、ここに追記していく想定です。
//   name  : 画面表示やログで使う名前
//   sheet : スプレッドシート下部のタブ名（"" なら先頭のシートを読む）
//   type  : データの種類。現状は "battery"（蓄電池メーカー比較表）のみ対応。
//           新ジャンルを追加する場合は、そのtype用の問題生成関数を
//           パート3/4に追加し、initApp内で分岐させてください。
const SHEET_CONFIG = [
  { name: "蓄電池メーカー比較", sheet: "", type: "battery" }
];

// スプレッドシートの列名 → アプリ内部のキー名 の対応表。
// 列の並び順が変わっても、この見出し名で照合するので問題ありません。
const COLUMN_MAP = {
  "メーカー名": "maker",
  "製品名・シリーズ名": "series",
  "型番": "model",
  "蓄電容量/kWh": "capacityKwh",
  "実効容量/kWh": "usableCapacityKwh",
  "電池材料・種類": "batteryMaterial",
  "蓄電池タイプ": "batteryType",
  "負荷タイプ": "loadType",
  "対応年数/設計寿命": "lifespan",
  "製品保証年数": "warrantyYears",
  "容量保証年数": "capacityWarrantyYears",
  "自然災害補償": "disasterCompensation",
  "停電時出力": "outageOutput",
  "定格出力": "ratedOutput",
  "太陽光連携": "solarLink",
  "V2H対応": "v2h",
  "AI制御/HEMS対応": "aiHems",
  "屋内/屋外設置": "installation",
  "サイズ": "size",
  "重量": "weight",
  "主な特徴": "feature",
  "メリット": "merit",
  "デメリット": "demerit",
  "向いている家庭": "suitableFamily",
  "営業時の訴求ポイント": "salesPoint",
  "公式URL": "url",
  "参照資料名": "sourceDoc",
  "情報確認日": "checkedDate",
  "備考": "note"
};


/* ================================================================
   [パート2] スプレッドシート読み込み・CSVパース・列名マッピング
   ================================================================ */

// gviz エンドポイントは共有リンク設定のシートをCSVとして返してくれる
function buildCsvUrl(sheetName) {
  let url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv`;
  if (sheetName) {
    url += `&sheet=${encodeURIComponent(sheetName)}`;
  }
  // スプレッドシートを更新した直後でも、ブラウザ/回線上のキャッシュに
  // 古いCSVが残って反映されないことがあるため、毎回異なる値を付けて回避する
  url += `&_=${Date.now()}`;
  return url;
}

// ダブルクォート・セル内カンマ・セル内改行に対応した簡易CSVパーサー
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'; // "" はエスケープされた1つの引用符
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(cell);
        cell = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++; // CRLF対応
        row.push(cell);
        cell = "";
        rows.push(row);
        row = [];
      } else {
        cell += ch;
      }
    }
  }
  // 最終行の処理
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// CSVの行列データを製品オブジェクトの配列に変換する。
// ・見出し行は「メーカー名」を含む行を自動検出（先頭に説明行があってもOK）
// ・メーカー名または製品名が空の行はスキップ（ランキング等のメモ行対策）
// ・見出し行が繰り返し貼り付けられていてもスキップ
function rowsToProducts(rows) {
  // 見出し行を探す
  let headerRowIndex = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (rows[i].some((c) => c.trim() === "メーカー名")) {
      headerRowIndex = i;
      break;
    }
  }
  if (headerRowIndex === -1) {
    return { products: [], error: "見出し行（「メーカー名」列）が見つかりません。" };
  }

  const headers = rows[headerRowIndex].map((h) => h.trim());
  // 列番号 → 内部キー名 の対応を作る
  const colKeys = headers.map((h) => COLUMN_MAP[h] || null);

  const products = [];
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const cells = rows[i];
    const obj = {};
    colKeys.forEach((key, idx) => {
      if (!key) return;
      obj[key] = (cells[idx] || "").trim();
    });

    // メーカー名・製品名がない行はデータ行ではないのでスキップ
    if (!obj.maker || !obj.series) continue;
    // 貼り付け時に見出し行が混ざっていた場合もスキップ
    if (obj.maker === "メーカー名") continue;

    products.push(obj);
  }

  return { products, error: null };
}

// スプレッドシートを読み込んで製品配列を返す
async function loadProductsFromSheet(sheetConf) {
  const url = buildCsvUrl(sheetConf.sheet);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`スプレッドシートの取得に失敗しました（HTTP ${res.status}）`);
  }
  const text = await res.text();
  if (!text.trim()) {
    return []; // シートが空
  }
  const { products, error } = rowsToProducts(parseCsv(text));
  if (error) {
    throw new Error(error);
  }
  return products;
}


/* ================================================================
   共通ユーティリティ
   ================================================================ */

let questionIdCounter = 1;
function nextQuestionId(prefix) {
  return prefix + String(questionIdCounter++).padStart(3, "0");
}

// 「不明」「空欄」「未確認」「公式未確認」を判定する。
// これらの値は問題化の対象にしない。
function isUnknownValue(value) {
  if (value === undefined || value === null) return true;
  const s = String(value).trim();
  if (s === "") return true;
  if (s === "不明" || s === "未確認" || s === "－" || s === "-") return true;
  if (s.startsWith("不明")) return true;
  if (s.includes("公式未確認")) return true;
  // 「判断保留」は本来ランキング等の判断を保留する際の記法だが、
  // 通常の項目セルに誤って入力されると調査メモがそのまま出題・解説に
  // 出てしまうため、こちらも「不明」と同様に扱う
  if (s.startsWith("判断保留")) return true;
  // 「主な特徴」「メリット」「営業時の訴求ポイント」等のセルに、
  // 本来の文章の代わりに参照用のURLだけが誤って入力されているケースがある。
  // そのまま出題・解説に出すと意味不明な選択肢になるため「不明」扱いにする。
  if (/^https?:\/\/\S+$/i.test(s)) return true;
  return false;
}

// 「あり/対応/可/○」系かどうか・「なし/非対応/不可/×」系かどうかの判定
function isPositiveValue(value) {
  if (isUnknownValue(value)) return false;
  const s = String(value).trim();
  if (isNegativeValue(s)) return false;
  return /あり|対応|可|○|◯|〇|有/.test(s);
}
function isNegativeValue(value) {
  if (isUnknownValue(value)) return false;
  const s = String(value).trim();
  return /^(なし|非対応|不可|無|×|✕)/.test(s) || /非対応|連携できない|対応していない/.test(s);
}

// 文字列の先頭付近から最初の数値を取り出す（"16.6kWh" → 16.6、"15年" → 15）
function parseLeadingNumber(value) {
  if (isUnknownValue(value)) return null;
  const m = String(value).replace(/,/g, "").match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
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

function pickRandomN(arr, n) {
  return shuffleArray(arr).slice(0, n);
}

function makerLabel(p) {
  return `${p.maker} ${p.series}`;
}

// 「」でくくられた文章が二重括弧にならないよう外側の記号を外す
function stripOuterQuotes(text) {
  const s = String(text).trim();
  if (s.startsWith("「") && s.endsWith("」")) {
    return s.slice(1, -1);
  }
  return s;
}


/* ================================================================
   [パート3] 知識問題の自動生成ロジック
   ----------------------------------------------------------------
   スプレッドシートの各行から、以下のルールで4択問題を作ります。
   ・値が「不明」「空欄」「公式未確認」の項目は問題化しない
   ・ダミー選択肢は他の行の異なる値から作る（3つ未満なら生成しない）
   ・解説には「主な特徴」「メリット」「営業時の訴求ポイント」を必ず含める
   ================================================================ */

// 解説文を組み立てる。特徴・メリット・訴求ポイントのうち
// スプレッドシートに値があるものだけを使う。
function buildKnowledgeExplanation(p) {
  const parts = [];
  if (!isUnknownValue(p.feature)) {
    parts.push(`${p.maker}「${p.series}」は、${stripOuterQuotes(p.feature)}という特徴があります。`);
  }
  if (!isUnknownValue(p.merit)) {
    parts.push(`メリットとしては「${stripOuterQuotes(p.merit)}」という点が挙げられます。`);
  }
  if (!isUnknownValue(p.salesPoint)) {
    parts.push(`営業時には「${stripOuterQuotes(p.salesPoint)}」という伝え方が効果的です。`);
  }
  if (parts.length === 0) {
    parts.push(`${p.maker}「${p.series}」の詳細はスプレッドシートの元データを確認してください。`);
  }
  return parts.join("");
}

/* ---- 3-1. 「製品→フィールドの値」を問う問題（例：保証年数は？） ---- */
function genFieldQuestions(products, field, questionTextFn, category, difficulty) {
  const questions = [];

  products.forEach((p) => {
    const correctRaw = p[field];
    if (isUnknownValue(correctRaw)) return; // 不明な項目は問題化しない

    const correctText = String(correctRaw).trim();

    // 他の製品から「異なる値」を集めてダミー選択肢の候補にする
    const seen = new Set([correctText]);
    const distractorPool = [];
    products.forEach((other) => {
      if (other === p) return;
      const v = other[field];
      if (isUnknownValue(v)) return;
      const t = String(v).trim();
      if (seen.has(t)) return;
      seen.add(t);
      distractorPool.push(t);
    });

    if (distractorPool.length < 3) return; // 選択肢が足りない場合は生成しない

    const distractors = pickRandomN(distractorPool, 3);
    const choices = shuffleArray([correctText, ...distractors]);

    questions.push({
      id: nextQuestionId("q"),
      mode: "knowledge",
      category,
      difficulty,
      question: questionTextFn(p),
      customerScenario: "",
      choices,
      answer: correctText,
      explanation: buildKnowledgeExplanation(p),
      sourceManufacturer: p.maker,
      sourceProduct: p.series
    });
  });

  return questions;
}

/* ---- 3-2. 「文章→メーカー・製品名」を当てる逆引き問題 ---- */
function genReverseQuestions(products, field, questionPrefix, category, difficulty, answerType) {
  const questions = [];

  products.forEach((p) => {
    if (isUnknownValue(p[field])) return;
    const stem = stripOuterQuotes(p[field]);

    const correctAnswer = answerType === "product" ? makerLabel(p) : p.maker;

    const distractorPool = [];
    const seen = new Set([correctAnswer]);
    products.forEach((other) => {
      if (other === p) return;
      const label = answerType === "product" ? makerLabel(other) : other.maker;
      if (seen.has(label)) return;
      seen.add(label);
      distractorPool.push(label);
    });

    if (distractorPool.length < 3) return;

    const distractors = pickRandomN(distractorPool, 3);
    const choices = shuffleArray([correctAnswer, ...distractors]);

    questions.push({
      id: nextQuestionId("q"),
      mode: "knowledge",
      category,
      difficulty,
      question: `${questionPrefix}\n${stem}`,
      customerScenario: "",
      choices,
      answer: correctAnswer,
      explanation: buildKnowledgeExplanation(p),
      sourceManufacturer: p.maker,
      sourceProduct: p.series
    });
  });

  return questions;
}

/* ---- 3-3. 「あり/なし」項目の問題（V2H・災害補償・AI/HEMSなど） ---- */
function genBooleanQuestions(products, field, questionTexts, category, difficulty) {
  const questions = [];

  const trueList = products.filter((p) => isPositiveValue(p[field]));
  const falseList = products.filter((p) => isNegativeValue(p[field]));

  // 「あり」製品を正解にして「なし」製品をダミーにする
  if (trueList.length >= 1 && falseList.length >= 3) {
    trueList.forEach((correctP) => {
      const distractors = pickRandomN(falseList, 3);
      questions.push(buildBooleanQuestion(correctP, distractors, questionTexts.positive, category, difficulty));
    });
  }

  // 「なし」製品を正解にして「あり」製品をダミーにする
  if (falseList.length >= 1 && trueList.length >= 3) {
    falseList.forEach((correctP) => {
      const distractors = pickRandomN(trueList, 3);
      questions.push(buildBooleanQuestion(correctP, distractors, questionTexts.negative, category, difficulty));
    });
  }

  return questions;
}

function buildBooleanQuestion(correctP, distractorPs, questionText, category, difficulty) {
  const choices = shuffleArray([makerLabel(correctP), ...distractorPs.map(makerLabel)]);
  return {
    id: nextQuestionId("q"),
    mode: "knowledge",
    category,
    difficulty,
    question: questionText,
    customerScenario: "",
    choices,
    answer: makerLabel(correctP),
    explanation: buildKnowledgeExplanation(correctP),
    sourceManufacturer: correctP.maker,
    sourceProduct: correctP.series
  };
}

/* ---- 3-4. 複数メーカー比較問題（数値の最大・最小を当てる上級問題） ---- */
function genExtremeQuestion(products, field, mode, questionText, category, difficulty) {
  const valid = products
    .map((p) => ({ p, num: parseLeadingNumber(p[field]) }))
    .filter((x) => x.num !== null);
  if (valid.length < 4) return null;

  const sorted = valid.slice().sort((a, b) => (mode === "max" ? b.num - a.num : a.num - b.num));
  const extremeVal = sorted[0].num;
  const tied = sorted.filter((x) => x.num === extremeVal);
  if (tied.length !== 1) return null; // 同値タイの場合は問題として成立しない

  const correctP = tied[0].p;
  const others = pickRandomN(valid.filter((x) => x.p !== correctP), 3);
  if (others.length < 3) return null;

  const choices = shuffleArray([makerLabel(correctP), ...others.map((x) => makerLabel(x.p))]);

  return {
    id: nextQuestionId("q"),
    mode: "knowledge",
    category,
    difficulty,
    question: questionText,
    customerScenario: "",
    choices,
    answer: makerLabel(correctP),
    explanation:
      buildKnowledgeExplanation(correctP) +
      `参考値：${correctP[field]}。` +
      `比較問題では、営業トークで「どこが一番強みか」を数字で語れるようにしておくことが大切です。`,
    sourceManufacturer: correctP.maker,
    sourceProduct: correctP.series
  };
}

/* ---- 3-5. 蓄電池シート用：知識問題プールの組み立て ---- */
function generateKnowledgeQuestions(products) {
  let qs = [];

  // ===== 初級：基本情報 =====
  qs = qs.concat(genFieldQuestions(products, "warrantyYears",
    (p) => `${p.maker}「${p.series}」の製品保証年数として正しいものはどれ？`, "保証", "初級"));
  qs = qs.concat(genFieldQuestions(products, "capacityWarrantyYears",
    (p) => `${p.maker}「${p.series}」の容量保証として正しいものはどれ？`, "保証", "初級"));
  qs = qs.concat(genFieldQuestions(products, "capacityKwh",
    (p) => `${p.maker}「${p.series}」の蓄電容量(kWh)として正しいものはどれ？`, "容量", "初級"));
  qs = qs.concat(genFieldQuestions(products, "usableCapacityKwh",
    (p) => `${p.maker}「${p.series}」の実効容量(kWh)として正しいものはどれ？`, "容量", "初級"));
  qs = qs.concat(genFieldQuestions(products, "batteryMaterial",
    (p) => `${p.maker}「${p.series}」に採用されている電池材料・種類はどれ？`, "電池材料", "初級"));
  qs = qs.concat(genFieldQuestions(products, "batteryType",
    (p) => `${p.maker}「${p.series}」の蓄電池タイプ（ハイブリッド型/単機能型など）はどれ？`, "メーカー比較", "初級"));

  // ===== 中級：特徴・負荷タイプ・停電時出力など =====
  qs = qs.concat(genFieldQuestions(products, "loadType",
    (p) => `${p.maker}「${p.series}」の負荷タイプ（停電時に使える範囲）はどれ？`, "停電対策", "中級"));
  qs = qs.concat(genFieldQuestions(products, "outageOutput",
    (p) => `${p.maker}「${p.series}」の停電時出力として正しいものはどれ？`, "停電対策", "中級"));
  qs = qs.concat(genFieldQuestions(products, "lifespan",
    (p) => `${p.maker}「${p.series}」の対応年数/設計寿命として正しいものはどれ？`, "保証", "中級"));
  qs = qs.concat(genFieldQuestions(products, "solarLink",
    (p) => `${p.maker}「${p.series}」の太陽光連携について正しい説明はどれ？`, "太陽光連携", "中級"));
  qs = qs.concat(genFieldQuestions(products, "installation",
    (p) => `${p.maker}「${p.series}」の設置条件（屋内/屋外）として正しいものはどれ？`, "メーカー比較", "中級"));
  // V2Hは「対応/不明」しかなく明確な「非対応」行がないデータでも、
  // 連携方式（V2Hポッド経由/eneplat経由 等）の違いから出題できるようにする
  qs = qs.concat(genFieldQuestions(products, "v2h",
    (p) => `${p.maker}「${p.series}」のV2H対応状況として正しいものはどれ？`, "V2H", "中級"));

  qs = qs.concat(genReverseQuestions(products, "suitableFamily",
    "次のような家庭に向いている製品はどれ？", "メリット/デメリット", "中級", "product"));
  qs = qs.concat(genReverseQuestions(products, "merit",
    "次のメリットが特徴とされている製品はどれ？", "メリット/デメリット", "中級", "maker"));
  qs = qs.concat(genReverseQuestions(products, "salesPoint",
    "次の営業トークが訴求ポイントとして合う製品はどれ？", "営業トーク", "中級", "maker"));
  qs = qs.concat(genReverseQuestions(products, "feature",
    "次の特徴を持つ製品はどれ？", "メーカー比較", "中級", "maker"));

  // ===== 上級：デメリット・複数メーカー比較 =====
  qs = qs.concat(genReverseQuestions(products, "demerit",
    "次のデメリット（注意点）が指摘されている製品はどれ？", "メリット/デメリット", "上級", "maker"));

  qs = qs.concat(genBooleanQuestions(products, "v2h", {
    positive: "V2H（電気自動車との連携）に対応しているのはどれ？",
    negative: "V2H（電気自動車との連携）に対応していないのはどれ？"
  }, "V2H", "中級"));

  qs = qs.concat(genBooleanQuestions(products, "aiHems", {
    positive: "AI制御・HEMS連携に対応しているのはどれ？",
    negative: "AI制御・HEMS連携に対応していないのはどれ？"
  }, "メーカー比較", "中級"));

  qs = qs.concat(genBooleanQuestions(products, "disasterCompensation", {
    positive: "自然災害補償が付帯しているのはどれ？",
    negative: "自然災害補償が付帯していないのはどれ？"
  }, "保証", "中級"));

  const extremeCandidates = [
    genExtremeQuestion(products, "capacityKwh", "max", "蓄電容量(kWh)が最も大きいのはどれ？", "メーカー比較", "上級"),
    genExtremeQuestion(products, "capacityKwh", "min", "蓄電容量(kWh)が最も小さいのはどれ？", "メーカー比較", "上級"),
    genExtremeQuestion(products, "warrantyYears", "max", "製品保証年数が最も長いのはどれ？", "保証", "上級"),
    genExtremeQuestion(products, "warrantyYears", "min", "製品保証年数が最も短いのはどれ？", "保証", "上級")
  ];
  extremeCandidates.forEach((q) => { if (q) qs.push(q); });

  return qs;
}


/* ================================================================
   [パート4] 実践提案問題の自動生成ロジック
   ----------------------------------------------------------------
   スプレッドシートの「向いている家庭」「営業時の訴求ポイント」
   「デメリット」列だけを材料にして、お客様状況→最適提案を選ぶ
   問題を自動生成します（シートにない情報は使いません）。

   仕組み：
   1. 各製品の「向いている家庭」等の文章からキーワードで
      重視カテゴリ（停電対策/電気代削減/…）を推定する
   2. お客様状況カード＝「向いている家庭」の内容をそのまま提示
   3. 正解＝その製品、ダミー＝重視カテゴリが異なる他製品
      （カテゴリが同じ製品はダミーにしない＝正解が曖昧にならない）
   4. 解説＝正解の理由（訴求ポイント）＋他の選択肢が弱い理由
      （各製品のデメリット）＋注意点（正解製品のデメリット）
   ================================================================ */

// 実践カテゴリごとの判定キーワード。
// 「向いている家庭」（重み2）と「メリット・主な特徴」（重み1）の中で
// キーワードが何回ヒットしたかを数え、最もスコアが高いカテゴリに分類する。
// （単純な優先順判定だと「初期費用を抑えて最低限の停電対策をしたい家庭」が
//   停電対策に誤分類されるため、スコアリング方式にしている）
const PRACTICE_CATEGORY_KEYWORDS = {
  "EV/V2H": ["EV", "V2H", "トライブリッド", "電気自動車"],
  "停電対策": ["停電", "災害", "防災", "バックアップ", "全負荷", "普段通り"],
  "電気代削減": ["電気代", "自家消費", "卒FIT", "売電", "節電", "余剰"],
  "初期費用": ["初期費用", "費用", "価格", "コスト", "安価", "予算", "エントリー", "手頃", "抑え"],
  "保証・安心": ["保証", "補償", "安心", "長期", "信頼"],
  "設置スペース": ["設置スペース", "省スペース", "狭小", "屋内", "コンパクト", "密集", "狭い"]
};

// 製品の「向いている家庭」等の文章から重視カテゴリを推定する
function detectPracticeCategory(p) {
  const primary = isUnknownValue(p.suitableFamily) ? "" : String(p.suitableFamily);
  const secondary = [p.merit, p.feature]
    .filter((t) => !isUnknownValue(t))
    .join(" ");

  let best = null;
  let bestScore = 0;
  for (const [category, words] of Object.entries(PRACTICE_CATEGORY_KEYWORDS)) {
    let score = 0;
    words.forEach((w) => {
      if (primary.includes(w)) score += 2;
      if (secondary.includes(w)) score += 1;
    });
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }
  return best; // どのカテゴリにも該当しない場合は null（実践問題の対象外）
}

// カテゴリごとの「お客様が重視していること」の言い換え（画面表示用）
const PRACTICE_PRIORITY_LABEL = {
  "停電対策": "停電・災害時の安心",
  "電気代削減": "電気代の削減効果",
  "初期費用": "初期費用を抑えること",
  "EV/V2H": "EV・V2Hとの連携",
  "保証・安心": "長期保証・故障時の安心",
  "設置スペース": "設置場所の制約への対応"
};

/* ----------------------------------------------------------------
   カテゴリごとの「客観的な失格条件」定義。
   ----------------------------------------------------------------
   以前は「重視カテゴリが違う製品」というだけでダミー選択肢を選んでいたが、
   これだと「人によっては他の選択肢も妥当では？」と解釈が割れやすいという
   指摘を受けた（営業現場での実機テストより）。
   そこで、各カテゴリについて実データ（構造化された列の値）だけで
   白黒つけられる「お客様の必須条件」を定義し、それに明確に矛盾する製品
   だけを「失格」として扱うようにした。
   ここに定義がないカテゴリ（例：初期費用＝価格データが無く客観的に
   判定できない）は、消去法問題を生成しない。
------------------------------------------------------------- */
// ※ reason()はすべて「〜ため、」に自然につながる中止形（プレーン形）で
//   統一している。文末（「〜です/ません」）にすると呼び出し側で
//   「ではありませんため」のような不自然な二重表現になるため。
const PRACTICE_DISQUALIFIER_RULES = {
  "停電対策": {
    requirement: "停電時に家全体（全負荷）の電気を使いたい",
    isDisqualified: (p) =>
      !isUnknownValue(p.loadType) && /特定負荷/.test(p.loadType) && !/全負荷/.test(p.loadType),
    reason: (p) => `負荷タイプが「${p.loadType}」で全負荷に対応しておらず、停電時に家全体を使いたいというご要望に応えられない`
  },
  "EV/V2H": {
    requirement: "EV・V2H連携が必須",
    isDisqualified: (p) => !isPositiveValue(p.v2h),
    reason: (p) => `V2H対応が公式データ上「${isUnknownValue(p.v2h) ? "不明" : p.v2h}」であり、V2H連携を確約して提案するのは適切でない`
  },
  "保証・安心": {
    requirement: "自然災害補償を含む長期の安心を重視",
    isDisqualified: (p) => !isPositiveValue(p.disasterCompensation),
    reason: (p) => `自然災害補償が公式データ上「${isUnknownValue(p.disasterCompensation) ? "不明" : p.disasterCompensation}」であり、災害時の補償を安心材料として断定的に伝えるのは適切でない`
  },
  "設置スペース": {
    requirement: "設置スペースが限られており屋内設置も検討したい",
    isDisqualified: (p) => !isUnknownValue(p.installation) && String(p.installation).trim() === "屋外設置",
    reason: (p) => `設置条件が「${p.installation}」で屋内設置ができず、設置スペースが限られるお客様には提案しづらい`
  },
  "電気代削減": {
    requirement: "太陽光の自家消費拡大で電気代を削減したい",
    isDisqualified: (p) => !isPositiveValue(p.solarLink),
    reason: (p) => `太陽光連携が公式データ上「${isUnknownValue(p.solarLink) ? "不明" : p.solarLink}」であり、自家消費による電気代削減を訴求する根拠が弱い`
  }
  // "初期費用"：価格帯のデータが無く客観的に判定できないため、あえて定義しない
};

// 実践提案問題（製品選択型）の解説文を組み立てる（5つの要素を必ず含める）
function buildPracticeExplanation(correctP, wrongPs, category, rule) {
  const parts = [];

  // 1. なぜ正解か ＋ 2. 判断材料になったお客様条件
  parts.push(
    `正解は${correctP.maker}「${correctP.series}」です。` +
    `お客様状況の「${stripOuterQuotes(correctP.suitableFamily)}」という条件が判断材料で、` +
    `この製品はまさにそうした家庭に向いているとされています。`
  );

  // 3. 他の選択肢が弱い理由
  // 客観的な失格条件（実データ上の矛盾）があればそれを優先して示し、
  // なければデメリット、それも無ければ重視ポイントとの合致度で説明する
  const weakParts = wrongPs.map((wp) => {
    if (rule && rule.isDisqualified(wp)) {
      return `${wp.maker}「${wp.series}」は${rule.reason(wp)}ため、この条件のお客様には明確に不向きです`;
    }
    if (!isUnknownValue(wp.demerit)) {
      return `${wp.maker}「${wp.series}」は「${stripOuterQuotes(wp.demerit)}」という注意点があり、このお客様の最優先ニーズとはズレがあります`;
    }
    return `${wp.maker}「${wp.series}」は今回のお客様の重視ポイント（${PRACTICE_PRIORITY_LABEL[category] || category}）との合致度で一歩譲ります`;
  });
  parts.push(`一方、${weakParts.join("。")}。`);

  // 4. 営業時にどう伝えるか
  if (!isUnknownValue(correctP.salesPoint)) {
    parts.push(`営業時には「${stripOuterQuotes(correctP.salesPoint)}」という伝え方が効果的です。`);
  }

  // 5. 注意すべきデメリット・確認事項
  if (!isUnknownValue(correctP.demerit)) {
    parts.push(`ただし「${stripOuterQuotes(correctP.demerit)}」という注意点があるため、提案時に正直に説明し、事前確認を怠らないようにしましょう。`);
  }

  return parts.join("");
}

/* ---- 4-1. 製品選択型（Aパターン）：お客様状況→最適な製品を選ぶ ----
   誤答（ダミー選択肢）は、客観的な失格条件（PRACTICE_DISQUALIFIER_RULES）を
   満たす製品を優先的に採用する。定義済みカテゴリでは「なぜ他の選択肢が
   不適切か」を実データの数値・文言で裏付けられるようになる。
   ルールが無い／失格候補が足りないカテゴリは、従来通り「重視カテゴリが
   違う製品」を補完的に使う（出題数を大きく減らさないため）。
------------------------------------------------------------- */
function genPracticeProductQuestions(products) {
  const questions = [];

  const withCat = products
    .map((p) => ({ p, category: detectPracticeCategory(p) }))
    .filter((x) => x.category !== null && !isUnknownValue(x.p.suitableFamily));

  withCat.forEach(({ p, category }) => {
    const rule = PRACTICE_DISQUALIFIER_RULES[category];
    const others = withCat.filter((x) => x.p !== p);

    const disqualifiedPool = rule ? others.filter((x) => rule.isDisqualified(x.p)) : [];
    const fallbackPool = others.filter((x) => x.category !== category && !disqualifiedPool.includes(x));

    let wrongs = pickRandomN(disqualifiedPool, Math.min(3, disqualifiedPool.length)).map((x) => x.p);
    if (wrongs.length < 3) {
      const filler = pickRandomN(fallbackPool, 3 - wrongs.length).map((x) => x.p);
      wrongs = wrongs.concat(filler);
    }
    if (wrongs.length < 3) return;

    const choices = shuffleArray([makerLabel(p), ...wrongs.map(makerLabel)]);

    questions.push({
      id: nextQuestionId("p"),
      mode: "practice",
      category,
      difficulty: "中級",
      question: "次のお客様に最も提案しやすい蓄電池はどれ？",
      customerScenario: {
        "想定されるお客様": stripOuterQuotes(p.suitableFamily),
        "重視していること": PRACTICE_PRIORITY_LABEL[category] || category
      },
      choices,
      answer: makerLabel(p),
      explanation: buildPracticeExplanation(p, wrongs, category, rule),
      sourceManufacturer: p.maker,
      sourceProduct: p.series
    });
  });

  return questions;
}

/* ---- 4-2. 営業トーク消去法（旧Bパターンを刷新）----
   「最も響くトークを選ぶ」形式は、複数の訴求ポイントが同時に妥当に見え、
   人によって解釈が割れやすいという指摘が最も多かった設問タイプ。
   そこで「明らかに不適切な提案を1つ選ぶ」消去法形式に変更した。
   正解（＝消去すべき1つ）は、客観的な失格条件（実データ上の矛盾）が
   確認できる製品に限定する。失格条件を定義できる／該当製品があるときだけ
   出題するため、「なぜこれが不正解か」を必ず実データで説明できる。
------------------------------------------------------------- */
function genPracticeTalkQuestions(products) {
  const questions = [];

  const withCat = products
    .map((p) => ({ p, category: detectPracticeCategory(p) }))
    .filter((x) => x.category !== null && !isUnknownValue(x.p.salesPoint));

  withCat.forEach(({ p: baseP, category }) => {
    const rule = PRACTICE_DISQUALIFIER_RULES[category];
    if (!rule) return; // 客観的な失格条件を定義できないカテゴリは出題しない

    // 実データ上、明確にお客様の必須条件と矛盾する製品（＝消去すべき選択肢）を探す
    const disqualified = withCat.filter((x) => x.p !== baseP && rule.isDisqualified(x.p));
    if (disqualified.length === 0) return;
    const badPick = disqualified[Math.floor(Math.random() * disqualified.length)].p;

    // 「明確な矛盾が無い」選択肢（消去法なので、ベストである必要はない）
    const safeCandidates = withCat.filter(
      (x) => x.p !== baseP && x.p !== badPick && !rule.isDisqualified(x.p)
    );
    if (safeCandidates.length < 2) return;
    const safePicks = pickRandomN(safeCandidates, 2).map((x) => x.p);

    const choiceProducts = shuffleArray([baseP, ...safePicks, badPick]);
    const choices = choiceProducts.map((cp) => stripOuterQuotes(cp.salesPoint));
    if (new Set(choices).size < 4) return; // 訴求ポイントの文言が重複する場合は出題しない

    questions.push({
      id: nextQuestionId("p"),
      mode: "practice",
      category: "営業トーク判断",
      difficulty: "上級",
      question: "次のうち、このお客様への提案として明らかに不適切なものはどれ？",
      customerScenario: {
        "想定されるお客様": stripOuterQuotes(baseP.suitableFamily) || rule.requirement,
        "必須条件": rule.requirement
      },
      choices,
      answer: stripOuterQuotes(badPick.salesPoint),
      explanation: buildTalkEliminationExplanation(badPick, rule),
      sourceManufacturer: badPick.maker,
      sourceProduct: badPick.series
    });
  });

  return questions;
}

// 営業トーク消去法問題の解説文（不適切と判断できる根拠を実データで示す）
function buildTalkEliminationExplanation(badP, rule) {
  const parts = [];

  parts.push(
    `不適切なのは${badP.maker}「${badP.series}」の訴求ポイントです。` +
    `このお客様は「${rule.requirement}」ことを必須条件としていますが、` +
    `${badP.maker}「${badP.series}」は${rule.reason(badP)}。`
  );

  parts.push(
    "他の3つの選択肢は、いずれも公式データ上この必須条件と明確に矛盾する情報がないため、状況に応じて提案しうる訴求ポイントです。"
  );

  if (!isUnknownValue(badP.merit)) {
    parts.push(
      `なお${badP.maker}「${badP.series}」自体は「${stripOuterQuotes(badP.merit)}」という別の強みを持つ製品なので、条件が異なるお客様には十分な選択肢になり得ます。`
    );
  }

  parts.push(
    "営業時には、訴求ポイントの魅力だけで即決せず、必ず対象製品の仕様がお客様の必須条件を満たすかを確認してから伝えることが重要です。"
  );

  return parts.join("");
}

function generatePracticeQuestions(products) {
  return genPracticeProductQuestions(products).concat(genPracticeTalkQuestions(products));
}


/* ================================================================
   [パート5] 画面制御・クイズ進行ロジック（アプリ本体）
   ================================================================ */

// カテゴリの表示順（データに存在するものだけが実際に表示される）
const CATEGORY_ORDER = [
  "保証", "容量", "電池材料", "停電対策", "V2H", "太陽光連携",
  "営業トーク", "メーカー比較", "メリット/デメリット",
  "電気代削減", "初期費用", "EV/V2H", "保証・安心", "設置スペース", "営業トーク判断"
];

// アプリの状態（グローバル管理）
const state = {
  mode: null,        // "knowledge" | "practice" | "mix"
  category: "全カテゴリ",
  countOption: null, // "5" | "10" | "20" | "all"
  sessionQuestions: [],
  currentIndex: 0,
  userAnswers: [],   // { question, chosenText, correct }
  selectedChoice: null,
  isReviewSession: false,
  dataLoaded: false,
  currentStreak: 0,       // 現在の連続正解数
  bestStreakThisSession: 0 // このセッション中の最大連続正解数
};

let knowledgeQuestions = [];
let practiceQuestions = [];
let loadedProducts = [];


/* ================================================================
   [パート6] 演出・効果音・記録（ゲーム的な楽しさのための仕掛け）
   ----------------------------------------------------------------
   ・正解/不正解を選択肢の色でその場でフィードバック
   ・連続正解（ストリーク）をトースト通知＋紙吹雪で盛り上げる
   ・Web Audio APIでその場で音を合成（音声ファイルは使わない）
   ・結果画面のスコアをカウントアップ演出
   ・正答率・連続正解の自己ベストをlocalStorageに保存して次回と比較
   ================================================================ */

const BEST_RATE_KEY = "batteryQuiz_bestRate";
const BEST_STREAK_KEY = "batteryQuiz_bestStreak";
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

  toast.textContent = `🔥 ${streak}連続正解！`;
  toast.hidden = false;
  void toast.offsetWidth; // 再アニメーションさせるための強制リフロー
  toast.classList.add("show");

  clearTimeout(streakToastTimer);
  streakToastTimer = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => { toast.hidden = true; }, 300);
  }, 1400);
}

function updateStreakBadge() {
  const badge = document.getElementById("streak-badge");
  if (!badge) return;
  if (state.currentStreak >= 2) {
    badge.textContent = `🔥 ${state.currentStreak}連続`;
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

// ---- 自己ベスト記録（localStorageで端末ごとに保存） ----
function getBestRate() {
  return Number(localStorage.getItem(BEST_RATE_KEY) || 0);
}
function getBestStreak() {
  return Number(localStorage.getItem(BEST_STREAK_KEY) || 0);
}

// スタート画面に自己ベストを表示する
function renderBestRecordOnStart() {
  const el = document.getElementById("best-record-text");
  if (!el) return;
  const bestRate = getBestRate();
  const bestStreak = getBestStreak();
  if (bestRate === 0 && bestStreak === 0) {
    el.textContent = "";
    return;
  }
  const parts = [];
  if (bestRate > 0) parts.push(`自己ベスト正答率 ${bestRate}%`);
  if (bestStreak > 0) parts.push(`最大連続正解 ${bestStreak}問`);
  el.textContent = "🏆 " + parts.join(" ／ ");
}

// 結果に応じた一言メッセージ
function getResultMessage(rate) {
  if (rate === 100) return "🎉 パーフェクト！完璧です！";
  if (rate >= 80) return "✨ 素晴らしい成績です！";
  if (rate >= 60) return "👍 いい調子！あと少しで上級者です";
  if (rate >= 40) return "💪 もう一歩！復習して伸ばしましょう";
  return "📚 まずは基礎から復習していきましょう";
}

// ---- 起動時の初期化 ----
async function initApp() {
  loadSoundPreference();
  document.getElementById("btn-sound-toggle").addEventListener("click", toggleSound);
  renderBestRecordOnStart();
  setupStartScreen();
  showScreen("screen-start");
  await loadAllData();
}

// スプレッドシートからデータを読み込み、問題を生成する
async function loadAllData() {
  const statusText = document.getElementById("data-status-text");
  const reloadBtn = document.getElementById("btn-reload-data");

  statusText.textContent = "スプレッドシートからデータを読み込み中…";
  statusText.className = "status-loading";
  reloadBtn.hidden = true;
  state.dataLoaded = false;
  validateStartButton();

  try {
    // SHEET_CONFIGの全シートを読み込む（現状は蓄電池シートのみ）
    knowledgeQuestions = [];
    practiceQuestions = [];
    loadedProducts = [];
    questionIdCounter = 1;

    for (const conf of SHEET_CONFIG) {
      const products = await loadProductsFromSheet(conf);
      if (conf.type === "battery") {
        loadedProducts = loadedProducts.concat(products);
        knowledgeQuestions = knowledgeQuestions.concat(generateKnowledgeQuestions(products));
        practiceQuestions = practiceQuestions.concat(generatePracticeQuestions(products));
      }
      // 将来の拡張：typeが増えたらここに分岐を追加する
      // else if (conf.type === "subsidy") { ... 補助金シート用の生成関数 ... }
    }

    if (loadedProducts.length === 0) {
      statusText.textContent =
        "スプレッドシートにまだデータがありません。リサーチ結果をシートに貼り付けてから「再読み込み」を押してください。";
      statusText.className = "status-warning";
      reloadBtn.hidden = false;
      return;
    }

    statusText.textContent =
      `読み込み完了：${loadedProducts.length}製品 → 知識問題${knowledgeQuestions.length}問・実践提案問題${practiceQuestions.length}問を生成しました。`;
    statusText.className = "status-ok";
    reloadBtn.hidden = false;
    state.dataLoaded = true;
    validateStartButton();

    // モード選択済みならカテゴリ一覧を更新する
    if (state.mode) populateCategorySelect();
  } catch (err) {
    // file:// で開いた場合のCORSエラーもここに来る
    const isFileProtocol = location.protocol === "file:";
    statusText.textContent = isFileProtocol
      ? "読み込みに失敗しました。file:// で直接開くとスプレッドシートを取得できません。ローカルサーバー経由（http://localhost/...）で開いてください（READMEの実行手順参照）。"
      : `読み込みに失敗しました：${err.message}。共有設定（リンクを知っている全員が閲覧可）とネット接続を確認して「再読み込み」を押してください。`;
    statusText.className = "status-error";
    reloadBtn.hidden = false;
  }
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

  document.getElementById("category-select").addEventListener("change", (e) => {
    state.category = e.target.value;
  });

  document.getElementById("btn-start").addEventListener("click", beginQuizSession);
  document.getElementById("btn-reload-data").addEventListener("click", loadAllData);
  document.getElementById("btn-answer").addEventListener("click", submitAnswer);
  document.getElementById("btn-next").addEventListener("click", goToNextQuestion);
  document.getElementById("btn-restart").addEventListener("click", resetToStart);
  document.getElementById("btn-review-wrong").addEventListener("click", startReviewSession);
}

// カテゴリ一覧は「実際に生成された問題」から動的に作る。
// 将来スプレッドシートに新ジャンルのシートを追加しても、
// 問題さえ生成されればカテゴリが自動的に選択肢に現れます。
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

  ["全カテゴリ", ...ordered].forEach((cat) => {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    select.appendChild(opt);
  });
  state.category = "全カテゴリ";
}

function validateStartButton() {
  const btn = document.getElementById("btn-start");
  btn.disabled = !(state.mode && state.countOption && state.dataLoaded);
}

// ---- 出題プールを組み立ててセッションを開始する ----
function beginQuizSession() {
  const pool = buildFilteredPool(state.mode, state.category);

  if (pool.length === 0) {
    document.getElementById("start-warning").textContent =
      "選択した条件に合う問題がありません。カテゴリを変更してください。";
    return;
  }
  document.getElementById("start-warning").textContent = "";

  const n = state.countOption === "all" ? pool.length : Math.min(Number(state.countOption), pool.length);
  state.sessionQuestions = pickSessionQuestions(pool, n, state.mode);
  state.currentIndex = 0;
  state.userAnswers = [];
  state.isReviewSession = false;
  state.currentStreak = 0;
  state.bestStreakThisSession = 0;

  showScreen("screen-quiz");
  renderQuestion();
}

function buildFilteredPool(mode, category) {
  let pool;
  if (mode === "knowledge") pool = knowledgeQuestions;
  else if (mode === "practice") pool = practiceQuestions;
  else pool = knowledgeQuestions.concat(practiceQuestions);

  if (category && category !== "全カテゴリ") {
    pool = pool.filter((q) => q.category === category);
  }
  return pool;
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
    q.mode === "knowledge" ? "知識問題" : "実践提案";
  document.getElementById("quiz-category-badge").textContent = q.category;
  document.getElementById("quiz-difficulty-badge").textContent = q.difficulty;
  updateStreakBadge();

  const progressPct = Math.round((state.currentIndex / state.sessionQuestions.length) * 100);
  document.getElementById("quiz-progress-bar").style.width = `${progressPct}%`;

  document.getElementById("question-text").textContent = q.question;

  // 実践提案モードの場合はお客様状況カードを表示する
  const customerCard = document.getElementById("customer-card");
  if (q.mode === "practice" && q.customerScenario && typeof q.customerScenario === "object") {
    customerCard.hidden = false;
    renderCustomerCard(q.customerScenario);
  } else {
    customerCard.hidden = true;
  }

  renderChoices(q.choices);
  document.getElementById("btn-answer").disabled = true;
}

// お客様状況カード：customerScenarioのキーと値をそのまま項目として表示する
function renderCustomerCard(scenario) {
  const list = document.getElementById("customer-card-list");
  list.innerHTML = "";

  Object.entries(scenario).forEach(([label, value]) => {
    if (!value) return;
    const li = document.createElement("li");
    const b = document.createElement("b");
    b.textContent = `${label}：`;
    li.appendChild(b);
    li.appendChild(document.createTextNode(value));
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
    textSpan.textContent = choiceText;

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

  if (isCorrect) {
    state.currentStreak++;
    state.bestStreakThisSession = Math.max(state.bestStreakThisSession, state.currentStreak);
    updateStreakBadge();
    if (state.currentStreak >= 2) {
      // 連続正解中は、単発の正解音より盛り上がる上昇アルペジオを鳴らす
      playStreakSound(state.currentStreak);
      showStreakToast(state.currentStreak);
    } else {
      playCorrectSound();
    }
    if (state.currentStreak >= 3 && state.currentStreak % 3 === 0) {
      launchConfetti(24);
    }
  } else {
    state.currentStreak = 0;
    playWrongSound();
    updateStreakBadge();
  }

  state.userAnswers.push({ question: q, chosenText, correct: isCorrect });

  setTimeout(() => {
    renderExplainScreen(q, chosenText, isCorrect);
    showScreen("screen-explain");
  }, 700);
}

function renderExplainScreen(q, chosenText, isCorrect) {
  const banner = document.getElementById("result-banner");
  banner.textContent = isCorrect ? "正解！" : "不正解";
  banner.className = "result-banner " + (isCorrect ? "correct" : "incorrect");

  document.getElementById("explain-correct-answer").textContent = q.answer;

  const userAnswerRow = document.getElementById("explain-user-answer-row");
  if (!isCorrect) {
    userAnswerRow.hidden = false;
    document.getElementById("explain-user-answer").textContent = chosenText;
  } else {
    userAnswerRow.hidden = true;
  }

  document.getElementById("explain-text").textContent = q.explanation;
}

// ---- 次の問題へ進む／終了して結果画面へ ----
function goToNextQuestion() {
  state.currentIndex++;
  if (state.currentIndex >= state.sessionQuestions.length) {
    renderResultScreen();
    showScreen("screen-result");
  } else {
    showScreen("screen-quiz");
    renderQuestion();
  }
}

// ---- 結果画面の描画 ----
function renderResultScreen() {
  const total = state.userAnswers.length;
  const correctCount = state.userAnswers.filter((a) => a.correct).length;
  const rate = total > 0 ? Math.round((correctCount / total) * 100) : 0;

  // スコア・正答率は0からカウントアップさせて演出する
  const scoreEl = document.getElementById("result-score");
  const rateEl = document.getElementById("result-rate");
  animateCountUp(scoreEl, correctCount, (v) => `${v} / ${total}`, 700);
  animateCountUp(rateEl, rate, (v) => `${v}%`, 700);

  document.getElementById("result-message").textContent = getResultMessage(rate);

  const knowledgeAnswers = state.userAnswers.filter((a) => a.question.mode === "knowledge");
  const practiceAnswers = state.userAnswers.filter((a) => a.question.mode === "practice");

  document.getElementById("result-knowledge-rate").textContent = formatRate(knowledgeAnswers);
  document.getElementById("result-practice-rate").textContent = formatRate(practiceAnswers);

  document.getElementById("streak-summary").textContent =
    `この回の最大連続正解：${state.bestStreakThisSession}問`;

  // 自己ベスト（正答率・連続正解）を更新できたかチェックする
  const prevBestRate = getBestRate();
  const prevBestStreak = getBestStreak();
  let isNewRecord = false;
  if (rate > prevBestRate) {
    localStorage.setItem(BEST_RATE_KEY, String(rate));
    isNewRecord = true;
  }
  if (state.bestStreakThisSession > prevBestStreak) {
    localStorage.setItem(BEST_STREAK_KEY, String(state.bestStreakThisSession));
    isNewRecord = true;
  }
  document.getElementById("new-record-banner").hidden = !isNewRecord;

  // 高得点・自己ベスト更新時は紙吹雪でお祝いする
  if (rate === 100) {
    playFanfare();
    setTimeout(() => launchConfetti(80), 150);
  } else if (isNewRecord || rate >= 80) {
    setTimeout(() => launchConfetti(isNewRecord ? 60 : 40), 150);
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
      modeTag.textContent = a.question.mode === "knowledge" ? "知識" : "実践提案";
      li.appendChild(modeTag);
      li.appendChild(document.createTextNode(a.question.question));
      wrongList.appendChild(li);
    });
  }

  document.getElementById("btn-review-wrong").disabled = wrongAnswers.length === 0;
}

function formatRate(answers) {
  if (answers.length === 0) return "該当なし";
  const correct = answers.filter((a) => a.correct).length;
  const rate = Math.round((correct / answers.length) * 100);
  return `${correct}/${answers.length}（${rate}%）`;
}

// ---- 間違えた問題だけ復習する ----
function startReviewSession() {
  const wrongQuestions = state.userAnswers.filter((a) => !a.correct).map((a) => a.question);
  if (wrongQuestions.length === 0) return;

  state.sessionQuestions = wrongQuestions;
  state.currentIndex = 0;
  state.userAnswers = [];
  state.isReviewSession = true;
  state.currentStreak = 0;
  state.bestStreakThisSession = 0;

  showScreen("screen-quiz");
  renderQuestion();
}

// ---- 最初からやり直す ----
function resetToStart() {
  state.mode = null;
  state.category = "全カテゴリ";
  state.countOption = null;
  state.sessionQuestions = [];
  state.currentIndex = 0;
  state.userAnswers = [];
  state.isReviewSession = false;

  document.querySelectorAll("#mode-select .option-btn, #count-select .option-btn").forEach((b) =>
    b.classList.remove("selected")
  );
  document.getElementById("btn-start").disabled = true;
  document.getElementById("start-warning").textContent = "";
  renderBestRecordOnStart();

  showScreen("screen-start");
}

// ---- 画面切り替えの共通関数 ----
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ---- アプリ起動 ----
window.addEventListener("DOMContentLoaded", initApp);
