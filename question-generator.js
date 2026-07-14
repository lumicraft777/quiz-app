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
  { name: "蓄電池メーカー比較", sheet: "再リサーチ", type: "battery" }
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

// スプレッドシートの記載が「〜の可能性がある」「確認できず」のような
// 推測・断定回避の表現になっている場合、そのまま問題文や解説に出すと
// 実務で使える知識として頼りない印象になってしまう。上級問題では
// こうした曖昧な記載を出題対象から除外し、断定できる事実のみを扱う。
function containsVagueHedging(text) {
  if (isUnknownValue(text)) return false;
  const s = String(text);
  return /可能性|かもしれない|と思われる|とみられる|恐れがある|断定はできない|確認できず|明記されていない|不明瞭|おそらく|といわれる|一部不明/.test(s);
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
    // 「〜の可能性がある」「確認できず」のような曖昧・推測混じりの記載は、
    // 断定できる知識として出題するのに向かないため対象から外す
    if (containsVagueHedging(p[field])) return;
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

    // デメリット（注意点）の逆引き問題は、単なる暗記ではなく「営業として
    // どう扱うべきか」まで解説することで実践的な内容にする
    const explanationText = field === "demerit"
      ? `この注意点は${p.maker}「${p.series}」に該当します。営業時にはこの点を隠さず正直に伝え、事前確認を怠らないようにしましょう。${buildKnowledgeExplanation(p)}`
      : buildKnowledgeExplanation(p);

    const choiceExplanations = {};
    choiceExplanations[correctAnswer] = {
      result: "正解",
      reason: field === "demerit"
        ? `この注意点は${p.maker}「${p.series}」に該当します。提案の際は先回りして説明し、お客様の懸念を先に解消しておくことが信頼につながります。`
        : `この文章は${p.maker}「${p.series}」についての記述です。${buildKnowledgeExplanation(p)}`
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
      explanation: explanationText,
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
      reason: `${makerLabel(x.p)}の実際の値は${x.p[field]}で、正解ほど${comparisonWord}ありません。ただしこの製品にも別の強みがあるため、条件次第では有効な選択肢になり得ます。`
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
      `数字を暗記するだけでなく、「この差がどんなお客様にとって決め手になるか」まで説明できて初めて営業トークとして使えます。` +
      `数値の大小だけで押すのではなく、お客様が実際にその差を必要としているかを見極めてから伝えましょう。`,
    choiceExplanations,
    sourceManufacturer: correctP.maker,
    sourceProduct: correctP.series
  };
}

/* ---- 3-5. 蓄電池シート用：知識問題プールの組み立て ---- */
function generateKnowledgeQuestions(products) {
  let qs = [];

  // ===== 中級：製品ごとの基本スペック =====
  // （旧・初級。細かい数値・型番レベルの知識は、訪問営業のアポインターが
  //   最低限覚えるべき内容ではないため中級に位置づけ、初級は
  //   generateBasicConceptQuestions() の基礎概念問題に置き換えている）
  qs = qs.concat(genFieldQuestions(products, "warrantyYears",
    (p) => `${p.maker}「${p.series}」の製品保証年数として正しいものはどれ？`, "保証", "中級"));
  qs = qs.concat(genFieldQuestions(products, "capacityWarrantyYears",
    (p) => `${p.maker}「${p.series}」の容量保証として正しいものはどれ？`, "保証", "中級"));
  qs = qs.concat(genFieldQuestions(products, "capacityKwh",
    (p) => `${p.maker}「${p.series}」の蓄電容量(kWh)として正しいものはどれ？`, "容量", "中級"));
  qs = qs.concat(genFieldQuestions(products, "usableCapacityKwh",
    (p) => `${p.maker}「${p.series}」の実効容量(kWh)として正しいものはどれ？`, "容量", "中級"));
  qs = qs.concat(genFieldQuestions(products, "batteryMaterial",
    (p) => `${p.maker}「${p.series}」に採用されている電池材料・種類はどれ？`, "電池材料", "中級"));
  qs = qs.concat(genFieldQuestions(products, "batteryType",
    (p) => `${p.maker}「${p.series}」の蓄電池タイプ（ハイブリッド型/単機能型など）はどれ？`, "メーカー比較", "中級"));

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
      difficulty: "上級",
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


/* ================================================================
   [パート5] 基礎知識問題（初級）の自動生成ロジック
   ----------------------------------------------------------------
   スプレッドシートの製品データには依存しない、静的な問題セット。
   訪問営業のアポインターが「最低限これだけは覚えておくべき」という
   太陽光・蓄電池の基礎概念（役割の違い・停電時の基本・全負荷/特定負荷の
   超基本・V2Hの超基本・お客様からよく聞かれる質問）を扱う。
   細かい型番・数値・メーカー比較は中級/上級に譲り、ここでは
   「意味・違い・用途」を問う内容だけに絞っている。
   ================================================================ */
const BASIC_CONCEPT_SPECS = [
  // ---- 太陽光発電の基本 ----
  {
    q: "太陽光発電の主な役割として最も近いものはどれですか？",
    choices: ["電気を作る", "水を温める", "電気を貯める", "ガスを作る"],
    answer: "電気を作る",
    explanation: "太陽光発電は、太陽の光を使って電気を作る設備です。蓄電池は電気を貯める設備なので、役割が違います。",
    reasons: {
      "水を温める": "「水を温める」のは太陽熱温水器などの設備で、太陽光発電とは異なります。",
      "電気を貯める": "「電気を貯める」のは蓄電池の役割です。太陽光発電は電気を作る設備です。",
      "ガスを作る": "太陽光発電はガスを作る設備ではありません。"
    }
  },
  {
    q: "太陽光発電が電気を作るのは、主にどのタイミングですか？",
    choices: ["日中（太陽が出ている間）", "夜間のみ", "天気に関係なく24時間一定", "雨の日だけ"],
    answer: "日中（太陽が出ている間）",
    explanation: "太陽光発電は太陽の光をエネルギー源にしているため、主に日中に発電します。夜間は発電量がほぼゼロになります。",
    reasons: {
      "夜間のみ": "夜は太陽の光がないため発電できません。",
      "天気に関係なく24時間一定": "天候や時間帯によって発電量は変動します。",
      "雨の日だけ": "雨の日はむしろ発電量が少なくなります。"
    }
  },
  {
    q: "太陽光で発電した電気の使い道として正しいものはどれですか？",
    choices: [
      "家庭で使う・売電する・蓄電池に貯める",
      "発電した電気は必ずすべて売電しなければならない",
      "発電した電気は貯めることができない",
      "発電した電気はガスに変換される"
    ],
    answer: "家庭で使う・売電する・蓄電池に貯める",
    explanation: "太陽光で作った電気は、家庭内で使う（自家消費）、電力会社に売る（売電）、蓄電池に貯める、という3つの使い道があります。",
    reasons: {
      "発電した電気は必ずすべて売電しなければならない": "自家消費や蓄電も選べるため、必ず全量売電しなければならないわけではありません。",
      "発電した電気は貯めることができない": "蓄電池があれば発電した電気を貯めることができます。",
      "発電した電気はガスに変換される": "電気をガスに変換する仕組みではありません。"
    }
  },
  {
    q: "太陽光発電が電気代対策になる理由として、最も適切なものはどれですか？",
    choices: [
      "電力会社から買う電気の量を減らせるから",
      "電気代がすべて0円になるから",
      "太陽光発電は電気代と関係がないから",
      "太陽光発電をすると電気代の請求が来なくなるから"
    ],
    answer: "電力会社から買う電気の量を減らせるから",
    explanation: "太陽光で作った電気を自宅で使うことで、電力会社から買う電気の量が減り、結果として電気代の削減につながります。",
    reasons: {
      "電気代がすべて0円になるから": "天候や使用量によって発電量は変わるため、必ず0円になるとは限りません。",
      "太陽光発電は電気代と関係がないから": "自家消費によって電気代に影響します。",
      "太陽光発電をすると電気代の請求が来なくなるから": "電力会社との契約自体はなくならないため、請求は続きます。"
    }
  },
  {
    q: "太陽光発電で電気が余った場合、どうなりますか？",
    choices: [
      "売電するか、蓄電池があれば貯めることができる",
      "自動的に消えてなくなる",
      "必ず近所で分け合う",
      "電力会社に無償で没収される"
    ],
    answer: "売電するか、蓄電池があれば貯めることができる",
    explanation: "使いきれず余った電気は、電力会社に売る（売電）か、蓄電池があれば貯めておくことができます。",
    reasons: {
      "自動的に消えてなくなる": "電気は消えてなくなるわけではなく、売電や蓄電に使われます。",
      "必ず近所で分け合う": "近所と直接電気を分け合うような仕組みではありません。",
      "電力会社に無償で没収される": "売電は契約に基づいた買い取りであり、無償で没収されるものではありません。"
    }
  },
  // ---- 蓄電池の基本 ----
  {
    q: "蓄電池の主な役割として最も近いものはどれですか？",
    choices: ["電気を貯める", "電気を作る", "ガスを作る", "水道代を下げる"],
    answer: "電気を貯める",
    explanation: "蓄電池は電気を貯める設備です。太陽光で作った電気や、電力会社から買った電気を貯めて、夜間や停電時に使える場合があります。",
    reasons: {
      "電気を作る": "電気を作るのは太陽光発電の役割です。",
      "ガスを作る": "ガスを作る設備ではありません。",
      "水道代を下げる": "水道代とは直接関係ありません。"
    }
  },
  {
    q: "蓄電池に貯められる電気として正しいものはどれですか？",
    choices: [
      "太陽光の余剰電力や、電力会社から買った電気",
      "雨水だけ",
      "ガスだけ",
      "太陽光の電気以外は貯められない"
    ],
    answer: "太陽光の余剰電力や、電力会社から買った電気",
    explanation: "蓄電池は、太陽光で余った電気だけでなく、電力会社から買った電気（深夜電力など）も貯めることができます。",
    reasons: {
      "雨水だけ": "蓄電池は電気を貯める設備で、雨水とは関係ありません。",
      "ガスだけ": "ガスを貯める設備ではありません。",
      "太陽光の電気以外は貯められない": "電力会社から買った電気も貯めることができます。"
    }
  },
  {
    q: "蓄電池が特に役立つ場面として正しいものはどれですか？",
    choices: ["夜間や停電時", "晴れた日の昼間だけ", "電気を全く使わないとき", "太陽光が無い家では一切役に立たない"],
    answer: "夜間や停電時",
    explanation: "蓄電池は、太陽光が発電しない夜間や、電力会社からの電気が止まる停電時に、貯めていた電気を使える点で役立ちます。",
    reasons: {
      "晴れた日の昼間だけ": "昼間は太陽光の電気をそのまま使えるため、蓄電池の効果がより出るのはむしろ夜間・停電時です。",
      "電気を全く使わないとき": "電気を使わなければ、貯めた電気を使う場面自体がありません。",
      "太陽光が無い家では一切役に立たない": "太陽光が無くても、電力会社の電気を貯めて夜使うといった使い方は可能です。"
    }
  },
  {
    q: "蓄電池は災害対策としてどのように役立ちますか？",
    choices: ["停電時に貯めていた電気を使える場合がある", "地震の揺れを軽減する", "断水を防ぐ", "火災を防ぐ"],
    answer: "停電時に貯めていた電気を使える場合がある",
    explanation: "蓄電池は災害による停電時に、貯めていた電気を使える場合があるため、防災・災害対策の観点でも案内されることが多い設備です。",
    reasons: {
      "地震の揺れを軽減する": "揺れを軽減する免震・耐震設備ではありません。",
      "断水を防ぐ": "断水対策には給水タンク等が必要で、蓄電池とは別の話です。",
      "火災を防ぐ": "火災を防ぐ設備ではありません。"
    }
  },
  {
    q: "太陽光と蓄電池を組み合わせることのメリットとして正しいものはどれですか？",
    choices: [
      "昼間に作った電気を夜にも活用でき、効果が出やすい",
      "組み合わせると発電量が2倍になる",
      "組み合わせないと故障しやすくなる",
      "組み合わせると売電が禁止される"
    ],
    answer: "昼間に作った電気を夜にも活用でき、効果が出やすい",
    explanation: "太陽光だけでは夜に電気を使えませんが、蓄電池を組み合わせることで昼間の余剰電力を夜に活用でき、自家消費率が高まります。",
    reasons: {
      "組み合わせると発電量が2倍になる": "発電量そのものが増えるわけではありません。",
      "組み合わせないと故障しやすくなる": "組み合わせない場合に故障しやすくなるという関係はありません。",
      "組み合わせると売電が禁止される": "売電の可否は契約や制度によるもので、蓄電池を組み合わせたから禁止されるわけではありません。"
    }
  },
  {
    q: "蓄電池は太陽光発電が無い家庭でも導入する意味はありますか？",
    choices: [
      "深夜の安い電力を貯めて日中に使うなど、単独でも意味がある場合がある",
      "太陽光が無い家庭では一切意味がない",
      "蓄電池は太陽光とセットでしか販売されていない",
      "太陽光が無い家庭では蓄電池を設置できない"
    ],
    answer: "深夜の安い電力を貯めて日中に使うなど、単独でも意味がある場合がある",
    explanation: "蓄電池は、太陽光が無くても、電気代が安い時間帯の電力を貯めて日中に使うなど、単独での活用方法もあります。ただし太陽光と組み合わせた方が効果は出やすいです。",
    reasons: {
      "太陽光が無い家庭では一切意味がない": "太陽光が無くても活用方法はあるため「一切意味がない」は言い過ぎです。",
      "蓄電池は太陽光とセットでしか販売されていない": "セット販売が必須というわけではありません。",
      "太陽光が無い家庭では蓄電池を設置できない": "太陽光が無くても蓄電池単体で設置できる場合があります。"
    }
  },
  // ---- 太陽光と蓄電池の違い ----
  {
    q: "太陽光と蓄電池の違いとして正しいものはどれですか？",
    choices: [
      "太陽光は電気を作り、蓄電池は電気を貯める",
      "太陽光は電気を貯め、蓄電池は電気を作る",
      "どちらも水を温める設備である",
      "どちらもガス代を下げる設備である"
    ],
    answer: "太陽光は電気を作り、蓄電池は電気を貯める",
    explanation: "太陽光は電気を作る設備、蓄電池は電気を貯める設備です。役割を分けて理解することが大切です。",
    reasons: {
      "太陽光は電気を貯め、蓄電池は電気を作る": "役割が逆です。太陽光が作る、蓄電池が貯める、が正しい対応です。",
      "どちらも水を温める設備である": "水を温める設備ではありません。",
      "どちらもガス代を下げる設備である": "ガス代ではなく主に電気代に関係する設備です。"
    }
  },
  {
    q: "太陽光発電だけを導入した場合にできないこととして正しいものはどれですか？",
    choices: ["夜間に発電すること", "昼間に発電すること", "余った電気を売電すること", "自家消費すること"],
    answer: "夜間に発電すること",
    explanation: "太陽光発電は太陽の光が無いと発電できないため、夜間は発電できません。夜も電気を活用したい場合は蓄電池が必要です。",
    reasons: {
      "昼間に発電すること": "昼間の発電はできます。",
      "余った電気を売電すること": "売電自体はできます。",
      "自家消費すること": "自家消費もできます。"
    }
  },
  {
    q: "蓄電池を導入すると、太陽光だけの場合と比べて何が変わりますか？",
    choices: [
      "夜間にも貯めた電気を使えるようになる",
      "太陽光の発電量が増える",
      "売電が完全にできなくなる",
      "電気工事が不要になる"
    ],
    answer: "夜間にも貯めた電気を使えるようになる",
    explanation: "蓄電池を組み合わせることで、昼間に太陽光で作って余った電気を夜間にも使えるようになります。",
    reasons: {
      "太陽光の発電量が増える": "発電量そのものは変わりません。",
      "売電が完全にできなくなる": "売電をどこまで行うかは契約次第で、蓄電池があるからといって完全にできなくなるわけではありません。",
      "電気工事が不要になる": "蓄電池の設置にも電気工事は必要です。"
    }
  },
  {
    q: "「太陽光と蓄電池はセットでないと導入できないんですか？」と聞かれた場合、最も適切な回答はどれですか？",
    choices: [
      "セットでなくても導入できますが、組み合わせるとより効果を発揮しやすいです",
      "セットでないと絶対に導入できません",
      "蓄電池だけは違法です",
      "太陽光だけは違法です"
    ],
    answer: "セットでなくても導入できますが、組み合わせるとより効果を発揮しやすいです",
    explanation: "太陽光・蓄電池はそれぞれ単独でも導入可能です。ただし、組み合わせることで昼の電気を夜にも使えるなど、より効果を発揮しやすくなります。",
    reasons: {
      "セットでないと絶対に導入できません": "単独導入も可能なため誤りです。",
      "蓄電池だけは違法です": "蓄電池単独の導入は違法ではありません。",
      "太陽光だけは違法です": "太陽光単独の導入も違法ではありません。"
    }
  },
  // ---- 停電時の基本 ----
  {
    q: "蓄電池があると停電時に期待できることとして、最も近いものはどれですか？",
    choices: ["貯めていた電気を使える場合がある", "ガスが自動で復旧する", "水道水を作れる", "電気代が必ず0円になる"],
    answer: "貯めていた電気を使える場合がある",
    explanation: "蓄電池があると、停電時に貯めていた電気を使える場合があります。ただし、使える家電や範囲は機種や配線方式によって異なります。",
    reasons: {
      "ガスが自動で復旧する": "ガスの復旧とは関係ありません。",
      "水道水を作れる": "水道水を作る設備ではありません。",
      "電気代が必ず0円になる": "停電時の電気代とは別の話で、必ず0円になるとは限りません。"
    }
  },
  {
    q: "停電時、蓄電池があれば家中すべての家電が必ず使えますか？",
    choices: [
      "機種や配線方式によって、使える範囲は異なる",
      "どんな機種でも家中すべて使える",
      "蓄電池があっても一切家電は使えない",
      "停電時は蓄電池の電源が自動で切れる仕組みになっている"
    ],
    answer: "機種や配線方式によって、使える範囲は異なる",
    explanation: "停電時に使える範囲は、全負荷型か特定負荷型かなど、機種や配線方式によって異なります。すべての機種で家中すべてが使えるとは限りません。",
    reasons: {
      "どんな機種でも家中すべて使える": "機種によっては使える範囲が限定される場合があります。",
      "蓄電池があっても一切家電は使えない": "機種によっては一部または全部の家電が使えます。",
      "停電時は蓄電池の電源が自動で切れる仕組みになっている": "自動で電源が切れる仕組みが標準というわけではありません。"
    }
  },
  {
    q: "蓄電池の「全負荷型」「特定負荷型」という違いがある理由として、最も適切なものはどれですか？",
    choices: [
      "停電時に電気を使える範囲が異なるため",
      "メーカーの本社所在地が異なるため",
      "電気の色が違うため",
      "太陽光の有無で名前が変わるだけで実際は同じもの"
    ],
    answer: "停電時に電気を使える範囲が異なるため",
    explanation: "全負荷型と特定負荷型は、停電時に電気を使える範囲（家全体か、一部の回路か）が異なるために分かれています。",
    reasons: {
      "メーカーの本社所在地が異なるため": "メーカーの所在地とは関係ありません。",
      "電気の色が違うため": "電気の色が変わることはありません。",
      "太陽光の有無で名前が変わるだけで実際は同じもの": "実際に使える範囲が異なるため、名前だけの違いではありません。"
    }
  },
  {
    q: "停電時に使いたい家電を事前に確認しておく必要があるのはなぜですか？",
    choices: [
      "機種によって停電時に使える範囲・容量に限りがあるため",
      "確認しなくても必ずすべて使えるため",
      "確認すると保証が切れてしまうため",
      "電力会社への届け出が必要なため"
    ],
    answer: "機種によって停電時に使える範囲・容量に限りがあるため",
    explanation: "停電時に使える電気の範囲や容量には限りがあるため、お客様が「停電時に何を使いたいか」を事前に確認し、それに合った機種を提案することが大切です。",
    reasons: {
      "確認しなくても必ずすべて使えるため": "範囲・容量に限りがあるため、事前確認は必要です。",
      "確認すると保証が切れてしまうため": "事前確認と保証は関係ありません。",
      "電力会社への届け出が必要なため": "事前確認は営業上の提案精度を上げるためのもので、電力会社への届け出とは別の話です。"
    }
  },
  // ---- 全負荷・特定負荷の超基本 ----
  {
    q: "全負荷型と特定負荷型の違いとして、最も近いものはどれですか？",
    choices: ["停電時に使える範囲が違う", "太陽光を作る会社が違う", "電気の色が変わる", "蓄電池が不要になる"],
    answer: "停電時に使える範囲が違う",
    explanation: "全負荷型は家全体に近い範囲、特定負荷型はあらかじめ決めた一部の回路で電気を使うタイプです。停電時にどこまで使いたいかで選び方が変わります。",
    reasons: {
      "太陽光を作る会社が違う": "メーカーとは関係ありません。",
      "電気の色が変わる": "電気の色が変わることはありません。",
      "蓄電池が不要になる": "どちらのタイプでも蓄電池自体は必要です。"
    }
  },
  {
    q: "「全負荷型」の説明として最も近いものはどれですか？",
    choices: [
      "停電時、家全体に近い範囲で電気を使えるタイプ",
      "停電時、あらかじめ決めた一部の回路だけ使えるタイプ",
      "停電時は一切電気が使えないタイプ",
      "太陽光が無いと使えないタイプ"
    ],
    answer: "停電時、家全体に近い範囲で電気を使えるタイプ",
    explanation: "全負荷型は、停電時でも家全体に近い範囲で電気を使えるタイプです。特定負荷型と比べて使える範囲が広いのが特徴です。",
    reasons: {
      "停電時、あらかじめ決めた一部の回路だけ使えるタイプ": "これは特定負荷型の説明です。",
      "停電時は一切電気が使えないタイプ": "全負荷型でも停電時に電気を使うことができます。",
      "太陽光が無いと使えないタイプ": "太陽光が無くても全負荷型の蓄電池を使うこと自体は可能です。"
    }
  },
  {
    q: "「特定負荷型」の説明として最も近いものはどれですか？",
    choices: [
      "停電時、あらかじめ決めた一部の回路だけ電気を使えるタイプ",
      "停電時、家全体で電気を使えるタイプ",
      "停電時に発電量が増えるタイプ",
      "太陽光専用の呼び方で蓄電池とは無関係"
    ],
    answer: "停電時、あらかじめ決めた一部の回路だけ電気を使えるタイプ",
    explanation: "特定負荷型は、停電時にあらかじめ決めておいた一部の回路（例：冷蔵庫やリビングの照明など）だけ電気を使えるタイプです。",
    reasons: {
      "停電時、家全体で電気を使えるタイプ": "これは全負荷型の説明です。",
      "停電時に発電量が増えるタイプ": "発電量が増える仕組みではありません。",
      "太陽光専用の呼び方で蓄電池とは無関係": "蓄電池の負荷タイプを表す言葉であり、太陽光専用の呼び方ではありません。"
    }
  },
  // ---- V2Hの超基本 ----
  {
    q: "V2Hとは、どのような仕組みですか？",
    choices: [
      "電気自動車（EV）と家をつなぐ仕組み",
      "電気自動車のバッテリーを充電する専用の道路",
      "家の電気を自動で節約する仕組み",
      "太陽光パネルの設置方法の名称"
    ],
    answer: "電気自動車（EV）と家をつなぐ仕組み",
    explanation: "V2H（Vehicle to Home）は、電気自動車（EV）と家をつなぎ、EVに貯めた電気を家庭で使えるようにする仕組みです。",
    reasons: {
      "電気自動車のバッテリーを充電する専用の道路": "道路の仕組みではありません。",
      "家の電気を自動で節約する仕組み": "自動節約機能ではありません。",
      "太陽光パネルの設置方法の名称": "太陽光パネルの設置方法の名称ではありません。"
    }
  },
  {
    q: "V2Hを導入すると、どのようなことができる場合がありますか？",
    choices: [
      "EVに貯めた電気を家庭で使うこと",
      "家の電気を自動でEVの燃料に変換すること",
      "EVを持っていなくても使えること",
      "太陽光が無いと一切使えないこと"
    ],
    answer: "EVに貯めた電気を家庭で使うこと",
    explanation: "V2Hがあると、EVに貯めた電気を家庭側で使える場合があります。停電時の非常用電源としても案内されることがあります。",
    reasons: {
      "家の電気を自動でEVの燃料に変換すること": "電気を燃料に変換する仕組みではありません。",
      "EVを持っていなくても使えること": "V2HはEVがあってこそ活用できる仕組みです。",
      "太陽光が無いと一切使えないこと": "太陽光が無くてもV2H自体は活用できる場合があります。"
    }
  },
  {
    q: "V2Hの提案が特に関係しやすいお客様として、最も近いものはどれですか？",
    choices: [
      "電気自動車（EV）を持っている、または検討している家庭",
      "電気自動車に一切興味が無い家庭",
      "自転車移動が中心の家庭",
      "電気を全く使わない家庭"
    ],
    answer: "電気自動車（EV）を持っている、または検討している家庭",
    explanation: "V2HはEVと家をつなぐ仕組みのため、EVを既に持っている、またはこれから検討している家庭には特に関係が深いご提案になります。",
    reasons: {
      "電気自動車に一切興味が無い家庭": "EVに興味が無い場合はV2Hの必要性を感じにくいです。",
      "自転車移動が中心の家庭": "自転車移動が中心の家庭にはEV関連の設備は関係が薄いです。",
      "電気を全く使わない家庭": "電気を使わない家庭という前提が非現実的で、V2Hの対象になりにくいです。"
    }
  },
  // ---- 訪問営業でよく聞かれる質問 ----
  {
    q: "お客様から「太陽光って何がいいの？」と聞かれた場合、最も適切な回答はどれですか？",
    choices: [
      "昼間に電気を作って自宅で使えるので、電気代対策になります",
      "夜も自動で電気を無限に作れます",
      "設置すると水道代が下がります",
      "ガス代が完全に0円になります"
    ],
    answer: "昼間に電気を作って自宅で使えるので、電気代対策になります",
    explanation: "太陽光発電は昼間に電気を作り、自宅で使うことで電力会社から買う電気を減らせるため、電気代対策になるとお伝えするのが基本です。",
    reasons: {
      "夜も自動で電気を無限に作れます": "夜間は発電できないため「無限に作れる」は誤りです。",
      "設置すると水道代が下がります": "水道代とは直接関係ありません。",
      "ガス代が完全に0円になります": "ガス代が0円になるわけではありません。"
    }
  },
  {
    q: "お客様から「蓄電池って何のためにあるの？」と聞かれた場合、最も適切な回答はどれですか？",
    choices: [
      "電気を貯めておいて、夜間や停電時に使うためです",
      "電気を作るためです",
      "ガスを貯めるためです",
      "水道代を下げるためです"
    ],
    answer: "電気を貯めておいて、夜間や停電時に使うためです",
    explanation: "蓄電池は電気を貯める設備で、太陽光の余剰電力や夜間の安い電力を貯めておき、必要なときに使えるようにするための設備です。",
    reasons: {
      "電気を作るためです": "電気を作るのは太陽光発電の役割です。",
      "ガスを貯めるためです": "ガスを貯める設備ではありません。",
      "水道代を下げるためです": "水道代とは直接関係ありません。"
    }
  },
  {
    q: "お客様から「停電時に使えるの？」と聞かれた場合、最も適切な回答はどれですか？",
    choices: [
      "蓄電池があれば、貯めていた電気を使える場合があります。ただし使える範囲は機種によって異なります",
      "蓄電池が無くても停電時は自動で電気が使えます",
      "停電時は法律で電気を使うことが禁止されています",
      "蓄電池があれば停電は絶対に起きません"
    ],
    answer: "蓄電池があれば、貯めていた電気を使える場合があります。ただし使える範囲は機種によって異なります",
    explanation: "停電時に使えるかどうかは蓄電池の有無と機種によって変わるため、「使える場合がある」「範囲は機種による」という前提を正直にお伝えすることが大切です。",
    reasons: {
      "蓄電池が無くても停電時は自動で電気が使えます": "蓄電池が無ければ停電時に自宅の電気を使うことは基本的にできません。",
      "停電時は法律で電気を使うことが禁止されています": "停電時に電気を使うこと自体が禁止されているわけではありません。",
      "蓄電池があれば停電は絶対に起きません": "蓄電池があっても停電そのものを防ぐことはできません。"
    }
  },
  {
    q: "お客様から「売電って何？」と聞かれた場合、最も適切な回答はどれですか？",
    choices: [
      "太陽光で作って使い切れなかった電気を、電力会社に買い取ってもらう仕組みです",
      "電気を無料で近所に配る仕組みです",
      "電力会社から電気を安く買う仕組みです",
      "蓄電池を売る仕組みです"
    ],
    answer: "太陽光で作って使い切れなかった電気を、電力会社に買い取ってもらう仕組みです",
    explanation: "売電とは、太陽光で発電して自宅で使いきれなかった電気を、電力会社に買い取ってもらう仕組みのことです。",
    reasons: {
      "電気を無料で近所に配る仕組みです": "近所へ無料で配る仕組みではありません。",
      "電力会社から電気を安く買う仕組みです": "電気を買う仕組みではなく、売る仕組みです。",
      "蓄電池を売る仕組みです": "蓄電池自体を売買する話ではありません。"
    }
  },
  {
    q: "お客様から「電気代は安くなるの？」と聞かれた場合、最も適切な回答はどれですか？",
    choices: [
      "自家消費が増えることで電力会社から買う電気が減り、電気代の削減につながりやすいです",
      "契約すると必ず電気代が0円になります",
      "電気代とは一切関係ありません",
      "電気代はむしろ確実に上がります"
    ],
    answer: "自家消費が増えることで電力会社から買う電気が減り、電気代の削減につながりやすいです",
    explanation: "太陽光・蓄電池の導入により自家消費が増えると、電力会社から買う電気の量が減るため、電気代の削減につながりやすいとお伝えします。ただし「必ず0円」など断定的な表現は避けましょう。",
    reasons: {
      "契約すると必ず電気代が0円になります": "必ず0円になるとは限らないため、断定的な表現は避けるべきです。",
      "電気代とは一切関係ありません": "電気代と密接に関係します。",
      "電気代はむしろ確実に上がります": "電気代が確実に上がるとは限りません。"
    }
  },
  {
    q: "お客様から「昼間家にいないと意味ないの？」と聞かれた場合、最も適切な回答はどれですか？",
    choices: [
      "蓄電池があれば、昼間に作った電気を夜に貯めて使えるので、日中不在でも活用しやすくなります",
      "昼間家にいない家庭には一切メリットがありません",
      "昼間家にいない場合は契約自体ができません",
      "蓄電池は昼間しか使えません"
    ],
    answer: "蓄電池があれば、昼間に作った電気を夜に貯めて使えるので、日中不在でも活用しやすくなります",
    explanation: "日中不在で自家消費が少ない家庭でも、蓄電池があれば昼間の余剰電力を貯めて夜に使えるため、活用しやすくなるとご案内できます。",
    reasons: {
      "昼間家にいない家庭には一切メリットがありません": "蓄電池と組み合わせることでメリットを出しやすくなるため「一切メリットがない」は言い過ぎです。",
      "昼間家にいない場合は契約自体ができません": "日中不在でも契約・導入は可能です。",
      "蓄電池は昼間しか使えません": "蓄電池は夜間や停電時にも使えます。"
    }
  },
  {
    q: "お客様から「蓄電池だけでも使えるの？」と聞かれた場合、最も適切な回答はどれですか？",
    choices: [
      "太陽光が無くても、電力会社から買った電気を貯めて使うなど、蓄電池単独での活用方法もあります",
      "蓄電池は太陽光が無いと絶対に使えません",
      "蓄電池だけの場合は電気を貯めることができません",
      "蓄電池単独では法律違反になります"
    ],
    answer: "太陽光が無くても、電力会社から買った電気を貯めて使うなど、蓄電池単独での活用方法もあります",
    explanation: "蓄電池は太陽光が無くても、深夜の安い電力を貯めて日中に使うなど、単独での活用方法があります。ただし太陽光と組み合わせるとより効果が出やすい点も併せてお伝えすると丁寧です。",
    reasons: {
      "蓄電池は太陽光が無いと絶対に使えません": "太陽光が無くても蓄電池単独で活用できる場合があります。",
      "蓄電池だけの場合は電気を貯めることができません": "蓄電池単独でも電気を貯めることはできます。",
      "蓄電池単独では法律違反になります": "単独導入自体は法律違反ではありません。"
    }
  },
  {
    q: "お客様から「太陽光と蓄電池はセットじゃないとダメなの？」と聞かれた場合、最も適切な回答はどれですか？",
    choices: [
      "セットでなくても導入できますが、組み合わせるとより効果を発揮しやすくなります",
      "セットでなければ絶対に導入できません",
      "蓄電池のみの導入は違法です",
      "太陽光のみの導入は違法です"
    ],
    answer: "セットでなくても導入できますが、組み合わせるとより効果を発揮しやすくなります",
    explanation: "太陽光・蓄電池はそれぞれ単独でも導入可能です。組み合わせることで昼間の電気を夜にも使えるなど、より高い効果を発揮しやすくなるとお伝えします。",
    reasons: {
      "セットでなければ絶対に導入できません": "それぞれ単独でも導入可能なため誤りです。",
      "蓄電池のみの導入は違法です": "蓄電池のみの導入は違法ではありません。",
      "太陽光のみの導入は違法です": "太陽光のみの導入も違法ではありません。"
    }
  }
];

function generateBasicConceptQuestions() {
  return BASIC_CONCEPT_SPECS.map((spec) => {
    const choiceExplanations = {};
    choiceExplanations[spec.answer] = { result: "正解", reason: spec.explanation };
    spec.choices.forEach((c) => {
      if (c === spec.answer) return;
      choiceExplanations[c] = { result: "不正解", reason: spec.reasons[c] };
    });

    return {
      id: nextQuestionId("b"),
      mode: "knowledge",
      category: "基礎知識",
      difficulty: "初級",
      question: spec.q,
      customerScenario: "",
      choices: shuffleArray(spec.choices),
      answer: spec.answer,
      explanation: spec.explanation,
      choiceExplanations,
      sourceManufacturer: null,
      sourceProduct: null
    };
  });
}

/* ================================================================
   太陽光発電の基礎知識（製品データに依存しない静的問題）
   出題範囲：太陽電池の発電原理・種類・特性値・システム構成・
   系統連系用語・関連制度など、営業現場で問われる太陽光発電の
   基礎〜応用知識。難易度は内容の専門性に応じて初級〜上級に分けている。
   ================================================================ */
const SOLAR_BASICS_SPECS = [
  {
    q: "太陽電池の基本動作原理として正しいものはどれか。",
    choices: ["電磁誘導により発電する", "光電効果（光起電力効果）により発電する", "化学反応により発電する", "熱電効果により発電する"],
    answer: "光電効果（光起電力効果）により発電する",
    difficulty: "初級",
    explanation: "太陽電池はp型半導体とn型半導体を接合したpn接合を利用し、光を照射するとキャリア（電子と正孔）が生成されて起電力が発生する光起電力効果（フォトボルタイック効果）を利用して発電する。熱電効果はゼーベック効果を利用した熱電素子、電磁誘導は回転発電機の原理である。"
  },
  {
    q: "シリコン系太陽電池のうち、最も変換効率が高い種類はどれか。",
    choices: ["薄膜シリコン太陽電池", "アモルファスシリコン太陽電池", "多結晶シリコン太陽電池", "単結晶シリコン太陽電池"],
    answer: "単結晶シリコン太陽電池",
    difficulty: "初級",
    explanation: "単結晶シリコン太陽電池は結晶の欠陥が少なく電子の移動度が高いため、シリコン系の中で最も高い変換効率を持つ。市販品での実用変換効率は20〜24%程度。多結晶シリコンは15〜20%、アモルファスシリコンは6〜10%程度。"
  },
  {
    q: "太陽電池の変換効率の定義として正しいものはどれか。",
    choices: [
      "太陽電池が受けた光エネルギーに対する最大発電電力の比率",
      "太陽電池の開放電圧と短絡電流の積に対する最大発電電力の比率",
      "標準試験条件下での出力電力に対する定格出力の比率",
      "太陽電池の理論効率に対する実測効率の比率"
    ],
    answer: "太陽電池が受けた光エネルギーに対する最大発電電力の比率",
    difficulty: "中級",
    explanation: "変換効率η＝最大出力Pmax（W）÷（照射面積S（㎡）×放射照度E（W/㎡））×100%で定義される。標準試験条件（STC）では放射照度1000W/㎡、気温25℃、スペクトルAM1.5で測定する。「開放電圧と短絡電流の積に対する比率」はフィルファクター（FF）の定義に近い。"
  },
  {
    q: "太陽電池の標準試験条件（STC）における放射照度として正しいものはどれか。",
    choices: ["1200W/㎡", "1000W/㎡", "800W/㎡", "500W/㎡"],
    answer: "1000W/㎡",
    difficulty: "初級",
    explanation: "標準試験条件（STC：Standard Test Condition）は、放射照度1000W/㎡、モジュール温度25℃、スペクトル分布AM1.5Gで規定されている。これは快晴時の地表における太陽放射照度を模擬している。"
  },
  {
    q: "太陽電池のI-V特性曲線において、最大電力点（MPP）の説明として正しいものはどれか。",
    choices: [
      "開放電圧（Voc）と短絡電流（Isc）の中間点",
      "電力（P＝V×I）が最大となる動作点",
      "電圧が最大となる動作点",
      "電流が最大となる動作点"
    ],
    answer: "電力（P＝V×I）が最大となる動作点",
    difficulty: "中級",
    explanation: "最大電力点（MPP：Maximum Power Point）は、I-V特性曲線上でP＝V×Iが最大となる点。パワーコンディショナはMPPT（最大電力点追従）制御により、常にこの点で動作するよう電圧を制御する。開放電圧は電流がゼロの点、短絡電流は電圧がゼロの点。"
  },
  {
    q: "太陽電池のフィルファクター（FF）の説明として正しいものはどれか。",
    choices: [
      "FF＝最大出力 ÷（開放電圧×短絡電流）",
      "FF＝変換効率 ÷ 理論効率",
      "FF＝最大出力 ÷ 照射エネルギー",
      "FF＝短絡電流 ÷ 開放電圧"
    ],
    answer: "FF＝最大出力 ÷（開放電圧×短絡電流）",
    difficulty: "中級",
    explanation: "フィルファクター（FF）＝最大出力Pmax÷（開放電圧Voc×短絡電流Isc）で定義される。理想的な太陽電池ではFF＝1.0に近づくが、実際は直列抵抗や並列抵抗の影響で0.7〜0.8程度。FFはI-V曲線の「直角度」を表し、太陽電池の品質指標の一つ。"
  },
  {
    q: "化合物系太陽電池のうち、CIGSの構成元素として正しいものはどれか。",
    choices: [
      "カドミウム・インジウム・ゲルマニウム・セレン",
      "銅・インジウム・ガリウム・セレン",
      "銅・鉄・ゲルマニウム・シリコン",
      "炭素・インジウム・ガリウム・スズ"
    ],
    answer: "銅・インジウム・ガリウム・セレン",
    difficulty: "中級",
    explanation: "CIGSは銅（Cu）・インジウム（In）・ガリウム（Ga）・セレン（Se）の4元素からなる化合物半導体。薄膜型のため少ない材料で製造でき、フレキシブル基板への応用も可能。変換効率は15〜22%程度で、シリコン系に次ぐ実用的な太陽電池。"
  },
  {
    q: "ペロブスカイト太陽電池の特徴として適切でないものはどれか。",
    choices: ["低コスト製造が可能", "既に市場で最も普及している太陽電池", "高い変換効率が期待できる", "鉛を含む材料が多く環境負荷が懸念される"],
    answer: "既に市場で最も普及している太陽電池",
    difficulty: "中級",
    explanation: "ペロブスカイト太陽電池は研究段階では30%超の変換効率を達成しているが、市場での普及は限定的。製造コストの低さと高効率が期待されているが、耐久性・安定性の課題や鉛含有材料の環境問題が商用化の障壁となっている。"
  },
  {
    q: "太陽電池モジュールの温度特性として正しいものはどれか。",
    choices: [
      "温度が上昇すると出力が増加する",
      "温度は出力に影響しない",
      "温度が上昇すると開放電圧は減少し、出力は低下する",
      "温度が上昇すると開放電圧は増加し、短絡電流は減少する"
    ],
    answer: "温度が上昇すると開放電圧は減少し、出力は低下する",
    difficulty: "中級",
    explanation: "結晶シリコン太陽電池では、温度上昇に伴い開放電圧（Voc）が温度係数約-0.3〜-0.45%/℃で減少する。短絡電流（Isc）はわずかに増加するが、その影響は小さく、全体としての最大出力（Pmax）は温度係数約-0.3〜-0.5%/℃で低下する。"
  },
  {
    q: "太陽光発電システムの基本構成要素として不適切なものはどれか。",
    choices: ["接続箱", "パワーコンディショナ（PCS）", "太陽電池モジュール", "タービン発電機"],
    answer: "タービン発電機",
    difficulty: "初級",
    explanation: "太陽光発電システムの基本構成は、太陽電池モジュール、接続箱（ストリング接続）、パワーコンディショナ（直流→交流変換）、系統連系保護装置（または一体型PCS）、電力量計から成る。タービン発電機は風力発電や火力発電などの回転型発電機に使用される部品。"
  },
  {
    q: "アモルファスシリコン太陽電池の特徴として正しいものはどれか。",
    choices: [
      "高温での出力低下が結晶シリコンより大きい",
      "光照射初期に出力が低下するステーブラー・ウロンスキー効果がある",
      "結晶シリコンよりも変換効率が高い",
      "製造に多量のシリコン原料が必要"
    ],
    answer: "光照射初期に出力が低下するステーブラー・ウロンスキー効果がある",
    difficulty: "上級",
    explanation: "アモルファスシリコン太陽電池はステーブラー・ウロンスキー（Staebler-Wronski）効果により、製造後の光照射初期に出力が約10〜20%低下する特性がある。また薄膜型のため使用シリコン量は少なく、温度係数が低いため高温での出力低下は結晶系より小さい利点がある。"
  },
  {
    q: "太陽電池の直列接続（ストリング）の目的として最も適切なものはどれか。",
    choices: ["発電量を安定させるため", "故障時の影響を少なくするため", "電圧を高めるため", "電流を増やすため"],
    answer: "電圧を高めるため",
    difficulty: "初級",
    explanation: "太陽電池モジュールを直列接続することでシステム電圧を高め、パワーコンディショナの入力電圧範囲に合わせる。一方、並列接続は電流を増やす目的。直列接続数はパワーコンディショナの最大入力電圧を超えないよう設計する必要がある。"
  },
  {
    q: "太陽電池の開放電圧（Voc）に関する説明として正しいものはどれか。",
    choices: [
      "外部回路を開放したときに生じる端子電圧",
      "最大電力点における動作電圧",
      "短絡時に流れる電流",
      "電流を最大に取り出したときの電圧"
    ],
    answer: "外部回路を開放したときに生じる端子電圧",
    difficulty: "初級",
    explanation: "開放電圧（Voc：Open Circuit Voltage）は外部回路を開放（無負荷）状態にしたときの端子電圧。この状態では電流は流れない。Vocは照射強度のほか温度の影響を強く受け、温度上昇で減少する。最大電力点電圧VmpはVocの75〜85%程度。"
  },
  {
    q: "結晶シリコン太陽電池の変換効率の温度係数の一般的な値として最も近いものはどれか。",
    choices: ["-2.0％/℃", "+0.4％/℃", "-0.05％/℃", "-0.4％/℃"],
    answer: "-0.4％/℃",
    difficulty: "上級",
    explanation: "結晶シリコン太陽電池の最大出力の温度係数は一般的に-0.3〜-0.5%/℃程度（典型値-0.4%/℃）。モジュール温度が25℃（STC）から10℃上昇すると出力は約4%低下する計算になる。この値はモジュールの仕様書に記載されており、発電量計算で重要な指標。"
  },
  {
    q: "太陽光発電の系統連系型システムにおける直流側の構成として適切なものはどれか。",
    choices: [
      "モジュール→接続箱→パワーコンディショナ→電力系統",
      "モジュール→インバータ→接続箱→電力系統",
      "モジュール→蓄電池→接続箱→電力系統",
      "モジュール→変圧器→接続箱→電力系統"
    ],
    answer: "モジュール→接続箱→パワーコンディショナ→電力系統",
    difficulty: "中級",
    explanation: "系統連系型太陽光発電システムの基本的な電力フローは、太陽電池モジュール（直流）→接続箱（ストリングの並列接続・保護）→パワーコンディショナ（直流→交流変換・系統連系）→分電盤→電力系統の順。変圧器はパワーコンディショナに内蔵される場合もある。"
  },
  {
    q: "多結晶シリコン太陽電池の製造方法として最も一般的なものはどれか。",
    choices: [
      "CVD法（化学気相蒸着法）によるシリコン薄膜成膜",
      "チョクラルスキー法による単結晶引き上げ後にスライス",
      "ゾーン精製法によるシリコン精製後に製造",
      "鋳造法（キャスティング法）によるシリコンブロック鋳造後にスライス"
    ],
    answer: "鋳造法（キャスティング法）によるシリコンブロック鋳造後にスライス",
    difficulty: "中級",
    explanation: "多結晶シリコン太陽電池は、溶融シリコンを鋳型に流し込んで固化させる鋳造法（キャスティング法）でシリコンブロックを作り、ワイヤーソーでスライスしてウェハを製造する。単結晶はチョクラルスキー法（CZ法）を使用。鋳造法は単結晶より低コストだが、結晶粒界があるため変換効率はやや劣る。"
  },
  {
    q: "太陽光発電モジュールの公称最大出力（Pmax）を測定する標準試験条件として、正しい組み合わせはどれか。",
    choices: [
      "放射照度1000W/㎡、温度25℃、AM1.5G",
      "放射照度1200W/㎡、温度25℃、AM1.5G",
      "放射照度800W/㎡、温度20℃、AM1.0",
      "放射照度1000W/㎡、温度20℃、AM1.5G"
    ],
    answer: "放射照度1000W/㎡、温度25℃、AM1.5G",
    difficulty: "中級",
    explanation: "JIS C 8918等で規定される標準試験条件（STC）は、放射照度1000W/㎡、モジュール温度25℃、スペクトル分布AM1.5Gの3条件。この条件で測定した最大出力がモジュールの公称最大出力（Wp：ワットピーク）として仕様書に記載される。"
  },
  {
    q: "CdTe（カドミウムテルル）太陽電池の特徴として適切でないものはどれか。",
    choices: [
      "結晶シリコンと同等以上の変換効率を持つ大型商業製品が普及している",
      "薄膜型のため大面積モジュール製造に適する",
      "テルルは希少元素のため原料調達に制約がある",
      "カドミウムを含むため廃棄時の環境規制に注意が必要"
    ],
    answer: "結晶シリコンと同等以上の変換効率を持つ大型商業製品が普及している",
    difficulty: "上級",
    explanation: "CdTe太陽電池は薄膜型の一種で、市販モジュールの変換効率は15〜18%程度。結晶シリコン単結晶（20〜24%）には及ばないが、大面積製造の低コスト性が強みで、特に米国First Solar社が大規模商業展開している。研究レベルでは22%超が達成されている。"
  },
  {
    q: "太陽電池の「バンドギャップ」と変換効率の関係として正しいものはどれか。",
    choices: [
      "バンドギャップが大きいほど変換効率は常に高くなる",
      "変換効率を最大化する最適なバンドギャップが存在する（シャックレー・クワイサー限界）",
      "バンドギャップは変換効率に影響しない",
      "バンドギャップが小さいほど変換効率は常に高くなる"
    ],
    answer: "変換効率を最大化する最適なバンドギャップが存在する（シャックレー・クワイサー限界）",
    difficulty: "上級",
    explanation: "太陽光スペクトルに対して最大変換効率をもたらすバンドギャップは理論上約1.1〜1.4eVとされ（シャックレー・クワイサー限界）、シリコンのバンドギャップ1.12eVはほぼ最適。バンドギャップが大きすぎると長波長光を利用できず、小さすぎると開放電圧が下がる。"
  },
  {
    q: "太陽光発電システムにおける「系統連系」の意味として正しいものはどれか。",
    choices: [
      "太陽電池と蓄電池を接続すること",
      "太陽光発電システムを電力会社の配電系統に接続すること",
      "パワーコンディショナと分電盤を接続すること",
      "複数の太陽電池モジュールを接続すること"
    ],
    answer: "太陽光発電システムを電力会社の配電系統に接続すること",
    difficulty: "初級",
    explanation: "系統連系とは、太陽光発電システムを電力会社の配電線（電力系統）に接続し、自家消費分を超えた余剰電力を電力系統へ送電（逆潮流）できる接続形態。単独運転防止機能などの保護装置が義務付けられている。"
  },
  {
    q: "太陽光発電における「逆潮流」の説明として正しいものはどれか。",
    choices: [
      "需要家から電力系統に向けて電力が流れること",
      "直流電力が交流電力に変換されること",
      "電力系統から需要家に向けて電力が流れること",
      "モジュールの直列接続で電圧が高くなること"
    ],
    answer: "需要家から電力系統に向けて電力が流れること",
    difficulty: "初級",
    explanation: "逆潮流とは需要家（発電設備を持つ家庭・事業者）から電力系統に向けて電力が流れること。太陽光発電の余剰電力が電力系統に流れる状態。FIT制度での売電はこの逆潮流によって実現される。逆潮流を認めない系統もあり、その場合は余剰電力を蓄電池に蓄えるなどの対策が必要。"
  },
  {
    q: "太陽光発電の「単独運転」とはどういう状態か。",
    choices: [
      "停電時に電力系統から切り離されて発電を続ける状態",
      "1台のパワーコンディショナのみで運転すること",
      "1つのストリングのみで運転する状態",
      "蓄電池なしで発電する状態"
    ],
    answer: "停電時に電力系統から切り離されて発電を続ける状態",
    difficulty: "中級",
    explanation: "単独運転とは、電力系統側で事故や停電が起きて上位系統から切り離された区間（アイランド）で、系統連系型太陽光発電システムがそれと気づかずに発電を続け、その区間に電力を供給し続けてしまう状態。系統の作業員への感電事故などの危険があるため、系統連系規程では単独運転防止機能の設置を義務付けている。"
  },
  {
    q: "太陽電池モジュールのホットスポットの説明として正しいものはどれか。",
    choices: [
      "モジュールが高温時に発電効率が上がる部分",
      "部分的な影や劣化により電流が集中して過熱する現象",
      "モジュールの裏面に設置した温度センサー",
      "日射量が最も多く受けているセル"
    ],
    answer: "部分的な影や劣化により電流が集中して過熱する現象",
    difficulty: "中級",
    explanation: "ホットスポットは、モジュールの一部のセルが影や汚れ・劣化などで発電できない状態になると、他のセルの電流が集中して過熱する現象。温度が150℃以上になることもあり、モジュールの焼損や火災の原因になりうる。バイパスダイオードを設置することで影響を軽減できる。"
  },
  {
    q: "バイパスダイオードの役割として正しいものはどれか。",
    choices: [
      "過電圧からモジュールを保護する",
      "影になったセルグループをバイパスし、ホットスポットや出力低下を防ぐ",
      "変換効率を向上させるために各セルに直列に接続する",
      "逆流防止のために接続箱に設置する"
    ],
    answer: "影になったセルグループをバイパスし、ホットスポットや出力低下を防ぐ",
    difficulty: "中級",
    explanation: "バイパスダイオードはモジュール内のセルグループ（通常18〜24セルごと）と並列に接続され、一部のセルが影になった際にそのグループをバイパスして電流が迂回できるようにする。これによりホットスポットの発生を防ぎ、影が当たっていない他のセルグループの発電継続を可能にする。"
  },
  {
    q: "逆流防止ダイオードが設置される場所として正しいものはどれか。",
    choices: ["接続箱の各ストリング入力回路", "各太陽電池セル内", "パワーコンディショナの出力側", "系統連系点の変圧器"],
    answer: "接続箱の各ストリング入力回路",
    difficulty: "中級",
    explanation: "逆流防止ダイオードは接続箱の各ストリング入力回路に設置される。複数のストリングを並列接続する場合、発電量の異なるストリング間での電流の逆流を防ぎ、影や故障による電流の逆流でモジュールが過熱することを防止する。"
  },
  {
    q: "太陽光発電システムの性能比（PR：Performance Ratio）の説明として正しいものはどれか。",
    choices: [
      "モジュール効率÷システム全体効率",
      "実際の発電量÷理論最大発電量で算出される効率指標",
      "年間発電量÷設置容量で算出される稼働率",
      "設計発電量÷実際の発電量"
    ],
    answer: "実際の発電量÷理論最大発電量で算出される効率指標",
    difficulty: "上級",
    explanation: "性能比（PR）＝実際の発電量（kWh）÷〔設備容量（kW）×期間内日射量（kWh/㎡）÷標準試験条件での放射照度（1kW/㎡）〕。理論的に期待される発電量に対する実際の発電量の比率で、システムの品質・損失を評価する。良好なシステムでは0.8以上が目安。"
  },
  {
    q: "太陽電池の「AM（エアマス）」の説明として正しいものはどれか。",
    choices: ["太陽電池モジュールの面積", "太陽電池の電気抵抗値", "大気圏を通過する太陽光の光路長を表す指標", "1時間あたりの太陽放射エネルギー量"],
    answer: "大気圏を通過する太陽光の光路長を表す指標",
    difficulty: "中級",
    explanation: "AM（Air Mass）は太陽光が大気圏を通過する経路長を、大気圏外直入射（AM0）を基準として表す指標。AM1.5は太陽天頂角約48.2°のときの値で、地上での標準的な太陽光スペクトルを表し、太陽電池の特性評価に使用される。AM0は宇宙空間の宇宙用太陽電池の評価に用いる。"
  },
  {
    q: "太陽光発電モジュールの「公称最大出力温度係数」が-0.40%/℃の場合、モジュール温度が25℃から65℃に上昇すると出力はどうなるか。",
    choices: ["約4%低下する", "変化しない", "約16%低下する", "約16%増加する"],
    answer: "約16%低下する",
    difficulty: "上級",
    explanation: "温度変化は65-25＝40℃。出力変化率＝-0.40%/℃×40℃＝-16%。つまりモジュール温度が25℃から65℃に上昇すると最大出力は約16%低下する。夏場の屋根設置では実際のモジュール温度が65〜70℃に達することがあり、発電量シミュレーションで重要な考慮事項。"
  },
  {
    q: "HIT（ヘテロ接合）太陽電池の特徴として正しいものはどれか。",
    choices: [
      "GaAsとシリコンを組み合わせた多接合構造",
      "多結晶シリコンとCIGSを組み合わせた構造",
      "有機材料とシリコンを組み合わせた構造",
      "単結晶シリコンとアモルファスシリコンを組み合わせた構造"
    ],
    answer: "単結晶シリコンとアモルファスシリコンを組み合わせた構造",
    difficulty: "上級",
    explanation: "HIT（Heterojunction with Intrinsic Thin layer）太陽電池は、単結晶シリコン基板の両面に薄いアモルファスシリコン（真性層＋ドープ層）を積層したヘテロ接合構造。高い変換効率（市販品で22〜25%）と優れた温度係数（-0.26%/℃程度）を持ち、両面発電型への応用も容易。"
  },
  {
    q: "太陽光発電の発電出力と日射量の関係として正しいものはどれか。",
    choices: [
      "発電出力は日射量の2乗に比例する",
      "発電出力は日射量にほぼ比例する（一次比例）",
      "発電出力は日射量の平方根に比例する",
      "発電出力と日射量に相関関係はない"
    ],
    answer: "発電出力は日射量にほぼ比例する（一次比例）",
    difficulty: "中級",
    explanation: "太陽電池の短絡電流（Isc）は照射した光子数に比例するため、発電出力は日射量（放射照度）にはほぼ一次比例する。例えば日射量が500W/㎡（1000W/㎡の半分）の場合、発電出力も約半分になる。これを利用して日射量データから年間発電量を計算する。"
  },
  {
    q: "太陽電池セル1枚の開放電圧の一般的な値として正しいものはどれか（結晶シリコン系）。",
    choices: ["約60V", "約0.6V", "約0.06V", "約6V"],
    answer: "約0.6V",
    difficulty: "中級",
    explanation: "結晶シリコン太陽電池の1セル当たりの開放電圧（Voc）は約0.6V。市販モジュール（60セル直列）では約36V、72セルでは約43Vとなる。この電圧を基に、パワーコンディショナの入力電圧範囲に合わせて直列接続数（ストリング数）を決定する。"
  },
  {
    q: "太陽光発電システムの「自家消費率」の説明として正しいものはどれか。",
    choices: [
      "消費電力のうち太陽光発電で賄った割合",
      "年間の売電量÷年間の発電量",
      "システムの変換効率",
      "発電した電力のうち自家消費に使用した割合"
    ],
    answer: "発電した電力のうち自家消費に使用した割合",
    difficulty: "初級",
    explanation: "自家消費率＝自家消費電力量÷総発電量×100%。発電した電力のうち何割を自分で使用したかを示す指標。蓄電池を設置すると自家消費率が向上する。一方「自給率」は消費電力量のうち太陽光発電でまかなえた割合で、異なる概念。"
  },
  {
    q: "太陽光発電の「FIT価格」（固定価格買取制度）に関して、住宅用（10kW未満）の買取期間として正しいものはどれか。",
    choices: ["5年", "15年", "10年", "20年"],
    answer: "10年",
    difficulty: "中級",
    explanation: "FIT制度（再生可能エネルギーの固定価格買取制度）において、住宅用太陽光発電（出力10kW未満）の余剰電力買取期間は10年間。産業用（10kW以上50kW未満を除く）は20年間。買取価格は設備認定年度によって異なり、毎年度見直される。"
  },
  {
    q: "GaAs（ガリウムヒ素）太陽電池の主な用途として最も適切なものはどれか。",
    choices: ["宇宙用太陽電池（人工衛星など）", "農業用ハウスの屋根", "一般住宅の屋根設置", "BIPV（建材一体型）モジュール"],
    answer: "宇宙用太陽電池（人工衛星など）",
    difficulty: "中級",
    explanation: "GaAs太陽電池は変換効率が30%以上と非常に高く耐放射線性に優れるが、製造コストが極めて高い。宇宙での単位面積当たりの発電量を最大化できるため人工衛星や探査機に使用される。地上では集光型太陽光発電（CPV）システムに使われることもある。"
  },
  {
    q: "太陽光発電の「発電端効率」と「送電端効率」の違いとして正しいものはどれか。",
    choices: [
      "発電端効率はモジュール効率、送電端効率はシステム全体効率",
      "発電端効率は太陽電池の発電電力÷日射エネルギー、送電端効率は系統連系点での電力÷日射エネルギー",
      "発電端効率は直流電力÷日射エネルギー、送電端効率は交流電力÷日射エネルギー",
      "同じ値を示す"
    ],
    answer: "発電端効率は太陽電池の発電電力÷日射エネルギー、送電端効率は系統連系点での電力÷日射エネルギー",
    difficulty: "上級",
    explanation: "発電端効率は太陽電池（モジュール）が発電する電力の日射エネルギーに対する効率。送電端効率は系統連系点（電力会社への送電地点）での電力を基準とした効率で、パワーコンディショナや配線の損失を含んだシステム全体の効率。通常は送電端効率＜発電端効率となる。"
  },
  {
    q: "太陽光発電モジュールの「最大出力動作電流（Imp）」の説明として正しいものはどれか。",
    choices: ["短絡時に流れる最大電流値", "過電流保護が動作する電流値", "最大電力点（MPP）における動作電流", "開放電圧時の電流値"],
    answer: "最大電力点（MPP）における動作電流",
    difficulty: "中級",
    explanation: "最大出力動作電流（Imp：Current at Maximum Power）は最大電力点（MPP）における動作電流。I-V特性曲線上の電力P＝V×Iが最大となる点の電流値で、通常短絡電流Iscの90〜95%程度の値。この値はストリング設計やパワーコンディショナ選定に使用される。"
  },
  {
    q: "両面発電型（バイフェイシャル）太陽電池モジュールの特徴として正しいものはどれか。",
    choices: ["表面のみで発電するため軽量", "変換効率は通常の片面型より低い", "設置角度に関わらず発電量は一定", "裏面からの反射光も利用して発電量を増やす"],
    answer: "裏面からの反射光も利用して発電量を増やす",
    difficulty: "中級",
    explanation: "バイフェイシャル（両面発電型）モジュールは表面の直達光に加え、地面や屋根からの反射光（アルベド）を裏面でも発電に利用できる。地面反射率（アルベド）が高い白色屋根や積雪地帯で効果が大きく、通常比5〜30%の発電量増加が期待できる。"
  },
  {
    q: "太陽電池モジュールの「セル」「ストリング」「モジュール」「アレイ」の関係として正しいものはどれか。",
    choices: [
      "セル→モジュール→ストリング→アレイ",
      "ストリング（最小単位）→セル→モジュール→アレイ",
      "モジュール→セル→ストリング→アレイ",
      "セル（最小単位）→ストリング（複数セル直列）→モジュール（封止したユニット）→アレイ（複数モジュール接続）"
    ],
    answer: "セル→モジュール→ストリング→アレイ",
    difficulty: "初級",
    explanation: "正しい構成順序はセル（単体の太陽電池素子）→モジュール（複数セルを直列・並列接続して封止した製品単位）→ストリング（複数モジュールを直列接続したもの）→アレイ（複数ストリングを並列接続した全体）。"
  },
  {
    q: "太陽光発電の「アレイ」の説明として正しいものはどれか。",
    choices: ["1枚の太陽電池モジュール", "パワーコンディショナの入力回路", "太陽電池モジュールを直列接続した1グループ", "太陽電池モジュールをすべて接続した発電設備全体"],
    answer: "太陽電池モジュールをすべて接続した発電設備全体",
    difficulty: "初級",
    explanation: "アレイ（Array）は、設置されたすべての太陽電池モジュールを直列・並列接続した発電設備全体を指す。ストリングを並列接続してアレイを構成する。アレイの出力はシステムの直流側定格出力となる。設置面積や向きが異なる場合はサブアレイに分けて管理することもある。"
  },
  {
    q: "太陽光発電における「系統安定化」の課題として最も適切なものはどれか。",
    choices: [
      "太陽光発電は直流のため系統安定化に有利",
      "太陽光発電は出力が安定しているため系統安定化の課題はない",
      "天候変動による出力変動が電力系統の周波数・電圧安定性に影響する",
      "発電量が多すぎて蓄電池が充電過剰になる"
    ],
    answer: "天候変動による出力変動が電力系統の周波数・電圧安定性に影響する",
    difficulty: "中級",
    explanation: "太陽光発電は天候（日射量・気温・雲）の影響を受けるため出力変動が大きい。大量導入が進むと電力系統の周波数や電圧の安定性に影響を与える課題がある。対策として、出力制御（出力抑制）、蓄電システム、需給バランス管理、系統増強などが行われている。"
  },
  {
    q: "太陽光発電モジュールの「NOCT（Nominal Operating Cell Temperature）」の説明として正しいものはどれか。",
    choices: ["標準試験条件での動作温度", "放射照度800W/㎡、周囲温度20℃、風速1m/s条件での代表的な動作温度", "モジュールが発火する最高温度", "年間平均の動作温度"],
    answer: "放射照度800W/㎡、周囲温度20℃、風速1m/s条件での代表的な動作温度",
    difficulty: "上級",
    explanation: "NOCT（公称動作温度）はIEC規格で定める試験条件（放射照度800W/㎡、周囲温度20℃、風速1m/s、オープンラック取付）でのモジュール動作温度。一般的な結晶シリコンモジュールのNOCTは45±2℃程度。実際の設置環境での発電量計算に活用される。"
  },
  {
    q: "太陽光発電の「出力制御」（カーテルメント）の説明として正しいものはどれか。",
    choices: ["太陽光発電設備の出力を増大させる制御", "パワーコンディショナの保護動作による出力停止", "夜間の無効電力補償", "電力系統の需給バランス維持のため発電出力を制限すること"],
    answer: "電力系統の需給バランス維持のため発電出力を制限すること",
    difficulty: "中級",
    explanation: "出力制御（カーテルメント）は、電力系統の需給バランスを保つため、電力会社の指示により太陽光発電設備の出力を抑制すること。太陽光発電の大量導入により、特に春秋の晴天日（需要が少なく発電量が多い）に出力制御が行われるケースが増加している。FIT認定設備では無補償での出力制御が条件となっている。"
  },
  {
    q: "太陽光発電モジュールの「EL（エレクトロルミネッセンス）検査」の目的として正しいものはどれか。",
    choices: ["モジュールに電圧を印加して発光させ、セルのひびや欠陥を検出する", "モジュールの表面汚れを自動清掃する", "モジュールの変換効率を向上させる処理", "モジュールの発電電力を測定する"],
    answer: "モジュールに電圧を印加して発光させ、セルのひびや欠陥を検出する",
    difficulty: "上級",
    explanation: "EL（エレクトロルミネッセンス）検査は、モジュールに電圧・電流を印加してシリコンセルを発光させ、その発光画像から内部の亀裂・ひび・デラミネーション（剥離）・断線などの欠陥を検出する非破壊検査手法。運搬時の損傷や施工後の異常検出、定期点検で活用される。"
  },
  {
    q: "太陽光発電システムの「システム損失」に含まれないものはどれか。",
    choices: ["配線損失（ケーブル抵抗による電力損失）", "温度損失（モジュール温度上昇による出力低下）", "パワーコンディショナの変換損失", "土地の賃料コスト"],
    answer: "土地の賃料コスト",
    difficulty: "中級",
    explanation: "システム損失は発電量に影響する技術的な損失要因で、配線損失、温度損失、汚れ・積雪による損失、パワーコンディショナ変換損失、MPPTミスマッチ損失、逆変換素子の待機損失などが含まれる。土地の賃料コストは経済的なコスト要因であり、発電効率には直接影響しない。"
  },
  {
    q: "「太陽光発電協会（JPEA）」の主な役割として適切なものはどれか。",
    choices: ["電力会社として太陽光発電の余剰電力を買い取る", "FIT買取価格を決定する行政機関", "太陽光発電設備の施工を直接行う", "業界団体として普及促進・技術基準策定・アドバイザー資格認定を行う"],
    answer: "業界団体として普及促進・技術基準策定・アドバイザー資格認定を行う",
    difficulty: "中級",
    explanation: "太陽光発電協会（JPEA：Japan Photovoltaic Energy Association）は、太陽光発電産業に携わる企業が加盟する業界団体。普及促進活動、技術基準・規格の策定への参画、太陽光発電アドバイザー資格の認定・管理などを行う。FIT価格の決定は調達価格等算定委員会（経済産業省）が行う。"
  },
  {
    q: "次の太陽電池の種類のうち、薄膜系太陽電池に分類されないものはどれか。",
    choices: ["CIGS太陽電池", "多結晶シリコン太陽電池", "アモルファスシリコン太陽電池", "CdTe（カドミウムテルル）太陽電池"],
    answer: "多結晶シリコン太陽電池",
    difficulty: "中級",
    explanation: "多結晶シリコン太陽電池は結晶系（バルク型）太陽電池に分類される。薄膜系太陽電池はアモルファスシリコン、CdTe、CIGS、薄膜シリコンなど。薄膜系は基板上に薄い光吸収層を成膜するため材料使用量が少なく低コストだが、一般に結晶系より変換効率が低い。"
  },
  {
    q: "太陽電池モジュールの「IEC 61215」規格で評価される耐久性試験として適切なものはどれか。",
    choices: ["毒性物質溶出試験", "電磁適合性（EMC）試験", "温湿度サイクル試験（熱サイクル試験・高温高湿試験）", "火炎伝播試験"],
    answer: "温湿度サイクル試験（熱サイクル試験・高温高湿試験）",
    difficulty: "上級",
    explanation: "IEC61215は結晶シリコン太陽電池モジュールの設計適格性と型式認証のための規格。試験項目には熱サイクル試験（-40℃⇔85℃の繰り返し）、湿熱試験（85℃・85%RH・1000時間）、ひょう打撃試験、メカニカルロード試験などの耐久性試験が含まれる。"
  },
  {
    q: "太陽光発電の「キャパシティファクター（設備利用率）」の説明として正しいものはどれか。",
    choices: ["年間の実際の発電量 ÷（設備容量×8760時間）×100%", "設備容量に対するモジュール変換効率の比率", "設備コスト ÷ 年間発電量", "最大出力時の発電効率"],
    answer: "年間の実際の発電量 ÷（設備容量×8760時間）×100%",
    difficulty: "上級",
    explanation: "設備利用率（キャパシティファクター）＝実際の年間発電量（kWh）÷（設備容量（kW）×8760時間）×100%。1年間ずっと最大出力で発電した場合の発電量に対する実際の発電量の比率。日本の太陽光発電の設備利用率は地域にもよるが概ね12〜14%程度。"
  },
  {
    q: "太陽光発電システムにおける「MPPT（最大電力点追従）制御」の目的として正しいものはどれか。",
    choices: ["電圧変動に関わらず常に最大電力が得られる動作点に制御する", "系統の周波数を一定に保つ", "逆潮流を防止する", "モジュールの温度を一定に保つ"],
    answer: "電圧変動に関わらず常に最大電力が得られる動作点に制御する",
    difficulty: "中級",
    explanation: "MPPT（Maximum Power Point Tracking）制御はパワーコンディショナに搭載された機能で、日射量・温度などの変動によりI-V特性が常に変化する中で、電圧を動的に変化させて最大電力点を追従し続ける制御。これにより日射変動や温度変化があっても常に最大の発電電力を系統へ供給できる。"
  },
  {
    q: "太陽光発電システムの「プリベンティブメンテナンス」（予防保全）と「コレクティブメンテナンス」（事後保全）の説明として正しいものはどれか。",
    choices: [
      "予防保全は故障前の定期点検・部品交換、事後保全は故障発生後の修理",
      "予防保全は太陽電池モジュール、事後保全はパワーコンディショナのみに適用",
      "両方とも同じ意味で使われる",
      "予防保全は故障発生後の修理、事後保全は定期的な点検・交換"
    ],
    answer: "予防保全は故障前の定期点検・部品交換、事後保全は故障発生後の修理",
    difficulty: "初級",
    explanation: "プリベンティブメンテナンス（予防保全）は故障が発生する前に定期点検・清掃・部品交換などを行い、故障を未然に防ぐ保全活動。コレクティブメンテナンス（事後保全、修正保全）は故障や異常が発生した後に原因究明・修理・交換を行う活動。O&Mでは両方を組み合わせて実施する。"
  },
  {
    q: "太陽光発電の「ライフサイクルCO₂」（LCA）の説明として正しいものはどれか。",
    choices: [
      "ライフサイクルCO₂は政府が毎年公表している数値",
      "製造・輸送・設置・運用・廃棄の全過程でのCO₂排出量を評価した指標",
      "太陽光発電は発電中にCO₂を全く排出しないため、ライフサイクルCO₂はゼロ",
      "太陽光発電のCO₂排出量は火力発電より多い"
    ],
    answer: "製造・輸送・設置・運用・廃棄の全過程でのCO₂排出量を評価した指標",
    difficulty: "中級",
    explanation: "ライフサイクルCO2（LCA：Life Cycle Assessment）は製品・システムの原料採取から廃棄までの全過程でのCO2排出量を評価する手法。太陽光発電は発電中のCO2排出はゼロだが、シリコン精製・モジュール製造での電力消費等でCO2を排出する。通常数年〜10年程度で「CO2回収」（運用中の排出ゼロとの相殺）が達成される。"
  },
  {
    q: "日本の太陽光発電の設置量について、2023年度末時点での累積導入量として最も近いものはどれか。",
    choices: ["約200GW", "約5GW", "約20GW", "約80GW"],
    answer: "約80GW",
    difficulty: "上級",
    explanation: "日本の太陽光発電の累積導入量は2023年度末時点で約85GW（系統連系容量ベース）に達しており、おおよそ80GWという選択肢が最も近い。FIT制度導入（2012年）以降急速に普及し、電源構成における再エネ比率向上に大きく貢献している。"
  },
  {
    q: "太陽電池のpn接合において、「空乏層」の説明として正しいものはどれか。",
    choices: [
      "光を最も効率よく吸収する層",
      "P型とN型の接合部でキャリアが少なく電界が生じている層",
      "電極が形成されている表面層",
      "電流が多く流れる領域"
    ],
    answer: "P型とN型の接合部でキャリアが少なく電界が生じている層",
    difficulty: "上級",
    explanation: "空乏層（Depletion layer）はpn接合界面付近でp型の正孔とn型の電子が再結合・拡散することでキャリアが失われ、固定した不純物イオンのみが残る領域。この空間電荷による内部電界（ビルトイン電場）が、光により生成された電子と正孔を分離して起電力を生じさせる。"
  },
  {
    q: "太陽電池モジュールの「デラミネーション」の説明として正しいものはどれか。",
    choices: ["配線の腐食による断線", "セルのひびや割れ", "セルに入射する光量が減少する現象", "モジュールの積層構造が剥離する現象"],
    answer: "モジュールの積層構造が剥離する現象",
    difficulty: "中級",
    explanation: "デラミネーション（Delamination）はモジュールの積層構造（ガラス・EVAシート・セル・バックシートなど）が剥離・分離する現象。EVA封止材の経年劣化、水分侵入、製造時の接着不良などが原因。デラミネーションが進行すると出力低下・腐食・漏電のリスクが高まる。"
  },
  {
    q: "太陽光発電モジュールの「PID（電位誘起劣化）」の説明として正しいものはどれか。",
    choices: [
      "電力変換効率を改善する自己修復機能",
      "モジュールの表面反射が増加して出力が低下する現象",
      "高電圧環境でセルと接地間の漏れ電流によりモジュール出力が低下する現象",
      "高温による焦電効果で出力が増加する現象"
    ],
    answer: "高電圧環境でセルと接地間の漏れ電流によりモジュール出力が低下する現象",
    difficulty: "上級",
    explanation: "PID（Potential Induced Degradation：電位誘起劣化）は、システム電圧によりモジュールセルと接地間に高い電位差が生じた際、漏れ電流によりシャント抵抗が低下してモジュール出力が大幅に低下する現象。特に湿度が高い環境で顕著。対策としてアース接続の工夫、PID耐性モジュールの使用、夜間電圧を打ち消す回路の設置などがある。"
  },
  {
    q: "太陽光発電の「LCOE（均等化発電コスト）」の計算要素として含まれないものはどれか。",
    choices: ["電力会社の燃料費", "年間発電量", "年間のO&Mコスト", "設備投資コスト"],
    answer: "電力会社の燃料費",
    difficulty: "上級",
    explanation: "LCOE（Levelized Cost of Energy）＝総コスト（設備投資＋O&Mコスト）の現在価値÷総発電量の現在価値で算出される。設備投資コスト、O&Mコスト（運用・保守費）、年間発電量（日射量・システム効率）が主要入力。電力会社の燃料費は再エネシステム自体のコストに含まれない。"
  },
  {
    q: "産業用太陽光発電（低圧50kW未満）のFIT買取期間として正しいものはどれか。",
    choices: ["25年", "15年", "20年", "10年"],
    answer: "20年",
    difficulty: "中級",
    explanation: "FIT制度において産業用太陽光発電（10kW以上）の買取期間は20年間。ただし住宅用（10kW未満）は余剰買取で10年間。2022年改正でFIT制度に加えてFIP（フィードインプレミアム）制度も創設され、大規模設備は移行が進んでいる。"
  },
  {
    q: "太陽光発電システムにおける「直流地絡故障」の危険性として正しいものはどれか。",
    choices: [
      "地絡故障はパワーコンディショナが自動修復する",
      "地絡電流は系統側から供給されないため感電リスクはない",
      "地絡が発生しても直流システムは安全なので対処不要",
      "直流アークが発生すると消弧が困難で火災リスクが高まる"
    ],
    answer: "直流アークが発生すると消弧が困難で火災リスクが高まる",
    difficulty: "上級",
    explanation: "太陽光発電の直流側で地絡故障が発生すると、直流アーク放電が発生した場合に交流と異なり電流がゼロになるタイミングがないため消弧が困難で、火災発生リスクが高い。また昼間は太陽電池が常時発電しているため、パワーコンディショナが停止してもモジュール側は電圧を発生し続ける。"
  },
  {
    q: "太陽電池モジュールの「蛍光灯下での測定」が実際の性能評価に適さない理由として正しいものはどれか。",
    choices: [
      "蛍光灯のスペクトルは太陽光（AM1.5G）と大きく異なる",
      "蛍光灯は太陽光より明るすぎる",
      "蛍光灯の照度が一定すぎて変動試験ができない",
      "蛍光灯では電流が流れない"
    ],
    answer: "蛍光灯のスペクトルは太陽光（AM1.5G）と大きく異なる",
    difficulty: "中級",
    explanation: "太陽電池の性能評価には標準スペクトル（AM1.5G）の光源が必要だが、蛍光灯は可視光域に偏った特定波長のスペクトルを持ち太陽スペクトルとは大きく異なる。このため蛍光灯での測定値はSTC条件での公称性能とは一致しない。性能評価にはソーラーシミュレータ（キセノンランプ＋フィルター）が使用される。"
  },
  {
    q: "太陽光発電における「エネルギーペイバックタイム（EPT）」の説明として正しいものはどれか。",
    choices: [
      "モジュールの耐用年数",
      "投資コストを回収するまでの期間",
      "製造・設置時の投入エネルギーを発電により回収するまでの期間",
      "FIT制度での売電収入で設備費を回収する期間"
    ],
    answer: "製造・設置時の投入エネルギーを発電により回収するまでの期間",
    difficulty: "中級",
    explanation: "エネルギーペイバックタイム（EPT）は、システムの製造・輸送・設置・廃棄に費やしたエネルギーを、実際の発電によって回収するまでに要する期間。日本では太陽光発電システムのEPTは一般的に2〜3年とされ、システム寿命（25〜30年）に比べて十分短いため、再エネとして意義がある。"
  },
  {
    q: "太陽電池モジュールの表面ガラスに「無反射コーティング（ARコーティング）」を施す目的として正しいものはどれか。",
    choices: [
      "モジュールの冷却効率を上げるため",
      "モジュールの強度を高めるため",
      "光の反射を減らして透過率を上げ、変換効率を改善するため",
      "汚れが付着しにくくするため"
    ],
    answer: "光の反射を減らして透過率を上げ、変換効率を改善するため",
    difficulty: "初級",
    explanation: "通常のガラスは表面で約4%の光を反射するが、ARコーティング（反射防止膜）を施すことで反射損失を1%以下に低減できる。これにより光の透過率が向上し、モジュールの変換効率が改善される。セルの表面にも反射防止膜（窒化シリコン等）が施されており、光の利用効率を高めている。"
  },
  {
    q: "太陽光発電システムにおける「ミスマッチ損失」の原因として最も適切なものはどれか。",
    choices: [
      "直列・並列接続するモジュール間の特性（電圧・電流）のばらつき",
      "配線の抵抗による電力損失",
      "モジュール温度の上昇による出力低下",
      "パワーコンディショナの変換効率が100%でないこと"
    ],
    answer: "直列・並列接続するモジュール間の特性（電圧・電流）のばらつき",
    difficulty: "中級",
    explanation: "ミスマッチ損失は、直列・並列接続するモジュール間に特性のばらつきがある場合に生じる損失。特に影の影響や特性の個体差がある場合に大きくなる。直列接続では電流が小さいモジュールで制限され、並列接続では電圧が高いストリングから低いストリングへ電流が流れる。オプティマイザやマイクロインバータで低減できる。"
  },
  {
    q: "太陽光発電モジュールのJIS規格認証（JIS C 8918等）に関して、認証の主な目的として正しいものはどれか。",
    choices: [
      "価格を標準化するため",
      "安全性・耐久性・性能の第三者検証と品質保証のため",
      "発電量を保証するため",
      "FIT認定の申請に必須の書類を発行するため"
    ],
    answer: "安全性・耐久性・性能の第三者検証と品質保証のため",
    difficulty: "初級",
    explanation: "JIS規格（JIS C 8918：結晶シリコン陸上用太陽電池モジュールの設計適格性認定及び型式認証など）認証は、第三者認証機関による安全性・耐久性・性能試験の検証。消費者・事業者が製品品質を確認できる手段。FIT設備認定でも認証取得モジュールが推奨されるが、必須ではない場合もある（要件は時期により変動）。"
  },
  {
    q: "太陽光発電の「FIP制度（フィードインプレミアム）」とFIT制度の違いとして正しいものはどれか。",
    choices: [
      "FIPは住宅用のみ、FITは産業用のみに適用される",
      "FIPは市場価格＋プレミアムで買い取り、市場参加を促す制度",
      "FIPは固定価格で買い取るが、FITは市場価格＋プレミアムで買い取る",
      "FIPは売電量に上限があり、FITは上限なし"
    ],
    answer: "FIPは市場価格＋プレミアムで買い取り、市場参加を促す制度",
    difficulty: "中級",
    explanation: "FIT（固定価格買取制度）は決められた固定価格で全量または余剰を買い取る制度。FIP（フィードインプレミアム）は市場価格にプレミアム（補助額）を上乗せして買い取る制度で、事業者は電力市場への参加と価格形成への関与が求められる。2022年改正電気事業法（再エネ特措法改正）でFIPが導入された。"
  },
  {
    q: "太陽光発電モジュールの「ストリングインバータ」と「マイクロインバータ」の特徴比較として正しいものはどれか。",
    choices: [
      "マイクロインバータは各モジュールに個別設置し、部分影の影響を受けにくい",
      "マイクロインバータは複数モジュールをまとめて変換するため効率が高い",
      "ストリングインバータのほうがマイクロインバータより高価",
      "ストリングインバータは部分影の影響を受けにくい"
    ],
    answer: "マイクロインバータは各モジュールに個別設置し、部分影の影響を受けにくい",
    difficulty: "中級",
    explanation: "マイクロインバータ（Micro Inverter）は各モジュールに1台ずつ設置して直交変換するため、一部のモジュールに影がかかっても他のモジュールの発電には影響しない。ストリングインバータは複数モジュールを直列接続して1台で変換するため、1枚のモジュールへの影響がストリング全体の出力低下につながる。コストはマイクロインバータの方が一般的に高い。"
  }
];

function generateSolarBasicsQuestions() {
  return SOLAR_BASICS_SPECS.map((spec) => {
    const choiceExplanations = {};
    choiceExplanations[spec.answer] = { result: "正解", reason: spec.explanation };
    spec.choices.forEach((c) => {
      if (c === spec.answer) return;
      choiceExplanations[c] = { result: "不正解", reason: `正解は「${spec.answer}」。${spec.explanation}` };
    });

    return {
      id: nextQuestionId("s"),
      mode: "knowledge",
      category: "太陽光発電",
      difficulty: spec.difficulty,
      question: spec.q,
      customerScenario: "",
      choices: shuffleArray(spec.choices),
      answer: spec.answer,
      explanation: spec.explanation,
      choiceExplanations,
      sourceManufacturer: null,
      sourceProduct: null
    };
  });
}

/* ================================================================
   第2章 システム設計・発電量計算（製品データに依存しない静的問題）
   出題範囲：日射量データ・傾斜角/方位角の影響・発電量計算式・影損失・
   ストリング設計・各種損失係数・シミュレーション用語など。
   ================================================================ */
const SYSTEM_DESIGN_SPECS = [
  {
    q: "日本の標準的な年間日射量（水平方向全天日射量）の全国平均として最も近いものはどれか。",
    choices: ["約2,000kWh/㎡", "約500kWh/㎡", "約1,100kWh/㎡", "約3,500kWh/㎡"],
    answer: "約1,100kWh/㎡",
    difficulty: "中級",
    explanation: "日本の年間水平面全天日射量の全国平均は概ね1,000〜1,200kWh/㎡程度で、約1,100kWh/㎡が全国平均の目安となる。地域差があり、九州・四国・東海が多く（1,200〜1,400kWh/㎡）、北海道・東北・日本海側が少ない（900〜1,100kWh/㎡）傾向がある。"
  },
  {
    q: "太陽光発電の年間発電量を概算する式として最も適切なものはどれか。（システム出力P[kW]、年間日射量H[kWh/㎡]、性能比PR）",
    choices: ["年間発電量＝P ÷ H × PR", "年間発電量＝P × H ÷ PR", "年間発電量＝P ＋ H ＋ PR", "年間発電量＝P × H × PR"],
    answer: "年間発電量＝P × H × PR",
    difficulty: "中級",
    explanation: "年間発電量（kWh）＝システム出力（kW）×年間日射量（kWh/㎡）×性能比（PR）で概算できる。日射量の単位kWh/㎡は「ピーク日射時間（h）」とも呼ばれ、1kW/㎡の日射が何時間相当かを表す。PRは通常0.7〜0.85程度で設定する。"
  },
  {
    q: "傾斜角30°南向きの設置面における日射量は水平面日射量に比べてどうなるか（日本の多くの地域で）。",
    choices: ["水平面の2倍以上になる", "水平面より約10〜20%少なくなる", "水平面より約10〜20%多くなる", "ほぼ同じになる"],
    answer: "水平面より約10〜20%多くなる",
    difficulty: "中級",
    explanation: "日本（緯度35°前後）では傾斜角30〜35°の南向き設置面が年間日射量を最大化する。傾斜角30°南向きでは水平面より年間で約10〜20%多くの日射量を受ける。これを「傾斜面日射量」といい、水平面日射量に傾斜面変換係数（Kb）を乗じて計算する。"
  },
  {
    q: "設置容量10kWp、年間日射量1,300kWh/㎡（傾斜面）、性能比0.78の太陽光発電システムの年間発電量として最も近いものはどれか。",
    choices: ["約10,140kWh", "約7,800kWh", "約13,000kWh", "約16,640kWh"],
    answer: "約10,140kWh",
    difficulty: "上級",
    explanation: "年間発電量＝10kW×1,300kWh/㎡×0.78＝10,140kWh。この計算式は太陽光発電の発電量見積もりの基本。性能比0.78は配線損失、温度損失、PCS変換損失などを含んだ典型的な値。"
  },
  {
    q: "太陽光発電の発電量シミュレーションに使用されるNEDOの日射量データベースとして正しいものはどれか。",
    choices: ["SOLAR-3000（民間データ）", "METPV（日本標準気象データ）またはMSM（メソスケールモデル）", "ECMWF（欧州中期予報）", "JMADDS（気象庁気象データ）"],
    answer: "METPV（日本標準気象データ）またはMSM（メソスケールモデル）",
    difficulty: "上級",
    explanation: "NEDOが整備した「METPV」シリーズ（METPV-11など）は日本全国の地点別・月別・時別の日射量・気温データを収録した標準気象データ。近年はMSM（メソスケールモデル）ベースの高解像度データも活用される。発電量シミュレーションソフト（PVsyst等）への入力に使用される。"
  },
  {
    q: "太陽光発電システムの「傾斜角」の最適値に影響する主な要因として正しいものはどれか。",
    choices: ["設置地点の緯度", "モジュールの変換効率", "架台の材質", "パワーコンディショナの効率"],
    answer: "設置地点の緯度",
    difficulty: "中級",
    explanation: "年間日射量を最大化する最適傾斜角は設置地点の緯度に依存する。緯度が高い（北）ほど太陽高度が低く、より傾きをつけた方が年間を通じて多く日射を受けられる。一般に最適傾斜角は緯度×0.9程度とされる。日本（北緯30〜45°）では25〜35°程度が最適とされることが多い。"
  },
  {
    q: "太陽光発電の「日照時間」と「日射量」の違いとして正しいものはどれか。",
    choices: [
      "同じ概念で単位が異なるだけ",
      "日射量は気象庁が測定し、日照時間はNEDOが測定する",
      "日照時間は発電できる時間、日射量は発電量に等しい",
      "日照時間は直達日射強度が120W/㎡以上の時間、日射量はエネルギー量（積算）"
    ],
    answer: "日照時間は直達日射強度が120W/㎡以上の時間、日射量はエネルギー量（積算）",
    difficulty: "中級",
    explanation: "日照時間（h）は直達日射強度が120W/㎡以上（日本気象協会・WMO基準）の時間数。日射量（kWh/㎡またはMJ/㎡）は太陽から受け取った放射エネルギー量の積算値。発電量計算では「日射量」を使用する。「ピーク日射時間」は日射量（kWh/㎡）をそのまま時間として扱った概念。"
  },
  {
    q: "太陽光発電の「方位角」について、真南を0°とした場合、真東の方位角として正しいものはどれか。",
    choices: ["+90°（または東偏90°）", "-90°（または西偏90°）", "180°", "0°"],
    answer: "+90°（または東偏90°）",
    difficulty: "中級",
    explanation: "太陽光発電の方位角は通常真南を0°として、東方向を正（＋）、西方向を負（－）で表す場合と、逆の定義を使う場合がある。日本のJIS・NEDO基準では真南0°、東側を－（マイナス）、西側を＋（プラス）とする表記が多いが、本問では「真東＝＋90°」という一般的な認識に沿った設定としている。"
  },
  {
    q: "太陽光発電システムの設計で「インバータの容量比（DC/AC比）」が重要な理由として正しいものはどれか。",
    choices: [
      "DC/AC比が小さいほど変換効率が高くなる",
      "DC/AC比が適切に設定されることで、年間発電量と設備コストのバランスが最適化される",
      "DC/AC比が大きいほどパワーコンディショナの寿命が延びる",
      "DC/AC比は常に1.0に設定しなければならない"
    ],
    answer: "DC/AC比が適切に設定されることで、年間発電量と設備コストのバランスが最適化される",
    difficulty: "上級",
    explanation: "DC/AC比（モジュール総容量÷インバータ定格出力）は通常約1.0〜1.3程度に設定される。比が大きいとピーク出力時にクリッピング損失が生じるが、年間を通した低日射時の発電効率が上がる。比が小さすぎると設備が過剰になる。最適値はシミュレーションで検証する。"
  },
  {
    q: "太陽光発電の「日射量データ」を取得する方法として最も一般的かつ推奨されるものはどれか。",
    choices: ["設置地点の電力会社から取得する", "Google Mapsの衛星写真から推計する", "NEDOや気象庁が提供するデータベースを参照する", "現地で1年間の実測調査を行う"],
    answer: "NEDOや気象庁が提供するデータベースを参照する",
    difficulty: "初級",
    explanation: "発電量シミュレーションにはNEDO（新エネルギー・産業技術総合開発機構）が提供する日射量データベース（METPV、日射量データベース閲覧システム）や気象庁の気象データが広く使用される。1年間の実測は時間とコストがかかる。シミュレーションでは30年程度の統計データに基づく標準気象データを使うことが多い。"
  },
  {
    q: "太陽光発電モジュールに影が落ちる場合の影響として正しいものはどれか。",
    choices: ["影がかかるとモジュール温度が下がり効率が上がる", "影響する面積に比例して出力が低下する", "ストリング全体またはモジュール全体の出力が大きく低下することがある", "影は発電量には影響しない"],
    answer: "ストリング全体またはモジュール全体の出力が大きく低下することがある",
    difficulty: "中級",
    explanation: "太陽電池の直列接続では、1枚のモジュールに影がかかると電流が最小のモジュールで制限されるため、ストリング全体の出力が大きく低下する（バイパスダイオード非動作時）。例えばモジュール1枚の数セルに影がかかるだけで、そのモジュール全体、さらにはストリング全体の出力が影響を受ける。"
  },
  {
    q: "影による発電量損失を最小化するための設計上の対策として適切でないものはどれか。",
    choices: ["マイクロインバータやオプティマイザを使用する", "影の影響を受けるモジュールを別ストリングにまとめる", "バイパスダイオードを取り除いてシンプルな構造にする", "影となる障害物から十分な離隔距離を確保する"],
    answer: "バイパスダイオードを取り除いてシンプルな構造にする",
    difficulty: "中級",
    explanation: "バイパスダイオードは影になったセルグループをバイパスして損失を最小化する重要な部品。取り除くと影による損失が大幅に拡大し、ホットスポットのリスクも高まる。適切な対策は「マイクロインバータ・オプティマイザによる個別制御」「影を受けるモジュールのストリング分離」「離隔距離の確保」である。"
  },
  {
    q: "太陽光発電設計における「前列パネルの影の影響を避けるための離隔距離」の計算に必要な要素として最も重要なものはどれか。",
    choices: ["年間の降雨量", "パワーコンディショナの入力電圧範囲", "架台の前列の高さと設置地点の緯度（太陽高度）", "モジュールの変換効率"],
    answer: "架台の前列の高さと設置地点の緯度（太陽高度）",
    difficulty: "上級",
    explanation: "前列モジュールの影が後列に落ちないようにするための離隔距離は、前列架台高さH（m）と冬至の南中時の太陽高度角から計算する。離隔距離D＝H÷tan（太陽高度角）。太陽高度角は緯度に依存するため、設置地点の緯度が重要な設計パラメータとなる。"
  },
  {
    q: "冬至の日の東京（北緯約35.7°）における太陽の南中高度として最も近いものはどれか。",
    choices: ["約11°", "約31°", "約78°", "約55°"],
    answer: "約31°",
    difficulty: "上級",
    explanation: "南中高度＝90°－緯度±赤緯（太陽赤緯）で計算。冬至の太陽赤緯は約－23.4°。東京（北緯約35.7°）での冬至の南中高度＝90°－35.7°－23.4°＝30.9°≒約31°。この太陽高度を用いて前列架台による影の影響範囲と離隔距離を計算する。"
  },
  {
    q: "太陽光発電システムの「ストリング設計」において考慮する事項として適切でないものはどれか。",
    choices: [
      "ストリングの直列枚数が多すぎてもシステム電圧に問題がなければよい",
      "最高気温時のモジュール最大電力点電圧がPCSのMPPT電圧範囲内であること",
      "最低気温時のモジュール開放電圧がPCSの最大入力電圧を超えないこと",
      "直列枚数と並列ストリング数によるアレイ電力とPCSの定格容量のマッチング"
    ],
    answer: "ストリングの直列枚数が多すぎてもシステム電圧に問題がなければよい",
    difficulty: "上級",
    explanation: "ストリング設計では、最低気温時の開放電圧がPCS最大入力電圧を超えないことが最重要。日本の電気設備技術基準では系統連系PCSの直流側電圧は750V以下（低圧系統連系）が基本。また最高気温時の動作電圧がMPPT範囲内であること、アレイ容量とPCS定格のバランスも重要。直列枚数が多くても電圧超過は安全上問題となるため「問題なければよい」という考え方は誤り。"
  },
  {
    q: "太陽光発電の年間発電量計算において「損失係数」に含まれる主な要因として適切でないものはどれか。",
    choices: ["パワーコンディショナの変換損失（インバータ効率）", "モジュール経年劣化による出力低下", "電力会社の配電網での送電損失", "モジュールの汚れ・積雪による損失"],
    answer: "電力会社の配電網での送電損失",
    difficulty: "中級",
    explanation: "年間発電量計算の損失係数（性能比PRに影響する損失）には、温度損失、汚れ・積雪損失、ミスマッチ損失、配線損失、パワーコンディショナ変換損失、モジュール経年劣化損失などが含まれる。電力会社の配電網での送電損失は需要家のシステムコントロール外であり、通常の発電量計算には含めない。"
  },
  {
    q: "「最大電力点追従（MPPT）範囲」の上限・下限電圧が設計上重要な理由として正しいものはどれか。",
    choices: ["MPPT範囲は法律で決まっている", "MPPT範囲外でも発電量は変わらない", "MPPT範囲はモジュールの保護のためにある", "アレイの動作電圧がMPPT範囲外になると最大電力点での動作ができず、発電量が大きく低下する"],
    answer: "アレイの動作電圧がMPPT範囲外になると最大電力点での動作ができず、発電量が大きく低下する",
    difficulty: "中級",
    explanation: "パワーコンディショナはMPPT追従範囲内の電圧でのみ最大電力点追従が可能。アレイ動作電圧がMPPT範囲を外れると（高温時に下限を下回る、低温時に上限を超えるなど）最大電力点で動作できず発電量が低下。ストリング設計ではすべての温度条件でMPPT範囲内に収まるよう設計する。"
  },
  {
    q: "太陽光発電システムの発電量シミュレーションに使用される代表的なソフトウェアとして正しいものはどれか。",
    choices: ["AutoCAD", "PVsyst（スイス製）またはNEDOのSolarDB", "Microsoft Excelのみで十分", "SAP（会計ソフト）"],
    answer: "PVsyst（スイス製）またはNEDOのSolarDB",
    difficulty: "中級",
    explanation: "PVsyst（スイス製）は世界的に広く使用される太陽光発電シミュレーションソフト。NEDOが提供する「日射量データベース閲覧システム」も日本での設計に活用される。その他、国内では「PV Design」「Virtual Solar」などのソフトが使用されている。発電量計算はExcelでの概算も可能だが、詳細シミュレーションには専用ソフトが使用される。"
  },
  {
    q: "「ピーク日射時間（h）」の定義として正しいものはどれか。",
    choices: [
      "太陽が最も高い位置にある時間帯（南中時刻±1時間）",
      "日照時間の中で最も日射が強い時間帯",
      "日射強度1kW/㎡が何時間継続した場合と等しい日射エネルギー量になるかを示す時間",
      "年間で最も日射量が多い月の月間日照時間"
    ],
    answer: "日射強度1kW/㎡が何時間継続した場合と等しい日射エネルギー量になるかを示す時間",
    difficulty: "中級",
    explanation: "ピーク日射時間は日射量（kWh/㎡）の数値をそのまま時間（h）として表したもの。例えば年間日射量1,200kWh/㎡は「ピーク日射時間1,200h」と表現できる。年間発電量（kWh）＝システム容量（kW）×ピーク日射時間（h）×性能比（PR）で計算できる便利な概念。"
  },
  {
    q: "太陽光発電の傾斜角と年間日射量の関係について、日本（中緯度地帯）での一般的な傾向として正しいものはどれか。",
    choices: ["傾斜角と年間日射量は無関係", "年間日射量を最大化する傾斜角は緯度に近い値（25〜35°程度）になる", "傾斜角0°（水平設置）が最も年間日射量が多い", "傾斜角90°（垂直設置）が最も年間日射量が多い"],
    answer: "年間日射量を最大化する傾斜角は緯度に近い値（25〜35°程度）になる",
    difficulty: "中級",
    explanation: "日本（北緯30〜45°）での年間日射量を最大化する最適傾斜角は概ね25〜35°程度で、設置地点の緯度に近い値になる（緯度×0.9程度）。水平設置は夏季は有利だが冬季は不利。垂直設置は年間を通じて非常に不利。屋根設置では屋根勾配に合わせた傾斜角になることが多い。"
  },
  {
    q: "太陽光発電の設計で「方位角による発電量の差」として正しいものはどれか。",
    choices: ["真南より真北の方が年間発電量が多い", "東向きと西向きでは年間発電量はほぼ同じで、真南より約5〜10%少ない", "方位角は発電量に影響しない", "東向きと西向きでは年間発電量が大きく異なる"],
    answer: "東向きと西向きでは年間発電量はほぼ同じで、真南より約5〜10%少ない",
    difficulty: "中級",
    explanation: "傾斜角30°の場合、真東および真西向き設置での年間日射量は真南向きに比べて約10〜15%少なくなる。東西の差はほぼ対称（日本では若干西の方が多い地域もある）。北向きは大幅に少なく、南向きの50〜60%程度になることもある。方位角は年間発電量に大きく影響する。"
  },
  {
    q: "住宅用太陽光発電システムのモジュール設置容量を計算する際、屋根の面積（㎡）とモジュール変換効率（％）から公称最大出力（kW）を求める式として正しいものはどれか。",
    choices: [
      "公称最大出力＝屋根面積（㎡）×モジュール変換効率（％）",
      "公称最大出力＝屋根面積（㎡）÷モジュール1枚の出力",
      "公称最大出力＝屋根面積（㎡）÷モジュール変換効率（％）",
      "公称最大出力（kW）＝屋根有効面積（㎡）×モジュール変換効率（小数）×1kW/㎡"
    ],
    answer: "公称最大出力（kW）＝屋根有効面積（㎡）×モジュール変換効率（小数）×1kW/㎡",
    difficulty: "上級",
    explanation: "モジュール面積あたりの出力＝放射照度（1kW/㎡）×変換効率（小数）。例えば変換効率20%（0.20）のモジュールでは1㎡あたり0.20kW（200W）。有効面積20㎡の屋根なら公称最大出力＝20㎡×0.20×1kW/㎡＝4kW。架台スペースや通路などを除いた有効面積を使用する。"
  },
  {
    q: "太陽光発電の「自家消費型」システムの設計において最も重要な検討事項として適切なものはどれか。",
    choices: ["モジュールの色や外観", "需要家の電力消費パターンと発電量のマッチング（ロードマッチング）", "発電量を最大化するモジュール設置量の決定のみ", "FIT買取価格の最大化"],
    answer: "需要家の電力消費パターンと発電量のマッチング（ロードマッチング）",
    difficulty: "中級",
    explanation: "自家消費型システムでは、発電電力を売電ではなく自家消費することで電力購入コストを削減するのが目的。このため需要家の時間別電力消費パターン（負荷プロファイル）と発電量のマッチングを分析することが最重要。蓄電池を組み合わせる場合は充放電スケジュールも含めた最適化が必要。"
  },
  {
    q: "太陽光発電の発電量計算において「温度損失」を計算する場合に必要な情報として正しいものはどれか。",
    choices: ["モジュールの開放電圧のみ", "パワーコンディショナのMPPT効率のみ", "モジュールの変換効率温度係数と実際のモジュール温度（または気温）", "設置地点の年間降水量"],
    answer: "モジュールの変換効率温度係数と実際のモジュール温度（または気温）",
    difficulty: "中級",
    explanation: "温度損失＝温度係数（%/℃）×（実際のモジュール温度－STC温度25℃）で計算。実際のモジュール温度は気温＋日射による温度上昇で算出する（NOCT等を利用）。温度係数はモジュール仕様書に記載されている。年平均気温が高い地域では温度損失が大きく、発電量計算に重要な影響を与える。"
  },
  {
    q: "5kWの太陽光発電システム（年間日射量1,200kWh/㎡、PR＝0.80）で、電力単価が27円/kWhの場合の年間想定発電量と節電／売電額として最も近いものはどれか。",
    choices: ["発電量9,600kWh、約259,200円", "発電量2,400kWh、約64,800円", "発電量6,000kWh、約162,000円", "発電量4,800kWh、約129,600円"],
    answer: "発電量4,800kWh、約129,600円",
    difficulty: "上級",
    explanation: "年間発電量＝5kW×1,200kWh/㎡×0.80＝4,800kWh。金額換算＝4,800kWh×27円/kWh＝129,600円（約13万円）。この値は自家消費分の節電額＋余剰売電収入として評価されるが、自家消費比率と売電単価によって実際の収入は異なる。"
  },
  {
    q: "太陽光発電システムの「配線損失」を最小化する設計上の対策として正しいものはどれか。",
    choices: ["モジュールからPCSまでのケーブル長を短くし、十分な断面積のケーブルを使用する", "直流側のケーブルを長くして交流変換後のケーブルを短くする", "配線損失は変換効率に影響しない", "ケーブルの断面積を小さくして材料コストを削減する"],
    answer: "モジュールからPCSまでのケーブル長を短くし、十分な断面積のケーブルを使用する",
    difficulty: "初級",
    explanation: "配線損失（P＝I²×R）を低減するには抵抗Rを下げることが重要。対策はケーブル長の短縮（モジュール・PCS間の距離を最小化）と、十分な断面積のケーブル使用（断面積を大きくするほど抵抗が低下）。一般に直流配線損失は系統連系システムで1〜2%以内に設計する。"
  },
  {
    q: "発電量シミュレーションにおける「最悪年（P90値）」の説明として正しいものはどれか。",
    choices: ["過去10年間の平均発電量", "気温が最高になった年の発電量", "10年に1回の頻度で発電量がこれを下回る確率10%の発電量（90%の確率で上回る発電量）", "最も発電量が多い年の予測値"],
    answer: "10年に1回の頻度で発電量がこれを下回る確率10%の発電量（90%の確率で上回る発電量）",
    difficulty: "上級",
    explanation: "P90値（Percentile 90）は90%の確率で達成できる発電量（10%の確率でしか下回らない）を意味する。金融機関の融資審査では発電量の下振れリスクを考慮してP90値を参考にすることが多い。P50（50%確率）は期待値（中央値）に相当する。P90はP50より低い値となる。"
  },
  {
    q: "太陽光発電システムにおける「DC750V超のシステム電圧」になる場合、何が必要になるか。",
    choices: ["特に追加対応は不要", "高圧に対応した絶縁仕様の機器・ケーブルが必要になる", "送電許可申請が追加で必要", "モジュール枚数を減らして750V以下にする必要がある"],
    answer: "高圧に対応した絶縁仕様の機器・ケーブルが必要になる",
    difficulty: "上級",
    explanation: "系統連系パワーコンディショナの直流側電圧は低圧連系では一般に750V以下が基本だが、産業用や高圧連系システムでは1000V以上の高電圧システムも存在する。高電圧システムでは絶縁距離・絶縁仕様が強化された機器・ケーブルが必要で、電気設備技術基準の高圧規定が適用される場合がある。"
  },
  {
    q: "年間日射量の「直達日射」「散乱日射」「反射日射（アルベド）」の説明として正しいものはどれか。",
    choices: [
      "反射日射（アルベド）は太陽電池の効率を下げる",
      "直達日射のみが発電に寄与し、散乱日射と反射日射は発電に使えない",
      "直達日射は太陽から直接届く日射、散乱日射は大気散乱光、反射日射は地面等からの反射光で、すべて発電に寄与する",
      "散乱日射は雨天時のみに観測される"
    ],
    answer: "直達日射は太陽から直接届く日射、散乱日射は大気散乱光、反射日射は地面等からの反射光で、すべて発電に寄与する",
    difficulty: "中級",
    explanation: "全天日射量＝直達日射量＋散乱日射量（天空散乱光）で構成される。傾斜面では地面や建物からの反射光（アルベド）も加わる。曇り日は直達成分が少なく散乱成分が主体となるが、散乱光でも太陽電池は発電できる。バイフェイシャルモジュールは反射日射（アルベド）も裏面で活用できる。"
  },
  {
    q: "太陽光発電の「受光面積」と「モジュール設置面積」の違いとして正しいものはどれか。",
    choices: ["受光面積はセルが光を受ける有効面積、モジュール設置面積はフレームを含む全体面積", "モジュール設置面積はシステム全体の敷地面積", "受光面積は傾斜角に関わらず水平投影面積", "両者は同じ意味"],
    answer: "受光面積はセルが光を受ける有効面積、モジュール設置面積はフレームを含む全体面積",
    difficulty: "初級",
    explanation: "受光面積（有効面積）はセル（光電変換素子）が実際に太陽光を受けている面積で、フレームや配線スペースを除いた部分。モジュール設置面積（全体面積）はフレーム込みの外形寸法。変換効率の計算には受光面積（またはモジュール全体面積）を明確にする必要がある。"
  },
  {
    q: "太陽光発電のシミュレーションで「クリッピング損失」が発生する状況として正しいものはどれか。",
    choices: ["モジュールに影がかかったとき", "パネルが汚れたとき", "気温が低いとき", "アレイ出力がインバータの定格入力を超えて、発電電力が制限されるとき"],
    answer: "アレイ出力がインバータの定格入力を超えて、発電電力が制限されるとき",
    difficulty: "上級",
    explanation: "クリッピング損失は、アレイ（モジュール）の最大出力がパワーコンディショナの定格入力を超えた際に、PCSが出力を定格値で制限（クリップ）することで生じる損失。DC/AC比を1.0より大きく設計した場合に年間一定の損失が発生するが、低日射時の動作改善とのトレードオフとなる。"
  },
  {
    q: "「日射量の季節変動」を考慮した太陽光発電の月別発電量として一般的な傾向として正しいものはどれか（日本・関東地方）。",
    choices: ["春〜夏（4〜8月）が多く、冬季（11〜2月）は少ない", "季節に関わらず月別発電量は一定", "梅雨（6〜7月）が最も発電量が多い", "冬季（12〜1月）が最も発電量が多い"],
    answer: "春〜夏（4〜8月）が多く、冬季（11〜2月）は少ない",
    difficulty: "中級",
    explanation: "日本（関東地方）では日照時間・日射量は春から夏にかけて多く、冬季は少ない傾向。ただし夏は高温によるモジュール温度損失も大きい。3月〜5月が好条件（気温は低く日照は多い）で最も高い月別発電量となることが多い。梅雨（6〜7月）は日射量が特に少なく発電量が落ち込む。"
  },
  {
    q: "太陽光発電の「土地利用率（グランドカバレッジレシオ：GCR）」の説明として正しいものはどれか。",
    choices: ["モジュール変換効率÷設置面積", "日射量の大地反射（アルベド）割合", "設置敷地面積に対するモジュール設置面積の比率", "モジュール出力÷敷地面積"],
    answer: "設置敷地面積に対するモジュール設置面積の比率",
    difficulty: "上級",
    explanation: "グランドカバレッジレシオ（GCR）＝モジュール設置面積÷総設置敷地面積。GCRが高いほど単位面積あたりの設置量が多く土地を効率利用できるが、前列の影が後列に落ちやすくなり影損失が増大する。GCRと影損失のバランスを取った設計が必要で、一般に地上設置では0.3〜0.5程度が多い。"
  },
  {
    q: "太陽光発電の設計においてパワーコンディショナの台数を増やす（マルチストリング構成）メリットとして適切なものはどれか。",
    choices: ["設置面積が増大する", "異なる方位・傾斜角の屋根面や影の影響を個別に最適化できる", "設備コストが安くなる", "系統連系の手続きが簡略化される"],
    answer: "異なる方位・傾斜角の屋根面や影の影響を個別に最適化できる",
    difficulty: "中級",
    explanation: "マルチストリング構成（複数のPCSを使用）では、異なる方位（南面・東面・西面など）や傾斜角の屋根面にそれぞれ独立したPCSを接続することで、各方位のストリングを独立してMPPT制御でき全体の発電効率を最大化できる。1台のPCSで異なる方位を混在させると最適動作点がずれて損失が生じる。"
  },
  {
    q: "発電量計算で使用する「モジュール劣化率」の業界標準的な値として適切なものはどれか（結晶シリコン系モジュール）。",
    choices: ["初年度で約10%以上劣化する", "年間0.3〜0.7%程度の線形劣化が一般的", "10年ごとに50%劣化する", "劣化しないため考慮不要"],
    answer: "年間0.3〜0.7%程度の線形劣化が一般的",
    difficulty: "中級",
    explanation: "結晶シリコン太陽電池モジュールの経年劣化率は業界標準として年間0.3〜0.7%程度（典型値0.5%/年）の線形劣化が想定される。25年後の出力保証（メーカー保証）は公称最大出力の80〜82%以上が一般的（年間約0.7%劣化相当）。発電量シミュレーションでは劣化率を年間0.5%程度として計算することが多い。"
  },
  {
    q: "太陽光発電の「積雪による損失」の対策として最も効果的なものはどれか。",
    choices: ["傾斜角を大きくして積雪が滑り落ちやすくする（地域による）", "パワーコンディショナの容量を大きくする", "接続箱の防水等級を上げる", "モジュールの変換効率を上げる"],
    answer: "傾斜角を大きくして積雪が滑り落ちやすくする（地域による）",
    difficulty: "初級",
    explanation: "積雪地域では、傾斜角を大きく（40〜60°程度）することで積雪が自然に滑り落ちやすくなり損失を軽減できる。また設置高さを積雪深より高くするか積雪荷重に対応した架台設計も必要。ただし傾斜角を大きくすると春〜夏の発電量が多少減少するため、年間を通した収支で検討する。"
  },
  {
    q: "太陽光発電システムの発電量計算における「汚れ損失」の典型的な値として最も近いものはどれか（日本の一般的な住宅・産業用）。",
    choices: ["損失はほぼゼロ", "年間10〜20%", "年間1〜3%程度", "年間0.1〜0.5%"],
    answer: "年間1〜3%程度",
    difficulty: "中級",
    explanation: "汚れ損失（ダスト・汚染物質による透過率低下）は設置環境・傾斜角・降雨頻度に依存するが、日本の一般的な住宅・産業用では年間1〜3%程度とされる。砂埃の多い地域（農地近辺等）では5%以上になることも。傾斜角が大きいと雨で自然洗浄があり汚れ損失が小さくなる傾向がある。"
  },
  {
    q: "太陽光発電の発電量と気温の関係について正しいものはどれか。",
    choices: ["気温は発電量に影響しない", "気温が低い冬は出力が大きく低下する", "気温が高い夏は効率が上がり発電量が増える", "気温が高いとモジュール温度が上昇して出力が低下し、年間発電量に影響する"],
    answer: "気温が高いとモジュール温度が上昇して出力が低下し、年間発電量に影響する",
    difficulty: "中級",
    explanation: "気温が高い夏季はモジュール温度が上昇し、温度係数（約－0.4%/℃）による出力低下が生じる。気温が低い冬季はモジュール温度が低くなり変換効率が上昇する（出力が向上）。春（3〜5月）は気温が低く日射量が多いため最も高い発電量になることが多い。"
  },
  {
    q: "太陽光発電の「系統制約」（連系容量制限）が設計に影響する場合として正しいものはどれか。",
    choices: ["系統制約は住宅用太陽光発電には全く関係ない", "系統制約はパワーコンディショナの効率のみに影響する", "電力会社の配電線の受け入れ可能容量を超える場合、連系が制限される場合がある", "系統制約は太陽電池の変換効率に影響する"],
    answer: "電力会社の配電線の受け入れ可能容量を超える場合、連系が制限される場合がある",
    difficulty: "中級",
    explanation: "電力会社の配電線には受け入れ可能な再エネ容量の制限があり、系統容量がひっ迫した地域では新規太陽光発電の系統連系が制限・遅延される場合がある（接続申し込みの保留）。また出力制御の頻度が高い地域では発電量シミュレーションに影響する。事前に電力会社への系統連系申し込みと確認が必要。"
  },
  {
    q: "発電量計算における「インバータ効率」の一般的な値として最も近いものはどれか（産業用高性能PCS）。",
    choices: ["約70〜80%", "約95〜98%", "約50〜60%", "約99.9%以上"],
    answer: "約95〜98%",
    difficulty: "中級",
    explanation: "近年の産業用パワーコンディショナの変換効率（最大変換効率）は95〜98%程度（ハイエンド品では98%超）が一般的。日本電機工業会（JEMA）等の規格では加重平均効率（EUパワー等）も重要指標。年間発電量計算では部分負荷も含めた加重平均効率（約94〜96%程度）を使用する。"
  },
  {
    q: "太陽光発電の「南北方向の設置（東西設置）」の特徴として正しいものはどれか。",
    choices: ["東西設置は日本では全く使われない", "東西設置の年間発電量は南向きより多い", "朝と夕方の発電量を均等化でき、1日の発電プロファイルが平準化される", "南向きに比べてピーク出力は高くなる"],
    answer: "朝と夕方の発電量を均等化でき、1日の発電プロファイルが平準化される",
    difficulty: "中級",
    explanation: "モジュールを東向きと西向きに分割設置（東西設置）すると、午前中は東面が多く発電し、午後は西面が多く発電するため、1日の発電量が平準化される。ピーク出力は南向きより低いが、自家消費型システムや蓄電池との組み合わせで有効。陸屋根建物で南北に棟が並ぶ場合にも使用される。"
  },
  {
    q: "太陽光発電設計における「安全率」の適用について正しいものはどれか。",
    choices: ["安全率は法律で一律に定められている", "発電量シミュレーション値をそのまま設計値として使用する", "安全率は架台強度の設計にのみ使用する", "気象変動・劣化・誤差等を考慮した安全マージンを設けた発電量を用いる"],
    answer: "気象変動・劣化・誤差等を考慮した安全マージンを設けた発電量を用いる",
    difficulty: "中級",
    explanation: "発電量シミュレーションには気象変動・モジュール劣化・モデル誤差・汚れ等の不確実性がある。実務では事業計画にP90値（90%確率達成値）を用いるか、P50に不確実性マージンを加算して保守的な想定発電量を設定する。特に融資を受けるプロジェクトでは金融機関から保守的な発電量想定が求められる。"
  },
  {
    q: "太陽光発電の「1時間日射量」が480Wh/㎡の場合、この時刻の平均日射強度（放射照度）として正しいものはどれか。",
    choices: ["480W/㎡", "4,800W/㎡", "48W/㎡", "0.48W/㎡"],
    answer: "480W/㎡",
    difficulty: "初級",
    explanation: "1時間積算の日射量（Wh/㎡）は、その時間中の平均放射照度（W/㎡）に等しい。日射量480Wh/㎡＝平均放射照度480W/㎡が1時間継続した積算値。これを標準放射照度1,000W/㎡で割ると0.48（ピーク日射時間換算）となる。"
  },
  {
    q: "太陽光発電のシステム設計で「モジュールの開放電圧（Voc）温度係数」が0.3％/℃の場合、最低気温-10℃時のモジュールVocの変化率を計算するとどうなるか（STC温度25℃基準）。",
    choices: ["約10.5%減少", "変化なし", "約3%増加", "約10.5%増加"],
    answer: "約10.5%増加",
    difficulty: "上級",
    explanation: "温度変化＝－10℃－25℃＝－35℃。Voc変化率＝－0.3%/℃×（－35℃）＝＋10.5%。低温では開放電圧が上昇するため、最低気温－10℃時のVocはSTCより約10.5%高くなる。この上昇後の電圧がPCSの最大入力電圧を超えないことを確認する必要がある。これがストリング設計の重要な検討事項。"
  },
  {
    q: "太陽光発電の「一軸追尾式架台」の特徴として正しいものはどれか。",
    choices: ["太陽の位置を常に追尾し固定式より年間発電量が30〜40%程度増加する場合がある", "メンテナンスが不要で低コスト", "固定式より年間発電量が少ない", "住宅用太陽光発電で最も一般的な方式"],
    answer: "太陽の位置を常に追尾し固定式より年間発電量が30〜40%程度増加する場合がある",
    difficulty: "中級",
    explanation: "一軸追尾式（東西・仰角の方向で太陽を追尾）は固定式に比べて日射受光量が大幅に増加し、理想的条件下では年間発電量が20〜40%増加することがある。ただし機械的構造が複雑で設備コスト・メンテナンスコストが高く、主に産業用・大規模発電所で使用される。住宅用では固定式が一般的。"
  },
  {
    q: "太陽光発電の設計で使用する「標準モジュール（72セル）」の開放電圧（Voc）の一般的な値として最も近いものはどれか。",
    choices: ["約72V", "約36V", "約43V", "約18V"],
    answer: "約43V",
    difficulty: "中級",
    explanation: "結晶シリコン太陽電池は1セルあたりVoc約0.6V。60セルモジュールは約36V、72セルモジュールは72×0.6≒43.2V。ハーフカットセル（半切り）や大型セルモジュールでは電圧・電流値が異なるが、基本は直列セル数×単セルVocで計算できる。"
  },
  {
    q: "大規模太陽光発電所（メガソーラー）の発電量計算で特に重要な項目として適切でないものはどれか。",
    choices: ["モジュールのパッケージデザイン", "広大な設置面積での日射量の地点間ばらつき", "大量のモジュール・ストリング間の特性ばらつきによるミスマッチ損失", "長大な直流・交流配線による配線損失"],
    answer: "モジュールのパッケージデザイン",
    difficulty: "中級",
    explanation: "大規模メガソーラーの発電量計算では、広大面積での日射量ばらつき、大量モジュール間ミスマッチ損失、長大配線による配線損失、変圧器損失、内部消費電力（監視・制御用）などが重要。モジュールのパッケージデザイン（外観・色）は発電量に直接影響しない。"
  },
  {
    q: "太陽光発電の「日射量観測値」の取り扱いにおいて、一般的な注意点として正しいものはどれか。",
    choices: ["日射量の年間変動はほぼゼロ", "1年間の実測値があれば長期発電量を正確に予測できる", "日射量観測は設備完成後にのみ行う", "短期実測値は年々変動するため、長期予測には複数年の統計データが必要"],
    answer: "短期実測値は年々変動するため、長期予測には複数年の統計データが必要",
    difficulty: "中級",
    explanation: "日射量は年によって10〜15%程度の変動がある。1年間の実測値だけでは長期の代表性が不十分で、偶然値が高い・低い年にあたる可能性がある。長期発電量予測には気象庁や気象データ会社の20〜30年以上の統計データを用いることが推奨される。確率分布（P50、P90等）の概念が重要。"
  },
  {
    q: "太陽光発電の発電量シミュレーション結果と実際の発電量が大きく乖離する場合の原因として適切でないものはどれか。",
    choices: ["モジュール劣化が想定より速い", "PCSの故障や効率低下", "架台の色が変わった", "実際の日射量が想定と異なる（気象変動）"],
    answer: "架台の色が変わった",
    difficulty: "中級",
    explanation: "発電量乖離の主な原因は、気象変動（実際の日射量・気温の差）、モジュール劣化（想定より速い）、汚れ・積雪の想定差、PCS故障・効率低下、影の増加、モジュール間ミスマッチの拡大などが挙げられる。架台の色の変化は通常発電量に直接影響しない（ただし反射光への影響がある場合は例外）。"
  },
  {
    q: "太陽光発電の「比発電量（specific yield）」の説明として正しいものはどれか。",
    choices: ["1時間あたりの最大発電量", "設置容量1kWpあたりの年間発電量（kWh/kWp）", "発電コスト（円/kWh）", "モジュール1㎡あたりの年間発電量（kWh/㎡）"],
    answer: "設置容量1kWpあたりの年間発電量（kWh/kWp）",
    difficulty: "上級",
    explanation: "比発電量（Specific YieldまたはSpecific Energy Yield）は設置容量1kWpあたりの年間発電量（kWh/kWp）で表される。日本では年間900〜1,200kWh/kWp程度が多い。設置場所や設計品質の比較指標として有用で、性能比（PR）とピーク日射時間から計算できる（比発電量＝PR×ピーク日射時間）。"
  },
  {
    q: "太陽光発電の「敷地面積あたりの発電量（W/㎡）」を推定する場合、主に考慮すべき要素として正しいものはどれか。",
    choices: ["パワーコンディショナのメーカー名", "工事費の多寡", "系統連系の電圧（低圧・高圧）", "モジュール変換効率と設置密度（GCR）"],
    answer: "モジュール変換効率と設置密度（GCR）",
    difficulty: "上級",
    explanation: "敷地面積あたりの設置出力（W/㎡）＝モジュール変換効率（W/㎡）×GCR（設置密度）で概算できる。例えば変換効率20%（200W/㎡）×GCR0.4＝80W/㎡程度の設置密度となる。この値と年間日射量・PRから敷地面積あたりの年間発電量が推計できる。"
  },
  {
    q: "太陽光発電の設計段階で「地盤調査」が必要になる主な場合として正しいものはどれか。",
    choices: ["屋根設置型の住宅用太陽光発電で必須", "すべての太陽光発電設備で必ず実施する必要がある", "地上設置の産業用太陽光発電で架台の基礎設計に地耐力が必要な場合", "地盤調査は太陽光発電設計には不要"],
    answer: "地上設置の産業用太陽光発電で架台の基礎設計に地耐力が必要な場合",
    difficulty: "中級",
    explanation: "地上設置型の産業用太陽光発電では、架台基礎（杭基礎・コンクリート基礎等）の設計に地盤の支持力（地耐力）データが必要となるため地盤調査を実施する。屋根設置型は建物の構造に直接設置するため原則として地盤調査は不要。ただし建物の構造耐力の確認は必要。"
  },
  {
    q: "太陽光発電の「正弦波インバータ」と「疑似正弦波（矩形波）インバータ」の違いとして正しいものはどれか。",
    choices: ["正弦波インバータは直流のみを扱う", "疑似正弦波の方が効率が高く一般的", "系統連系用には正弦波インバータが必須で、疑似正弦波は系統連系に使えない", "両方とも系統連系に使える"],
    answer: "系統連系用には正弦波インバータが必須で、疑似正弦波は系統連系に使えない",
    difficulty: "中級",
    explanation: "系統連系型パワーコンディショナは電力系統の交流波形（正弦波）に合わせた正弦波交流出力が必要で、電力系統の品質を維持するため正弦波インバータが必須。疑似正弦波（矩形波・変形正弦波）は系統連系には使用不可で、独立系（単独運転）の小型インバータ等に使われる。"
  },
  {
    q: "太陽光発電の「発電予測精度向上」に使用される技術として最近活用されているものはどれか。",
    choices: ["過去の発電量平均のみを使用", "太陽黒点数による長期予測", "人工衛星画像を用いた雲予測や機械学習による短時間予測", "天気予報機関の主観的判断のみ"],
    answer: "人工衛星画像を用いた雲予測や機械学習による短時間予測",
    difficulty: "中級",
    explanation: "近年の太陽光発電量予測では、気象衛星画像を用いた雲の移動・発生予測、メソスケール気象モデル（MSM等）の数値予報、機械学習（深層学習）を活用した短時間〜翌日予測が実用化されている。電力系統の需給管理精度向上のために重要な技術。"
  },
  {
    q: "太陽光発電システムの「容量設計」において、系統連系規程の制約として正しいものはどれか。",
    choices: ["低圧系統連系では原則として出力50kW未満が対象", "産業用では容量の上限規制はない", "住宅用太陽光発電は契約電力の2倍まで設置できる", "住宅用は1kW以上でなければ設置できない"],
    answer: "低圧系統連系では原則として出力50kW未満が対象",
    difficulty: "中級",
    explanation: "電力会社との系統連系規程では、低圧（100V・200V）系統への連系は原則出力50kW未満の設備が対象。50kW以上は高圧系統への連系となり、電力会社との協議・受電設備の設置が必要。産業用大規模では特別高圧（2万V以上）連系となる場合もある。"
  },
  {
    q: "太陽光発電のシミュレーションで「電力需要プロファイル」が必要になる場合として正しいものはどれか。",
    choices: ["産業用でのみ使用する指標", "全量売電FIT事業では不要だが、自家消費型の評価に必要", "電力需要プロファイルは発電量に影響しない", "すべての場合で常に必要"],
    answer: "全量売電FIT事業では不要だが、自家消費型の評価に必要",
    difficulty: "中級",
    explanation: "全量売電型FIT事業（発電した電力をすべて売電）の発電量計算では電力需要プロファイルは不要。しかし自家消費型・余剰売電型システムの経済性評価では、発電量と消費量の時間的マッチングを分析するために時間別の電力需要プロファイル（負荷曲線）が必要。"
  },
  {
    q: "太陽光発電の設計において「電圧降下」の許容値として電気設備技術基準で規定されている上限（住宅・低圧幹線）として最も近いものはどれか。",
    choices: ["5%以下", "20%以下", "2%以下", "10%以下"],
    answer: "5%以下",
    difficulty: "上級",
    explanation: "電気設備技術基準の解釈では、低圧幹線の電圧降下は原則として電路の最遠端で5%以下（分岐回路まで含めると3%以下とすることが推奨される場合もある）とされている。太陽光発電システムの配線設計でもこの基準に基づき配線サイズを選定する。"
  },
  {
    q: "太陽光発電の「フラットルーフ（陸屋根）」への設置における傾斜角の一般的な設定として正しいものはどれか。",
    choices: ["架台を使用して10〜30°の傾斜角を持たせて設置することが多い", "陸屋根には太陽光発電を設置できない", "常に45°以上の傾斜角が必要", "陸屋根は水平設置（0°）のみ可能"],
    answer: "架台を使用して10〜30°の傾斜角を持たせて設置することが多い",
    difficulty: "初級",
    explanation: "陸屋根（傾斜のない平坦な屋根）に設置する場合、傾斜架台を使用して10〜30°程度の傾斜角を持たせることで発電量を向上させる。0°（水平）でも設置は可能だが発電量が低下する上に汚れが溜まりやすい。前列の影を避けるため、傾斜角が大きくなるほど列間隔を広くする必要がある。"
  },
  {
    q: "太陽光発電の「LCOE（均等化発電コスト）」を下げるための有効な方策として最も適切なものはどれか。",
    choices: ["設備容量を小さくする", "初期コスト削減と発電量増加（高変換効率・高PR設計）の両立", "売電価格を下げる", "O&Mコストを増やして品質を向上させる"],
    answer: "初期コスト削減と発電量増加（高変換効率・高PR設計）の両立",
    difficulty: "中級",
    explanation: "LCOE＝総コスト（設備費＋O&Mコスト）÷総発電量。LCOEを下げるには分子（総コスト）を削減するか分母（総発電量）を増やす必要がある。具体的には設備費の削減、高変換効率モジュールによる単位面積あたりの発電量増加、性能比（PR）向上（損失低減）、O&Mコストの適正化が有効。"
  },
  {
    q: "太陽光発電の「ドミノ現象（影のカスケード）」の説明として正しいものはどれか。",
    choices: ["モジュールが次々に故障する現象", "大雨で架台が倒壊する現象", "ストリング内の一つのセルグループへの影がバイパスダイオード経由で出力を低下させ、連鎖的に影響が広がる現象", "パワーコンディショナが連鎖的に停止する現象"],
    answer: "ストリング内の一つのセルグループへの影がバイパスダイオード経由で出力を低下させ、連鎖的に影響が広がる現象",
    difficulty: "上級",
    explanation: "ドミノ現象（影のカスケード）はストリング内で一部セルグループに影がかかった際にバイパスダイオードが作動し、その電流迂回がストリング全体の動作点を変化させ、影のかかっていないセルグループの出力にも影響を与える現象。設計で影の影響を最小化することが重要。"
  },
  {
    q: "発電量計算で使用する「性能比（PR）」の典型的な値として最も適切なものはどれか（日本の系統連系システム）。",
    choices: ["0.95〜0.99", "1.0以上", "0.7〜0.85", "0.3〜0.5"],
    answer: "0.7〜0.85",
    difficulty: "中級",
    explanation: "性能比（PR）は実際の発電量÷理論最大発電量（日射量×容量）で算出され、システム全体の損失を表す指標。日本の一般的な系統連系システムでは0.7〜0.85程度。温度損失・汚れ損失・PCS変換損失・配線損失等の合計。優良なシステムでPR0.85超もある。PRが1.0を超えることは理論的にあり得ない。"
  },
  {
    q: "太陽光発電の「バーチャルネットメタリング」の説明として正しいものはどれか。",
    choices: ["モジュールの仮想データシートによる選定", "インターネット経由でPCSを遠隔操作する技術", "複数サイトでの太陽光発電を仮想的に集約して相殺する仕組み", "仮想通貨による太陽光発電の電力売買"],
    answer: "複数サイトでの太陽光発電を仮想的に集約して相殺する仕組み",
    difficulty: "上級",
    explanation: "バーチャルネットメタリング（VNM）は、複数の場所に設置した太陽光発電の発電量を仮想的に合算して、複数の消費地点の電力と相殺する仕組み。共同住宅や複数施設を持つ企業が太陽光発電の恩恵を分散できる。日本では制度的整備が進んでいる段階。"
  },
  {
    q: "太陽光発電設計での「モジュール間隔（列間隔）」の計算式として正しいものはどれか（Hはモジュール高さ、θは傾斜角、αは太陽高度角）。",
    choices: ["間隔＝H×θ×α", "間隔＝H÷θ×α", "間隔＝H×cos(θ)÷sin(α)", "間隔＝H×sin(θ)÷tan(α)"],
    answer: "間隔＝H×sin(θ)÷tan(α)",
    difficulty: "上級",
    explanation: "前列モジュールによる影が後列の受光面下端に達しない最小間隔は、D＝H×sin(θ)÷tan(α)で求める。H×sin(θ)は前列モジュールの高さ（垂直投影）、tan(α)は冬至南中時の太陽高度角から影の水平投影距離を計算するための値。設計では冬至日の南中時間（最も影が長くなる条件）を基準として列間隔を決定する。"
  },
  {
    q: "太陽光発電の「蓄電池容量の選定」において考慮すべき事項として最も重要なものはどれか（自家消費最大化目的）。",
    choices: ["蓄電池は発電量シミュレーションに関係ない", "蓄電池は大きければ大きいほど常に良い", "蓄電池は架台の強度設計に使用するデータ", "1日の余剰発電量と夜間消費量のバランスに基づいた最適容量の選定"],
    answer: "1日の余剰発電量と夜間消費量のバランスに基づいた最適容量の選定",
    difficulty: "中級",
    explanation: "自家消費最大化を目的とした蓄電池容量の選定では、昼間の余剰発電量と夜間・悪天候時の消費電力量のバランスが基本となる。蓄電池容量が過小だと余剰電力を蓄えきれず、過大だと初期コストが上昇して経済性が悪化する。そのため、日単位の充放電サイクルシミュレーションによって最適容量を検討する。"
  },
  {
    q: "太陽光発電の「年間売電収入」の計算に必要な情報として最も重要なものはどれか。",
    choices: ["年間発電量（kWh）と売電単価（円/kWh）、および自家消費比率", "近隣の気象観測所の海抜高度", "モジュールのメーカー名とフレームの色", "架台の材質と設置工事費のみ"],
    answer: "年間発電量（kWh）と売電単価（円/kWh）、および自家消費比率",
    difficulty: "中級",
    explanation: "年間売電収入＝年間発電量（kWh）×（1－自家消費率）×売電単価（円/kWh）で計算する。FIT売電では全量売電（買取単価×全発電量）または余剰売電（買取単価×余剰発電量）で計算する。自家消費型では、節電単価（回避コスト）と売電単価を使い分けて経済性を評価する。"
  }
];

function generateSystemDesignQuestions() {
  return SYSTEM_DESIGN_SPECS.map((spec) => {
    const choiceExplanations = {};
    choiceExplanations[spec.answer] = { result: "正解", reason: spec.explanation };
    spec.choices.forEach((c) => {
      if (c === spec.answer) return;
      choiceExplanations[c] = { result: "不正解", reason: `正解は「${spec.answer}」。${spec.explanation}` };
    });

    return {
      id: nextQuestionId("d"),
      mode: "knowledge",
      category: "システム設計・発電量計算",
      difficulty: spec.difficulty,
      question: spec.q,
      customerScenario: "",
      choices: shuffleArray(spec.choices),
      answer: spec.answer,
      explanation: spec.explanation,
      choiceExplanations,
      sourceManufacturer: null,
      sourceProduct: null
    };
  });
}


module.exports = {
  SHEET_CONFIG,
  loadProductsFromSheet,
  resetQuestionIdCounter,
  generateKnowledgeQuestions,
  generatePracticeQuestions,
  generateBasicConceptQuestions,
  generateSolarBasicsQuestions,
  generateSystemDesignQuestions,
  isUnknownValue
};
