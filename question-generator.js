/* ================================================================
   question-generator.js（Node専用・スプレッドシート→問題生成ロジック）
   ----------------------------------------------------------------
   これは以前 script.js の パート1〜4 だった内容をそのまま移設した
   ものです。ロジック自体は一切変更していません。

   ★ ブラウザからはもう読み込みません。ブラウザは事前に生成済みの
     問題をSupabaseの questions テーブルから取得するだけになりました。
   ★ このファイルは scripts/sync-questions.js からのみ使われます。
     スプレッドシートを更新したら、このロジックで問題を作り直し、
     Supabaseに書き込みます（詳しくはREADME参照）。
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
//           パート3/4に追加し、sync-questions.js内で分岐させてください。
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
  // 毎回異なる値を付けてキャッシュを回避する
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

// スプレッドシートを読み込んで製品配列を返す（Node 18+ の組み込みfetchを使う）
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
function resetQuestionIdCounter() {
  questionIdCounter = 1;
}
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

/* ---- 3-1. 「製品→フィールドの値」を問う問題（例：保証年数は？） ----
   choiceExplanations：各選択肢について、正解なら「実際の値」を、
   誤答ならその値が本当はどの製品のものかを明示して「なぜ違うか」を示す。
------------------------------------------------------------- */
function genFieldQuestions(products, field, questionTextFn, category, difficulty) {
  const questions = [];

  products.forEach((p) => {
    const correctRaw = p[field];
    if (isUnknownValue(correctRaw)) return; // 不明な項目は問題化しない

    const correctText = String(correctRaw).trim();

    // 他の製品から「異なる値」を集めてダミー選択肢の候補にする（出どころの製品も保持）
    const seen = new Set([correctText]);
    const distractorPool = [];
    products.forEach((other) => {
      if (other === p) return;
      const v = other[field];
      if (isUnknownValue(v)) return;
      const t = String(v).trim();
      if (seen.has(t)) return;
      seen.add(t);
      distractorPool.push({ text: t, product: other });
    });

    if (distractorPool.length < 3) return; // 選択肢が足りない場合は生成しない

    const distractors = pickRandomN(distractorPool, 3);
    const choices = shuffleArray([correctText, ...distractors.map((d) => d.text)]);

    const choiceExplanations = {};
    choiceExplanations[correctText] = {
      result: "正解",
      reason: `${p.maker}「${p.series}」の実際の値は「${correctText}」です。${buildKnowledgeExplanation(p)}`
    };
    distractors.forEach((d) => {
      choiceExplanations[d.text] = {
        result: "不正解",
        reason: `「${d.text}」は${d.product.maker}「${d.product.series}」の値であり、${p.maker}「${p.series}」の値ではありません。${p.maker}「${p.series}」の正しい値は「${correctText}」です。`
      };
    });

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
      choiceExplanations,
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
      distractorPool.push({ label, product: other });
    });

    if (distractorPool.length < 3) return;

    const distractors = pickRandomN(distractorPool, 3);
    const choices = shuffleArray([correctAnswer, ...distractors.map((d) => d.label)]);

    const choiceExplanations = {};
    choiceExplanations[correctAnswer] = {
      result: "正解",
      reason: `この文章は${p.maker}「${p.series}」についての記述です。${buildKnowledgeExplanation(p)}`
    };
    distractors.forEach((d) => {
      const ownText = !isUnknownValue(d.product[field]) ? stripOuterQuotes(d.product[field]) : null;
      // d.labelはメーカー名のみの場合があるため、解説では必ず具体的な製品名まで
      // 明記する（「どの製品と比較して不正解なのか」を常に追える状態にする）
      const specificName = `${d.product.maker}「${d.product.series}」`;
      choiceExplanations[d.label] = {
        result: "不正解",
        reason: ownText
          ? `${specificName}自体の該当項目は「${ownText}」であり、今回の文章とは異なります。今回の文章が指しているのは${p.maker}「${p.series}」です。`
          : `${specificName}にはこの文章に該当する記載がなく、今回の文章が指しているのは${p.maker}「${p.series}」です。`
      };
    });

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
      choiceExplanations,
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
      questions.push(buildBooleanQuestion(correctP, distractors, questionTexts.positive, category, difficulty, field));
    });
  }

  // 「なし」製品を正解にして「あり」製品をダミーにする
  if (falseList.length >= 1 && trueList.length >= 3) {
    falseList.forEach((correctP) => {
      const distractors = pickRandomN(trueList, 3);
      questions.push(buildBooleanQuestion(correctP, distractors, questionTexts.negative, category, difficulty, field));
    });
  }

  return questions;
}

function buildBooleanQuestion(correctP, distractorPs, questionText, category, difficulty, field) {
  const choices = shuffleArray([makerLabel(correctP), ...distractorPs.map(makerLabel)]);

  const choiceExplanations = {};
  choiceExplanations[makerLabel(correctP)] = {
    result: "正解",
    reason: `${makerLabel(correctP)}の該当項目は「${correctP[field]}」で、条件に一致します。${buildKnowledgeExplanation(correctP)}`
  };
  distractorPs.forEach((dp) => {
    choiceExplanations[makerLabel(dp)] = {
      result: "不正解",
      reason: `${makerLabel(dp)}の該当項目は「${isUnknownValue(dp[field]) ? "不明" : dp[field]}」であり、今回問われている条件とは一致しません。`
    };
  });

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
    choiceExplanations,
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

  const comparisonWord = mode === "max" ? "大きく" : "小さく";
  const choiceExplanations = {};
  choiceExplanations[makerLabel(correctP)] = {
    result: "正解",
    reason: `${makerLabel(correctP)}の実際の値は${correctP[field]}で、比較対象の中で最も${mode === "max" ? "大きい" : "小さい"}値です。${buildKnowledgeExplanation(correctP)}`
  };
  others.forEach((x) => {
    choiceExplanations[makerLabel(x.p)] = {
      result: "不正解",
      reason: `${makerLabel(x.p)}の実際の値は${x.p[field]}で、正解ほど${comparisonWord}ありません。`
    };
  });

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
    choiceExplanations,
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

  // answerTypeは全て"product"（メーカー＋製品名）に統一している。
  // 以前は"maker"（メーカー名のみ）を使っていたが、同じメーカーが複数製品を
  // 持つ場合に「どの製品と比較して不正解なのか」が選択肢からは分からず、
  // 選択肢ごとの解説を読んでも紐づけにくいという指摘を受けたため。
  // 質問文もそもそも「製品はどれ？」と聞いているので、製品単位の方が一致する。
  qs = qs.concat(genReverseQuestions(products, "suitableFamily",
    "次のような家庭に向いている製品はどれ？", "メリット/デメリット", "中級", "product"));
  qs = qs.concat(genReverseQuestions(products, "merit",
    "次のメリットが特徴とされている製品はどれ？", "メリット/デメリット", "中級", "product"));
  qs = qs.concat(genReverseQuestions(products, "salesPoint",
    "次の営業トークが訴求ポイントとして合う製品はどれ？", "営業トーク", "中級", "product"));
  qs = qs.concat(genReverseQuestions(products, "feature",
    "次の特徴を持つ製品はどれ？", "メーカー比較", "中級", "product"));

  // ===== 上級：デメリット・複数メーカー比較 =====
  qs = qs.concat(genReverseQuestions(products, "demerit",
    "次のデメリット（注意点）が指摘されている製品はどれ？", "メリット/デメリット", "上級", "product"));

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
  const weakParts = wrongPs.map((wp) => describeWrongChoiceReason(wp, category, rule));
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

// 誤答（不向きな製品）を選んだ理由。客観的な失格条件（実データ上の矛盾）が
// あればそれを優先し、なければデメリット、それも無ければ重視ポイントとの
// 合致度で説明する。buildPracticeExplanationとchoiceExplanationsの両方で使う。
function describeWrongChoiceReason(wp, category, rule) {
  if (rule && rule.isDisqualified(wp)) {
    return `${wp.maker}「${wp.series}」は${rule.reason(wp)}ため、この条件のお客様には明確に不向きです`;
  }
  if (!isUnknownValue(wp.demerit)) {
    return `${wp.maker}「${wp.series}」は「${stripOuterQuotes(wp.demerit)}」という注意点があり、このお客様の最優先ニーズとはズレがあります`;
  }
  return `${wp.maker}「${wp.series}」は今回のお客様の重視ポイント（${PRACTICE_PRIORITY_LABEL[category] || category}）との合致度で一歩譲ります`;
}

// 「この選択肢はどんな場面なら有効か」を示す一文（誤答の製品自身の強みを紹介する）
function describeWhenApplicable(wp) {
  if (!isUnknownValue(wp.salesPoint)) {
    return `この製品自体は「${stripOuterQuotes(wp.salesPoint)}」という強みがあり、条件が異なるお客様には有効な提案になり得ます。`;
  }
  if (!isUnknownValue(wp.merit)) {
    return `この製品自体は「${stripOuterQuotes(wp.merit)}」というメリットがあり、条件が異なるお客様には有効な提案になり得ます。`;
  }
  return "お客様の状況によっては有効な提案になり得るため、条件を再確認しましょう。";
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

    // 選択肢ごとの比較（正解/不正解・理由・営業判断のポイント）
    const choiceExplanations = {};
    choiceExplanations[makerLabel(p)] = {
      result: "正解",
      reason: `お客様状況の「${stripOuterQuotes(p.suitableFamily)}」という条件に最も合致します。`,
      salesPoint: !isUnknownValue(p.salesPoint) ? stripOuterQuotes(p.salesPoint) : ""
    };
    wrongs.forEach((wp) => {
      choiceExplanations[makerLabel(wp)] = {
        result: "不正解",
        reason: describeWrongChoiceReason(wp, category, rule) + "。",
        salesPoint: describeWhenApplicable(wp)
      };
    });

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
      choiceExplanations,
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

    // 選択肢ごとの比較。この設問は「不適切なものを選ぶ」消去法なので、
    // 失格製品(badPick)の訴求ポイントを選ぶことが「このクイズの正解」になる点に注意。
    const choiceExplanations = {};
    choiceProducts.forEach((cp) => {
      const text = stripOuterQuotes(cp.salesPoint);
      if (cp === badPick) {
        choiceExplanations[text] = {
          result: "正解",
          reason: `このお客様は「${rule.requirement}」ことを必須条件としていますが、${cp.maker}「${cp.series}」は${rule.reason(cp)}ため、この訴求ポイントで断定的に提案するのは避けるべきです。`,
          salesPoint: !isUnknownValue(cp.merit)
            ? `この製品自体は「${stripOuterQuotes(cp.merit)}」という強みを持つため、条件が異なるお客様には有効な選択肢になり得ます。`
            : "条件が異なるお客様には有効な選択肢になり得るため、要件を再確認しましょう。"
        };
      } else {
        choiceExplanations[text] = {
          result: "不正解",
          reason: `${cp.maker}「${cp.series}」は公式データ上「${rule.requirement}」という必須条件と明確に矛盾する情報がないため、この訴求ポイントで提案すること自体は問題ありません。`,
          salesPoint: "そのため「明らかに不適切な提案」には該当せず、今回の設問では不正解の選択肢です。"
        };
      }
    });

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
      choiceExplanations,
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


module.exports = {
  SHEET_CONFIG,
  loadProductsFromSheet,
  resetQuestionIdCounter,
  generateKnowledgeQuestions,
  generatePracticeQuestions
};
