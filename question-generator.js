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

/* ================================================================
   第3章 機器・部品の知識（製品データに依存しない静的問題）
   出題範囲：モジュール構成部材（封止材/バックシート/フレーム/ガラス）・
   PCS（機能/保護機能/構成方式）・接続箱・ケーブル・コネクタ・蓄電池
   （SOC/DOD/化学特性）・監視/点検機器・電気工事/法規まわりの知識。
   ================================================================ */
const EQUIPMENT_SPECS = [
  {
    q: "太陽電池モジュールの封止材として最も一般的に使用される材料はどれか。",
    choices: ["EVA（エチレン酢酸ビニル共重合体）", "PET（ポリエチレンテレフタレート）", "HDPE（高密度ポリエチレン）", "PVC（ポリ塩化ビニル）"],
    answer: "EVA（エチレン酢酸ビニル共重合体）",
    difficulty: "中級",
    explanation: "EVA（Ethylene Vinyl Acetate：エチレン酢酸ビニル共重合体）はモジュールのセルとガラス・バックシートを接着・封止する材料として最も広く使用される。透明性・接着性・耐候性に優れる。近年はPOE（ポリオレフィンエラストマー）の採用も増えている（EVAより耐湿性・PID耐性が高い）。"
  },
  {
    q: "太陽電池モジュールのバックシートの主な役割として正しいものはどれか。",
    choices: ["モジュール裏面の電気絶縁・水分侵入防止・保護", "モジュールの温度を下げるための放熱", "太陽光を反射してセルに集光する", "バイパスダイオードを保護する"],
    answer: "モジュール裏面の電気絶縁・水分侵入防止・保護",
    difficulty: "初級",
    explanation: "バックシートはモジュール裏面の最外層材料で、電気絶縁性・水分遮断性・耐候性・紫外線耐性が求められる。一般的にPET（ポリエチレンテレフタレート）やPVF（ポリビニルフルオライド、テドラー）などの複合構造が使用される。バックシートの劣化は水分浸入・絶縁低下・出力低下につながる。"
  },
  {
    q: "パワーコンディショナ（PCS）の主な機能として含まれないものはどれか。",
    choices: ["単独運転防止機能", "最大電力点追従（MPPT）制御", "太陽電池セルの製造", "直流電力を交流電力に変換する（DC/AC変換）"],
    answer: "太陽電池セルの製造",
    difficulty: "初級",
    explanation: "パワーコンディショナ（PCS：Power Conditioning System）の主な機能は①直流→交流変換（インバータ機能）②MPPT制御（最大電力点追従）③系統連系保護（単独運転防止・過電圧保護・不足電圧保護・周波数異常保護）④自動運転停止。太陽電池セルの製造はPCSの機能ではない。"
  },
  {
    q: "太陽光発電システムの「接続箱」の役割として正しいものはどれか。",
    choices: ["複数のストリングを並列接続し、逆流防止・過電流保護・地絡検出などを行う", "系統への連系を遮断する", "直流をACに変換する", "発電量をモニタリングする"],
    answer: "複数のストリングを並列接続し、逆流防止・過電流保護・地絡検出などを行う",
    difficulty: "初級",
    explanation: "接続箱は複数の太陽電池ストリングをパワーコンディショナの入力端子に接続するための中間機器。主な機能は複数ストリングの並列接続、逆流防止ダイオード（各ストリング）、過電流保護素子（ヒューズ等）、開閉器（ストリング単位のオフ機能）、地絡検出機能（大規模システム）など。"
  },
  {
    q: "パワーコンディショナの「加重平均効率（EUパワーあるいはCECパワー）」が「最高効率」より重要とされる理由として正しいものはどれか。",
    choices: ["法律で加重平均効率の使用が義務付けられているから", "実際の日射変動条件下での年間発電量は部分負荷（低日射）での運転が多いため", "加重平均効率のほうが常に数値が大きいから", "最高効率は測定が難しいから"],
    answer: "実際の日射変動条件下での年間発電量は部分負荷（低日射）での運転が多いため",
    difficulty: "上級",
    explanation: "最高効率は最大出力付近（定格の100%近傍）での効率だが、実際の太陽光発電では年間を通じて日射変動により低負荷（定格の10〜30%程度）での運転も多い。加重平均効率（EUパワー・CEC効率）は複数の部分負荷点での効率を実際の運転比率で重み付け平均したもので、年間発電量の予測精度が高い。"
  },
  {
    q: "太陽電池モジュールのアルミフレームの役割として最も適切なものはどれか。",
    choices: ["接地（アース）のためのみに使用する", "モジュールの発電効率を上げる", "モジュールの構造的強度確保・架台への取付・端面の保護", "バイパスダイオードを内蔵する"],
    answer: "モジュールの構造的強度確保・架台への取付・端面の保護",
    difficulty: "初級",
    explanation: "アルミフレームはモジュールの外周を囲み、ガラス・封止材・バックシートの積層体を保護する構造部材。架台への取付穴（ボルト穴）を設け、施工時の固定に使用される。アルミは軽量・耐食性・加工性に優れる。フレームはモジュール接地（アース）の接続点にもなる。"
  },
  {
    q: "太陽光発電用ケーブル（PV用ケーブル）の特徴として正しいものはどれか。",
    choices: ["屋外・直流高電圧に対応した耐候性・絶縁性能を持つ専用ケーブルを使用すべき", "PV用ケーブルは接続箱内部のみに使用する", "直流用ケーブルは交流用より細くてよい", "一般の家庭用VVFケーブルと同様の仕様で問題ない"],
    answer: "屋外・直流高電圧に対応した耐候性・絶縁性能を持つ専用ケーブルを使用すべき",
    difficulty: "中級",
    explanation: "太陽光発電の直流ケーブルには、屋外での紫外線・熱・機械的ストレスへの耐性と、直流高電圧（最大1000V超）への絶縁性能が要求される。IEC 62930規格に適合したPV専用ケーブル（EPRやXLPE絶縁）を使用すべき。一般家庭用VVFケーブルは直流高電圧・屋外長期曝露には不適切。"
  },
  {
    q: "太陽光発電システムの「パワーコンディショナの保護機能」として含まれないものはどれか。",
    choices: ["過電圧保護（OVP）", "周波数上昇・低下保護（OFR・UFR）", "不足電圧保護（UVP）", "電力料金の自動計算"],
    answer: "電力料金の自動計算",
    difficulty: "中級",
    explanation: "系統連系パワーコンディショナの保護機能には、過電圧保護（OVP）・不足電圧保護（UVP）・周波数上昇保護（OFR）・周波数低下保護（UFR）・逆電力保護・地絡過電流保護・単独運転防止（能動型・受動型）などが含まれる。電力料金の自動計算はPCSの機能ではない。"
  },
  {
    q: "太陽電池モジュールの「IEC61730」規格で評価される主な項目はどれか。",
    choices: ["リサイクル可能比率", "安全性評価（電気・機械・火災耐性など）", "環境適合性（RoHS）", "モジュールの変換効率のみ"],
    answer: "安全性評価（電気・機械・火災耐性など）",
    difficulty: "上級",
    explanation: "IEC 61730は太陽電池モジュールの安全認定に関する規格で、電気的安全性（絶縁性・耐電圧）、機械的安全性（メカニカルロード）、火災耐性など安全に関する試験項目を規定する。性能評価はIEC 61215（結晶シリコン）またはIEC 61646（薄膜）で規定されており、IEC 61730は安全性の認証規格。"
  },
  {
    q: "太陽光発電用架台の材質として最も一般的に使用されるものはどれか。",
    choices: ["アルミニウム合金または溶融亜鉛メッキ鋼材", "銅合金", "プラスチック（樹脂）", "木材"],
    answer: "アルミニウム合金または溶融亜鉛メッキ鋼材",
    difficulty: "初級",
    explanation: "屋根・地上設置の架台にはアルミニウム合金（軽量・耐食性・加工性に優れる）または溶融亜鉛メッキ鋼材（強度が高く大型設備向け）が主に使用される。木材は耐久性・防火性の問題から太陽光発電架台には適さない。架台は20〜30年以上の耐久性が求められる。"
  },
  {
    q: "太陽光発電の「モニタリングシステム」の主な機能として正しいものはどれか。",
    choices: ["電力会社との売電量の検針のみ行う", "発電量・日射量・温度等のデータ収集・記録・遠隔監視・異常検知", "モジュールの製造工程を管理する", "モジュールを定期的に清掃する"],
    answer: "発電量・日射量・温度等のデータ収集・記録・遠隔監視・異常検知",
    difficulty: "初級",
    explanation: "モニタリングシステムは、発電量・日射量・モジュール温度・環境温度等のデータをリアルタイムで収集・記録し、遠隔からの監視・異常検知・アラート通知を行う。データは性能評価（PR計算）・O&Mの効率化・故障早期発見に活用される。電力会社の検針は別の電力量計（スマートメーター）が担う。"
  },
  {
    q: "蓄電池の「SOC（State of Charge）」の説明として正しいものはどれか。",
    choices: ["蓄電池の化学組成", "蓄電池の充電状態（残量）を0〜100%で示す指標", "蓄電池1回のサイクルで放電できるエネルギー量", "蓄電池の放電深度の上限値"],
    answer: "蓄電池の充電状態（残量）を0〜100%で示す指標",
    difficulty: "初級",
    explanation: "SOC（State of Charge：充電状態）は蓄電池の現在の充電量を満充電（100%）に対するパーセンテージで示す。SOC100%は満充電、SOC0%は完全放電。蓄電池の充放電管理ではSOCを一定範囲内（例えば20〜90%）に保つことで寿命延長が図られる。"
  },
  {
    q: "リチウムイオン蓄電池の特徴として適切でないものはどれか。",
    choices: ["鉛蓄電池より軽量", "過充電・過放電に対し非常に堅牢で保護回路は不要", "エネルギー密度が高い", "サイクル寿命が長い（数千回以上）"],
    answer: "過充電・過放電に対し非常に堅牢で保護回路は不要",
    difficulty: "中級",
    explanation: "リチウムイオン電池は過充電や過放電に弱く、熱暴走・発火のリスクがあるため、BMS（Battery Management System：電池管理システム）による充放電制御・保護回路が必須。エネルギー密度・サイクル寿命・重量の点では鉛蓄電池より優れる。住宅・産業用蓄電システムで広く採用されている。"
  },
  {
    q: "太陽光発電システムにおける「スマートメーター（電力量計）」の役割として正しいものはどれか。",
    choices: ["電力系統からの受電量と逆潮流（売電量）を計量し、遠隔検針を可能にする", "蓄電池の充放電を制御する", "太陽電池の発電量を測定する", "パワーコンディショナのMPPT制御を行う"],
    answer: "電力系統からの受電量と逆潮流（売電量）を計量し、遠隔検針を可能にする",
    difficulty: "中級",
    explanation: "スマートメーター（電子式電力量計）は電力会社が設置する計量器で、買電量・売電量を高精度に計量する。通信機能を持ち遠隔検針・30分値データの取得が可能。FIT売電の精算にも使用される。太陽電池の発電量は別途設置される発電電力量計やモニタリングシステムで計測する。"
  },
  {
    q: "太陽光発電モジュールの「PERC（Passivated Emitter and Rear Cell）セル」の特徴として正しいものはどれか。",
    choices: ["GaAsベースの高効率セル", "ペロブスカイトと組み合わせたタンデムセル", "セル裏面にパッシベーション層を設けて再結合を減らし、変換効率を向上させた結晶シリコンセル", "薄膜型太陽電池の一種"],
    answer: "セル裏面にパッシベーション層を設けて再結合を減らし、変換効率を向上させた結晶シリコンセル",
    difficulty: "上級",
    explanation: "PERCセル（Passivated Emitter and Rear Cell）は従来の結晶シリコンセルの裏面に誘電体パッシベーション層（Al₂O₃等）を追加し、裏面でのキャリア再結合を抑制することで変換効率を高めた技術。市販モジュールの効率20〜22%超を実現。現在の結晶シリコンセルの主流技術の一つ。"
  },
  {
    q: "太陽光発電用パワーコンディショナのトランスレス（絶縁変圧器なし）型の特徴として正しいものはどれか。",
    choices: ["商用電源からの絶縁が確実でPID抑制に効果がある", "日本では使用が禁止されている", "絶縁変圧器型より変換効率が低い", "軽量・小型・高効率だが直流地絡時の対地電圧管理が重要"],
    answer: "軽量・小型・高効率だが直流地絡時の対地電圧管理が重要",
    difficulty: "上級",
    explanation: "トランスレス型PCSは絶縁変圧器を省略することで小型・軽量・高効率（変換効率向上）を実現。一方でモジュールアレイと系統が直流的に繋がり対地電圧の管理が必要（PIDの懸念、地絡検出の難しさ）。日本では絶縁変圧器なしでも要件を満たせば使用可能。住宅用では広く普及している。"
  },
  {
    q: "太陽光発電システムの「避雷器（SPD：Surge Protective Device）」の役割として正しいものはどれか。",
    choices: ["系統の電圧変動を制御する", "逆電力を防止する", "雷サージから機器を保護するために設置する", "漏電を検知して遮断する"],
    answer: "雷サージから機器を保護するために設置する",
    difficulty: "中級",
    explanation: "避雷器（SPD）は落雷や開閉サージによる過電圧から機器を保護する。太陽光発電システムでは直流側（モジュール・接続箱）と交流側（PCS出力・分電盤）の両方に設置が推奨される。特に落雷の多い地域や雷サージが侵入しやすいケーブル長の長いシステムでは重要。"
  },
  {
    q: "太陽光発電の「絶縁抵抗計（メガー）」を使用した点検の目的として正しいものはどれか。",
    choices: ["発電量を計測する", "パワーコンディショナの保護機能を試験する", "モジュールの変換効率を測定する", "直流回路や交流回路の絶縁劣化（漏電の有無）を確認する"],
    answer: "直流回路や交流回路の絶縁劣化（漏電の有無）を確認する",
    difficulty: "中級",
    explanation: "絶縁抵抗計（メガー）は電気回路の絶縁抵抗を測定する計器。太陽光発電システムでは、モジュール・ケーブル・接続箱の絶縁劣化（水分浸入・経年劣化・ケーブル傷など）の検出に使用する。設置時の施工確認と定期点検で実施され、規定値（一般に1MΩ以上）を満足することを確認する。"
  },
  {
    q: "「ハーフカットセルモジュール（ハーフカット技術）」の特徴として正しいものはどれか。",
    choices: ["セルを半分に切断することでモジュールサイズを小さくする技術", "セルを半分に切断して電流を半減させ、抵抗損失を減らし出力・耐シェード性を向上させる", "半導体薄膜を半分だけ利用する技術", "変換効率を2倍にする技術"],
    answer: "セルを半分に切断して電流を半減させ、抵抗損失を減らし出力・耐シェード性を向上させる",
    difficulty: "中級",
    explanation: "ハーフカットセル技術はセルをレーザーで半分に切断し、一つのモジュール内でセルを上下半面に分割して配線する。セル面積が半分になると電流が1/2になり、電力損失P＝I²Rも1/4に減少する。これにより配線損失低減・耐シェード性向上・高温特性改善が実現。変換効率は全体で1〜2%程度向上する。"
  },
  {
    q: "太陽光発電の「鉛蓄電池」と「リチウムイオン電池」の比較として正しいものはどれか。",
    choices: ["両者の充放電効率はほぼ同じ", "鉛蓄電池のほうがサイクル寿命が長い", "鉛蓄電池のほうが安全性が低い", "リチウムイオン電池のほうがエネルギー密度が高く軽量"],
    answer: "リチウムイオン電池のほうがエネルギー密度が高く軽量",
    difficulty: "初級",
    explanation: "リチウムイオン電池は鉛蓄電池に比べてエネルギー密度が体積・重量ともに高く（3〜5倍程度）、サイクル寿命も長い（鉛蓄電池：300〜500サイクル、リチウムイオン：2000〜6000サイクル）。充放電効率も高い（Li-ion：90〜95%、鉛：80〜85%）。一方、鉛蓄電池は安価で技術が確立している。"
  },
  {
    q: "太陽光発電システムにおける「漏電遮断器（ELCB）」の設置目的として正しいものはどれか。",
    choices: ["系統の電圧を安定化させる", "直流電流の逆流を防ぐ", "最大電力点を追従する", "感電事故・火災を防止するため、漏電を検知して回路を遮断する"],
    answer: "感電事故・火災を防止するため、漏電を検知して回路を遮断する",
    difficulty: "中級",
    explanation: "漏電遮断器（ELCB：Earth Leakage Circuit Breaker）は、電路に漏電が発生した際に感度電流（一般に30mA）以上の漏れ電流を検知して自動的に回路を遮断し、感電事故や電気火災を防止する。太陽光発電システムでは交流側（パワーコンディショナ出力〜分電盤）に設置される。"
  },
  {
    q: "太陽光発電用「パワーコンディショナの認証制度（JIS C 8961等）」の目的として正しいものはどれか。",
    choices: ["設置工事業者を認定する", "安全性・系統連系保護機能・性能の適合を第三者が認証する", "製造メーカーを認定する", "製品の価格を認証する"],
    answer: "安全性・系統連系保護機能・性能の適合を第三者が認証する",
    difficulty: "中級",
    explanation: "JIS C 8961（小出力太陽光発電用パワーコンディショナの試験方法）等の規格、および第三者認証機関（JET・TÜV等）による認証は、PCSの安全性（絶縁・耐電圧）・系統連系保護機能（単独運転防止等）・変換効率・高調波品質などの要件への適合を検証する。電力会社との系統連系申請でも認証取得品が求められる。"
  },
  {
    q: "太陽光発電の「マイクロインバータ」のデメリットとして正しいものはどれか。",
    choices: ["台数が多くなり初期コストが高い・メンテナンス箇所が増える", "部分影の影響を強く受ける", "ストリングインバータより変換効率が低い", "モジュールごとの個別MPPT制御ができない"],
    answer: "台数が多くなり初期コストが高い・メンテナンス箇所が増える",
    difficulty: "中級",
    explanation: "マイクロインバータは各モジュールに1台設置するため、台数が多くなり初期設備コストがストリングインバータより高くなる。また設置台数が多い分、故障発生件数やメンテナンス箇所も増加する可能性がある。一方で部分影の影響を受けにくい・個別MPPT制御可能・1台故障でも他は影響なしといったメリットがある。"
  },
  {
    q: "太陽光発電の「DC最適化器（パワーオプティマイザ）」の機能として正しいものはどれか。",
    choices: ["蓄電池の充放電を制御する", "各モジュールに設置してモジュール単位でMPPT制御し、ストリングのミスマッチ損失を低減する", "直流を直接交流に変換する", "逆電力を防止する"],
    answer: "各モジュールに設置してモジュール単位でMPPT制御し、ストリングのミスマッチ損失を低減する",
    difficulty: "上級",
    explanation: "DC最適化器（パワーオプティマイザ）は各モジュールに設置するDC/DCコンバータで、モジュール単位でMPPT制御を行い最適化された直流電力をストリングインバータに送る。影や性能ばらつきによるミスマッチ損失を大幅に低減できる。SolarEdgeが主要メーカー。マイクロインバータと異なりDC→AC変換は中央のインバータで行う。"
  },
  {
    q: "太陽電池モジュールの「PID試験（IEC 62804）」の目的として正しいものはどれか。",
    choices: ["モジュールの色の安定性を評価する", "モジュールの変換効率の高さを検証する", "電位誘起劣化（PID）に対するモジュールの耐性を評価する", "架台への固定強度を試験する"],
    answer: "電位誘起劣化（PID）に対するモジュールの耐性を評価する",
    difficulty: "上級",
    explanation: "IEC 62804はPID（電位誘起劣化）耐性試験の規格で、高温・高湿環境下でモジュールに高電圧（−1000Vや−1500V）を印加し、PIDによる出力低下を評価する。PID耐性が認証されたモジュールを選定することで、高電圧システムでの長期性能維持が期待できる。"
  },
  {
    q: "太陽光発電の「監視システム（SCADA）」を導入する目的として最も適切なものはどれか。",
    choices: ["電力会社への売電量を集計する専用システム", "太陽電池の研究開発用データ収集", "複数サイトの発電量・異常・性能を統合的にリアルタイム監視する", "モジュールの製造記録を管理する"],
    answer: "複数サイトの発電量・異常・性能を統合的にリアルタイム監視する",
    difficulty: "上級",
    explanation: "SCADA（Supervisory Control And Data Acquisition）は大規模太陽光発電所・複数サイト管理に用いる監視・制御システム。発電量・日射量・機器状態（PCS・変圧器等）をリアルタイム収集・可視化し、異常を自動検知してアラート発報、遠隔操作も可能。O&Mの効率化と発電量最大化に貢献する。"
  },
  {
    q: "「ドローン点検」を太陽光発電所の点検に活用する場合の主な用途として正しいものはどれか。",
    choices: ["モジュールの電気特性（I-V特性）の測定", "ケーブルの絶縁抵抗測定", "接続箱内部の目視点検", "赤外線カメラによるモジュールのホットスポット・温度異常の検出"],
    answer: "赤外線カメラによるモジュールのホットスポット・温度異常の検出",
    difficulty: "中級",
    explanation: "ドローンに搭載した赤外線（サーモグラフィー）カメラを使用して、太陽電池モジュールの温度分布を空撮し、ホットスポット・PID劣化・断線・汚れ等による温度異常箇所を効率的に検出できる。人が屋根に上がる必要なく、大規模発電所でも短時間に多数のモジュールを点検できるため普及が進んでいる。"
  },
  {
    q: "太陽光発電用の「コネクタ（MC4等）」に関する注意事項として最も重要なものはどれか。",
    choices: ["異メーカーのコネクタを無断で組み合わせると接触不良・発熱・火災リスクがある", "コネクタの締め付けトルクは種類によらず一定である", "コネクタは使用しないほうが安全", "コネクタは適当に接続すれば問題ない"],
    answer: "異メーカーのコネクタを無断で組み合わせると接触不良・発熱・火災リスクがある",
    difficulty: "中級",
    explanation: "太陽電池モジュールや直流ケーブルには主にMC4型コネクタが使用される。異メーカーのコネクタを組み合わせると外径・接触圧・材質の違いから接触不良・接触抵抗増大・発熱・最終的な火災のリスクが生じる。IEC 62852規格では異なる設計のコネクタの組み合わせに対する要件を規定。必ず同一規格・同一メーカーのペアを使用する。"
  },
  {
    q: "太陽光発電の「開閉器（直流断路器）」が必要な理由として正しいものはどれか。",
    choices: ["発電量を調整するため", "最大電力点を固定するため", "系統の周波数を調整するため", "保守・点検時や緊急時にモジュールアレイとPCSを安全に切り離すため"],
    answer: "保守・点検時や緊急時にモジュールアレイとPCSを安全に切り離すため",
    difficulty: "中級",
    explanation: "直流断路器はモジュールアレイとパワーコンディショナの間に設置し、点検・修理・緊急時にアレイとPCSを切り離す。太陽光発電の直流側は昼間には常時電圧が発生しているため、直流断路器なしではPCSや接続箱への安全なアクセスができない。電気設備技術基準や系統連系規程で設置が求められる。"
  },
  {
    q: "「V2H（Vehicle to Home）」システムで太陽光発電と電気自動車（EV）を組み合わせた場合の利点として正しいものはどれか。",
    choices: ["EVの航続距離が伸びる", "系統連系が不要になる", "EVの大容量バッテリーを家庭用蓄電池として活用し、余剰電力の自家消費率向上・停電対策が可能", "太陽光発電の発電量が増加する"],
    answer: "EVの大容量バッテリーを家庭用蓄電池として活用し、余剰電力の自家消費率向上・停電対策が可能",
    difficulty: "初級",
    explanation: "V2H（Vehicle to Home）システムは電気自動車のバッテリー（通常40〜100kWh）を住宅の電力供給に活用する仕組み。太陽光発電との組み合わせで昼間の余剰電力でEVを充電し、夜間や停電時にEVから住宅へ給電することで自家消費率向上・電力コスト削減・非常用電源確保が可能。"
  },
  {
    q: "太陽電池モジュールの「フロントガラス」の主な仕様として正しいものはどれか。",
    choices: ["強化ガラス（厚さ3〜4mm）で高い透過率と耐衝撃性を持つ", "厚さ約1mmの普通板ガラスを使用する", "プラスチック（アクリル）板を使用する", "ガラスは使用せず透明EVAフィルムのみ"],
    answer: "強化ガラス（厚さ3〜4mm）で高い透過率と耐衝撃性を持つ",
    difficulty: "中級",
    explanation: "太陽電池モジュールのフロントガラスは一般に厚さ3〜4mmの強化ガラス（ひょう・飛来物への耐衝撃性確保）で、低鉄ガラス（白板ガラス）を使用して透過率を高め（約91〜93%）、ARコーティング（反射防止）を施したものが一般的。IEC規格ではひょう打撃試験（直径25mmの氷球を23m/s）への耐性が求められる。"
  },
  {
    q: "太陽光発電用パワーコンディショナの「単独運転防止機能」として、能動的方式の例として正しいものはどれか。",
    choices: ["電流微分値検出方式", "電圧位相跳躍検出方式", "電圧上昇検出方式", "周波数シフト方式（無効電力変動注入等）"],
    answer: "周波数シフト方式（無効電力変動注入等）",
    difficulty: "上級",
    explanation: "単独運転防止の能動的方式は、PCSが積極的に小さな擾乱（周波数シフト・無効電力変動・有効電力変動）を注入してその応答から単独運転を検出する方式。能動型：周波数シフト、無効電力変動注入など。受動型：電圧位相跳躍検出、周波数変化率検出など。能動型は検出精度が高いが高調波・電圧変動をわずかに発生させる。"
  },
  {
    q: "蓄電池システムの「DOD（Depth of Discharge：放電深度）」の説明として正しいものはどれか。",
    choices: ["蓄電池をどれだけ深く放電させるかの割合（満充電に対するパーセンテージ）", "蓄電池の1回の充電に要する時間", "蓄電池の設計容量と実際容量の差", "充電電流の大きさ"],
    answer: "蓄電池をどれだけ深く放電させるかの割合（満充電に対するパーセンテージ）",
    difficulty: "中級",
    explanation: "DOD（放電深度）は満充電容量に対してどれだけ放電したかの比率。DOD80%は満充電の80%を放電した状態。SOCとの関係：SOC＝100%−DOD。一般にDODを低く保つ（浅い放電）ほど蓄電池寿命が延びる。リチウムイオン電池の推奨DODは80〜90%程度が多い。"
  },
  {
    q: "太陽光発電システムの「直流側電気設備」として電気設備技術基準の適用を受ける条件として正しいものはどれか。",
    choices: ["直流電圧が48Vを超える場合", "直流電圧が120Vを超える場合（電気設備技術基準）", "FIT認定を受けた設備すべて", "設置容量が1kW以上の場合"],
    answer: "直流電圧が120Vを超える場合（電気設備技術基準）",
    difficulty: "上級",
    explanation: "電気設備技術基準（電技）では、直流の「低圧」は750V以下、「高圧」は750V超10kV以下と定義されているが、直流回路への電技適用の始まりは対地電圧の概念に基づく。一般に直流120V超（または対地電圧120V超）の電気設備は厳格の規制対象となる。"
  },
  {
    q: "太陽光発電用「蓄電池（据置型）」の設置基準について、消防法上の規定として正しいものはどれか。",
    choices: ["設置後の消防署への報告は不要", "蓄電池は常に屋外設置が義務", "大型の蓄電池設備（300kWh超等）は消防設備の設置・定期点検等が必要", "蓄電池は消防法の規制対象外"],
    answer: "大型の蓄電池設備（300kWh超等）は消防設備の設置・定期点検等が必要",
    difficulty: "上級",
    explanation: "蓄電池設備は消防法の「電気設備」に係る消火設備・警報設備の要件を満たす必要がある。大容量蓄電池（設置場所・容量による）は消防法上の「指定可燃物」や「危険物」に該当する場合があり、消防署への届出、防火措置、消火設備の設置が求められる場合がある。リチウムイオン電池火災への対応として規制が強化されている。"
  },
  {
    q: "太陽光発電モジュールの「IV曲線トレーサー」の用途として正しいものはどれか。",
    choices: ["モジュールの絶縁抵抗を測定する", "日射量を計測する", "モジュールの設置角度を測定する", "実際の設置環境下でI-V特性曲線を計測し、モジュールの性能・劣化を評価する"],
    answer: "実際の設置環境下でI-V特性曲線を計測し、モジュールの性能・劣化を評価する",
    difficulty: "上級",
    explanation: "IV曲線トレーサーはモジュール・ストリングに電子負荷を接続してI-V特性曲線をスイープ計測する機器。Voc・Isc・Vmp・Imp・Pmaxを現地で実測し、仕様値や過去データとの比較により性能低下・劣化の有無を評価する。施工後の引き渡し検査や定期点検で活用される。"
  },
  {
    q: "太陽光発電システムの「接地（アース）」の目的として正しいものはどれか。",
    choices: ["モジュールの温度を下げるため", "感電防止・雷害防止・機器保護のため、導電性部分を大地に接続する", "発電量を増やすため", "系統への逆潮流を防ぐため"],
    answer: "感電防止・雷害防止・機器保護のため、導電性部分を大地に接続する",
    difficulty: "初級",
    explanation: "接地（アース）は電気設備の導電性外部（フレーム・架台・筐体等）と大地を電気的に接続すること。太陽光発電では感電防止（漏電時の異常電圧上昇を抑制）・雷害対策（サージ電流を大地に逃がす）・機器保護（過電圧防止）が主な目的。電気設備技術基準で接地工事の要件が規定されている。"
  },
  {
    q: "太陽光発電システムのO&Mで使用する「サーモグラフィ（熱画像）カメラ」の活用場面として適切なものはどれか。",
    choices: ["絶縁抵抗を測定する", "モジュールの清掃状態を確認する", "ホットスポット・接続部の発熱・劣化箇所の検出", "日射量を測定する"],
    answer: "ホットスポット・接続部の発熱・劣化箇所の検出",
    difficulty: "中級",
    explanation: "サーモグラフィ（熱画像）カメラは赤外線放射量から温度分布を画像化する。太陽光発電システムでは、セルのひびや影によるホットスポット、接続箱内のコネクタ・ヒューズの発熱、パワーコンディショナの熱異常などを目視では見えない温度差として検出できる。ドローン搭載による大規模点検への活用も普及。"
  },
  {
    q: "太陽光発電の「全負荷型蓄電システム」と「特定負荷型蓄電システム」の違いとして正しいものはどれか。",
    choices: ["全負荷型は売電のみ、特定負荷型は自家消費のみ", "違いは接続するPVのパネル枚数のみ", "全負荷型は大容量電池のみで使用し、特定負荷型は小容量電池向け", "全負荷型は家全体に給電でき、特定負荷型は一部の回路のみに給電できる"],
    answer: "全負荷型は家全体に給電でき、特定負荷型は一部の回路のみに給電できる",
    difficulty: "初級",
    explanation: "停電時の運転形態として、全負荷型は住宅の分電盤全体に給電して普段通りに家電・エアコン等が使える（大容量電池が必要）。特定負荷型は事前に設定した特定回路（照明・冷蔵庫・コンセント等）のみに給電する（小容量でも対応可能）。通常時（連系時）は両方式とも電力系統と連携して動作する。"
  },
  {
    q: "太陽光発電のパワーコンディショナ（PCS）の「交流出力側」に設置する主な保護機器として正しいものはどれか。",
    choices: ["漏電遮断器（ELCB）と連系点遮断器", "バイパスダイオード", "逆流防止ダイオード", "直流ヒューズ"],
    answer: "漏電遮断器（ELCB）と連系点遮断器",
    difficulty: "中級",
    explanation: "パワーコンディショナの交流出力側には、漏電遮断器（ELCB：漏電保護）と系統連系点の遮断器（開閉器：系統から切り離す機能）が設置される。逆流防止ダイオードとバイパスダイオードは直流モジュール側に使用。直流ヒューズは接続箱（直流側）に設置。"
  },
  {
    q: "太陽光発電の「ストリングモニタリング機能」の説明として正しいものはどれか。",
    choices: ["各セルの変換効率を個別に測定する", "ストリングの架台温度を計測する", "ストリング全体の映像をカメラで記録する", "ストリングの電圧・電流を個別に計測して異常を検出する"],
    answer: "ストリングの電圧・電流を個別に計測して異常を検出する",
    difficulty: "中級",
    explanation: "ストリングモニタリングは、接続箱やPCS内で各ストリングの電圧・電流を個別に計測して記録・監視する機能。ストリング間の電流値を比較することで、影・地絡・モジュール故障・逆流防止ダイオードの異常などを早期に検出できる。大規模発電所のO&Mでは特に重要な機能。"
  },
  {
    q: "固定価格買取制度（FIT）に関連した「発電量計量」に使用するメーターの種類として正しいものはどれか。",
    choices: ["日射計", "FIT法で認可された取引用計量器（電力量計）", "PCS内蔵の発電量表示", "温度センサー"],
    answer: "FIT法で認可された取引用計量器（電力量計）",
    difficulty: "中級",
    explanation: "FIT売電の精算に使用する計量には、計量法で認定された取引用計量器（電力量計・積算電力量計）を使用しなければならない。精度等級・検定有効期間の管理が必要。PCS内蔵の発電量表示は参考値であり、取引用計量の代替にはならない。スマートメーターが取引用計量器として電力会社から設置される。"
  },
  {
    q: "太陽光発電モジュールの「EVA黄変（黄化）」の説明として正しいものはどれか。",
    choices: ["アルミフレームの酸化", "セルの電極が黄金色に変化する", "モジュールの効率向上につながる変化", "封止材のEVAが紫外線・熱・水分で経年劣化して黄色く変色し、透過率低下を引き起こす現象"],
    answer: "封止材のEVAが紫外線・熱・水分で経年劣化して黄色く変色し、透過率低下を引き起こす現象",
    difficulty: "中級",
    explanation: "EVA黄変はEVA封止材が紫外線・熱・水分の影響で酢酸を生成しながら分解・変色（黄色〜茶色化）する劣化現象。透明度が低下して光透過率が減少し、出力低下につながる。使用するEVA材料の品質・製造時の架橋条件・使用環境によって劣化速度が異なる。高品質EVAまたはPOE封止材で抑制できる。"
  },
  {
    q: "太陽光発電の「接続箱」に設置される「直流ヒューズ（又はサーキットブレーカー）」の目的として正しいものはどれか。",
    choices: ["系統電圧を安定させる", "ストリング短絡・地絡時に過電流からモジュールやケーブルを保護する", "変換効率を向上させる", "逆潮流を防止する"],
    answer: "ストリング短絡・地絡時に過電流からモジュールやケーブルを保護する",
    difficulty: "中級",
    explanation: "接続箱内の直流ヒューズ（または直流用小型サーキットブレーカー）は、ストリングの短絡・地絡が発生した際に大電流が流れてモジュール・ケーブル・他のストリングへ損傷を与えることを防ぐ。直流回路用であり交流用ヒューズとは仕様が異なる（直流は消弧が困難なため直流専用品が必要）。"
  },
  {
    q: "太陽光発電システムの「遠隔監視」の主なメリットとして正しいものはどれか。",
    choices: ["現地に行かなくてもよいため点検が全く不要になる", "遠隔監視システムは大規模発電所にのみ有効", "リアルタイムで発電量・異常を把握し、異常時の迅速な対応・現地点検の効率化が可能", "遠隔操作でモジュールの交換ができる"],
    answer: "リアルタイムで発電量・異常を把握し、異常時の迅速な対応・現地点検の効率化が可能",
    difficulty: "初級",
    explanation: "遠隔監視システムにより、現地に行かなくても発電量・異常アラート・機器状態をリアルタイムで確認できる。異常が発生した際に迅速に検知して対応することで損失を最小化できる。また性能データの蓄積によりO&Mの最適化が可能。ただし遠隔監視で代替できない点検（目視・絶縁測定等）は現地点検が必要。"
  },
  {
    q: "住宅用太陽光発電の「エネルギーマネジメントシステム（HEMS）」の説明として正しいものはどれか。",
    choices: ["太陽光発電設備の製造を管理するシステム", "電力会社の送配電を管理するシステム", "住宅内の電力消費・太陽光発電・蓄電池を統合管理し、エネルギー利用を最適化するシステム", "住宅ローンの返済を管理するシステム"],
    answer: "住宅内の電力消費・太陽光発電・蓄電池を統合管理し、エネルギー利用を最適化するシステム",
    difficulty: "初級",
    explanation: "HEMS（Home Energy Management System）は住宅の電力消費機器（家電・空調等）・太陽光発電・蓄電池・EVなどをネットワークで接続・可視化し、エネルギー消費の最適化（自家消費率向上・電力コスト削減・CO2削減）を図るシステム。ZEH（ネット・ゼロ・エネルギー・ハウス）の要素技術としても重要。"
  },
  {
    q: "太陽光発電モジュールの「出力偏差（±○％）」保証の説明として正しいものはどれか。",
    choices: ["モジュールの変換効率の年間変化率", "FIT買取価格の変動範囲", "STC条件での公称最大出力に対し、メーカーが保証する出荷時の出力偏差範囲", "架台強度の安全係数"],
    answer: "STC条件での公称最大出力に対し、メーカーが保証する出荷時の出力偏差範囲",
    difficulty: "上級",
    explanation: "出力偏差保証は、STC条件で測定した際に公称最大出力に対する偏差（±%）をメーカーが保証するもの。例えば「±3%」の場合、300Wpモジュールは291〜309Wpの範囲内で出荷される保証。近年は「＋0%／−3%」（プラス偏差方向に設計）や「±0〜＋5W」のポジティブ偏差のみの保証も増えている。"
  },
  {
    q: "太陽光発電の「AC結合型蓄電システム」と「DC結合型蓄電システム」の違いとして正しいものはどれか。",
    choices: ["DC結合型は太陽光の直流をそのまま蓄電池に充電でき変換回数が少ない。AC結合型はPCSを介してAC経由で充電", "両者の変換効率は同じ", "AC結合型は屋外設置専用", "AC結合型は太陽光発電専用で蓄電池と組み合わせられない"],
    answer: "DC結合型は太陽光の直流をそのまま蓄電池に充電でき変換回数が少ない。AC結合型はPCSを介してAC経由で充電",
    difficulty: "上級",
    explanation: "DC結合型は太陽電池の直流電力をDC/DCコンバータを通じて直接蓄電池に充電できるため、AC変換を1回で済ませ変換損失が少ない（効率が高い）。AC結合型は既存の太陽光発電PCSの交流出力側に蓄電池用パワコンを接続する方式で、既設システムへの後付けが容易。"
  },
  {
    q: "太陽光発電システムのメンテナンスで「絶縁抵抗試験」を実施する際の注意事項として最も重要なものはどれか。",
    choices: ["絶縁抵抗試験は専門家でなくても誰でも行ってよい", "測定は晴天の昼間に発電中に行う", "太陽光発電の直流側は発電中は電圧がかかるため、安全のため夜間または遮光後に測定する", "絶縁抵抗値は低いほど良い"],
    answer: "太陽光発電の直流側は発電中は電圧がかかるため、安全のため夜間または遮光後に測定する",
    difficulty: "中級",
    explanation: "太陽光発電の直流側（モジュール・ケーブル・接続箱）は昼間は常時電圧が発生している（開放電圧が数百V）。絶縁抵抗試験（メガー測定）の前には、PCSを停止し、日射がある場合はモジュールを遮光するか夜間に実施し、回路に残留電圧がないことを確認してから行う必要がある。感電事故防止のために重要な手順。"
  },
  {
    q: "太陽光発電の「電気工事士」資格が必要な作業として正しいものはどれか。",
    choices: ["発電量データの読み取り", "電気設備（配線・接続箱・PCS等）の電気工事", "モジュールの清掃", "架台の目視点検"],
    answer: "電気設備（配線・接続箱・PCS等）の電気工事",
    difficulty: "初級",
    explanation: "電気工事士法により、電気工事（電気設備の配線・接続・設置等）は第一種または第二種電気工事士が実施しなければならない。具体的には太陽電池モジュールの配線・接続箱への接続・パワーコンディショナの設置・分電盤への接続などの電気工事が対象。モジュール清掃・目視点検・データ読み取りは電気工事に該当しない。"
  },
  {
    q: "太陽光発電の「パワーコンディショナの自動運転・停止機能」の説明として正しいものはどれか。",
    choices: ["系統停電時も自動的に運転を継続する", "日の出後に入力電圧が動作電圧を超えると自動起動し、日没後に停止する自動運転機能を持つ", "年1回の手動操作で年間動作スケジュールを設定する", "手動で毎日起動・停止操作が必要"],
    answer: "日の出後に入力電圧が動作電圧を超えると自動起動し、日没後に停止する自動運転機能を持つ",
    difficulty: "中級",
    explanation: "系統連系パワーコンディショナは日の出後に太陽電池からの入力電力が動作電力以上になると自動的に起動（自動運転開始）し、日没後に入力電力が低下すると自動停止する。系統停電時は安全のため単独運転防止機能により自動停止する（系統復旧後に自動再起動）。毎日の手動操作は不要。"
  },
  {
    q: "太陽電池モジュールの「リード線（出力ケーブル）」に関する注意事項として正しいものはどれか。",
    choices: ["リード線の長さは短いほど変換効率が上がる", "リード線の色は発電量に影響する", "リード線は交流用と直流用で同じ仕様でよい", "リード線を鋭く折り曲げたり踏みつけると断線・絶縁破損のリスクがある"],
    answer: "リード線を鋭く折り曲げたり踏みつけると断線・絶縁破損のリスクがある",
    difficulty: "初級",
    explanation: "モジュールのリード線（出力ケーブル）は柔軟なEVAや架橋ポリエチレン（XLPE）被覆の直流専用ケーブル。鋭い折り曲げ・機械的圧迫・踏みつけなどにより絶縁被覆が損傷し断線・漏電のリスクがある。ケーブルの固定・保護（トレイや固定金具使用）は重要な施工要件。"
  },
  {
    q: "「ハイブリッドパワーコンディショナ（ハイブリッドPCS）」の特徴として正しいものはどれか。",
    choices: ["交流と直流を同時に出力できるPCS", "太陽光発電と蓄電池の両方を1台のPCSで統合制御できるシステム", "複数台のPCSを並列接続したシステム", "太陽光発電のみに対応したPCS"],
    answer: "太陽光発電と蓄電池の両方を1台のPCSで統合制御できるシステム",
    difficulty: "中級",
    explanation: "ハイブリッドパワーコンディショナは太陽光発電（直流入力）と蓄電池（直流充放電）を1台のPCSで統合管理するシステム。太陽光→蓄電池、蓄電池→系統などの電力フローを効率的に制御でき、変換回数（損失）を削減できる。住宅用蓄電システムで普及が進んでいる。"
  },
  {
    q: "太陽光発電モジュールの「モジュール温度係数」はどのような条件で仕様書に記載されているか。",
    choices: ["標準試験条件（STC）を基準に単位℃あたりの変化率（%/℃またはmV/℃）として記載", "最高温度と最低温度の差に対する変化率", "任意の設置環境での実測値", "年間の平均温度変化に対するパーセンテージ"],
    answer: "標準試験条件（STC）を基準に単位℃あたりの変化率（%/℃またはmV/℃）として記載",
    difficulty: "中級",
    explanation: "温度係数はSTC（25℃）を基準として、温度が1℃変化したときのVoc・Isc・Pmaxの変化率（%/℃）として仕様書に記載される。例：Pmax温度係数−0.40%/℃。設計者はこの値と設置地の年間温度条件から温度損失を計算し、発電量シミュレーションの精度を高める。"
  },
  {
    q: "太陽光発電モジュールの「積雪荷重対応」について正しいものはどれか。",
    choices: ["積雪荷重対応は架台のみの問題でモジュールは関係ない", "積雪荷重に対応した強化仕様（メカニカルロード5400Pa等）モジュールを選定する必要がある", "雪の多い地域でも標準モジュールで問題ない", "積雪荷重はモジュールに影響しない"],
    answer: "積雪荷重に対応した強化仕様（メカニカルロード5400Pa等）モジュールを選定する必要がある",
    difficulty: "中級",
    explanation: "積雪地域では、積雪荷重（雪の重さ）によるセルのたわみ・破損を防ぐため、メカニカルロードの強化仕様モジュールを選定する必要がある。IEC 61215では2400Pa（240kgf/㎡相当）の荷重試験が標準だが、豪雪地帯では5400Pa（540kgf/㎡）以上の強化仕様品が推奨される。架台の構造計算も積雪荷重を含めて設計する。"
  },
  {
    q: "太陽光発電の「直流高電圧（1500Vシステム）」の特徴として正しいものはどれか。",
    choices: ["1500Vシステムは日本では禁止されている", "750Vシステムと比べて安全性が高い", "システム電圧を高めることで電流・配線損失を減らし、大規模システムのコストダウンが可能", "直流1500Vは一般住宅用に使用される"],
    answer: "システム電圧を高めることで電流・配線損失を減らし、大規模システムのコストダウンが可能",
    difficulty: "上級",
    explanation: "直流1500Vシステムは大規模メガソーラーで採用が増えている。システム電圧を1000V→1500Vに上げることで、同じ出力に対してケーブル電流が減少（P＝V×I、電圧増加で電流減少）し、配線損失と銅材コストが削減される。また直列接続枚数が増え接続箱・PCSの台数が減る効果もある。1500Vは高圧に相当するため専門的な安全管理が必要。"
  },
  {
    q: "太陽光発電の「オールインワン型（一体型）PCS」の特徴として正しいものはどれか。",
    choices: ["モジュール・架台・PCSをセットにした商品", "太陽電池モジュールとPCSを一体化した製品", "複数の接続箱とPCSを統合したユニット", "接続箱・インバータ・系統連系保護・モニタリングを1筐体に統合した機器"],
    answer: "接続箱・インバータ・系統連系保護・モニタリングを1筐体に統合した機器",
    difficulty: "中級",
    explanation: "オールインワン型（一体型）パワーコンディショナは接続箱機能（逆流防止・MPPT）・インバータ・系統連系保護装置・モニタリング機能などを1筐体に統合した機器。住宅用や小規模産業用で広く使用される。設置スペースの節約・工事の簡略化・費用削減ができる一方、大規模システムには複数台のストリングインバータが適する。"
  },
  {
    q: "太陽電池モジュールの「バックシートのPVF素材」（テドラー）の特徴として正しいものはどれか。",
    choices: ["耐紫外線・耐候性・電気絶縁性に優れた長寿命の材料", "耐候性が低く短寿命", "リサイクルが容易な素材", "透明で光を通す素材"],
    answer: "耐紫外線・耐候性・電気絶縁性に優れた長寿命の材料",
    difficulty: "中級",
    explanation: "PVF（ポリビニルフルオライド、商品名テドラー）はデュポン社が開発したフッ素系高分子材料で、耐紫外線・耐候性・耐化学薬品性・電気絶縁性に優れ、モジュールのバックシートとして25〜30年以上の屋外耐久性を持つ。近年はコスト削減のためPET系バックシートも増加しているが、PVFは長期耐久性の点で優れている。"
  },
  {
    q: "太陽光発電システムの「高圧受変電設備（キュービクル）」が必要となる場合として正しいものはどれか。",
    choices: ["電力系統への高圧連系（6600V等）が必要な大規模システム（50kW以上）", "蓄電池を設置する場合すべて", "モジュールが100枚以上になる場合", "住宅用の4kWシステム"],
    answer: "電力系統への高圧連系（6600V等）が必要な大規模システム（50kW以上）",
    difficulty: "上級",
    explanation: "一般に出力50kW以上の太陽光発電は高圧系統（6600V）への連系となり、高圧受変電設備（キュービクル）の設置が必要。キュービクルには変圧器・断路器・遮断器・保護継電器・計器用変流器等が含まれ、電気主任技術者の選任が必要となる（500kW以上は常駐）。"
  },
  {
    q: "太陽光発電の「BIPVモジュール（建材一体型太陽電池）」の例として適切なものはどれか。",
    choices: ["工場の床に設置する太陽電池", "屋根材・外壁材・窓ガラスなどの建材に太陽電池を組み込んだ製品", "駐車場の屋根に設置する標準的なモジュール", "水面に浮かべる浮体式太陽電池"],
    answer: "屋根材・外壁材・窓ガラスなどの建材に太陽電池を組み込んだ製品",
    difficulty: "初級",
    explanation: "BIPV（Building Integrated Photovoltaics：建材一体型太陽電池）は建物の屋根材（瓦型・鋼板型）・外壁材・窓ガラス（半透明）・外装パネルとして機能する太陽電池。建物の外装と発電機能を両立し、設置面積の有効活用・意匠性・建材コストとの一体化が可能。ZEBの実現に向けて注目されている。"
  }
];

function generateEquipmentQuestions() {
  return EQUIPMENT_SPECS.map((spec) => {
    const choiceExplanations = {};
    choiceExplanations[spec.answer] = { result: "正解", reason: spec.explanation };
    spec.choices.forEach((c) => {
      if (c === spec.answer) return;
      choiceExplanations[c] = { result: "不正解", reason: `正解は「${spec.answer}」。${spec.explanation}` };
    });

    return {
      id: nextQuestionId("e"),
      mode: "knowledge",
      category: "機器・部品の知識",
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
   第4章 施工・設置の知識（製品データに依存しない静的問題）
   出題範囲：電気工事士等の資格区分・防水/防鳥/耐荷重などの施工上の
   配慮・高所作業安全・接地/絶縁試験・法規（消防法/建築基準法/
   農地法/廃棄物処理法）・引渡し書類・O&M/保証まわりの知識。
   ================================================================ */
const CONSTRUCTION_SPECS = [
  {
    q: "住宅屋根への太陽光発電モジュール設置工事において、「第二種電気工事士」の資格が必要な作業として正しいものはどれか。",
    choices: ["架台の設計・計算作業", "屋内配線（分電盤への接続）などの電気工事", "モジュールの架台への固定作業のみ", "モジュールの荷下ろし作業"],
    answer: "屋内配線（分電盤への接続）などの電気工事",
    difficulty: "初級",
    explanation: "電気工事士法により、電気設備の「電気工事」（配線・接続・設置等）は第二種電気工事士以上の資格が必要。具体的にはパワーコンディショナと分電盤の接続、屋内配線工事が該当。一方、モジュールの架台固定・荷下ろしは電気工事に該当しない（ただし安全に関する知識は必要）。"
  },
  {
    q: "太陽光発電モジュールを傾斜屋根に設置する際の「防水処理」で最も重要な箇所として正しいものはどれか。",
    choices: ["ケーブルの外装被覆の保護", "パワーコンディショナの設置台の防水", "モジュールのフレームの塗装", "架台固定ボルトの貫通部（屋根材への穿孔部）のシーリング処理"],
    answer: "架台固定ボルトの貫通部（屋根材への穿孔部）のシーリング処理",
    difficulty: "中級",
    explanation: "傾斜屋根への架台固定では、屋根材に穿孔（ドリル穴）してボルト固定する場合が多い。この穿孔部から雨水が浸入すると雨漏りの原因となる。シーリング材（コーキング）による確実な防水処理が不可欠。フラッシング（防水金具）を使用する工法では防水性能が高い。"
  },
  {
    q: "太陽光発電の施工において「風圧荷重」を考慮した架台設計が重要な理由として正しいものはどれか。",
    choices: ["風圧荷重はモジュールの発電量に影響する", "風圧荷重が大きいほど発電量が増加する", "台風・強風時にモジュールや架台が破損・飛散しないよう構造強度が必要", "風圧荷重は法律で定められた発電量目標"],
    answer: "台風・強風時にモジュールや架台が破損・飛散しないよう構造強度が必要",
    difficulty: "初級",
    explanation: "太陽光発電の架台・モジュールは設置期間中（20〜30年）の台風・強風にも耐える構造強度が必要。建築基準法・JIS C8955（設計用荷重）に基づいて設計地点の地表面粗度区分・基準風速・高さ補正等から設計風圧力を算出し、架台の部材断面・ボルト強度・固定方法を決定する。"
  },
  {
    q: "屋根設置型太陽光発電の施工で「屋根の構造耐力」を確認する目的として正しいものはどれか。",
    choices: ["固定資産税の計算のため", "太陽光発電システムの重量（架台・モジュール）が屋根の許容荷重内であることを確認するため", "電気工事の安全基準を確認するため", "屋根材の色を確認するため"],
    answer: "太陽光発電システムの重量（架台・モジュール）が屋根の許容荷重内であることを確認するため",
    difficulty: "初級",
    explanation: "太陽光発電システム（モジュール：約10〜14kg/㎡、架台）の積載荷重が屋根の許容積載荷重を超えないことを確認する必要がある。特に古い建物や積雪荷重がかかる地域では構造確認が重要。設置前に建物の構造計算書や設計図書で確認するか、構造設計士による検討が必要な場合がある。"
  },
  {
    q: "太陽光発電の施工における「作業安全」として、高所作業での墜落防止措置として正しいものはどれか。",
    choices: ["高所作業は安全帯なしで作業できる高さ制限はない", "1m以上の高所では常に足場の設置が義務付けられている", "屋根作業は天気が良ければ安全対策不要", "2m以上の高所では安全帯（墜落制止用器具）の使用が法律で義務付けられている"],
    answer: "2m以上の高所では安全帯（墜落制止用器具）の使用が法律で義務付けられている",
    difficulty: "中級",
    explanation: "労働安全衛生規則により、高さ2m以上の箇所での作業では墜落防止のために安全帯（フルハーネス型等の墜落制止用器具）の使用・保護帽着用が義務付けられている。太陽光発電の屋根作業は典型的な高所作業であり、適切な安全帯・命綱・作業手順の確立が必須。"
  },
  {
    q: "太陽光発電の施工で「鳥害対策」として一般的に使用される方法はどれか。",
    choices: ["モジュール表面を特殊コーティングする", "架台を高くして鳥を寄せ付けない", "モジュールの色を変える", "モジュール周囲に鳥が巣を作れないよう防鳥ネット・防鳥ピン等を設置する"],
    answer: "モジュール周囲に鳥が巣を作れないよう防鳥ネット・防鳥ピン等を設置する",
    difficulty: "初級",
    explanation: "モジュール下部に鳥（ハト等）が巣を作るとフン・巣材による汚損・火災リスク・モジュール破損のリスクがある。対策としてモジュール周囲フレームに防鳥ネット・防鳥ピン・バードストップ（隙間を塞ぐ部材）を設置する。施工時や定期点検時に確認・取付けを行う。"
  },
  {
    q: "太陽光発電の地上設置型架台の「基礎工事」として一般的に使用される方法として適切でないものはどれか。",
    choices: ["ブロック基礎", "鋼管杭（スクリュー杭）打設", "コンクリート基礎（フーチング・独立基礎）", "木製の台木に重石を置くだけ"],
    answer: "木製の台木に重石を置くだけ",
    difficulty: "中級",
    explanation: "地上設置型の架台基礎には、鋼管杭（スクリュー杭：地盤に直接打込む）、コンクリート基礎（独立基礎・連続基礎）、ブロック基礎（重量で固定）などが使用される。木製台木に重石を置くだけの固定は強度・耐久性が不十分で、台風等での転倒・飛散リスクが高いため不適切。"
  },
  {
    q: "太陽光発電施工時の「感電防止」として、モジュール接続作業中に遵守すべき事項として正しいものはどれか。",
    choices: ["モジュールの接続作業は日中でも電圧が発生しているため、絶縁手袋の着用と接続順序の管理が必要", "感電リスクは接続完了後にのみ生じる", "モジュールは昼間に接続作業してよい", "ケーブルが外れていれば電圧は発生しない"],
    answer: "モジュールの接続作業は日中でも電圧が発生しているため、絶縁手袋の着用と接続順序の管理が必要",
    difficulty: "中級",
    explanation: "太陽電池モジュールは日光が当たると直流電圧が発生するため、昼間の接続作業では必ず絶縁手袋を着用する必要がある。また、接続作業中にコネクタやターミナルから開放電圧（数百V）に触れる危険がある。ストリングを接続する際は、電流が流れないように順序を考慮し（通常、最後の接続は遮光後や夕方が推奨）、慎重に作業する。"
  },
  {
    q: "太陽光発電の施工における「ケーブルの保護」で適切なものはどれか。",
    choices: ["ケーブルは束ねて一緒に固定すれば保護材は不要", "ケーブルは屋外でも保護不要", "ケーブルは架台やモジュールフレームに直接巻き付けて固定する", "ケーブルはダクト・配管・保護管・固定クリップで保護・固定し、鋭利な縁やたわみに触れないようにする"],
    answer: "ケーブルはダクト・配管・保護管・固定クリップで保護・固定し、鋭利な縁やたわみに触れないようにする",
    difficulty: "初級",
    explanation: "PV用ケーブルは屋外の紫外線・熱・機械的ストレスにさらされるため、適切な保護が必要。架台の鋭利なエッジによる被覆損傷を防ぐため保護スリーブやコルゲートチューブを使用し、固定クリップで一定間隔ごとに固定する。ケーブルを架台に巻き付けると絶縁被覆が傷み故障・火災の原因になる。"
  },
  {
    q: "傾斜屋根への太陽光発電設置で、「塗装鋼板屋根（折板屋根）」への取付け工法として特徴的なものはどれか。",
    choices: ["釘打ちによる固定", "穿孔せずに折板の形状（ハゼ）を利用したクランプ固定（ハゼ式）", "アンカーボルトを打ち込んで固定", "モジュールを屋根材に直接接着剤で固定"],
    answer: "穿孔せずに折板の形状（ハゼ）を利用したクランプ固定（ハゼ式）",
    difficulty: "中級",
    explanation: "折板屋根（スタンディングシーム等）への太陽光発電設置では、折板のハゼ（リブ）をクランプで挟んで固定するハゼ式取付け工法が一般的。穿孔が不要なため屋根防水性を損なわず、脱着・修理も容易。スレート・瓦屋根では専用の屋根フック・スタンドをアンカーボルトで固定する工法が多い。"
  },
  {
    q: "「消防法」上、太陽光発電設備（屋根設置）に関係する規制として最も適切なものはどれか。",
    choices: ["住宅用太陽光発電は消防法の規制対象外", "10kW以上の設備には自動火災報知設備が義務", "消防法は太陽光発電に一切関係しない", "屋根面積の大部分をモジュールで覆う場合、消防活動・延焼防止への影響を考慮した設計が求められる"],
    answer: "屋根面積の大部分をモジュールで覆う場合、消防活動・延焼防止への影響を考慮した設計が求められる",
    difficulty: "上級",
    explanation: "消防法上、太陽光発電モジュールが屋根を大きく覆うと消防活動（排煙・屋根からの放水）の障害になる可能性がある。総務省消防庁から太陽光発電設備の設置ガイドラインが示されており、屋根面積に対するモジュール設置割合の考慮、消防活動上の通路（排煙帯）の確保、モジュール裏面の感電リスク情報の共有などが求められている。"
  },
  {
    q: "太陽光発電の「建築確認申請」が必要になる場合として正しいものはどれか。",
    choices: ["設置容量10kW以上は常に必要", "屋根設置では常に不要", "地上設置で独立した工作物として規模（高さ等）が建築確認申請の要件を満たす場合", "FIT申請には必ず建築確認申請が必要"],
    answer: "地上設置で独立した工作物として規模（高さ等）が建築確認申請の要件を満たす場合",
    difficulty: "上級",
    explanation: "建築基準法上、太陽光発電の取扱いは設置形態によって異なる。屋根設置は建物の一部として扱われ通常は建築確認は別途不要（ただし増改築扱いになる場合は検討要）。地上設置型は独立した工作物（構造物）として扱われ、高さ・規模が一定を超えると建築確認申請が必要になる場合がある（例：高さ2mを超える工作物等）。"
  },
  {
    q: "太陽光発電の「屋根への積載荷重」の計算において考慮すべき荷重の組み合わせとして正しいものはどれか。",
    choices: ["地震荷重のみ", "固定荷重（モジュール・架台自重）のみ", "電気的荷重（電流値）のみ", "固定荷重＋風圧荷重＋積雪荷重（地域に応じて）の組み合わせで検討"],
    answer: "固定荷重＋風圧荷重＋積雪荷重（地域に応じて）の組み合わせで検討",
    difficulty: "中級",
    explanation: "屋根の構造設計では複数の荷重を組み合わせて検討する。固定荷重（モジュール・架台・ケーブルの自重）＋積雪荷重（積雪地域）＋風圧荷重（正圧・負圧）を組み合わせた最大荷重に対し、屋根の構造が安全であることを確認する。建築基準法・JIS C 8955に基づいて計算する。"
  },
  {
    q: "太陽光発電システムの施工後の「試運転・引渡し検査」で確認すべき事項として適切でないものはどれか。",
    choices: ["モジュールの発電量の20年保証書の取得", "パワーコンディショナの正常動作確認", "絶縁抵抗試験（各回路の絶縁確認）", "各ストリングの開放電圧・短絡電流の確認"],
    answer: "モジュールの発電量の20年保証書の取得",
    difficulty: "中級",
    explanation: "施工後の試運転検査では、各ストリングのI-V特性確認（Voc・Isc測定）、絶縁抵抗試験、PCSの正常起動・停止・保護動作確認、接地確認、外観検査（モジュール破損・ケーブル状態確認）などを実施する。「20年間の発電量保証書」は施工業者が発行するものではなく、施工検査項目には含まれない（モジュールメーカーの出力保証書は別途）。"
  },
  {
    q: "太陽光発電施工時に「傾斜屋根のスレート（コロニアル）」への設置で特に注意が必要な点として正しいものはどれか。",
    choices: ["スレートは防水性が最高なので穿孔防水処理は不要", "スレートは非常に強度が高く何をしても問題ない", "スレート屋根への設置は法律で禁止されている", "スレートは脆くて割れやすいため、踏み込む位置や荷重のかけ方に注意が必要"],
    answer: "スレートは脆くて割れやすいため、踏み込む位置や荷重のかけ方に注意が必要",
    difficulty: "初級",
    explanation: "スレート（コロニアル）はセメント系薄板材料で脆く、直接踏むと破損する。施工時は踏み台・足場板を使用して荷重を分散し、スレートを直接踏まないよう作業する。また設置年数が古いスレートにはアスベストが含まれている場合があり（1990年代以前）、穿孔作業時の粉塵管理（防塵マスク着用等）が必要。"
  },
  {
    q: "「電気設備の技術基準の解釈」において、太陽電池発電設備の直流側回路に関する要件として正しいものはどれか。",
    choices: ["直流配線は最短距離で接続することが義務", "直流電路には最大電力点追従機能が義務付けられている", "直流電路には接地が不要", "直流電路は対地電圧を規定値以下（住宅用は600V以下、最大対地電圧450V等）に保つ要件がある"],
    answer: "直流電路は対地電圧を規定値以下（住宅用は600V以下、最大対地電圧450V等）に保つ要件がある",
    difficulty: "上級",
    explanation: "電気設備技術基準の解釈では、太陽電池発電設備の直流電路の対地電圧は、住宅の屋内に施設する場合は直流600V以下（最大対地電圧450V以下）等の制限がある。また電路の絶縁・接地・保護装置の要件も規定されており、設計・施工はこれらの基準を満足する必要がある。"
  },
  {
    q: "太陽光発電の「接地工事」の種類として、一般的な低圧機器外箱の接地として正しいものはどれか。",
    choices: ["A種接地工事（接地抵抗10Ω以下）", "C種接地工事（接地抵抗10Ω以下）", "D種接地工事（接地抵抗100Ω以下）", "B種接地工事（変圧器中性点接地）"],
    answer: "D種接地工事（接地抵抗100Ω以下）",
    difficulty: "上級",
    explanation: "低圧（300V以下）機器の金属製外箱・架台等の接地には、D種接地工事（接地抵抗100Ω以下）が原則適用される。PCSや接続箱の外箱はD種接地。C種（10Ω以下）は300V超低圧機器に、A種（10Ω以下）は高圧・特別高圧機器に適用。"
  },
  {
    q: "「フラッシング（防水金具）」を使用した屋根取付け工法の特徴として正しいものはどれか。",
    choices: ["穿孔が必要で完全防水には別途コーキングが必要", "屋根材に穿孔しない工法", "日本では使用されない工法", "屋根材への穿孔部を防水金具で覆い、雨水侵入を確実に防ぐ工法"],
    answer: "屋根材への穿孔部を防水金具で覆い、雨水侵入を確実に防ぐ工法",
    difficulty: "中級",
    explanation: "フラッシング（防水金具）は架台固定のため屋根に穿孔した箇所に設置する金属製防水部材。アルミや鋼製のキャップ状・プレート状で、穿孔部に雨水が入らないよう覆い、シーリング材と組み合わせて確実な防水を実現する。施工精度や使用するシーリング材の品質が防水性能を左右する重要な要素。"
  },
  {
    q: "太陽光発電の「落雷対策」として正しいものはどれか。",
    choices: ["太陽光発電は屋外設置のため落雷対策は不要", "落雷発生後にのみ対策を講じればよい", "モジュールを水平設置にすることで落雷を防げる", "避雷針（外部雷保護）・サージプロテクター（SPD、内部雷保護）の設置と適切な接地工事"],
    answer: "避雷針（外部雷保護）・サージプロテクター（SPD、内部雷保護）の設置と適切な接地工事",
    difficulty: "中級",
    explanation: "落雷対策は外部雷保護（避雷針・避雷導線で直撃雷を大地に安全に流す）と内部雷保護（SPD：サージプロテクターで誘導雷サージから機器を保護）の両方が必要。設置環境のリスク評価に基づき、IEC62305・JIS A4201等の規格に沿って設計する。山頂や開けた場所での設置は特に重要。"
  },
  {
    q: "太陽光発電の施工で「ケーブルの接地側配線（負側）」の色分けとして、日本の慣行として正しいものはどれか。",
    choices: ["白色", "青色または黒色", "赤色", "緑色"],
    answer: "青色または黒色",
    difficulty: "中級",
    explanation: "太陽光発電の直流配線では、正極（プラス側）を赤色、負極（マイナス側）を青色または黒色とする色分けが一般的な慣行。接地側（負側）は青色または黒色が多い。IEC60364（電気設備設計の一般原則）やJPEAガイドラインでも配線色の推奨がある。色分けを統一することで保守・点検時の誤接続防止に役立つ。"
  },
  {
    q: "太陽光発電システムの「定期点検」で実施すべき作業として不適切なものはどれか。",
    choices: ["モジュールの目視点検（破損・汚損確認）", "架台・ボルトの錆・緩みの確認", "太陽電池モジュールの分解・内部点検", "接続箱の外観確認・端子の締め付け確認"],
    answer: "太陽電池モジュールの分解・内部点検",
    difficulty: "初級",
    explanation: "太陽電池モジュールの定期点検では目視による外観確認（セルのひび・変色・デラミネーション・バックシートの劣化等）を行う。モジュールの分解・内部点検は通常の定期点検作業ではなく、特別な理由がある場合の専門的調査。分解すると封止や防水性能が損なわれるため、通常は実施しない。"
  },
  {
    q: "太陽光発電の施工における「アスベスト含有スレート」への対応として正しいものはどれか。",
    choices: ["アスベスト含有の有無に関わらず通常どおり施工する", "アスベスト含有スレートへの穿孔作業では防塵マスク（DS2以上）着用等の飛散防止措置が必要", "アスベスト対策は撤去工事にのみ必要で施工には関係ない", "アスベスト含有屋根へは太陽光発電を設置できない"],
    answer: "アスベスト含有スレートへの穿孔作業では防塵マスク（DS2以上）着用等の飛散防止措置が必要",
    difficulty: "上級",
    explanation: "1990年代以前に施工されたスレートにはアスベスト（石綿）が含まれている可能性がある。穿孔・切断作業でアスベスト繊維が飛散する可能性があるため、石綿障害予防規則に基づき事前調査、防塵マスク（DS2等）着用、飛散防止措置、廃棄物の適正処理が必要。石綿の種類・含有量によっては特定作業への該当もある。"
  },
  {
    q: "太陽光発電の施工で「直流配線の極性確認」を行う目的として正しいものはどれか。",
    choices: ["発電量を最大化するため", "系統連系の手続きに必要な書類を作成するため", "直流の逆接続によるダイオード破損・機器損傷・火災を防止するため", "モジュールの傾斜角を正確に測定するため"],
    answer: "直流の逆接続によるダイオード破損・機器損傷・火災を防止するため",
    difficulty: "中級",
    explanation: "直流回路では正負の極性（プラス・マイナス）が決まっており、逆接続すると逆流防止ダイオードの破損・接続箱や機器の損傷・最悪の場合は火災が発生する可能性がある。施工時にはテスターで極性を確認してから接続し、コネクタの形状（オス・メス）も確認する。色分けと極性表示の一貫した管理が重要。"
  },
  {
    q: "太陽光発電の「屋根設置型」で「南向き・傾斜角30°」の屋根に設置する場合の施工上の注意点として適切なものはどれか。",
    choices: ["傾斜角30°は発電に最適なので特別な考慮は不要", "傾斜角30°での施工は作業姿勢・荷重・足場計画を十分検討し、安全に配慮する", "30°傾斜では架台は不要", "30°以上の傾斜ではモジュール設置できない"],
    answer: "傾斜角30°での施工は作業姿勢・荷重・足場計画を十分検討し、安全に配慮する",
    difficulty: "初級",
    explanation: "傾斜角30°の屋根作業は一般的な住宅屋根で最も多い施工条件だが、作業者が傾斜面に立つためバランスを取りにくく転落リスクがある。施工前に足場・安全帯・踏み台の計画を十分検討し、滑り止めの付いた靴の着用、二人以上での作業、安全帯の使用が必要。モジュールを持ちながらの高所移動は特に危険。"
  },
  {
    q: "太陽光発電の施工における「架台の溶融亜鉛メッキ鋼材」の特徴と注意事項として正しいものはどれか。",
    choices: ["軽量なのでアルミニウムより施工が容易", "一般に高い耐食性を持つが、海塩粒子の多い沿岸部では腐食が進みやすくステンレスや樹脂コーティング品が推奨される場合がある", "電気を通さないため接地が不要", "耐食性が高く海岸近くでも追加対策不要"],
    answer: "一般に高い耐食性を持つが、海塩粒子の多い沿岸部では腐食が進みやすくステンレスや樹脂コーティング品が推奨される場合がある",
    difficulty: "中級",
    explanation: "溶融亜鉛メッキは表面に亜鉛層を形成し耐食性を付与するが、海岸近くや工業地帯等の腐食環境では亜鉛層が早く消費されて錆が発生する場合がある。海塩粒子が多い沿岸部（海岸から500m以内等）ではステンレス鋼材・アルミ合金・樹脂コーティング材を選定するか、定期的な腐食点検が必要。"
  },
  {
    q: "太陽光発電の施工における「モジュールの搬入・揚重」で適切な方法として正しいものはどれか。",
    choices: ["モジュールは縦置き・横置きどちらでも同じリスク", "モジュールは上から踏んで搬送コストを下げてよい", "モジュールは一人で複数枚まとめて運んでも問題ない", "モジュールは搬入時に端部を持って運び、表面・裏面に荷重をかけないようにする"],
    answer: "モジュールは搬入時に端部を持って運び、表面・裏面に荷重をかけないようにする",
    difficulty: "初級",
    explanation: "太陽電池モジュールは端部フレームを持って搬送し、ガラス面や裏面に不均一な荷重をかけないようにする。積み重ねは仕様の枚数以内で、表面（ガラス）を上向きにする。運搬中の振動・衝撃（ハンドリングダメージ）によるセルのひびは目視では発見困難なため、取り扱いに注意が必要。"
  },
  {
    q: "太陽光発電の「陸屋根（コンクリート）」への設置で重要な施工事項として正しいものはどれか。",
    choices: ["コンクリートに穿孔して架台アンカーを打ち込む際の防水処理", "コンクリートは完全防水なので追加の防水処理は不要", "陸屋根へのモジュール設置は法律で禁止されている", "コンクリート屋根への設置はDIYで可能"],
    answer: "コンクリートに穿孔して架台アンカーを打ち込む際の防水処理",
    difficulty: "中級",
    explanation: "コンクリート陸屋根への架台設置ではアンカーボルト（ケミカルアンカーや打ち込みアンカー）を使用するが、穿孔部から雨水が浸入するとコンクリートへの影響（凍害・鉄筋腐食）が生じる。十分なシーリング・防水処理（ウレタン防水等）が必要。重量物設置のため建物の荷重制限も確認する。"
  },
  {
    q: "太陽光発電の施工で「竣工図書（完成図書）」に含めるべき書類として適切でないものはどれか。",
    choices: ["架台図・基礎図", "担当工事業者の個人所得証明", "電気工事の系統図・配線図", "機器仕様書・カタログ"],
    answer: "担当工事業者の個人所得証明",
    difficulty: "初級",
    explanation: "竣工図書（完成図書）には電気系統図・配線図、架台・基礎の施工図、機器仕様書・カタログ、試験成績書（絶縁抵抗・絶縁耐力試験）、FIT認定書・電力会社との連系承認書、保証書などが含まれる。工事業者の個人所得証明は竣工図書とは無関係。"
  },
  {
    q: "太陽光発電の「フェールセーフ設計」の説明として正しいものはどれか。",
    choices: ["故障が発生した場合でも安全側に動作するよう設計すること", "失敗しないよう施工精度を高めること", "故障しにくい高品質機器のみを使用すること", "保険に加入してリスクを回避すること"],
    answer: "故障が発生した場合でも安全側に動作するよう設計すること",
    difficulty: "中級",
    explanation: "フェールセーフ（Fail-safe）設計は、システムに故障や誤動作が発生した場合でも危険状態にならず安全側（停止・安全方向）に働くよう設計する思想。太陽光発電では系統停電時のPCS自動停止、地絡・過電流時の保護装置動作などがフェールセーフの例。単独運転防止機能も重要なフェールセーフ設計の一つ。"
  },
  {
    q: "太陽光発電の「施工ミス（不適切な施工）」による事故として報告されているものとして適切なものはどれか。",
    choices: ["架台の過剰強化による倒壊", "施工ミスによる事故は報告されていない", "モジュールの設置枚数超過による過発電", "ケーブルの施工不良（接続不良・被覆損傷）による発熱・火災"],
    answer: "ケーブルの施工不良（接続不良・被覆損傷）による発熱・火災",
    difficulty: "初級",
    explanation: "太陽光発電の事故原因の一つとして施工不良（ケーブルの接続不良・接触抵抗増大による発熱、被覆損傷による短絡・地絡、コネクタの不完全嵌合など）が挙げられる。特に接続箱・コネクタ部での発熱・火災事例が報告されている。適切な施工とその後の施工確認（試験）が重要。"
  },
  {
    q: "「JIS C 8955」は太陽光発電のどの設計に関連する規格か。",
    choices: ["モジュールの電気性能試験", "FIT認定の申請手続き", "系統連系パワーコンディショナの試験", "太陽電池アレイ用支持物の設計用荷重（風圧・積雪・固定荷重）"],
    answer: "太陽電池アレイ用支持物の設計用荷重（風圧・積雪・固定荷重）",
    difficulty: "上級",
    explanation: "JIS C 8955「太陽電池アレイ用支持物の設計用荷重及び設計方法」は架台（支持物）の設計荷重（固定荷重・積雪荷重・風圧荷重・地震荷重等）の算定方法を規定する規格。架台設計において適切な荷重を算定し構造強度を確保するための基準として活用される。"
  },
  {
    q: "太陽光発電の施工における「電気の試験」として実施する「接地抵抗試験」の目的として正しいものはどれか。",
    choices: ["各ストリングの開放電圧を確認する", "ケーブルの断面積を確認する", "PCSの変換効率を測定する", "接地電極の接地抵抗が規定値（種別に応じた基準値）以内であることを確認する"],
    answer: "接地電極の接地抵抗が規定値（種別に応じた基準値）以内であることを確認する",
    difficulty: "中級",
    explanation: "接地抵抗試験は、施工した接地極（接地電極）の接地抵抗を測定し、電気設備技術基準で規定された種別ごとの基準値（D種：100Ω以下等）を満たしていることを確認する試験。工事完了後の引渡し検査の必須項目。接地抵抗計（アース・テスター）を使用して3極法で測定する。"
  },
  {
    q: "太陽光発電の「有資格工事業者」制度として「JPEA-PV施工技術者」の役割として正しいものはどれか。",
    choices: ["太陽光発電施工の技術・品質向上を目的とし、適切な施工が可能な技術者を認定・教育する制度", "モジュールの品質検査", "電力会社との系統連系交渉", "FIT申請の窓口業務"],
    answer: "太陽光発電施工の技術・品質向上を目的とし、適切な施工が可能な技術者を認定・教育する制度",
    difficulty: "中級",
    explanation: "JPEA（太陽光発電協会）が認定・管理するPV施工技術者（JPEAパートナーシップ）は、太陽光発電設備の適切な施工技術の普及を目的とした技術者認定制度。施工の品質・安全性確保のため、電気・建築・機械の知識と実技を習得した施工者を認定する。消費者が施工業者を選ぶ際の目安にもなる。"
  },
  {
    q: "太陽光発電の「屋根一体型（屋根材型）」モジュールの特徴として正しいものはどれか。",
    choices: ["太陽電池が屋根材自体の機能を持ち、別途屋根材が不要", "通常の屋根材を撤去せず上から設置する", "既存屋根の上に乗せる架台設置型の一種", "メンテナンスが全く不要"],
    answer: "太陽電池が屋根材自体の機能を持ち、別途屋根材が不要",
    difficulty: "中級",
    explanation: "屋根材型（ルーフタイル型、シングル型等）の太陽電池モジュールは、屋根材としての防水・断熱機能と発電機能を兼ね備えた製品。別途屋根材が不要で意匠性が高く、建物本体の建設・リフォーム時に一体施工できる。既存屋根材を撤去して設置するか、新築時に採用する形態。架台が不要な分軽量。"
  },
  {
    q: "太陽光発電の「スクリュー杭基礎」の特徴として正しいものはどれか。",
    choices: ["回転圧入工法で施工が比較的簡単・速く、撤去も容易で環境影響が小さい", "地上設置型には使用できない", "軟弱地盤には全く適さない", "打設に騒音・振動が大きくコンクリートが必要"],
    answer: "回転圧入工法で施工が比較的簡単・速く、撤去も容易で環境影響が小さい",
    difficulty: "中級",
    explanation: "スクリュー杭（ネジ式鋼管杭）は地盤にスクリュー（螺旋翼）を回転させながら圧入する工法。振動・騒音が少なく、コンクリートが不要で工期が短縮できる。撤去も容易で原状回復が求められる農地・借地での活用も多い。ただし地盤条件（支持力・N値）を確認し、軟弱地盤では設計に注意が必要。"
  },
  {
    q: "太陽光発電施工時の「作業者の熱中症対策」として正しいものはどれか。",
    choices: ["屋根上や開放環境での夏場の施工では水分・塩分補給、休憩、WBGT（湿球黒球温度）管理が重要", "晴天でも屋外作業では熱中症リスクは低い", "電気工事士資格があれば熱中症対策は不要", "熱中症対策はモジュール設置後のみ必要"],
    answer: "屋根上や開放環境での夏場の施工では水分・塩分補給、休憩、WBGT（湿球黒球温度）管理が重要",
    difficulty: "初級",
    explanation: "太陽光発電の屋根施工は夏場の高温・直射日光・熱輻射の三重苦の環境。屋根面の表面温度は60〜80℃に達することもある。労働安全衛生のためのWBGT（暑さ指数）管理、こまめな水分・塩分補給、冷却ベスト使用、高WBGT時の作業中断・交替、熱中症症状への迅速対応が求められる。"
  },
  {
    q: "「電気設備に関する技術基準を定める省令（電技省令）」で規定される「感電保護」として正しいものはどれか。",
    choices: ["接触可能な電気設備に対し適切な絶縁・外部保護を施すことが求められる", "電気設備の感電保護規定は太陽光発電には適用されない", "感電保護はモジュールメーカーの責任のみ", "感電保護は工事業者の任意対策"],
    answer: "接触可能な電気設備に対し適切な絶縁・外部保護を施すことが求められる",
    difficulty: "上級",
    explanation: "電技省令（電気設備に関する技術基準を定める省令）では電気設備は感電・電気火災・障害が生じないよう施設することを基本的な安全要件として規定している。太陽光発電を含むすべての電気設備に適用され、充電部の保護（絶縁・外囲・防護）、接地・保護装置の設置などが求められる。"
  },
  {
    q: "太陽光発電の「長期性能保証」（メーカー保証）の一般的な内容として正しいものはどれか。",
    choices: ["電力会社がFIT期間中の買取価格を保証する", "モジュールメーカーが一定期間（10〜12年）の製品保証と25年間の出力保証（公称最大出力の80〜83%以上）を提供", "政府が20年間の発電量を保証する", "施工業者が25年間の発電量を保証する"],
    answer: "モジュールメーカーが一定期間（10〜12年）の製品保証と25年間の出力保証（公称最大出力の80〜83%以上）を提供",
    difficulty: "中級",
    explanation: "大手モジュールメーカーは一般的に、製品保証（10〜12年間の材料欠陥・製造不良への対応）と性能保証（25〜30年間の出力保証・年間劣化率を担保し、25年後に公称最大出力の80〜83%以上を保証）を提供。施工業者の工事保証（1〜2年等）とは別物。"
  },
  {
    q: "太陽光発電の「施工不良による保証免責」について正しいものはどれか。",
    choices: ["施工不良による損害は電力会社が補償する", "施工不良（不適切な設置・改造等）による損傷・不具合はメーカー保証が免責となる場合が多い", "施工不良はFIT制度でカバーされる", "施工不良でも常にメーカー保証が適用される"],
    answer: "施工不良（不適切な設置・改造等）による損傷・不具合はメーカー保証が免責となる場合が多い",
    difficulty: "中級",
    explanation: "モジュールメーカーの保証は適切な施工・使用条件のもとでの欠陥に対するもの。不適切な施工（指定外の固定方法・過積載・改造・不適切な電圧設定等）による損傷は保証対象外（免責）となる場合が多い。施工業者は適切な施工を行う義務があり、施工起因の損害は施工業者が責任を持つ。"
  },
  {
    q: "太陽光発電の「施工後の系統連系申請（電力会社への申込み）」について正しいものはどれか。",
    choices: ["系統連系申請は電力会社ではなくJPEAに行う", "FIT認定があれば系統連系申請は不要", "系統連系申請は設備設置後にのみ行う", "系統連系申請は設備設置前に行う必要がある"],
    answer: "系統連系申請は設備設置前に行う必要がある",
    difficulty: "中級",
    explanation: "系統連系申請（電力会社への連系申込み）は設備設置工事を開始する前に行い、電力会社の技術検討・承認を得てから施工することが正しい手順。設置前に連系技術要件・工期・費用を確認する。施工後に連系申請すると連系工事の変更が必要になる場合がある。FIT認定と系統連系申請は別の手続き。"
  },
  {
    q: "太陽光発電の施工で「モジュールの短辺方向への取付け」（横置き）と「長辺方向への取付け」（縦置き）の違いとして実務上重要なものはどれか。",
    choices: ["横置きは法律で禁止されている", "縦置きは発電効率が2倍になる", "発電量が大きく異なる", "架台（縦桟・横桟）の設計と荷重分散が異なるため、取付方向によって架台仕様を変える必要がある"],
    answer: "架台（縦桟・横桟）の設計と荷重分散が異なるため、取付方向によって架台仕様を変える必要がある",
    difficulty: "中級",
    explanation: "モジュールを縦置き（縦桟に沿った方向）と横置き（横桟に沿った方向）で取り付ける場合、荷重のかかり方・架台部材のスパン・取付点間隔が変わる。発電量自体に大きな差はないが、架台設計（桟のピッチ・断面・ボルト配置）を取付方向に合わせて設計する必要がある。"
  },
  {
    q: "太陽光発電の「O&Mマニュアル」に記載すべき内容として適切でないものはどれか。",
    choices: ["故障診断の手順・修理依頼先", "緊急停止の手順・連絡先", "定期点検の周期・点検項目・手順", "競合他社の設備仕様との比較"],
    answer: "競合他社の設備仕様との比較",
    difficulty: "初級",
    explanation: "O&Mマニュアルには、定期点検の頻度・手順・確認項目、緊急時（火災・感電・故障）の対応手順と緊急連絡先、故障診断・対処の手順、修理・交換の依頼先（メーカー・施工業者等）、運転データの管理方法などが記載される。競合他社との比較は保守運用に関係なく不要な内容。"
  },
  {
    q: "太陽光発電の施工業者が顧客に引き渡す際に必要な「引渡し書類」として重要でないものはどれか。",
    choices: ["施工担当者の趣味プロフィール", "竣工図（系統図・設置図）", "保証書（施工保証・メーカー保証）", "操作・取扱説明書"],
    answer: "施工担当者の趣味プロフィール",
    difficulty: "初級",
    explanation: "引渡し書類には保証書（施工保証・機器保証）、竣工図（系統図・配線図・設置図）、機器取扱説明書、試験・検査成績書、系統連系承認書（電力会社）、FIT認定書（必要な場合）等が含まれる。担当者の個人的プロフィールは引渡し書類には含まれない。"
  },
  {
    q: "「農地への太陽光発電（農地転用）」に必要な手続きとして正しいものはどれか。",
    choices: ["農業委員会への農地転用許可申請（農地法に基づく）が必要", "農地は電力会社の許可のみで設置可能", "農地への太陽光発電設置は全国一律禁止", "農地への設置は無手続きで可能"],
    answer: "農業委員会への農地転用許可申請（農地法に基づく）が必要",
    difficulty: "上級",
    explanation: "農地に太陽光発電を設置する場合、農地法に基づく農地転用許可（4ha以下は農業委員会、4ha超は農林水産大臣）が必要。ただし農業と太陽光発電を共存させる「営農型太陽光発電（ソーラーシェアリング）」では、一時転用許可制度を活用して農地上部に太陽電池を設置しながら農業を継続することが可能。"
  },
  {
    q: "太陽光発電の施工における「モジュールのアース（接地）工事」の一般的方法として正しいものはどれか。",
    choices: ["モジュールのアース工事は不要", "モジュールフレーム→架台→接地線（緑/黄）→接地極の順に接続し、電気的な連続性を確保する", "各モジュールから個別に接地線を大地まで配線する", "アース工事はパワーコンディショナのみに行う"],
    answer: "モジュールフレーム→架台→接地線（緑/黄）→接地極の順に接続し、電気的な連続性を確保する",
    difficulty: "中級",
    explanation: "モジュールのアース工事では、各モジュールのアルミフレームを架台に電気的に接続（ボルト固定等で金属接触）し、架台から接地線（黄緑色）を通じて接地極（アース棒）に接続する。モジュール→架台→接地極の経路での電気的連続性（導通）が確保されていることをテスターで確認する。"
  },
  {
    q: "太陽光発電システムの「自立運転機能」の説明として正しいものはどれか。",
    choices: ["停電時でも電力系統に送電できる機能", "電力会社の許可なしに発電できる機能", "停電時に系統から切り離して太陽光発電で特定のコンセント（100V交流）に限定的に給電できる機能", "昼夜問わず発電できる機能"],
    answer: "停電時に系統から切り離して太陽光発電で特定のコンセント（100V交流）に限定的に給電できる機能",
    difficulty: "中級",
    explanation: "自立運転機能は、系統停電時にパワーコンディショナが系統から切り離され、太陽光発電電力を特定の自立運転用コンセント（通常100V・1500Wまで等の制限あり）に供給する機能。昼間の晴天時のみ使用可能。携帯電話の充電・照明・小型家電が使用可能で、非常時の電源として重要。"
  },
  {
    q: "太陽光発電の「設備認定番号」の役割として正しいものはどれか。",
    choices: ["モジュールのシリアル番号", "FIT制度の認定を受けた際に付与される固有番号で、売電契約・補助金申請等に使用", "電気工事士の資格番号", "電力会社の申し込み受付番号"],
    answer: "FIT制度の認定を受けた際に付与される固有番号で、売電契約・補助金申請等に使用",
    difficulty: "中級",
    explanation: "設備認定番号はFIT制度（再エネ特措法）で設備認定を受けた際に資源エネルギー庁から付与される固有の識別番号。電力会社との売電契約・系統連系手続・補助金申請等で使用する。認定に際しては設備仕様・設置場所等の情報が審査される。2017年以降は認定制度から「事業計画認定」に移行。"
  },
  {
    q: "太陽光発電の「消防活動排煙帯（消防活動上の通路）」の目的として正しいものはどれか。",
    choices: ["施工業者が移動するための通路", "火災時の消防活動のため、屋根面のモジュール設置エリアに一定幅の空きスペースを確保する", "雨水を排水するための経路", "モジュールの発電効率を高めるための空気の流れを確保する"],
    answer: "火災時の消防活動のため、屋根面のモジュール設置エリアに一定幅の空きスペースを確保する",
    difficulty: "上級",
    explanation: "消防活動排煙帯は建物が火災になった際、消防士が排煙・消火活動のために屋根に上がれるよう屋根面上にモジュール未設置のスペース（通路）を確保するもの。消防庁の太陽光発電設備の設置に係る消防活動上の問題・取扱いガイドラインでは、屋根棟から敷地境界までの排煙帯（幅50cm以上等）確保を推奨している。"
  },
  {
    q: "太陽光発電の「施工後検査」における「絶縁耐力試験（耐電圧試験）」の目的として正しいものはどれか。",
    choices: ["PCSの変換効率を確認する試験", "電路の絶縁が規定の試験電圧に耐えられることを確認する試験", "発電量を確認するための試験", "架台の強度を確認する試験"],
    answer: "電路の絶縁が規定の試験電圧に耐えられることを確認する試験",
    difficulty: "中級",
    explanation: "絶縁耐力試験（耐電圧試験）は電路の絶縁体に最大使用電圧の1.5倍（または規定の試験電圧）の電圧を一定時間（10分間等）印加し、絶縁破壊・フラッシオーバーが生じないことを確認する試験。太陽光発電の直流側高電圧回路の絶縁品質確認に使用される重要な施工後検査。"
  },
  {
    q: "太陽光発電の「地上設置型」における「越境日陰問題」への対応として正しいものはどれか。",
    choices: ["日陰は太陽光の所有者に帰属するので問題ない", "近隣への日陰影響に配慮した設計・事前説明が必要で、民法上の日照権・景観に関わるトラブルに発展することがある", "日陰が越境しても法的な問題はない", "越境日陰は電力会社が解決する"],
    answer: "近隣への日陰影響に配慮した設計・事前説明が必要で、民法上の日照権・景観に関わるトラブルに発展することがある",
    difficulty: "中級",
    explanation: "地上設置型太陽光発電（特に大規模）では、架台・パネルが近隣の農地・住宅・施設に日陰を落とす「越境日陰」が問題になることがある。民法や景観条例に基づくトラブルに発展するケースもある。事前に近隣への影響調査・説明・同意取得が重要。設計段階でシミュレーションにより影響範囲を確認する。"
  },
  {
    q: "太陽光発電の「屋根設置」で「瓦屋根」への施工時の注意点として正しいものはどれか。",
    choices: ["瓦は全て撤去してから設置する", "瓦の種類（日本瓦・洋瓦等）に対応した専用の取付け金具を使用し、瓦を破損させないよう慎重に作業する", "瓦屋根への設置は工事費に違いはない", "瓦屋根は強固なので特別な配慮は不要"],
    answer: "瓦の種類（日本瓦・洋瓦等）に対応した専用の取付け金具を使用し、瓦を破損させないよう慎重に作業する",
    difficulty: "初級",
    explanation: "瓦屋根（日本瓦・洋瓦・S瓦等）は形状が複雑で割れやすいため、瓦の形状に合わせた専用取付け金具（屋根フック・固定金具）を使用し、瓦を破損させないよう慎重に作業する。また取付け後の防水確認が重要。瓦の重量と積載したモジュール・架台の重量の合計を構造確認する。"
  },
  {
    q: "太陽光発電施工後の「試験・検査」として「絶縁抵抗測定」の規定値として電気設備技術基準解釈で正しいものはどれか（低圧電路・対地電圧150V以下の場合）。",
    choices: ["規定なし", "0.1MΩ以上", "10MΩ以上", "0.1MΩ以上（MCCB二次側、対地電圧150V以下）"],
    answer: "0.1MΩ以上（MCCB二次側、対地電圧150V以下）",
    difficulty: "上級",
    explanation: "電気設備技術基準の解釈では、低圧電路の使用電圧区分に応じた絶縁抵抗の最低値が定められている。対地電圧150V以下（単相2線100V等）の低圧電路では0.1MΩ以上が規定値。対地電圧150V超300V以下では0.2MΩ以上。太陽光発電のPCS交流側の検査に使用する基準値。"
  },
  {
    q: "太陽光発電の「ストリング電流確認」で使用する計器として正しいものはどれか。",
    choices: ["絶縁抵抗計（メガー）", "回転計", "温度計", "クランプメーター（電流クランプ）またはデジタルマルチメーター"],
    answer: "クランプメーター（電流クランプ）またはデジタルマルチメーター",
    difficulty: "中級",
    explanation: "ストリングの発電電流の確認にはクランプメーター（非接触でケーブルを挟んで電流測定）またはデジタルマルチメーター（電流測定レンジ）が使用される。各ストリングの電流値を比較して異常なストリング（電流が著しく低い等）を発見できる。絶縁抵抗計は絶縁性能確認用で電流測定には使用しない。"
  },
  {
    q: "「再生可能エネルギー発電設備廃棄費用の積立て」制度（FIT法改正）の目的として正しいものはどれか。",
    choices: ["パワーコンディショナの定期交換費用を積み立てるため", "売電収入の一部を積み立てる義務", "施工工事費を積み立てるため", "FIT期間終了後の太陽光発電設備の適正廃棄を確保するため、事業者が廃棄費用を積み立てる義務"],
    answer: "FIT期間終了後の太陽光発電設備の適正廃棄を確保するため、事業者が廃棄費用を積み立てる義務",
    difficulty: "上級",
    explanation: "FIT法（再エネ特措法）の改正により、一定規模以上の太陽光発電事業者に対して設備廃棄費用の積立て義務が課された（2022年施行）。FIT・FIP期間終了後に大量廃棄が見込まれる太陽電池モジュール・架台等の産業廃棄物を適正に処理するための費用を確保することが目的。"
  },
  {
    q: "太陽光発電の施工管理における「品質管理」として重要な事項はどれか。",
    choices: ["施工担当者の年齢管理", "施工業者の売上管理", "施工手順書・仕様書に基づいた工程管理・材料確認・検査記録の作成", "施工コストの最小化のみ"],
    answer: "施工手順書・仕様書に基づいた工程管理・材料確認・検査記録の作成",
    difficulty: "初級",
    explanation: "施工品質管理では、施工手順書・仕様書（設計図書）に基づいて各工程を管理し、使用材料の仕様確認（メーカー・型式・数量）、施工状態の検査・確認、検査結果の記録・保管を行う。品質記録は引渡し時の竣工図書に含めるとともに、保証対応・トラブル発生時の証拠書類としても重要。"
  },
  {
    q: "太陽光発電の「雷保護システム」における「等電位ボンディング」の目的として正しいものはどれか。",
    choices: ["避雷針の代わりとなる機能", "系統連系のための電圧調整", "雷電流を吸収してエネルギーを発電に利用する", "建物・設備の金属部を共通接地に接続し、雷サージによる電位差を小さくして機器損傷を防ぐ"],
    answer: "建物・設備の金属部を共通接地に接続し、雷サージによる電位差を小さくして機器損傷を防ぐ",
    difficulty: "上級",
    explanation: "等電位ボンディングは建物・太陽光発電設備の金属部分（架台・フレーム・PCS筐体・電気配管等）をすべて共通の接地電位に結び付ける措置。雷サージが侵入した際に各部の電位差（電位差が大きいと機器間で絶縁破壊・電流が流れる）を最小化し、機器損傷・火災を防ぐ。IEC 62305の内部雷保護の重要な手法。"
  },
  {
    q: "太陽光発電の「浮体式（フローティング）太陽光発電」の特徴として正しいものはどれか。",
    choices: ["浮体式は日本では実用化されていない", "陸上設置より変換効率が大幅に低い", "海水面にのみ設置できる", "農業用ため池・ダム・貯水池の水面を活用でき、水の蒸発抑制・水温上昇抑制効果もある"],
    answer: "農業用ため池・ダム・貯水池の水面を活用でき、水の蒸発抑制・水温上昇抑制効果もある",
    difficulty: "初級",
    explanation: "浮体式太陽光発電（フローティングソーラー）は農業用ため池・ダム・産業用調整池などの水面にモジュールを浮かべて設置する方式。土地の有効活用、水面冷却によるモジュール温度低下（発電量向上）、水の蒸発抑制・藻類繁殖抑制などのメリットがある。日本でも2012年頃から普及が始まり、ため池活用が多い。"
  },
  {
    q: "太陽光発電の「自家消費型太陽光発電の余剰電力」の取り扱いとして正しいものはどれか。",
    choices: ["余剰電力は必ず全量廃棄しなければならない", "余剰電力は蓄電池に充電するか、FIT/FIP制度等により電力会社に売電することができる", "余剰電力はPCSが自動的に蓄熱設備に変換する", "余剰電力の発生は違法"],
    answer: "余剰電力は蓄電池に充電するか、FIT/FIP制度等により電力会社に売電することができる",
    difficulty: "初級",
    explanation: "自家消費後の余剰電力は、蓄電池に充電して後で使う（自家消費率向上）か、FIT・FIP制度で電力会社に売電するかを選択できる。売電の場合は電力会社との売電契約・スマートメーターの設置が必要。余剰電力を無駄にせず活用する方が経済性が高くなる。"
  },
  {
    q: "太陽光発電施工における「ケーブルラック・電線管」の使用が推奨される場面として正しいものはどれか。",
    choices: ["パワーコンディショナ内部配線のみに使用", "屋内（屋根裏・天井裏等）を通過する直流ケーブルの保護", "交流ケーブルのみに使用", "屋外のケーブルのみに使用する"],
    answer: "屋内（屋根裏・天井裏等）を通過する直流ケーブルの保護",
    difficulty: "中級",
    explanation: "直流ケーブルが屋内（天井裏・壁内・屋根裏）を通過する場合、電気設備技術基準の要件を満たすためケーブルラック・金属電線管・合成樹脂電線管等を使用して保護・固定することが求められる（直流電路の屋内配線規制）。屋外では露出配線も可能だが適切な支持・保護が必要。"
  },
  {
    q: "太陽光発電の「産業廃棄物（廃棄モジュール）」の適正処理について正しいものはどれか。",
    choices: ["廃棄モジュールは産業廃棄物として許可を持つ業者に委託して適正に処理・リサイクルする必要がある", "太陽電池廃棄物は環境汚染リスクがないので規制されていない", "廃棄モジュールは自由に土地に埋設できる", "廃棄モジュールは一般ごみとして廃棄できる"],
    answer: "廃棄モジュールは産業廃棄物として許可を持つ業者に委託して適正に処理・リサイクルする必要がある",
    difficulty: "初級",
    explanation: "使用済み太陽電池モジュールは廃棄物処理法（廃棄物の処理及び清掃に関する法律）上の産業廃棄物（「廃プラスチック類」「金属くず」「ガラスくず」等）に該当し、産業廃棄物収集運搬・処分業の許可を持つ業者に委託して適正処理が必要。JPEA等が太陽電池リサイクルシステムの整備を進めている。"
  }
];

function generateConstructionQuestions() {
  return CONSTRUCTION_SPECS.map((spec) => {
    const choiceExplanations = {};
    choiceExplanations[spec.answer] = { result: "正解", reason: spec.explanation };
    spec.choices.forEach((c) => {
      if (c === spec.answer) return;
      choiceExplanations[c] = { result: "不正解", reason: `正解は「${spec.answer}」。${spec.explanation}` };
    });

    return {
      id: nextQuestionId("c"),
      mode: "knowledge",
      category: "施工・設置の知識",
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
   第5章 系統連系と電力制度（製品データに依存しない静的問題）
   出題範囲：系統連系規程・FIT/FIP制度・出力制御・電力市場（JEPX/
   需給調整市場）・アグリゲーターとVPP・電圧/周波数維持・慣性力
   低下問題・電力自由化と関連機関（OCCTO等）・接続手続きと法規。
   ================================================================ */
const GRID_POLICY_SPECS = [
  {
    q: "「系統連系規程（JEAC9701）」とはどのような規程か。",
    choices: ["電力系統に発電設備を接続する際の技術要件・手続きを定めた業界規程", "電力会社が設定するFIT買取価格の規程", "太陽電池モジュールの品質基準を定めた規程", "電気工事士の資格要件を定めた規程"],
    answer: "電力系統に発電設備を接続する際の技術要件・手続きを定めた業界規程",
    difficulty: "中級",
    explanation: "系統連系規程（JEAC9701：電力系統連系技術要件ガイドライン）は、一般社団法人日本電気協会が制定する業界規程で、太陽光発電等の分散型電源を電力系統に接続する際の技術要件（保護装置・電気品質・系統への影響等）と接続手続きを規定している。電力会社との系統連系申込みで準拠を求められる。"
  },
  {
    q: "FIT（固定価格買取制度）の2023年度の「住宅用（10kW未満）余剰電力買取単価」として最も近いものはどれか。",
    choices: ["50円/kWh", "16円/kWh", "42円/kWh", "8円/kWh"],
    answer: "16円/kWh",
    difficulty: "上級",
    explanation: "FIT制度の住宅用太陽光発電（10kW未満）の余剰電力買取単価は、制度開始当初（2012年）の42円/kWhから毎年度下落が続き、2023年度は16円/kWh（東京電力管内等）程度になっている。買取単価は設備認定（事業計画認定）時点の単価が適用され、買取期間（10年）は固定される。"
  },
  {
    q: "FIT制度において「全量買取型」が適用される太陽光発電の規模として正しいものはどれか。",
    choices: ["10kW以上（産業用）", "500W以下", "1MW以上", "10kW未満"],
    answer: "10kW以上（産業用）",
    difficulty: "中級",
    explanation: "FIT制度では10kW以上の産業用太陽光発電（低圧区分の10kW以上50kW未満を除く場合あり）は発電した電力の全量を電力会社が買い取る「全量買取型」が適用される。10kW未満の住宅用は自家消費した後の余剰電力のみの買い取り「余剰買取型」。2022年のFIT改正で制度が一部見直された。"
  },
  {
    q: "FIP（フィードインプレミアム）制度における「プレミアム（補助額）」の説明として正しいものはどれか。",
    choices: ["プレミアムは毎月一定で変動しない", "市場価格とは無関係に一定の追加額を支払う制度", "FIPはFITの倍の単価が適用される", "基準価格と市場参照価格の差額（＝プレミアム）を事業者が電力市場取引収入に上乗せして受け取れる制度"],
    answer: "基準価格と市場参照価格の差額（＝プレミアム）を事業者が電力市場取引収入に上乗せして受け取れる制度",
    difficulty: "上級",
    explanation: "FIP制度のプレミアム額＝基準価格（FITに相当）−市場参照価格（電力市場の参照価格）。市場価格が高い時はプレミアムが低くなり、市場価格が低い時はプレミアムが高くなる逆相関の関係。事業者の電力市場参加（当日・前日取引）への動機付けを促し、電力系統安定化への貢献が期待される。"
  },
  {
    q: "系統連系において「逆潮流」を制限する「逆潮流なし」条件の場合に必要な装置として正しいものはどれか。",
    choices: ["昇圧変圧器", "逆電力継電器（RPR）と系統連系断路器の組み合わせ", "蓄電池", "無効電力補償装置（SVC）"],
    answer: "逆電力継電器（RPR）と系統連系断路器の組み合わせ",
    difficulty: "上級",
    explanation: "逆潮流なし（零潮流）条件での連系では、逆電力継電器（RPR：Reverse Power Relay）が余剰電力の逆潮流を検知すると系統連系断路器（開閉器）を開放してPCSを系統から切り離す。発電量が自家消費量を超えた場合に系統への電力流出を防ぐ。農業用配電線や特定の事業所での条件として課される。"
  },
  {
    q: "電力系統の「電圧調整」に太陽光発電が与える影響として正しいものはどれか。",
    choices: ["太陽光発電は電圧調整に全く影響しない", "太陽光発電は周波数を安定させるが電圧には影響しない", "太陽光発電は電圧を常に安定させる", "大量の太陽光発電からの逆潮流により配電線の末端電圧が上昇し、電圧品質問題が発生することがある"],
    answer: "大量の太陽光発電からの逆潮流により配電線の末端電圧が上昇し、電圧品質問題が発生することがある",
    difficulty: "中級",
    explanation: "配電線に大量の太陽光発電が接続されると、余剰電力の逆潮流による電圧上昇（特に配電線末端部）が問題になる。電気事業法・電技省令では需要家の受電電圧を適正範囲（101±6V、202±20V等）に保つ義務があり、電圧上昇を抑制するためにPCSによる力率制御・無効電力調整や自動電圧調整器（SVR）等が使用される。"
  },
  {
    q: "FIT制度の「認定」（事業計画認定）を受けるための申請窓口として正しいものはどれか。",
    choices: ["経済産業局（産業保安監督部）", "JPEA（太陽光発電協会）", "資源エネルギー庁（または委託機関のJ-クレジット制度事務局）", "電力会社"],
    answer: "資源エネルギー庁（または委託機関のJ-クレジット制度事務局）",
    difficulty: "上級",
    explanation: "FIT・FIP制度の事業計画認定（設備認定）の申請は、資源エネルギー庁が管轄する「再生可能エネルギー電子申請（RE-Portal）」を通じてオンライン申請する。電力会社は系統連系申込みの窓口。JPEAは業界団体。産業保安監督部は保安監督の機関。"
  },
  {
    q: "「電力受給契約（売電契約）」を締結する相手先として正しいものはどれか。",
    choices: ["発電所が接続する電力会社（一般送配電事業者等）または小売電気事業者", "資源エネルギー庁", "JPEA（太陽光発電協会）", "経済産業省"],
    answer: "発電所が接続する電力会社（一般送配電事業者等）または小売電気事業者",
    difficulty: "中級",
    explanation: "太陽光発電の余剰電力・全量売電の受給契約（売電契約）は、設備が接続する電力会社（一般送配電事業者が対象の場合）または小売電気事業者（旧一般電気事業者等）と締結する。FIT制度では特定の電力会社が義務買取事業者として指定されており、その窓口を通じて契約する。"
  },
  {
    q: "「電力系統の周波数」について、東日本（東北・関東等）と西日本（中部以西）の違いとして正しいものはどれか。",
    choices: ["日本全国統一で50Hz", "東日本：50Hz、西日本：60Hz", "東日本：60Hz、西日本：50Hz", "日本全国統一で60Hz"],
    answer: "東日本：50Hz、西日本：60Hz",
    difficulty: "初級",
    explanation: "日本の電力系統は東日本（北海道・東北・東京管内）が50Hz、西日本（中部・北陸・関西・中国・四国・九州管内）が60Hzと異なる周波数系統に分かれている。これは明治時代に異なる周波数の発電機が輸入されたためで、東西間の融通は周波数変換所（佐久間・新信濃・東清水等）を介して行われる。"
  },
  {
    q: "「低圧配電線への系統連系」（一般住宅）の条件として規定されているものとして正しいものはどれか。",
    choices: ["系統連系には変圧器が必須", "パワーコンディショナの出力は10MW以上", "住宅用は系統連系できない", "パワーコンディショナの出力は原則として50kW未満"],
    answer: "パワーコンディショナの出力は原則として50kW未満",
    difficulty: "中級",
    explanation: "低圧配電線（100V・200V）への系統連系は、系統連系規程・電力会社の連系条件により一般的にパワーコンディショナ出力50kW未満の設備が対象。50kW以上は高圧（6600V）系統への連系となり、受変電設備（キュービクル）の設置・高圧受電契約が必要。"
  },
  {
    q: "「再エネ賦課金（再生可能エネルギー発電促進賦課金）」の説明として正しいものはどれか。",
    choices: ["電力会社が自主的に収集する基金", "再エネ発電事業者が収益の一部を拠出する制度", "太陽光発電設置者のみが支払う税金", "FIT制度の買取費用を電力消費量に応じてすべての電力使用者が負担する制度"],
    answer: "FIT制度の買取費用を電力消費量に応じてすべての電力使用者が負担する制度",
    difficulty: "初級",
    explanation: "再エネ賦課金（再生可能エネルギー発電促進賦課金）はFIT制度の買取費用の一部を電力使用量に比例して全電力使用者（家庭・企業）が負担する仕組み。電力料金に上乗せして徴収される。再エネの普及とともに単価が上昇しており、2023年度は1.40円/kWhから3.45円/kWh程度。"
  },
  {
    q: "太陽光発電の「出力制御（カーテルメント）」を受ける際の補償について、FIT認定設備に関して正しいものはどれか。",
    choices: ["原則として無補償（補償なし）で出力制御に従う義務がある（ルールに基づく場合）", "出力制御を受けた発電量に対して全額補償される", "電力会社が損害賠償を支払う", "出力制御は任意であり拒否できる"],
    answer: "原則として無補償（補償なし）で出力制御に従う義務がある（ルールに基づく場合）",
    difficulty: "中級",
    explanation: "FIT・FIP認定設備の事業計画認定には電力系統の需給バランス維持のための出力制御（指定ルールに基づく無補償制御）に応じる義務が含まれている。九州電力管内など再エネ比率の高い地域では出力制御の実施頻度が増加している。無補償制御の上限日数は設備区分・時期によって異なるルールが設定されている。"
  },
  {
    q: "電力系統の「電圧・無効電力制御」において太陽光発電のPCSが対応できる機能として正しいものはどれか。",
    choices: ["PCSは有効電力のみを制御できる", "力率制御（無効電力の吸収・発生）により系統電圧の安定化に貢献できる", "PCSは電圧制御機能を持たない", "PCSの電圧制御は法律で禁止されている"],
    answer: "力率制御（無効電力の吸収・発生）により系統電圧の安定化に貢献できる",
    difficulty: "中級",
    explanation: "現代のPCS（パワーコンディショナ）は有効電力のほか、無効電力（進み・遅れ）を制御する力率制御（パワーファクターコントロール）機能を持つ。FIT・系統連系規程の要件として力率0.85以上（遅れ）での運転等が求められることがある。電圧上昇抑制のために進み無効電力（容量性）を消費させる制御も行われる。"
  },
  {
    q: "「FIT認定の失効」が起こりうる条件として正しいものはどれか。",
    choices: ["電力会社との契約が更新されなかった場合", "認定取得後に正当な理由なく設備設置・運転開始が遅延する場合や、認定要件を満たさなくなった場合", "モジュールを国産品から輸入品に変更した場合", "FIT認定は一度取得すれば永久に失効しない"],
    answer: "認定取得後に正当な理由なく設備設置・運転開始が遅延する場合や、認定要件を満たさなくなった場合",
    difficulty: "中級",
    explanation: "FIT認定（事業計画認定）は、認定後の運転開始期限の遅延（正当理由のない遅延）・認定要件違反（設備仕様変更の無届け・不適切な事業実施）・廃止届出等で取り消し・失効となる場合がある。認定失効後は買取義務が消滅する。2017年改正で規律強化・適切な事業実施の義務が追加された。"
  },
  {
    q: "「アグリゲーター」（仮想発電所：VPP）と太陽光発電の関係について正しいものはどれか。",
    choices: ["アグリゲーターは太陽電池を製造する企業", "太陽光発電の建設工事を管理する会社", "FIT申請の代行業者", "複数の分散型太陽光発電・蓄電池を束ねて仮想的な大型電源として電力市場に参加させる事業者"],
    answer: "複数の分散型太陽光発電・蓄電池を束ねて仮想的な大型電源として電力市場に参加させる事業者",
    difficulty: "中級",
    explanation: "アグリゲーター（Aggregator）は複数の分散型エネルギーリソース（太陽光発電・蓄電池・EV・工場負荷等）を束ねて管理し、仮想発電所（VPP：Virtual Power Plant）として電力市場や需給調整市場に参加する事業者。FIP制度との組み合わせで普及が期待されており、電力系統への貢献（周波数調整・需給バランス）が可能。"
  },
  {
    q: "「電力広域的運営推進機関（OCCTO）」の役割として正しいものはどれか。",
    choices: ["全国の電力系統の広域的な運用・需給調整・接続を管理する機関", "FIT・FIP制度の認定審査を行う機関", "電気工事士の資格認定を行う機関", "太陽光発電モジュールの品質を審査する機関"],
    answer: "全国の電力系統の広域的な運用・需給調整・接続を管理する機関",
    difficulty: "上級",
    explanation: "OCCTO（電力広域的運営推進機関）は2015年の電力システム改革の一環として設立された公的機関で、全国の電力系統の広域的な運用（需給調整・系統整備計画の策定）と系統接続に関するルールの整備・管理を担う。再エネの大量導入に対応した系統整備・広域融通の最適化を推進する。"
  },
  {
    q: "「電力小売全面自由化」（2016年）後の太陽光発電の余剰電力売電に関して正しいものはどれか。",
    choices: ["電力自由化によりFIT制度は廃止された", "FIT売電は新電力会社（PPS）にのみ申込みできる", "電力小売自由化後も、FIT売電の買取は義務買取事業者（一般送配電事業者等）が担い、単価は政府が設定", "自由化後は売電価格を発電事業者が自由に設定できる"],
    answer: "電力小売自由化後も、FIT売電の買取は義務買取事業者（一般送配電事業者等）が担い、単価は政府が設定",
    difficulty: "中級",
    explanation: "2016年の電力小売全面自由化後もFIT制度の仕組みは維持されており、FIT認定を受けた太陽光発電の買取は義務買取事業者（各地域の一般送配電事業者等）が担い、政府（調達価格等算定委員会）が設定した買取単価で行われる。自由化市場での取引はFIT以外の売電に適用される。"
  },
  {
    q: "「ネットメタリング（net metering）」の説明として正しいものはどれか。",
    choices: ["蓄電池の充放電サイクルを計数する方式", "太陽光発電の発電量を電力会社に全量売却する方式", "電力会社のスマートグリッドの通信プロトコル", "買電量から売電量を差し引いた分のみ電力料金を支払う精算方式"],
    answer: "買電量から売電量を差し引いた分のみ電力料金を支払う精算方式",
    difficulty: "中級",
    explanation: "ネットメタリングは売電量と買電量を相殺し、差額分のみ電力料金を精算する方式。1つのメーター（双方向計量）で電力の出入りを計量し、1ヶ月の買電量－売電量の差額を請求。米国等で普及しているが、日本のFIT制度では「余剰売電」（購入単価と異なる売電単価）が採用されており、厳密なネットメタリングとは異なる。"
  },
  {
    q: "太陽光発電の「特定契約（FIT売電契約）」の締結相手として正しいものはどれか（電力会社管内の場合）。",
    choices: ["一般送配電事業者または小売電気事業者（義務買取事業者）", "JPEA", "再生可能エネルギー電子申請サイト", "経済産業大臣"],
    answer: "一般送配電事業者または小売電気事業者（義務買取事業者）",
    difficulty: "中級",
    explanation: "FIT制度における特定契約（再エネ特措法に基づく買取契約）は、設備が接続する一般送配電事業者（東京電力パワーグリッド・中部電力パワーグリッド等）または政府が指定する義務買取事業者（地域に応じた旧一般電気事業者の小売部門等）との間で締結する。"
  },
  {
    q: "「系統連系保護装置」として「自動周波数制御（AFC）」と「自動電圧制御（AVC）」の役割を正しく説明しているものはどれか。",
    choices: ["AFCとAVCはともに保護継電器の一種", "AFCは周波数偏差に応じて発電出力を調整し周波数を維持、AVCは系統電圧を規定範囲内に維持する制御", "AFCは太陽光用、AVCは風力用の制御", "AFCは発電量を最大化、AVCは電力消費を最小化する制御"],
    answer: "AFCは周波数偏差に応じて発電出力を調整し周波数を維持、AVCは系統電圧を規定範囲内に維持する制御",
    difficulty: "上級",
    explanation: "AFC（Automatic Frequency Control）は電力系統の周波数偏差（50Hzまたは60Hzからのずれ）を検出し、それに応じて発電機の出力を増減させて周波数を基準値に保つ制御。AVC（Automatic Voltage Control）は系統電圧を検出し変圧器タップや無効電力を調整して電圧を規定範囲内（±5%等）に維持する制御。"
  },
  {
    q: "「再エネ特措法（電気事業者による再生可能エネルギー電気の調達に関する特別措置法）」の主な目的として正しいものはどれか。",
    choices: ["再生可能エネルギーの普及促進（買取義務・価格保証によるインセンティブ付与）", "電力料金の値下げ", "火力発電所の建設促進", "原子力発電の推進"],
    answer: "再生可能エネルギーの普及促進（買取義務・価格保証によるインセンティブ付与）",
    difficulty: "初級",
    explanation: "再エネ特措法（2012年施行、その後改正）はFIT制度・FIP制度の法的根拠を定める法律で、再生可能エネルギー（太陽光・風力・水力・地熱・バイオマス）による発電電力の電力会社による買取義務と固定価格・プレミアムによる価格保証を定め、再エネの普及促進を目的としている。"
  },
  {
    q: "「産業用太陽光発電（高圧連系）」のFIT2024年度買取単価として最も近いものはどれか。（50kW以上500kW未満の区分）",
    choices: ["約10円/kWh", "約42円/kWh", "約3円/kWh", "約30円/kWh"],
    answer: "約10円/kWh",
    difficulty: "上級",
    explanation: "FIT制度の産業用太陽光発電の買取単価は年々低下しており、2024年度の50kW以上500kW未満区分では10円/kWh程度（入札対象外区分は11〜12円/kWh前後）が設定されている。制度開始当初の40円/kWh（2012年）から大幅に低下。大規模（500kW以上）は入札制度が適用される。"
  },
  {
    q: "「電力需給調整市場（需給調整市場）」への太陽光発電の活用に関して正しいものはどれか。",
    choices: ["需給調整市場への参加でFIT単価が増額される", "需給調整市場は電力会社専用の市場", "太陽光発電は出力変動があるため需給調整市場に参加できない", "太陽光発電と蓄電池等を組み合わせ、アグリゲーターを通じて需給調整市場（調整力）に参加できる"],
    answer: "太陽光発電と蓄電池等を組み合わせ、アグリゲーターを通じて需給調整市場（調整力）に参加できる",
    difficulty: "中級",
    explanation: "日本では2021年から電力需給調整市場が整備され、FIP認定設備や自家消費型設備（蓄電池付き太陽光発電）がアグリゲーターを通じて三次調整力（余剰・不足時の需給バランス）として参加できるようになっている。太陽光単独では出力変動が大きいが、蓄電池との組み合わせで制御可能な調整力を提供できる。"
  },
  {
    q: "「再エネの自己託送制度」の説明として正しいものはどれか。",
    choices: ["自分で電線を敷設して発電電力を供給する", "再エネの発電量を電力会社に委託管理してもらう制度", "自社・関連施設で離れた場所に設置した再エネ発電電力を既存の電力系統を経由して送電（託送）する制度", "再エネ電力を電力会社に寄付する制度"],
    answer: "自社・関連施設で離れた場所に設置した再エネ発電電力を既存の電力系統を経由して送電（託送）する制度",
    difficulty: "上級",
    explanation: "自己託送制度は、同一の電気事業者（または一定の関係性を持つグループ企業）が離れた場所にある発電設備で発電した電力を、既存の電力系統（送配電線）を経由して自社の需要場所に送電する制度。一般送配電事業者への接続申込みと託送料金の支払いが必要。太陽光発電の自家消費率向上に活用される。"
  },
  {
    q: "太陽光発電の「系統連系における逆潮流の技術的制約」として正しいものはどれか。",
    choices: ["逆潮流は発電量を増加させる", "逆潮流の技術的制約はない", "逆潮流による配電線の電圧上昇・過負荷・保護リレーの誤動作が起きないよう技術的な条件が設けられる", "逆潮流は常に技術的に不可能"],
    answer: "逆潮流による配電線の電圧上昇・過負荷・保護リレーの誤動作が起きないよう技術的な条件が設けられる",
    difficulty: "中級",
    explanation: "逆潮流（需要家から電力系統への電力流入）は電圧上昇・配電線過負荷・既設保護リレーの誤動作などの技術的問題を引き起こす可能性がある。電力会社は系統への影響を検討（技術的検討・系統連系申込み審査）し、影響が大きい場合は系統増強工事・電圧調整装置設置・出力制御条件を付すなどの対策を設備者・申請者に要求することがある。"
  },
  {
    q: "「電力市場（JEPX：日本卸電力取引所）」での取引について太陽光発電との関係として正しいものはどれか。",
    choices: ["FIP認定設備は市場価格（スポット市場等）で売電し、プレミアムを上乗せして収入を得る", "JEPXでの取引は大手電力会社のみ可能", "FIT認定設備はすべてJEPXで取引する義務がある", "太陽光発電は市場価格に影響しない"],
    answer: "FIP認定設備は市場価格（スポット市場等）で売電し、プレミアムを上乗せして収入を得る",
    difficulty: "上級",
    explanation: "FIP（フィードインプレミアム）制度では、認定を受けた再エネ事業者はJEPX等の卸電力市場で発電電力を売却し、市場価格（スポット市場価格等の参照市場価格）に政府が設定したプレミアムを上乗せした収入を得る仕組み。太陽光発電の大量導入により日中の市場価格が低下（鴨川問題等）する現象も見られる。"
  },
  {
    q: "「電力系統安定化のための太陽光発電の出力変動抑制」対策として正しいものはどれか。",
    choices: ["蓄電池を組み合わせた出力変動平滑化制御や、予測に基づく出力調整・広域需給調整", "太陽光発電の設置を全面的に禁止する", "すべての太陽光発電を南向き・固定角度で設置する", "出力変動はパワーコンディショナの停止のみで抑制できる"],
    answer: "蓄電池を組み合わせた出力変動平滑化制御や、予測に基づく出力調整・広域需給調整",
    difficulty: "中級",
    explanation: "太陽光発電の出力変動（雲による日射変動）対策として、蓄電池との組み合わせによる出力変動平滑化・需給調整（数秒〜数分の変動吸収）、気象予測を活用した前日・当日の発電量予測に基づく計画値策定・需給調整、広域での需給バランス管理（地域間融通）等の対策が実施・研究されている。"
  },
  {
    q: "「高圧系統連系」において設置が必要な「受電設備（キュービクル）」の構成要素として適切でないものはどれか。",
    choices: ["断路器（DS）", "モジュール架台", "電力用変圧器（TR）または連系変圧器", "保護継電器（OVR・UVR等）"],
    answer: "モジュール架台",
    difficulty: "初級",
    explanation: "高圧系統連系（6600V）の受変電設備（キュービクル）には、断路器（DS）・遮断器（VCB等）・変圧器・計器用変流器（CT）・計器用変圧器（VT）・保護継電器（過電圧継電器OVR・不足電圧継電器UVR・周波数継電器等）・電力量計などが含まれる。モジュール架台は受変電設備の構成要素ではない。"
  },
  {
    q: "「太陽光発電のSPF（システム総合効率）」の説明として正しいものはどれか。",
    choices: ["年間発電量と年間消費電力量の差", "FIT買取単価と自家消費節電額の比率", "システムが受け取った太陽エネルギーに対して最終的に系統に送電できた電気エネルギーの割合", "モジュール変換効率とPCS変換効率の積"],
    answer: "システムが受け取った太陽エネルギーに対して最終的に系統に送電できた電気エネルギーの割合",
    difficulty: "上級",
    explanation: "システム総合効率（SPF：System Performance Factor）は受光エネルギーに対する系統送電電気量の比率。モジュール変換効率×PCS効率×配線効率等の積となり、すべての損失を含んだシステムとしての最終的な効率指標。典型的な系統連系システムでは10〜15%程度（モジュール効率18%×PR0.78等）。"
  },
  {
    q: "「電力系統のスマートグリッド化」と太陽光発電との関係について正しいものはどれか。",
    choices: ["通信・制御技術を活用して再エネの大量導入・蓄電池・需要側との連携で系統安定性を高める次世代電力網", "スマートグリッドは太陽光発電の出力を下げる", "スマートグリッドは海外でのみ導入されている", "スマートグリッドは電力系統の老朽化対策にすぎない"],
    answer: "通信・制御技術を活用して再エネの大量導入・蓄電池・需要側との連携で系統安定性を高める次世代電力網",
    difficulty: "初級",
    explanation: "スマートグリッドはICT（情報通信技術）・センサー・制御技術を電力系統に統合し、再エネ（太陽光・風力等）の出力変動に対応した需給最適化・蓄電池活用・需要側応答（DR）・電気自動車連携などを実現する次世代の双方向電力網。日本でも系統増強・スマートメーター普及と連携して整備が進んでいる。"
  },
  {
    q: "「電力の供給信頼度」の指標として使用される「SAIDI（System Average Interruption Duration Index）」の説明として正しいものはどれか。",
    choices: ["FIT買取量の累積合計", "年間発電量の変動係数", "顧客1件あたりの年間平均停電時間（停電の持続時間の指標）", "系統の平均電圧"],
    answer: "顧客1件あたりの年間平均停電時間（停電の持続時間の指標）",
    difficulty: "上級",
    explanation: "SAIDI（System Average Interruption Duration Index）は電力系統の信頼度指標の一つで、顧客1件あたりの年間平均停電時間（分・時間）を示す。日本の電力系統は世界最高水準の供給信頼度を持ち、SAIDIは先進国の中でも非常に低い値（年間数分程度）。太陽光発電の大量導入は系統安定性に影響するため、信頼度指標の維持が課題。"
  },
  {
    q: "「電力の需給調整市場（デマンドレスポンス：DR）」への太陽光発電の参加形態として正しいものはどれか。",
    choices: ["太陽光発電は発電のみで需要側応答には関与できない", "DRは太陽光発電のコスト削減制度", "DRへの参加はFIT事業者に義務付けられている", "蓄電池付き太陽光発電を活用した上げDR（発電増加）・下げDR（発電・充電制御）への参加"],
    answer: "蓄電池付き太陽光発電を活用した上げDR（発電増加）・下げDR（発電・充電制御）への参加",
    difficulty: "中級",
    explanation: "デマンドレスポンス（DR）は需要側（または需要家側発電・蓄電設備）が系統の需給バランス維持のために電力消費・発電量を調整する仕組み。蓄電池付き太陽光発電では、余剰時に蓄電池を充電（下げDR）・不足時に蓄電池から放電（上げDR）することで調整力を提供できる。アグリゲーターが仲介することが多い。"
  },
  {
    q: "「太陽光発電の入札制度（FIT入札）」の説明として正しいものはどれか。",
    choices: ["電力会社が太陽光発電所の建設場所を入札で決定する", "入札は住宅用のみに適用される", "FITの買取単価を入札で決定する制度で、大規模設備（一定容量以上）に適用される", "設備を最安値で施工する業者を入札で決定する制度"],
    answer: "FITの買取単価を入札で決定する制度で、大規模設備（一定容量以上）に適用される",
    difficulty: "中級",
    explanation: "FIT入札制度は大規模太陽光発電（当初250kW以上、現在は500kW以上等、区分は変更あり）に適用され、事業者が希望する買取単価（入札価格）で入札し、安い順（価格競争）で認定枠が決まる。競争原理で買取単価の引き下げを促す仕組み。2017年から本格導入され、落札単価の低下が進んでいる。"
  },
  {
    q: "「太陽光発電の発電量予測」と「電力需給バランス管理」の関係として正しいものはどれか。",
    choices: ["太陽光発電の予測誤差は電力会社が全額補償する", "発電量予測の精度は電力需給に影響しない", "発電量予測は電力会社のみが実施する", "精度の高い発電量予測により計画値と実績値の乖離が減少し、系統の需給バランス維持が容易になる"],
    answer: "精度の高い発電量予測により計画値と実績値の乖離が減少し、系統の需給バランス維持が容易になる",
    difficulty: "中級",
    explanation: "電力系統の需給バランス管理では、太陽光発電の予測と実績の差（予測誤差）が大きいと調整電源が必要になる。高精度な発電量予測（気象情報・AI活用）により計画値と実績の差を小さくし、余分な調整電源容量・コストを削減できる。FIP制度では計画値と実績の乖離に対するインバランス料金が課される仕組みで、予測精度向上へのインセンティブが働く。"
  },
  {
    q: "「電力系統への接続検討」で電力会社が実施する内容として正しいものはどれか。",
    choices: ["FIT価格の決定", "太陽電池モジュールの品質審査", "連系する系統の受入可能容量・電圧・保護協調等の技術的検討と必要な系統増強工事の特定", "接続申し込みは受付のみで技術的検討は不要"],
    answer: "連系する系統の受入可能容量・電圧・保護協調等の技術的検討と必要な系統増強工事の特定",
    difficulty: "中級",
    explanation: "電力会社（一般送配電事業者）は系統連系申込みを受けた後、接続する変電所・配電線の受入れ可能容量（空き容量）、電圧変動・潮流変化の影響、保護リレーとの協調等の技術的検討を実施し、必要に応じた系統増強工事（費用は事業者負担の場合あり）や接続条件を提示する。"
  },
  {
    q: "「固定価格買取制度（FIT）」の「認定有効期限」について正しいものはどれか。",
    choices: ["認定は10年で自動更新", "認定に有効期限はなく永久に有効", "有効期限は電力会社が決定する", "認定後一定期間内に運転開始しなければ認定が取り消される場合がある（運転開始期限）"],
    answer: "認定後一定期間内に運転開始しなければ認定が取り消される場合がある（運転開始期限）",
    difficulty: "中級",
    explanation: "FIT事業計画認定には運転開始期限が設定されており、正当な理由なく期限内に運転を開始しない場合は認定取り消しの対象となる。設備区分・容量・認定時期によって期限が異なる。施工計画や電力会社との系統連系工事の遅れにも注意が必要。期限延長申請の手続きもある（事業計画変更認定）。"
  },
  {
    q: "「分散型電源の単独運転防止」が電力系統に重要な理由として正しいものはどれか。",
    choices: ["単独運転は電気料金を下げるため問題がない", "単独運転は発電量を増加させるため好ましい", "単独運転防止は環境保護のための措置", "系統停電中に発電を続けると、系統復旧作業員への感電危険・復旧時の電圧位相不一致による機器損傷が起きる"],
    answer: "系統停電中に発電を続けると、系統復旧作業員への感電危険・復旧時の電圧位相不一致による機器損傷が起きる",
    difficulty: "中級",
    explanation: "単独運転（島運転）が発生すると、①停電復旧作業を行う電力会社作業員が系統が生きていると思って感電する危険、②系統復旧時に電力会社系統と太陽光発電の電圧・位相が不一致で大きな過渡電流が発生し機器損傷の危険がある。系統連系規程では単独運転防止機能（受動・能動の両方式）の設置を義務付けている。"
  },
  {
    q: "「太陽光発電の事業性評価（デューデリジェンス）」で金融機関が重視する指標として正しいものはどれか。",
    choices: ["施工担当者の年齢", "モジュールのデザイン性", "発電所の近隣施設の数", "P90発電量・IRR（内部収益率）・DSCRなどの財務・発電量指標"],
    answer: "P90発電量・IRR（内部収益率）・DSCRなどの財務・発電量指標",
    difficulty: "上級",
    explanation: "金融機関がメガソーラー等への融資審査（デューデリジェンス）で重視する指標には、発電量予測の保守性（P90値）、IRR（Internal Rate of Return：内部収益率）、DSCR（Debt Service Coverage Ratio：元利金返済余裕率）、O&Mコスト・保険料の妥当性、事業計画の健全性などが含まれる。"
  },
  {
    q: "「電力系統のブラックアウト（全域停電）」と太陽光発電の大量導入との関係について正しいものはどれか。",
    choices: ["太陽光発電の単独運転防止機能がブラックアウトを引き起こす", "大量の太陽光発電の急激な出力変動や不適切な連系保護設定が周波数急落やブラックアウトリスクの一因になり得る", "太陽光発電は常にブラックアウトを防止する", "ブラックアウトは太陽光発電とは無関係"],
    answer: "大量の太陽光発電の急激な出力変動や不適切な連系保護設定が周波数急落やブラックアウトリスクの一因になり得る",
    difficulty: "上級",
    explanation: "2018年の北海道胆振東部地震では需給バランスの急変による周波数低下・発電所の解列連鎖でブラックアウトが発生した。太陽光発電が大量接続された系統では、雲による急激な出力変動や系統事故時の大量脱落が周波数・電圧安定性を損なうリスクがある。適切な連系保護・系統強化・調整電源確保が重要。"
  },
  {
    q: "「電力系統の配電電圧上昇対策」として太陽光発電のPCSが実施できる機能として正しいものはどれか。",
    choices: ["出力を増加させて電圧を上げる", "PCSには電圧制御機能はない", "有効電力出力の抑制または進み力率運転（無効電力消費）により電圧上昇を抑制する", "接地抵抗を変化させる"],
    answer: "有効電力出力の抑制または進み力率運転（無効電力消費）により電圧上昇を抑制する",
    difficulty: "中級",
    explanation: "配電線の電圧上昇抑制対策として、太陽光発電PCSは、①有効電力出力の抑制（出力を下げて逆潮流を減らす）、②進み力率運転（無効電力を消費して電圧を引き下げる）の機能を使用できる。系統連系規程では電力会社から力率制御指令に応じる機能を持つことが求められる場合がある。"
  },
  {
    q: "「電力の周波数維持」において太陽光発電の大量導入が課題となる理由として正しいものはどれか。",
    choices: ["太陽光発電は常に周波数を安定させる", "太陽光発電は周波数調整に最も適した電源", "太陽光発電が増えると周波数が上昇し続ける", "太陽光発電は一次周波数調整機能（ガバナ機能）を持たないため、出力変動が系統周波数変動を引き起こす可能性がある"],
    answer: "太陽光発電は一次周波数調整機能（ガバナ機能）を持たないため、出力変動が系統周波数変動を引き起こす可能性がある",
    difficulty: "上級",
    explanation: "従来の火力・水力発電機は系統周波数変動に応じて自動的に出力を調整する一次調整（ガバナ機能）を持つ。しかし太陽光発電（インバータ電源）は従来の同期発電機のような慣性を持たず、ガバナ機能もなかった。大量導入で系統の慣性が低下し、周波数変動が大きくなる（RoCoF増大）リスクがある。対策として仮想慣性（Virtual Inertia）制御の研究が進んでいる。"
  },
  {
    q: "「高圧自家用電気工作物」の保安管理において「電気主任技術者」の選任が必要になる場合として正しいものはどれか。",
    choices: ["住宅用10kW未満の太陽光発電", "容量を問わず全ての太陽光発電", "高圧（6600V）系統に連系する太陽光発電など500kW未満の自家用電気工作物", "低圧連系の全ての太陽光発電"],
    answer: "高圧（6600V）系統に連系する太陽光発電など500kW未満の自家用電気工作物",
    difficulty: "上級",
    explanation: "電気事業法により、高圧受電設備を持つ自家用電気工作物（高圧連系の太陽光発電含む）は電気主任技術者の選任（または外部委託）が義務付けられる。500kW未満は第三種電気主任技術者の選任または外部委託が可能。500kW以上は原則として常駐の主任技術者が必要。低圧連系・住宅用は対象外（一般用電気工作物）。"
  },
  {
    q: "「インバランス（計画値と実績の乖離）」に対するFIP事業者への影響として正しいものはどれか。",
    choices: ["インバランスは無制限で許容される", "FIP事業者は発電量の計画値（30分刻み）を策定する義務があり、計画と実績の差（インバランス）に対してインバランス料金が発生する", "インバランス料金は発電量に比例して一定", "インバランスはFIT事業者にのみ課される"],
    answer: "FIP事業者は発電量の計画値（30分刻み）を策定する義務があり、計画と実績の差（インバランス）に対してインバランス料金が発生する",
    difficulty: "上級",
    explanation: "FIP制度では事業者が電力市場での取引を通じて発電量の計画値（コマ別30分値）を策定・提出する義務がある。計画値と実績値の差（インバランス）は一般送配電事業者に調整コストを発生させるため、インバランス料金として事業者に請求される仕組み。これが発電量予測精度向上へのインセンティブとなっている。"
  },
  {
    q: "「電力系統への再エネ大量導入に伴う系統増強」において「送電網マスタープラン」の目的として正しいものはどれか。",
    choices: ["太陽光発電の設置位置を指定する計画", "電力会社の経営計画", "FIT認定の上限数を決める計画", "2050年カーボンニュートラルに向けた広域的な送電網整備の長期計画"],
    answer: "2050年カーボンニュートラルに向けた広域的な送電網整備の長期計画",
    difficulty: "上級",
    explanation: "「電力系統の広域連系系統のマスタープラン」（国の機関・OCCTOが策定）は、2050年カーボンニュートラル・2030年再エネ目標の達成に向けて全国の送電網を大規模に増強するための長期計画。北海道・東北・九州等の再エネポテンシャルが高い地域から大都市圏への送電容量拡大・洋上風力対応の海底ケーブル整備等が含まれる。"
  },
  {
    q: "「電力系統への太陽光発電の系統連系」において「PCS（パワーコンディショナ）」が系統に与える影響として正しいものはどれか。",
    choices: ["PCSが多くなるほど系統電圧が安定する", "PCSはインバータのため高調波を発生させる可能性があり、電力品質への影響を考慮する必要がある", "PCSは高調波を全く発生させない", "PCSによる高調波は電力会社が全額補償する"],
    answer: "PCSはインバータのため高調波を発生させる可能性があり、電力品質への影響を考慮する必要がある",
    difficulty: "中級",
    explanation: "PCS（インバータ）はスイッチング素子（IGBT等）のオン・オフによる電力変換を行うため、高調波（基本波の整数倍の周波数成分）を発生させる可能性がある。電力系統への高調波流出は他の機器への悪影響（通信障害・過熱等）を引き起こす恐れがあるため、系統連系規程では高調波電流の上限値（総合電流歪み率THD等）が規定されている。"
  },
  {
    q: "「電力市場のプライスキャップ」の説明として正しいものはどれか。",
    choices: ["太陽光発電モジュールの最高販売価格", "卸電力市場での取引価格の上限（電力供給危機時等に適用）", "FIT制度での最低買取価格の下限", "電気工事費用の上限"],
    answer: "卸電力市場での取引価格の上限（電力供給危機時等に適用）",
    difficulty: "上級",
    explanation: "プライスキャップは卸電力市場（JEPX等）での電力取引価格に設ける上限。電力需給ひっ迫時に市場価格が異常高騰して需要者や小売電気事業者に過大な負担が発生するリスクを抑えるため設定される。日本では2021年の電力市場高騰（kWh当たり200円超）後に上限設定が強化された。太陽光発電はこの市場で売電する場合に影響を受ける。"
  },
  {
    q: "「電力の同時同量原則（リアルタイムバランス）」の説明として正しいものはどれか。",
    choices: ["電力は貯蔵できないため、発電量と消費量が常にリアルタイムで一致していなければならない原則", "1ヶ月単位で発電量と消費量が一致すれば良い", "太陽光発電は同時同量の義務が免除されている", "同時同量は発電所のみが守るべき原則"],
    answer: "電力は貯蔵できないため、発電量と消費量が常にリアルタイムで一致していなければならない原則",
    difficulty: "中級",
    explanation: "電力の同時同量（Simultaneous Equivalence）は電力系統の安定運用の基本原則で、発電量と消費量が常にリアルタイム（理論上は瞬時、実際は数秒〜30分単位）で一致していなければ系統の周波数が変動・不安定化する。太陽光発電の出力変動は同時同量維持の困難要因であり、調整電源・蓄電池・需要応答で対処する。"
  },
  {
    q: "「2030年度の再エネ目標（日本政府・エネルギー基本計画）」での太陽光発電の電源構成比目標として最も近いものはどれか。",
    choices: ["約5%", "約30%", "約50%", "約14〜16%"],
    answer: "約14〜16%",
    difficulty: "上級",
    explanation: "2021年10月に閣議決定された第6次エネルギー基本計画では、2030年度の電源構成における太陽光発電の比率目標は約14〜16%（再エネ合計36〜38%のうち）とされた。2050年カーボンニュートラルに向けて太陽光発電の導入加速が重要な政策課題となっている。"
  },
  {
    q: "「低圧太陽光発電（50kW未満）」の系統連系申込みで電力会社が「標準申込様式」で受付する場合の手続きとして正しいものはどれか。",
    choices: ["電力会社が定める様式で申し込み→技術的検討→承認→工事→完成検査→売電開始の流れ", "系統連系申し込みは施工後にしか行えない", "専門コンサルタントへの依頼が必須", "低圧系統連系は申し込み不要で自動的に連系できる"],
    answer: "電力会社が定める様式で申し込み→技術的検討→承認→工事→完成検査→売電開始の流れ",
    difficulty: "初級",
    explanation: "低圧系統連系の一般的な手続きフローは、設備設置前に電力会社へ接続申込み→電力会社による技術的検討（接続可否・条件）→承認→電気工事士による施工→完成検査（電力会社による接続確認）→電力受給契約（売電契約）締結→売電開始（スマートメーター等取付け）。施工前の申し込みが基本。"
  },
  {
    q: "「電力系統への分散型電源（太陽光発電等）の大量接続」による「系統の慣性力（イナーシャ）低下問題」について正しいものはどれか。",
    choices: ["太陽光発電は慣性を持つため問題ない", "インバータ電源は系統慣性を増加させる", "慣性力の低下は発電量増加で補える", "同期発電機が減少し回転体の慣性が低下すると、周波数変動が大きく急速になる（RoCoF増大）"],
    answer: "同期発電機が減少し回転体の慣性が低下すると、周波数変動が大きく急速になる（RoCoF増大）",
    difficulty: "上級",
    explanation: "従来の同期発電機（タービン・発電機の回転体）は大きな慣性モーメントを持ち、急な発電変動時にその慣性（回転エネルギーの放出・吸収）が周波数変動を緩衝する役割を担う。太陽光発電等のインバータ電源はこの機械的慣性を持たないため、大量普及すると系統の等価慣性が低下し、RoCoF（周波数変化率）が大きくなり系統不安定リスクが高まる。"
  },
  {
    q: "「電力の配電損失」と太陽光発電の設置場所の関係として正しいものはどれか。",
    choices: ["需要地近傍への分散型太陽光発電設置は配電損失の低減に寄与する", "太陽光発電は遠隔地に集中設置する方が配電損失は小さい", "配電損失は太陽光発電の位置に関わらず一定", "太陽光発電は配電損失を増加させる"],
    answer: "需要地近傍への分散型太陽光発電設置は配電損失の低減に寄与する",
    difficulty: "中級",
    explanation: "配電線の電力損失（I²R損失）は送電距離と電流の二乗に比例。需要地近傍に太陽光発電を分散設置すると、遠方の大規模発電所から送電する電力量が減少し、配電線を流れる電流・送電距離が短くなり配電損失を低減できる。ピーク時の配電設備負荷軽減にも寄与。ただし逆潮流が大きいと損失増加の場合もある。"
  },
  {
    q: "「FIT制度の長期認定（50kW以上）」において「事業計画策定ガイドライン」が定める内容として適切なものはどれか。",
    choices: ["施工業者の選定方法", "売電先の電力会社の指定", "適切な事業実施（農地転用許可・騒音対策・景観配慮・廃棄積立て・定期点検等）の要件", "モジュールのメーカー指定"],
    answer: "適切な事業実施（農地転用許可・騒音対策・景観配慮・廃棄積立て・定期点検等）の要件",
    difficulty: "中級",
    explanation: "FIT事業計画策定ガイドライン（資源エネルギー庁）は、太陽光発電事業の適切な実施のため、①関係法令（農地法・森林法・条例等）の遵守、②地域との合意形成・景観・騒音配慮、③適切な保守点検・維持管理、④廃棄等費用の積立て、⑤事業終了時の適正廃棄等を定める。違反時はFIT認定取消しの可能性。"
  },
  {
    q: "「電力系統の空き容量計算（潮流計算）」における「N-1基準」の説明として正しいものはどれか。",
    choices: ["配電線が1本あれば十分という基準", "電力会社が1社のみ運営できる基準", "系統内の1設備が故障しても残りの設備で正常に電力供給できる基準", "太陽光発電が1kW発電できる基準"],
    answer: "系統内の1設備が故障しても残りの設備で正常に電力供給できる基準",
    difficulty: "上級",
    explanation: "N-1基準（単一設備故障基準）は、系統内の任意の1設備（送電線・変圧器・発電機等）が故障・停止しても、残りの設備で過負荷・電圧異常を起こさずに供給を継続できるように系統を計画・運用する基準。空き容量計算ではN-1故障時にも容量超過しない範囲で接続可能容量を算定する。"
  },
  {
    q: "「ノンファーム型接続（Non-Firm Connection）」の説明として正しいものはどれか。",
    choices: ["蓄電池なしの接続に限定した方式", "系統の空き容量が0でも出力制御条件付きで接続を認める方式", "接続を断固として拒否する方式", "ソーラーシェアリングの専用接続方式"],
    answer: "系統の空き容量が0でも出力制御条件付きで接続を認める方式",
    difficulty: "上級",
    explanation: "ノンファーム型接続は、送電線の平常時空き容量が不足していても、混雑時の出力制御を条件に接続を認める方式。従来のファーム型接続（常時送電容量保証）に対し、系統増強を待たずに早期接続が可能。2021年から全国展開。出力制御による売電損失リスクは事業者が負担。"
  },
  {
    q: "「2050年カーボンニュートラル」目標と太陽光発電の関係について正しいものはどれか。",
    choices: ["2050年目標は太陽光発電に関係ない", "カーボンニュートラルは原子力のみで達成する計画", "太陽光発電は脱炭素化の主力電源として大幅な導入拡大が見込まれており、2050年に向けて容量を更に大幅増加させる必要がある", "2050年には太陽光発電の役割は終了する"],
    answer: "太陽光発電は脱炭素化の主力電源として大幅な導入拡大が見込まれており、2050年に向けて容量を更に大幅増加させる必要がある",
    difficulty: "初級",
    explanation: "2050年カーボンニュートラル実現には、電力部門の脱炭素化が不可欠。太陽光発電は再エネの主力電源として、2030年14〜16%、2050年には更に大幅な容量増が必要。適地制約・系統制約への対応として屋根置き義務化検討・ソーラーシェアリング・ペロブスカイト太陽電池等の技術革新が期待される。"
  },
  {
    q: "「電力会社への系統連系申請」で「スクリーニングシート」の提出が求められる場合の目的として正しいものはどれか。",
    choices: ["接続申込み前に設備概要（規模・位置等）を電力会社に事前通知し、大まかな接続可否・工期・費用を確認するため", "施工業者の資格を申告するため", "モジュールのメーカーを申告するため", "FIT認定番号を登録するため"],
    answer: "接続申込み前に設備概要（規模・位置等）を電力会社に事前通知し、大まかな接続可否・工期・費用を確認するため",
    difficulty: "中級",
    explanation: "電力会社への接続検討申込み前に提出するスクリーニングシートには、発電設備の容量・設置場所・連系電圧・予定時期・PCS仕様等を記載。電力会社が簡易的な系統状況を確認し、大まかな接続可否・標準工期・概算費用を事前回答する。正式な接続検討前の予備的手続きで、大規模案件で活用。"
  },
  {
    q: "「電力需給調整市場の三次調整力」に太陽光発電が活用される場面として正しいものはどれか。",
    choices: ["年間の発電量計画策定", "数時間前からの計画変更に対応した発電量調整（蓄電池付き太陽光発電等）", "数秒単位の瞬間的な周波数調整", "モジュールの保証管理"],
    answer: "数時間前からの計画変更に対応した発電量調整（蓄電池付き太陽光発電等）",
    difficulty: "上級",
    explanation: "需給調整市場の三次調整力は応動時間が比較的長い（数分〜数時間）調整力で、前日・当日の需給予測誤差や再エネ出力変動に対応。蓄電池付き太陽光発電はアグリゲーターの指令により充放電・出力制御して三次調整力を提供可能。一次・二次調整力は秒〜分単位の高速応答が必要。"
  },
  {
    q: "「太陽光発電の容量クレジット（設備容量への寄与率）」の説明として正しいものはどれか。",
    choices: ["出力の不確実性・天候依存性から、太陽光発電の容量クレジット（信頼度貢献）は設備容量より低い", "太陽光発電は出力が100%保証されるため容量クレジットは1.0", "容量クレジットはFIT単価の決定に直接使用される", "太陽光発電の容量クレジットは蓄電池より高い"],
    answer: "出力の不確実性・天候依存性から、太陽光発電の容量クレジット（信頼度貢献）は設備容量より低い",
    difficulty: "上級",
    explanation: "容量クレジット（Capacity Credit）は、電力需給ピーク時に供給力として期待できる割合。太陽光発電は夕方のピーク時間帯に発電量が低下し、天候依存性もあるため、設備容量100MWでも供給力として評価されるのは10〜30MW程度（地域・系統により異なる）。蓄電池併設で容量クレジットを高められる。"
  },
  {
    q: "「電力系統の中長期的な計画停電（計画保守停電）」と太陽光発電の関係について正しいものはどれか。",
    choices: ["系統連系型太陽光発電は計画停電（系統停電）時には単独運転防止機能により自動停止する", "計画停電は太陽光発電に有利に働く", "太陽光発電があれば計画停電は不要", "計画停電があっても太陽光発電は発電を継続できる"],
    answer: "系統連系型太陽光発電は計画停電（系統停電）時には単独運転防止機能により自動停止する",
    difficulty: "中級",
    explanation: "系統連系型太陽光発電は、電力会社系統の停電を検知すると単独運転防止機能によりPCSが自動停止する。これは作業員の感電防止・復旧時の機器損傷防止のため。自立運転機能付きPCSの場合は、系統から切り離した状態で専用コンセントから最大1.5kW程度の電力を使用できる（晴天時）。"
  },
  {
    q: "「電力系統の再エネ出力制御率（出力制御比率）」が高い地域として日本で挙げられる例として正しいものはどれか。",
    choices: ["九州（九州電力管内）", "関東（東京電力管内）", "北海道", "東北（東北電力管内）"],
    answer: "九州（九州電力管内）",
    difficulty: "中級",
    explanation: "日本で最初に本格的な再エネ出力制御が実施されたのは九州電力管内（2018年10月）。太陽光発電導入量が需要に対して多く、春・秋の晴天日など需要が低い時期に火力発電の抑制・揚水運転・地域間連系線活用でも余剰が解消できない場合、太陽光・風力の出力制御が実施される。近年は北海道・東北・中国・四国等にも拡大。"
  },
  {
    q: "「電力需給ひっ迫警報・注意報」が発令された場合の太陽光発電の役割として正しいものはどれか。",
    choices: ["需給ひっ迫時には太陽光発電を停止させる", "需給ひっ迫時でも太陽光発電の出力制御が必要", "太陽光発電は需給ひっ迫に無関係", "昼間の晴天時は太陽光発電の最大出力で貢献できるが、夜間・悪天候時は貢献できない"],
    answer: "昼間の晴天時は太陽光発電の最大出力で貢献できるが、夜間・悪天候時は貢献できない",
    difficulty: "中級",
    explanation: "需給ひっ迫時、昼間の晴天時は太陽光発電が供給力として大きく貢献し、火力発電の燃料消費・需給ひっ迫を緩和。一方、夕方の太陽光出力急減（ダックカーブ）・夜間・悪天候時には貢献できず、蓄電池・火力・揚水等のバックアップ電源が必要。需給ひっ迫警報は予備率3%未満で発令される場合がある。"
  },
  {
    q: "「電力系統の国際連系（国際電力取引）」と日本の状況について正しいものはどれか。",
    choices: ["日本は島国のため他国との電力系統が接続されておらず、国際電力融通ができない", "日本は中国・韓国と海底ケーブルで接続している", "国際連系は日本の再エネ導入に重要", "日本は国際的な電力融通で再エネ変動を補っている"],
    answer: "日本は島国のため他国との電力系統が接続されておらず、国際電力融通ができない",
    difficulty: "初級",
    explanation: "日本は島国であり、他国との国際連系線（海底ケーブル等）がないため、欧州のような国際電力融通はできない。国内では北海道―本州・東北―東京・中部―関西等の地域間連系線で融通。アジアスーパーグリッド（中国・韓国・ロシアとの国際連系）構想が議論されているが、実現していない。"
  },
  {
    q: "「太陽光発電の系統連系時の受電電力会社への申請費用（接続検討費用）」について正しいものはどれか。",
    choices: ["接続検討は常に無料", "一定以上の規模では接続検討申込みに検討費用（申込み料）が必要な場合がある", "費用はFIT認定後に全額補助される", "費用は設備の発電量に比例"],
    answer: "一定以上の規模では接続検討申込みに検討費用（申込み料）が必要な場合がある",
    difficulty: "中級",
    explanation: "系統接続検討の費用は設備規模・電圧区分により異なる。低圧連系は無料または数万円程度、高圧・特別高圧の接続検討は一般に20万円程度（税別）以上の検討料が必要。検討期間は原則3か月（大規模・複雑な場合は延長）。検討結果に基づき系統増強工事費負担金が提示される。"
  },
  {
    q: "「余剰電力買取価格の低下」が太陽光発電の「自家消費へのシフト」を促している背景として正しいものはどれか。",
    choices: ["売電価格が上昇したため", "電力購入単価より売電単価が低くなり、売電より自家消費の方が経済的メリットが大きくなった", "蓄電池の価格が上昇したため", "FIT制度が廃止されたため"],
    answer: "電力購入単価より売電単価が低くなり、売電より自家消費の方が経済的メリットが大きくなった",
    difficulty: "中級",
    explanation: "FIT買取単価の低下（住宅用2023年度16円/kWh）に対し、電力購入単価は燃料費高騰・再エネ賦課金等で30〜40円/kWh程度に上昇。「売電16円より自家消費で買電30円を削減する方が1kWhあたり14円有利」となり、蓄電池・EV・エコキュート等を活用した自家消費率向上が経済的に有利。"
  },
  {
    q: "「電力系統への新規接続ルール（連系ルール）」において「工事費負担金制度」の説明として正しいものはどれか。",
    choices: ["国が全額補助するルール", "系統連系に必要な工事費用を原因者（接続申込者）が負担する仕組み", "工事費は発電量に応じて分割払い", "電力会社が全て負担するルール"],
    answer: "系統連系に必要な工事費用を原因者（接続申込者）が負担する仕組み",
    difficulty: "中級",
    explanation: "工事費負担金制度は、発電設備の系統連系に必要な送電線・変電所の増強工事費用を接続申込者（発電事業者）が負担する「原因者負担」の原則。複数事業者が同一工事を利用する場合は按分。工事費は接続検討結果で提示され、支払い後に工事着手。近年は一般負担上限制度（一定額まで電力会社負担）も導入。"
  }
];

function generateGridPolicyQuestions() {
  return GRID_POLICY_SPECS.map((spec) => {
    const choiceExplanations = {};
    choiceExplanations[spec.answer] = { result: "正解", reason: spec.explanation };
    spec.choices.forEach((c) => {
      if (c === spec.answer) return;
      choiceExplanations[c] = { result: "不正解", reason: `正解は「${spec.answer}」。${spec.explanation}` };
    });

    return {
      id: nextQuestionId("g"),
      mode: "knowledge",
      category: "系統連系と電力制度",
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
   第6章 関係法規（製品データに依存しない静的問題）
   出題範囲：電気事業法・電気用品安全法・建築基準法・再エネ特措法
   （FIT/FIP）・電気工事士法・農地法/森林法/都市計画法等の立地規制・
   消費者保護関連法・廃棄物処理法・各種業法/技術基準の解釈。
   ================================================================ */
const LAW_SPECS = [
  {
    q: "「電気事業法」における太陽光発電設備の分類として正しいものはどれか。",
    choices: ["電気事業法は太陽光発電に適用されない", "発電用電気工作物として一般用電気工作物または自家用電気工作物に分類される", "電気用品安全法の対象外", "50kW以上は一般用電気工作物に分類される"],
    answer: "発電用電気工作物として一般用電気工作物または自家用電気工作物に分類される",
    difficulty: "中級",
    explanation: "電気事業法では電気工作物を「一般用電気工作物」（住宅等低圧600V以下で小規模）と「自家用電気工作物」（高圧受電・発電設備等）に分類する。住宅用太陽光発電（低圧連系、50kW未満）は一般用電気工作物、高圧連系や50kW以上は自家用電気工作物（電気主任技術者選任等が必要）に分類される。"
  },
  {
    q: "「電気用品安全法（PSE法）」において太陽光発電に関係する規制として正しいものはどれか。",
    choices: ["PSEマークは任意取得で義務ではない", "電気用品安全法は電力会社にのみ適用される", "パワーコンディショナは電気用品安全法の規制対象で、PSEマークの取得が必要", "太陽電池モジュールは電気用品安全法の対象外"],
    answer: "パワーコンディショナは電気用品安全法の規制対象で、PSEマークの取得が必要",
    difficulty: "中級",
    explanation: "電気用品安全法（PSE法）はパワーコンディショナを「電気用品」として規制し、製造・輸入事業者には安全基準への適合・届出・検査・PSEマーク（特定電気用品以外：丸PSE）の表示が義務付けられている。なお太陽電池モジュールは2012年以降に電気用品安全法の規制対象に追加された。"
  },
  {
    q: "「建築基準法」において屋根に設置する太陽光発電が関係する規定として正しいものはどれか。",
    choices: ["住宅屋根への設置に関する建築基準法の規定はない", "建物用途・面積等によっては建築基準法の防火関係規定（屋根材の不燃性等）への適合確認が必要", "太陽光発電は建築物ではないため建築基準法は適用されない", "建築確認申請は常に不要"],
    answer: "建物用途・面積等によっては建築基準法の防火関係規定（屋根材の不燃性等）への適合確認が必要",
    difficulty: "中級",
    explanation: "建築基準法では屋根材に防火性能（不燃材料・準不燃・難燃）の要件がある。屋根一体型モジュール（屋根材型）は建材として不燃性能の確認が必要。また大規模な屋根設置での積載荷重増大は構造安全性（構造基準適合）への影響があり確認が必要。地上設置型は独立工作物として一定規模で建築確認申請が必要になる場合がある。"
  },
  {
    q: "「再エネ特措法（電気事業者による再生可能エネルギー電気の調達に関する特別措置法）」に基づく事業計画認定において、設備設置者の義務として規定されていないものはどれか。",
    choices: ["周辺環境への配慮（騒音・景観・生態系等）", "廃棄費用の積立て", "電力会社との合弁事業の設立", "設備の適切な保守点検の実施"],
    answer: "電力会社との合弁事業の設立",
    difficulty: "初級",
    explanation: "再エネ特措法の事業計画認定を受けた設備設置者の主な義務は、①設備の適切な保守点検、②関係法令遵守（農地転用・砂防等）、③周辺環境への配慮（騒音・景観・生態系）、④廃棄費用の積立て、⑤情報開示（標識掲示等）などが規定されている。電力会社との合弁事業設立は義務に含まれない。"
  },
  {
    q: "「電気工事士法」において第二種電気工事士の作業範囲として正しいものはどれか。",
    choices: ["自家用電気工作物の全ての電気工事に従事できる", "高圧受電設備の電気工事も可能", "一般用電気工作物（低圧）の電気工事に従事できる", "電気工事の設計のみで施工は第一種のみ"],
    answer: "一般用電気工作物（低圧）の電気工事に従事できる",
    difficulty: "初級",
    explanation: "第二種電気工事士は一般用電気工作物（600V以下の低圧電気設備を持つ住宅・小規模店舗等）の電気工事に従事できる。住宅用太陽光発電（低圧連系）の電気工事は第二種電気工事士で対応可能。高圧受電設備や自家用電気工作物の電気工事は第一種電気工事士または特種電気工事資格者が必要。"
  },
  {
    q: "「計量法」において太陽光発電の売電量計（取引用計量）に使用できる計量器の要件として正しいものはどれか。",
    choices: ["パワーコンディショナ内蔵の発電量表示で代替できる", "計量法の検定を受けた取引用電力量計（認定検定証付）を使用しなければならない", "温度センサーで代替できる", "計量法は太陽光発電の計量に適用されない"],
    answer: "計量法の検定を受けた取引用電力量計（認定検定証付）を使用しなければならない",
    difficulty: "中級",
    explanation: "計量法では商取引（売電）に使用する計量器は経済産業大臣が検定・承認した「取引・証明用計量器」（電力量計の場合は検定合格品）でなければならない。FIT売電に使用するスマートメーター（双方向計量）も計量法に基づく認定品。PCS内蔵の発電量表示は参考値であり取引計量には使用できない。"
  },
  {
    q: "「消防法」に基づく太陽光発電設備に関係する規制として適切なものはどれか。",
    choices: ["太陽光発電のモジュールは危険物扱い", "住宅用でも消防署への届出が義務", "大型蓄電池を設置する場合には消防法の危険物・指定可燃物に係る規制が適用される場合がある", "消防法は太陽光発電に全く適用されない"],
    answer: "大型蓄電池を設置する場合には消防法の危険物・指定可燃物に係る規制が適用される場合がある",
    difficulty: "中級",
    explanation: "消防法上、リチウムイオン電池等の大型蓄電池（設置場所・容量等による）は指定可燃物や危険物に該当する場合があり、消防設備の設置・構造・保管量の制限・消防署への届出等が必要。屋根設置の太陽光モジュールも消防活動の障害になりうるとして消防庁がガイドラインを示している。"
  },
  {
    q: "「廃棄物の処理及び清掃に関する法律（廃棄物処理法）」における太陽光発電モジュールの廃棄について正しいものはどれか。",
    choices: ["モジュールは土壌に埋めて廃棄できる", "住宅用モジュールは一般廃棄物（家庭ゴミ）として廃棄できる", "廃棄物処理法は太陽電池には適用されない", "産業廃棄物として許可業者に委託して適正処理する必要がある"],
    answer: "産業廃棄物として許可業者に委託して適正処理する必要がある",
    difficulty: "初級",
    explanation: "太陽電池モジュールは廃棄物処理法上の産業廃棄物（廃プラスチック類・金属くず・ガラスくず・汚泥等の複合廃棄物）に該当し、産業廃棄物処理業の許可を持つ業者に委託して適正処理する。家庭設置品であっても撤去・廃棄は事業者が行うため産業廃棄物として扱われる。"
  },
  {
    q: "「電気主任技術者制度」において、「自家用電気工作物（500kW未満）」の保安管理として認められている方法として正しいものはどれか。",
    choices: ["電気主任技術者の選任のみ認められている", "電気主任技術者の選任または外部委託（保安管理業務の外部委託承認に基づく）のどちらかが認められている", "施工業者が兼務できる", "500kW未満は保安管理不要"],
    answer: "電気主任技術者の選任または外部委託（保安管理業務の外部委託承認に基づく）のどちらかが認められている",
    difficulty: "中級",
    explanation: "500kW未満の自家用電気工作物（高圧連系太陽光発電等）の保安管理は、電気主任技術者を選任（社内または外部から）するか、電気保安協会等の保安管理業務を委託できる外部委託先に委託するかのどちらかが認められている。500kW以上（設備容量）は原則常駐の主任技術者選任が必要。"
  },
  {
    q: "「労働安全衛生法」における高所作業（太陽光発電施工）に関する規定として正しいものはどれか。",
    choices: ["高所作業に関する規定はない", "高さ2m以上の作業では墜落防止措置（安全帯・足場等）と安全衛生教育が義務付けられている", "屋根作業は例外的に規制されない", "安全帯の使用は任意"],
    answer: "高さ2m以上の作業では墜落防止措置（安全帯・足場等）と安全衛生教育が義務付けられている",
    difficulty: "初級",
    explanation: "労働安全衛生法・労働安全衛生規則により、高さ2m以上での作業は墜落防止措置（安全帯〔墜落制止用器具〕の使用・手すり設置等）が義務付けられる。また作業主任者の選任・安全衛生教育の実施が求められる。太陽光発電の屋根・高所作業は典型的な適用対象。2019年に安全帯規則が改正（フルハーネス型推奨）された。"
  },
  {
    q: "「農地法」において太陽光発電設備を農地に設置する場合に必要な手続きとして正しいものはどれか。",
    choices: ["電力会社の許可のみ必要", "消防署への届出のみ必要", "農地転用許可（4ha以下は農業委員会、4ha超は農林水産大臣）の取得が必要", "特に手続きは不要"],
    answer: "農地転用許可（4ha以下は農業委員会、4ha超は農林水産大臣）の取得が必要",
    difficulty: "中級",
    explanation: "農地に太陽光発電を設置する場合、農地法第4条（農地を農地以外に転用）または第5条（農地を他者に譲渡して転用）に基づく農地転用許可が必要。4ha以下は農業委員会の許可、4ha超は農林水産大臣の許可（都道府県経由）が必要。ソーラーシェアリング（営農型太陽光）では一時転用許可（更新制）の活用も可能。"
  },
  {
    q: "「砂防法・地すべり等防止法・急傾斜地法（いわゆる砂防三法）」と太陽光発電の関係として正しいものはどれか。",
    choices: ["山地への太陽光発電は常に禁止", "砂防三法は海岸にのみ適用される", "砂防指定地・地すべり防止区域・急傾斜地崩壊危険区域への設置は各法に基づく許可が必要", "砂防三法は太陽光発電に全く関係しない"],
    answer: "砂防指定地・地すべり防止区域・急傾斜地崩壊危険区域への設置は各法に基づく許可が必要",
    difficulty: "上級",
    explanation: "大規模な地上設置型太陽光発電を山地・斜面に設置する場合、砂防法（砂防指定地）・地すべり等防止法（地すべり防止区域）・急傾斜地崩壊危険区域の指定区域内では各法の許可（行為許可）が必要。造成工事による斜面の不安定化・土砂流出リスクへの対応が求められる。"
  },
  {
    q: "「環境影響評価法（環境アセスメント）」と大規模太陽光発電の関係について正しいものはどれか。",
    choices: ["全ての太陽光発電が対象", "太陽光発電は環境に影響しないため対象外", "環境アセスメントは都道府県のみが実施する", "2017年改正で一定規模以上（50MW以上等）の太陽光発電が環境アセスメント（環境影響評価）の対象となった"],
    answer: "2017年改正で一定規模以上（50MW以上等）の太陽光発電が環境アセスメント（環境影響評価）の対象となった",
    difficulty: "上級",
    explanation: "2011年の環境影響評価法改正（施行2012年）で大規模な発電所が環境アセスメント対象となり、2017年からは第一種事業（出力5万kW以上の太陽光発電所）が環境アセスメントの必須実施対象に追加された。4〜5万kWの第二種事業はスクリーニング（配慮書手続き）の対象。地域の生態系・景観・土砂流出等の環境影響を評価する。"
  },
  {
    q: "「景観法」と太陽光発電の関係について正しいものはどれか。",
    choices: ["景観地区・重要文化的景観区域等では太陽光発電設備に届出・制限が適用される場合がある", "景観法は太陽光発電に適用されない", "景観法は都市部にのみ適用される", "景観地区でも太陽光発電は自由に設置できる"],
    answer: "景観地区・重要文化的景観区域等では太陽光発電設備に届出・制限が適用される場合がある",
    difficulty: "中級",
    explanation: "景観法に基づいて市町村が定める「景観地区」や「景観計画区域」内では、建築物・工作物の外観等に制限が設けられる場合がある。太陽光発電も届出や許可の対象となりうる。歴史的景観・農村景観が重要な地域では太陽光発電の設置制限が条例等で定められているケースもある。"
  },
  {
    q: "「電気設備に関する技術基準を定める省令（電技省令）」が太陽光発電に求める主な要件として正しいものはどれか。",
    choices: ["電技省令は太陽光発電に適用されない", "FIT買取価格への適合のみ要求する", "高圧連系のみに適用される", "感電・電気火災・電波障害等が生じないよう電気設備を施設する要件"],
    answer: "感電・電気火災・電波障害等が生じないよう電気設備を施設する要件",
    difficulty: "初級",
    explanation: "電技省令は電気設備（発電設備含む）が人体への危害・物件への損傷を与えないよう施設することを基本要件として規定し、感電防止・絶縁・接地・過電流保護・電気機器の安全基準・電気品質等の要件を定める。すべての電圧区分・規模の電気設備に適用され、太陽光発電（直流・交流側）も対象となる。"
  },
  {
    q: "「電気設備の技術基準の解釈」において、「低圧屋内配線（直流600V以下）」に関する規定として正しいものはどれか。",
    choices: ["直流600V以下の屋内配線に関する規定はない", "直流配線には電流制限がなく任意の太さでよい", "施工方法（ケーブル・配線管等の使用要件）・電線の種類・接続方法等が規定されている", "直流配線は屋内に施設できない"],
    answer: "施工方法（ケーブル・配線管等の使用要件）・電線の種類・接続方法等が規定されている",
    difficulty: "上級",
    explanation: "電気設備技術基準の解釈（電技解釈）では低圧電路の施工方法（ケーブル工事・配線管工事等）、使用する電線の種類・規格、電線の接続方法（接続器使用・はんだ等）、電路の保護装置（過電流遮断器等）の設置要件が規定されており、太陽光発電の直流側屋内配線もこれらの規定に従う必要がある。"
  },
  {
    q: "「建築物省エネ法（建築物のエネルギー消費性能の向上に関する法律）」と太陽光発電の関係として正しいものはどれか。",
    choices: ["太陽光発電は建築物省エネ法とは無関係", "建築物省エネ法は工場にのみ適用される", "太陽光発電の設置が省エネ法で義務付けられている", "ZEH・ZEB等の省エネ性能評価や届出において、太陽光発電による創エネ分がエネルギー消費量の計算に考慮される"],
    answer: "ZEH・ZEB等の省エネ性能評価や届出において、太陽光発電による創エネ分がエネルギー消費量の計算に考慮される",
    difficulty: "中級",
    explanation: "建築物省エネ法（2016年施行）に基づく建築物のエネルギー消費性能の評価（BEI・PAL等）では、太陽光発電による創エネ量（kWh/年）がエネルギー消費量から差し引かれ、ZEH（ネット・ゼロ・エネルギー・ハウス）やZEBの認定要件（一次エネルギー消費量ゼロ以下）の達成に重要な役割を果たす。"
  },
  {
    q: "「自然公園法（国立公園・国定公園）」内への太陽光発電設備について正しいものはどれか。",
    choices: ["国立公園内でも太陽光発電は自由に設置できる", "国立公園内の太陽光発電は国が優先的に設置する", "自然公園区域内（特別地域等）への設置には環境大臣・都道府県知事の許可が必要", "自然公園法は建築物にのみ適用される"],
    answer: "自然公園区域内（特別地域等）への設置には環境大臣・都道府県知事の許可が必要",
    difficulty: "上級",
    explanation: "自然公園法により国立公園・国定公園の特別保護地区・第一〜三種特別地域内での工作物の新築・改築は原則として環境大臣（国立公園）または都道府県知事（国定公園）の許可が必要。普通地域では届出が必要。再エネ導入との自然保護のバランスが重要な課題となっている。"
  },
  {
    q: "「森林法」と大規模地上設置型太陽光発電の関係として正しいものはどれか。",
    choices: ["保安林・林地開発許可区域での伐採・開発行為（地上設置のための林地開発）には許可が必要", "森林法の許可は電力会社が代行する", "山林は自由に開発して太陽光発電を設置できる", "森林法は太陽光発電に全く関係しない"],
    answer: "保安林・林地開発許可区域での伐採・開発行為（地上設置のための林地開発）には許可が必要",
    difficulty: "中級",
    explanation: "大規模太陽光発電のために森林（林地）を開発する場合、森林法の林地開発許可（1ha超の場合、都道府県知事）が必要。保安林（水源涵養・土砂流出防備等）内では原則として開発が認められない。また開発による表土裸出・土砂流出・水源涵養機能低下等の問題への対応が求められる。"
  },
  {
    q: "「土地収用法・都市計画法」に関連した太陽光発電の立地規制として正しいものはどれか。",
    choices: ["都市計画法は電力会社が管轄する", "市街化区域では太陽光発電は設置禁止", "都市計画法の開発許可は太陽光発電に関係しない", "市街化調整区域等への一定規模以上の地上設置型太陽光発電には開発許可（都市計画法）が必要な場合がある"],
    answer: "市街化調整区域等への一定規模以上の地上設置型太陽光発電には開発許可（都市計画法）が必要な場合がある",
    difficulty: "上級",
    explanation: "都市計画法の開発許可制度は、市街化調整区域等での一定面積以上の開発行為（土地の形質変更等）に都道府県知事の許可を求める。一定規模以上の地上設置型太陽光発電所の造成工事が開発行為に該当する場合がある。市街化調整区域では開発の抑制が原則で、許可要件が厳しくなる場合がある。"
  },
  {
    q: "「電気工事業の業務の適正化に関する法律（電気工事業法）」において電気工事業者に求められる義務として正しいものはどれか。",
    choices: ["電気工事業者は登録なしに営業できる", "電気工事業の登録または通知・届出が必要で、電気工事士の設置・器具の備え付け・標識掲示等が義務", "電気工事業法はFIT認定業者のみに適用", "電気工事業法は個人事業者に適用されない"],
    answer: "電気工事業の登録または通知・届出が必要で、電気工事士の設置・器具の備え付け・標識掲示等が義務",
    difficulty: "中級",
    explanation: "電気工事業法では、電気工事業を営む者は都道府県知事への登録（または通知・届出）が必要。主任電気工事士（第一種電気工事士または5年経験の第二種電気工事士）を設置し、電気工事士への検査器具の備え付け、事業所への標識掲示、帳簿の備え付け（5年保存）等が義務付けられている。"
  },
  {
    q: "「高圧ガス保安法」と太陽光発電の蓄電池の関係として正しいものはどれか。",
    choices: ["太陽光発電はすべて高圧ガス保安法の対象", "リチウムイオン電池等の取り扱いは高圧ガスに該当しないが、製造・輸送の際に関連する場合がある", "高圧ガス保安法は蓄電池に全く関係しない", "蓄電池は高圧ガス扱いで常時許可が必要"],
    answer: "リチウムイオン電池等の取り扱いは高圧ガスに該当しないが、製造・輸送の際に関連する場合がある",
    difficulty: "上級",
    explanation: "蓄電池（リチウムイオン電池等）は通常の使用状態では高圧ガス保安法の直接の適用対象ではないが、蓄電池の製造工程（電解液充填等）や火災・異常時に可燃性ガスが発生する事象については、関連する化学物質規制・消防法規制が適用される。なおCNG（圧縮天然ガス）蓄電池等は高圧ガス保安法の対象。"
  },
  {
    q: "「地方自治体の条例・ガイドライン」と太陽光発電の関係として正しいものはどれか。",
    choices: ["全国一律の条例が適用される", "条例は住宅用のみに適用される", "地方条例は太陽光発電には適用されない", "地方自治体が再エネ発電設備の設置に関する条例・ガイドラインを制定し、住民説明・届出・設計要件等を求める場合がある"],
    answer: "地方自治体が再エネ発電設備の設置に関する条例・ガイドラインを制定し、住民説明・届出・設計要件等を求める場合がある",
    difficulty: "初級",
    explanation: "複数の都道府県・市区町村が太陽光発電（特に大規模地上設置型）の設置に関する独自の条例やガイドラインを制定し、一定規模以上の設備に対して事前届出・住民説明会の実施・環境配慮・景観配慮・雨水流出抑制対策等を求めるケースが増えている。法令とは別に地域ごとの規制に注意が必要。"
  },
  {
    q: "「電力業界の自主ガイドライン」として太陽光発電設備の火災・感電防止に関するものとして正しいものはどれか。",
    choices: ["ガイドラインは法律より上位の規制", "業界の自主ガイドラインは存在しない", "ガイドラインは電力会社のみに適用される", "JPEA・経済産業省・消防庁等が連携して太陽光発電設備の安全対策（防火・感電防止）のガイドラインを策定している"],
    answer: "JPEA・経済産業省・消防庁等が連携して太陽光発電設備の安全対策（防火・感電防止）のガイドラインを策定している",
    difficulty: "初級",
    explanation: "JPEAや経済産業省・消防庁等の関係機関が太陽光発電設備の安全対策に関するガイドラインを策定・公表している。内容は施工の安全（感電防止・火災対策）、消防活動への配慮（排煙帯確保等）、点検・保守の基準等。法的拘束力はないが業界標準として普及しており、施工品質確保に重要な役割を果たしている。"
  },
  {
    q: "「特定電気用品（電気用品安全法）」に分類されるものとして正しいものはどれか。",
    choices: ["すべての電気用品が特定電気用品", "接続箱のみが特定電気用品", "太陽電池モジュール（通常品）", "パワーコンディショナ内部の変圧器等（特定電気用品）に該当する部品類"],
    answer: "パワーコンディショナ内部の変圧器等（特定電気用品）に該当する部品類",
    difficulty: "上級",
    explanation: "電気用品安全法では安全上特に危険性が高い「特定電気用品」（◇PSEマーク）と「特定電気用品以外の電気用品」（○PSEマーク）に分類される。パワーコンディショナは一般的に「特定電気用品以外の電気用品（○PSE）」に分類されるが、内部構成によって「特定電気用品」該当部品を含む場合がある。モジュールも2012年から「特定電気用品以外」に指定された。"
  },
  {
    q: "「再エネ特措法の事業計画認定取り消し事由」として法令に規定されているものはどれか。",
    choices: ["認定要件への違反・虚偽申請・指導是正命令への不服従などの場合", "売電収入が想定を下回った場合", "パワーコンディショナが故障した場合", "モジュールのメーカーを変更した場合"],
    answer: "認定要件への違反・虚偽申請・指導是正命令への不服従などの場合",
    difficulty: "中級",
    explanation: "再エネ特措法に基づく認定取り消し事由として、認定要件への違反（設備仕様変更の無届・不適切な事業実施）、申請書類の虚偽記載、経済産業大臣の指導・命令に従わない場合等が規定されている。適切な情報更新（設備変更の届出）・適正な事業運営・法令遵守が認定維持の条件。"
  },
  {
    q: "「電気事業法の保安規制」において「自家用電気工作物の工事・維持・運用」に関する規定として正しいものはどれか。",
    choices: ["保安規制は大手電力会社のみに適用", "電気主任技術者または委託先の指揮監督のもとで工事・維持・運用を行う義務がある", "第二種電気工事士があれば自由に工事できる", "自家用電気工作物の工事に規制はない"],
    answer: "電気主任技術者または委託先の指揮監督のもとで工事・維持・運用を行う義務がある",
    difficulty: "中級",
    explanation: "電気事業法では自家用電気工作物の所有者・管理者に、電気主任技術者（または外部委託先）の指揮監督のもとで工事・維持・運用を行う義務があり、主任技術者への技術上の管理義務が課せられる。電気工事士は個別工事の施工資格だが、自家用電気工作物では主任技術者の監督下での工事となる。"
  },
  {
    q: "「電波法」と太陽光発電の関係として正しいものはどれか。",
    choices: ["パワーコンディショナの高調波・ノイズが他の無線通信（TV・ラジオ等）に影響（電波障害）を与えた場合、電波法上の問題になりえる", "太陽光発電は電波法に全く関係しない", "太陽光発電に電波法が適用されるのは500kW以上のみ", "電波法はパワーコンディショナの製造メーカーのみに適用"],
    answer: "パワーコンディショナの高調波・ノイズが他の無線通信（TV・ラジオ等）に影響（電波障害）を与えた場合、電波法上の問題になりえる",
    difficulty: "中級",
    explanation: "パワーコンディショナのインバータ動作はスイッチングノイズ（電磁波）を発生させることがあり、近隣の無線通信（アマチュア無線・地上デジタル放送等）に影響（電波障害）を与えることがある。このような場合は電波法の不法電波発射に係る問題になりうるため、電磁ノイズ対策（シールドケーブル・フィルター）が重要。"
  },
  {
    q: "「住宅の品質確保の促進等に関する法律（品確法）」と太陽光発電の関係として正しいものはどれか。",
    choices: ["新築住宅の太陽光発電設備は、住宅の瑕疵担保責任（構造・防水等）の範囲に含まれる場合があり、施工品質に関係する", "品確法はモジュールの性能保証のみを規定", "品確法は太陽光発電に全く関係しない", "品確法は既存住宅にのみ適用される"],
    answer: "新築住宅の太陽光発電設備は、住宅の瑕疵担保責任（構造・防水等）の範囲に含まれる場合があり、施工品質に関係する",
    difficulty: "中級",
    explanation: "住宅の品質確保の促進等に関する法律（品確法）は新築住宅の構造・雨水侵入防止等に係る10年間の瑕疵担保責任を規定している。屋根設置の太陽光発電工事の不具合（架台固定による雨漏り等）が構造上の問題や雨水侵入に関係する場合は品確法の瑕疵担保責任の範囲で問題になりえる。"
  },
  {
    q: "「公正取引委員会の競争法（独禁法）」と太陽光発電の関係として正しいものはどれか。",
    choices: ["独禁法は太陽光発電に全く関係しない", "発電事業者間の価格カルテルや不公正な取引方法（系統接続の差別的扱い等）は独禁法の対象になりえる", "独禁法はFIT価格の決定に使用される", "電力会社は独禁法の適用除外"],
    answer: "発電事業者間の価格カルテルや不公正な取引方法（系統接続の差別的扱い等）は独禁法の対象になりえる",
    difficulty: "上級",
    explanation: "独占禁止法は市場競争の維持・促進を目的とし、電力市場においても発電事業者間の価格カルテル・市場支配的地位の濫用・系統接続における不公正な差別的取扱い等が問題になりえる。電力システム改革後は公正取引委員会と経済産業省が電力市場の競争監視を強化している。"
  },
  {
    q: "「特定製品に係るフロン類の回収及び破壊の実施の確保等に関する法律（フロン排出抑制法）」と太陽光発電の関係として正しいものはどれか。",
    choices: ["空調設備と太陽光発電を組み合わせたシステムで、空調機の廃棄時にフロン回収が必要になる場合がある", "フロン排出抑制法はパワーコンディショナに適用", "太陽光発電にフロン排出抑制法は全く関係しない", "太陽電池モジュールにはフロンが含まれている"],
    answer: "空調設備と太陽光発電を組み合わせたシステムで、空調機の廃棄時にフロン回収が必要になる場合がある",
    difficulty: "上級",
    explanation: "フロン排出抑制法はフロン類（HFC・CFC等）を冷媒として使用する冷凍空調機器（業務用）の廃棄時にフロンを回収する義務を規定。太陽光発電設備自体にはフロンは含まれないが、工場・施設に太陽光発電と空調設備を組み合わせたシステムでは、空調機の廃棄にフロン排出抑制法が適用される。"
  },
  {
    q: "「電気設備技術基準の解釈」における「太陽電池モジュールの接続」に関する要件として正しいものはどれか。",
    choices: ["太陽電池の接続に特別な要件はない", "直列接続時の最大電圧がシステム設計電圧を超えないこと、逆流防止措置等の要件が規定されている", "モジュールの並列数に上限は設定されていない", "接続規制は屋外設置のみ対象"],
    answer: "直列接続時の最大電圧がシステム設計電圧を超えないこと、逆流防止措置等の要件が規定されている",
    difficulty: "上級",
    explanation: "電技解釈では太陽電池モジュールの電気的接続に関し、直列接続による最大電圧が設計上の許容電圧を超えないこと、逆流防止措置（逆流防止ダイオード等）、接続箱の設置・保護等について規定している。PCS入力定格との整合、施工管理基準への適合が求められる。"
  },
  {
    q: "「電気工事士法第3条」において「電気工事士等でなければ従事できない」作業として誤りはどれか。",
    choices: ["パワーコンディショナの接続（電気配線）工事", "電灯・コンセントの配線工事", "太陽電池モジュールの清掃・目視点検", "分電盤の設置・配線工事"],
    answer: "太陽電池モジュールの清掃・目視点検",
    difficulty: "中級",
    explanation: "電気工事士法第3条は「電気工事士等でなければ電気工事に従事してはならない」と規定するが、電気工事に該当しない作業（モジュール清掃・目視点検・設備記録読み取り等）は資格不要。パワーコンディショナ接続・電灯コンセント配線・分電盤設置はいずれも電気工事に該当し電気工事士が必要。清掃・点検のみの作業は電気工事に該当しない。"
  },
  {
    q: "「再生可能エネルギー電気の利用の促進に関する特別措置法（再エネ特措法）」の2022年改正で追加された主な制度として正しいものはどれか。",
    choices: ["太陽光発電の認定廃止", "FIT価格の引き上げ", "全量売電の廃止", "FIP（フィードインプレミアム）制度の創設と廃棄費用積立義務・地域共生要件の強化"],
    answer: "FIP（フィードインプレミアム）制度の創設と廃棄費用積立義務・地域共生要件の強化",
    difficulty: "中級",
    explanation: "2022年（令和4年）の再エネ特措法の主な改正内容は、①FIP制度の創設（FITからFIPへの移行促進）②廃棄費用積立義務化③地域共生・周辺環境への配慮要件の強化④情報開示・標識掲示の義務化等。"
  },
  {
    q: "「電気設備の技術基準の解釈（電技解釈）」第147条で規定される「低圧連系における保護リレー要件」として正しいものはどれか。",
    choices: ["過電圧保護・不足電圧保護・周波数上下限保護・単独運転防止機能等が規定されている", "単独運転防止機能は任意", "保護リレーは電力会社が設置する", "低圧連系には保護リレーが不要"],
    answer: "過電圧保護・不足電圧保護・周波数上下限保護・単独運転防止機能等が規定されている",
    difficulty: "上級",
    explanation: "電技解釈第147条（小規模発電設備との接続）等では低圧系統連系において、PCSに過電圧保護（OVP）・不足電圧保護（UVP）・過周波数保護（OFP）・不足周波数保護（UFP）・逆電力保護・単独運転防止機能（能動・受動の2方式）を備えることを規定している。"
  },
  {
    q: "「個人情報保護法」と太陽光発電モニタリングシステムの関係として正しいものはどれか。",
    choices: ["住宅の電力消費・発電データは居住者の生活パターンを反映する個人情報になりえるため適切な管理が必要", "発電データの利用に制限はない", "個人情報保護法は事業者のみに適用される", "太陽光発電データは個人情報に該当しない"],
    answer: "住宅の電力消費・発電データは居住者の生活パターンを反映する個人情報になりえるため適切な管理が必要",
    difficulty: "中級",
    explanation: "住宅の時間別電力消費・発電データは居住者の生活習慣（在宅時間・家電使用パターン等）を反映した個人情報になりえる。スマートメーターデータや家庭用モニタリングシステムのデータ取り扱いには、個人情報保護法に基づく適切な管理（目的外使用禁止・第三者提供制限等）が求められる。"
  },
  {
    q: "「特定電気工事（自家用電気工作物の電気工事）」の施工に必要な資格として正しいものはどれか。",
    choices: ["第一種電気工事士または認定電気工事従事者（低圧部分のみ）", "電気主任技術者が施工する必要がある", "特別な資格は不要", "第二種電気工事士のみで施工可能"],
    answer: "第一種電気工事士または認定電気工事従事者（低圧部分のみ）",
    difficulty: "上級",
    explanation: "自家用電気工作物（高圧受電設備含む）の電気工事は「特定電気工事」と「特定電気工事以外の自家用電気工事」に分かれる。高圧部分の工事は第一種電気工事士が必要。低圧部分（600V以下）の工事は第一種電気工事士または「認定電気工事従事者（第二種電気工事士が取得できる追加認定）」が担当できる。"
  },
  {
    q: "「絶縁監視装置（地絡検出装置）」の設置義務について正しいものはどれか。",
    choices: ["絶縁監視装置の設置は任意", "住宅用を含むすべての太陽光発電に設置義務がある", "高圧以上で接続する自家用電気工作物には地絡検出・遮断装置の設置が必要", "低圧連系では絶縁監視装置は不要"],
    answer: "高圧以上で接続する自家用電気工作物には地絡検出・遮断装置の設置が必要",
    difficulty: "上級",
    explanation: "電技解釈では高圧以上で受電・連系する自家用電気工作物（高圧連系太陽光発電含む）に地絡発生時の自動遮断装置（地絡保護リレー）の設置を義務付けている。地絡を検出して遮断器を動作させ、電路の地絡継続による感電・火災を防止する。低圧連系では漏電遮断器（ELCB）が対応する。"
  },
  {
    q: "「電力系統への連系基準（JEAC9701系統連系技術要件ガイドライン）」が規定する「低圧連系の電力品質要件」として正しいものはどれか。",
    choices: ["太陽光発電は電力品質要件の対象外", "品質要件の基準値は各電力会社が独自に設定できる", "電圧変動・高調波・力率等の品質要件（高調波電流上限値・力率0.85以上等）が規定されている", "電力品質要件は大規模発電所のみ"],
    answer: "電圧変動・高調波・力率等の品質要件（高調波電流上限値・力率0.85以上等）が規定されている",
    difficulty: "上級",
    explanation: "系統連系規程（JEAC 9701）は太陽光発電を含む分散型電源の系統連系に関して、電圧変動（逆潮流による電圧上昇の抑制）・高調波電流の上限値（THD・各次高調波電流）・力率（0.85以上の遅れ進み）・単独運転防止等の電力品質要件を規定している。電力会社はこの規程に基づいて連系条件を審査する。"
  },
  {
    q: "「保安監督部（経済産業省地方局）」の電気保安における役割として正しいものはどれか。",
    choices: ["自家用電気工作物の保安規制監督（電気事故報告受理・立入検査・行政処分等）", "太陽電池モジュールの認定", "工事業者への施工指導", "FIT買取価格の設定"],
    answer: "自家用電気工作物の保安規制監督（電気事故報告受理・立入検査・行政処分等）",
    difficulty: "中級",
    explanation: "経済産業省産業保安監督部（産業保安監督部・各経済産業局）は電気事業法に基づく電気保安の行政機関で、自家用電気工作物の保安規制を監督する。電気事故（火災・感電・異常電圧等）が発生した場合の事故報告受理、立入検査による設備・保安管理の適正確認、違反事業者への行政処分（改善命令等）を実施する。"
  },
  {
    q: "「再エネ特措法の認定」と「建築確認申請」「農地転用許可」等の法令許認可の関係として正しいものはどれか。",
    choices: ["すべての許認可はワンストップで申請できる", "再エネ特措法認定は発電制度上の認定であり、建築確認・農地転用等の他法令上の許認可は別途必要", "電力会社の承認があれば他の許認可は不要", "再エネ特措法の認定を受ければ他の許認可は不要"],
    answer: "再エネ特措法認定は発電制度上の認定であり、建築確認・農地転用等の他法令上の許認可は別途必要",
    difficulty: "中級",
    explanation: "再エネ特措法の事業計画認定（FIT・FIP）は発電制度上の認定であり、設置に必要な建築確認申請・農地転用許可・林地開発許可・環境アセスメント・系統連系申し込み等の他法令に基づく許認可・手続きとは独立して行われる。認定事業者は事業実施に必要な関係法令の許認可をすべて自ら取得する義務がある。"
  },
  {
    q: "「太陽光発電の事業計画認定（FIT）」の「事後変更」に必要な手続きとして正しいものはどれか。",
    choices: ["設備仕様・設置場所等の変更には「変更認定申請」または「変更届出」が必要", "軽微な変更でも常に変更認定申請が必要", "認定後は変更不可", "変更は電力会社に申告すればよい"],
    answer: "設備仕様・設置場所等の変更には「変更認定申請」または「変更届出」が必要",
    difficulty: "中級",
    explanation: "事業計画認定後に設備仕様（容量・設置場所・機器等）を変更する場合、変更の種類と程度によって「変更認定申請（変更前に承認が必要な軽微でない変更）」または「変更届出（軽微な変更は届出のみ）」が必要。無届けの重要変更は認定取り消し事由になりえるため、変更計画がある場合は事前に確認が必要。"
  },
  {
    q: "「特定計量器（電力量計）」の「有効期限（検定証印の有効期間）」について正しいものはどれか。",
    choices: ["有効期限は電力会社が設定する", "有効期限はなく永久に使用できる", "電力量計の検定証印には有効期間（通常5年または10年等）があり、期限超過のものは取引計量に使用できない", "取引計量に有効期限の要件はない"],
    answer: "電力量計の検定証印には有効期間（通常5年または10年等）があり、期限超過のものは取引計量に使用できない",
    difficulty: "中級",
    explanation: "計量法に基づく取引用電力量計（電力量計）の検定証印（検定合格の証印）には有効期間が設定されている。電力量計の検定有効期間は原則として5年（一部は10年）で、期限が切れたものは取引・証明用途に使用できず再検定が必要。電力会社（一般送配電事業者）がスマートメーターの管理・更新を行う。"
  },
  {
    q: "「グリーンエネルギー証書（J-クレジット等）」と太陽光発電の関係として正しいものはどれか。",
    choices: ["太陽光発電の環境価値（CO₂削減量）をクレジット化して売買する仕組みで、企業のカーボンニュートラル宣言等に活用できる", "グリーンエネルギー証書はFIT制度の一部", "グリーン証書は政府が強制的に発行する", "グリーン証書があれば系統連系申請が不要"],
    answer: "太陽光発電の環境価値（CO₂削減量）をクレジット化して売買する仕組みで、企業のカーボンニュートラル宣言等に活用できる",
    difficulty: "中級",
    explanation: "J-クレジット（国内クレジット制度）・グリーン電力証書・非化石証書等は太陽光発電等の再エネで発電した電力の環境価値（CO2排出削減・非化石由来）をクレジット・証書として認証し売買できる仕組み。企業がScopeのCO2削減・RE100（再エネ100%）目標達成に購入・活用できる。FITを受けた電力は非化石証書として制度化されている。"
  },
  {
    q: "「消費者契約法」と太陽光発電の販売・契約に関係する問題として正しいものはどれか。",
    choices: ["不実告知（虚偽の発電量・収入見込みの提示）等の不当な勧誘で締結された消費者契約は取り消せる", "消費者契約法に違反しても取り消しはできない", "消費者契約法はFIT制度の管轄下にある", "消費者契約法は事業者間取引に適用される"],
    answer: "不実告知（虚偽の発電量・収入見込みの提示）等の不当な勧誘で締結された消費者契約は取り消せる",
    difficulty: "初級",
    explanation: "消費者契約法は事業者と消費者の間の契約に適用され、不実告知（虚偽の事実を告げる行為、例：実際より大幅に高い発電量・収益の提示）・断定的判断の提供（確実に利益が出るなどの断言）・不当な勧誘によって締結した契約は消費者が取り消せる権利を保護する。太陽光発電の訪問販売等でのトラブルに関係。"
  },
  {
    q: "「特定商取引法（特商法）」と太陽光発電の販売の関係として正しいものはどれか。",
    choices: ["特商法は太陽光発電の販売に適用されない", "特商法に違反してもクーリングオフは不可", "訪問販売・電話勧誘等による太陽光発電の販売は特商法の規制を受け、書面交付・クーリングオフ等の消費者保護が適用される", "特商法はオンライン販売にのみ適用される"],
    answer: "訪問販売・電話勧誘等による太陽光発電の販売は特商法の規制を受け、書面交付・クーリングオフ等の消費者保護が適用される",
    difficulty: "初級",
    explanation: "特定商取引法（特商法）は訪問販売・電話勧誘販売・通信販売等の販売形態を規制する法律。訪問販売等による太陽光発電の販売には、契約書面の交付義務・クーリングオフ権（8日間）・不当勧誘の禁止・誇大広告の禁止等が適用される。消費者庁が違反業者に対して業務停止命令等を行使する。"
  },
  {
    q: "「割賦販売法」と太陽光発電の分割払い（クレジット）販売の関係として正しいものはどれか。",
    choices: ["割賦販売法は銀行ローンにのみ適用", "割賦販売（クレジット）で太陽光発電を購入した場合、割賦販売法に基づく取り消しが可能な場合がある（抗弁権の接続等）", "割賦販売法は太陽光発電に適用されない", "クレジット払いは常に違法"],
    answer: "割賦販売（クレジット）で太陽光発電を購入した場合、割賦販売法に基づく取り消しが可能な場合がある（抗弁権の接続等）",
    difficulty: "中級",
    explanation: "割賦販売法はクレジット（分割払い）による商品・サービスの取引を規制する法律。太陽光発電をクレジット契約で購入した場合、販売会社との契約に問題（詐欺・虚偽説明等）があった場合は、クレジット会社への支払いを拒絶できる「抗弁権の接続」を行使できる場合がある。訪問販売での高額商品の分割払い契約で重要。"
  },
  {
    q: "「独立行政法人製品評価技術基盤機構（NITE）」と太陽光発電の関係として正しいものはどれか。",
    choices: ["NITEはFIT認定機関", "NITEは製品安全情報の収集・分析・公表を行い、太陽光発電関連の事故・不具合情報も取り扱う", "NITEは太陽電池モジュールの製造を認可する", "NITEは電気工事士の資格試験機関"],
    answer: "NITEは製品安全情報の収集・分析・公表を行い、太陽光発電関連の事故・不具合情報も取り扱う",
    difficulty: "中級",
    explanation: "NITE（ナイト：独立行政法人製品評価技術基盤機構）は消費生活用製品・電気用品等の製品安全に関する調査・評価・情報提供を行う機関。太陽光発電システム（モジュール・PCS・蓄電池等）の事故・不具合情報を収集・分析し、消費者・業界への情報提供・注意喚起を行う。重大製品事故の報告窓口の役割も担う。"
  },
  {
    q: "「2022年改正再エネ特措法」における「地域共生要件」の内容として正しいものはどれか。",
    choices: ["地域共生要件は容量10MW以上にのみ適用", "地域共生要件はFIP事業のみに適用", "地域住民が全員賛成しなければ認定されない", "事業実施にあたって周辺地域への説明・合意形成・景観・環境への配慮を適切に行うことが認定要件に含まれる"],
    answer: "事業実施にあたって周辺地域への説明・合意形成・景観・環境への配慮を適切に行うことが認定要件に含まれる",
    difficulty: "中級",
    explanation: "2022年改正再エネ特措法では、事業計画認定要件に地域との共生に関する要件が強化された。具体的には地域への適切な情報開示・説明（標識掲示・事業情報公開）・騒音・景観・生態系への配慮・地域との合意形成への努力が求められる。特定の規模以上では地域の意見聴取が推奨・求められる場合もある。"
  },
  {
    q: "「電気工事士法施行規則」に規定される「軽微な電気工事」（電気工事士でなくても行える作業）として正しいものはどれか。",
    choices: ["600V以下の電気機器の端子への電線接続（差し込みコネクターを除く固定配線）", "コンセントの取替え", "分電盤への配線工事", "電球・ランプの交換"],
    answer: "電球・ランプの交換",
    difficulty: "中級",
    explanation: "電気工事士法の「軽微な工事」（電気工事士資格不要）の例には、電球・ランプの交換、玩具用変圧器の接続、電力量計の取付け（電力会社が行う場合）などが含まれる。一方、コンセントの取替え・分電盤への配線は「電気工事」に該当し電気工事士が必要。太陽電池モジュールの配線も電気工事に該当する。"
  },
  {
    q: "「電気設備の技術基準の解釈」において「低圧電路の絶縁性能」で規定される最低絶縁抵抗値について正しいものはどれか（300V以下で対地電圧150V超の場合）。",
    choices: ["0.1MΩ以上", "1.0MΩ以上", "0.2MΩ以上", "10MΩ以上"],
    answer: "0.2MΩ以上",
    difficulty: "上級",
    explanation: "電技解釈では低圧電路の絶縁抵抗最低値として、対地電圧150V以下：0.1MΩ以上、対地電圧150V超300V以下：0.2MΩ以上、300V超：0.4MΩ以上と規定されている。太陽光発電の低圧交流側（単相3線式100/200V、対地電圧150V超）の検査値は0.2MΩ以上が基準となる。"
  },
  {
    q: "「再エネ特措法に基づく標識掲示義務」について正しいものはどれか。",
    choices: ["標識は電力会社が設置する", "標識掲示義務は2030年から施行", "認定を受けた再エネ発電設備（一定規模以上）は設備の見えやすい場所に認定番号等を記載した標識を掲示する義務がある", "10kW未満の住宅用は標識掲示不要"],
    answer: "認定を受けた再エネ発電設備（一定規模以上）は設備の見えやすい場所に認定番号等を記載した標識を掲示する義務がある",
    difficulty: "中級",
    explanation: "2022年改正再エネ特措法では、認定を受けた再エネ発電設備（一定規模以上）の設置者に対し、設備の見やすい場所への標識掲示義務が設けられた。標識には認定番号・事業者名・設備容量・連絡先等を記載し、地域住民や消防機関等が設備情報を確認できるようにすることが目的。"
  },
  {
    q: "「産業廃棄物管理票（マニフェスト）制度」における太陽光発電廃棄物の取り扱いとして正しいものはどれか。",
    choices: ["マニフェストは廃棄後に作成する", "産業廃棄物を処理業者に委託する場合、マニフェスト（産業廃棄物管理票）を交付して廃棄物の流れを追跡・管理する義務がある", "太陽光発電廃棄物はマニフェスト不要", "マニフェストは電力会社が管理する"],
    answer: "産業廃棄物を処理業者に委託する場合、マニフェスト（産業廃棄物管理票）を交付して廃棄物の流れを追跡・管理する義務がある",
    difficulty: "初級",
    explanation: "廃棄物処理法では産業廃棄物を処理業者に委託する際、排出事業者はマニフェスト（産業廃棄物管理票）を交付し、収集・運搬・処分の各段階で伝票が返送されることで廃棄物の適正処理を追跡・確認する義務がある。廃棄太陽電池モジュールも産業廃棄物として、委託処理の際には電子マニフェストまたは紙マニフェストの使用が義務。"
  },
  {
    q: "「電気関係報告規則」における電気事故報告の対象として正しいものはどれか。",
    choices: ["電力会社のみが報告義務を持つ", "感電死傷事故・電気火災・主要設備の損傷等の重大事故は産業保安監督部への報告が義務", "小さな短絡もすべて報告義務あり", "報告は任意"],
    answer: "感電死傷事故・電気火災・主要設備の損傷等の重大事故は産業保安監督部への報告が義務",
    difficulty: "中級",
    explanation: "電気関係報告規則により、電気事業者・自家用電気工作物の設置者は、感電死傷（死亡または入院）・電気火災・主要設備の損傷等の「重大な電気事故」が発生した場合、産業保安監督部（経済産業局）へ所定の書式で報告する義務がある。太陽光発電所での感電事故・モジュール火災等も対象になりえる。"
  },
  {
    q: "「浮体式太陽光発電（ため池設置）」の関連法規として農業用ため池に特有の規制について正しいものはどれか。",
    choices: ["農業用ため池は完全に規制対象外", "農業用ため池を管理する土地改良区・農業委員会等の許可・同意が必要な場合がある", "浮体式は電力会社の許可のみ必要", "水面への設置に法律は関係しない"],
    answer: "農業用ため池を管理する土地改良区・農業委員会等の許可・同意が必要な場合がある",
    difficulty: "上級",
    explanation: "農業用ため池への浮体式太陽光発電の設置は、農業用ため池の管理者（土地改良区・市区町村等）の許可・同意が必要。農業用ため池及び水路の保全管理に関する法律（ため池保全法）が施行（2019年）され、届出・工事許可等の規定が整備された。農地法・水利権・自治体条例等も確認が必要。"
  },
  {
    q: "「防衛施設（自衛隊基地・米軍基地）周辺」への大規模太陽光発電の設置に関する法規として正しいものはどれか。",
    choices: ["防衛施設から1km以内は設置禁止", "防衛施設周辺への設置に特別な規制はない", "自衛隊が全ての設備を管理する", "防衛関係施設の周辺（経済安全保障推進法等）では安全保障上の観点から規制や区画が行われる場合がある"],
    answer: "防衛関係施設の周辺（経済安全保障推進法等）では安全保障上の観点から規制や区画が行われる場合がある",
    difficulty: "上級",
    explanation: "2022年施行の経済安全保障推進法等により、自衛隊・米軍基地・重要インフラ施設の周辺における特定の外国資本による土地・設備取得が審査・規制対象となっている。防衛関係施設の近傍での大規模太陽光発電の設置、特に外国資本が関与する場合には安全保障上の規制が適用されうる。"
  },
  {
    q: "「電気工事士法第4条の2」における「認定電気工事従事者」が行える作業の範囲として正しいものはどれか。",
    choices: ["自家用電気工作物の低圧部分（600V以下）の電気工事（ネオン・非常用予備電源を除く）", "高圧受電設備のすべての工事", "一般用電気工作物のすべての工事", "屋外配線工事のみ"],
    answer: "自家用電気工作物の低圧部分（600V以下）の電気工事（ネオン・非常用予備電源を除く）",
    difficulty: "上級",
    explanation: "認定電気工事従事者（経済産業大臣認定）は自家用電気工作物の低圧部分（600V以下の電気設備）の電気工事に従事できる。ネオン工事・非常用予備電源工事は別途資格が必要。高圧設備の工事は第一種電気工事士が必要。第二種電気工事士が認定電気工事従事者認定証を取得することで自家用低圧工事に対応できる。"
  },
  {
    q: "「電気工事業者の主任電気工事士」に関する電気工事業法の要件として正しいものはどれか。",
    choices: ["登録電気工事業者は事業所ごとに主任電気工事士（第一種電気工事士または一定経験の第二種電気工事士）を置く義務がある", "主任電気工事士は施工後に選任すればよい", "主任電気工事士は1社に1人いればよい", "主任電気工事士は任意配置で義務ではない"],
    answer: "登録電気工事業者は事業所ごとに主任電気工事士（第一種電気工事士または一定経験の第二種電気工事士）を置く義務がある",
    difficulty: "中級",
    explanation: "電気工事業法により、登録電気工事業者は事業所ごとに主任電気工事士を置く義務がある。主任電気工事士の要件は第一種電気工事士、または第二種電気工事士で3年以上の実務経験を持つ者。主任電気工事士は従業員の電気工事士に対する指導・管理の責任を担う。欠員が生じた場合は速やかに補充が必要。"
  },
  {
    q: "「電気設備の技術基準（電技省令）」に規定される「電気設備による障害の防止」として正しいものはどれか。",
    choices: ["太陽光発電は電波障害を引き起こさない", "電気設備から発生する電磁波・電波が他の通信設備・機器に障害を与えないよう設計・施工する要件がある", "電波障害の防止義務は電力会社のみ", "電気設備は電磁障害・電波障害・通信障害を引き起こしてはならない義務はない"],
    answer: "電気設備から発生する電磁波・電波が他の通信設備・機器に障害を与えないよう設計・施工する要件がある",
    difficulty: "中級",
    explanation: "電技省令第16条等では、電気設備は他の通信設備・機器への電磁誘導や電波障害を防止するよう施設することが求められる。パワーコンディショナのインバータ動作による高調波ノイズ（スイッチングノイズ）が近隣のAM・FM・短波ラジオや無線通信に影響を与えることがあるため、ノイズ対策（EMI対策・シールド・フィルター）が重要。"
  },
  {
    q: "「特定自家用電気工作物（500kW以上）」への電気主任技術者選任要件として正しいものはどれか。",
    choices: [
      "第三種電気主任技術者の選任で可（外部委託も可）",
      "電気主任技術者の資格区分は容量のみで決まる",
      "5万V以上は第一種電気主任技術者が必要、5万V未満（受電電圧）は第二種、電圧6600Vの自家用は第三種電気主任技術者が担当できる",
      "500kW以上は電気主任技術者不要"
    ],
    answer: "5万V以上は第一種電気主任技術者が必要、5万V未満（受電電圧）は第二種、電圧6600Vの自家用は第三種電気主任技術者が担当できる",
    difficulty: "上級",
    explanation: "電気主任技術者の種別選任要件は受電（または最高運転電圧）により異なる。受電電圧が17万V以上は第一種、5万V〜17万V未満は第二種、5万V未満（一般的な高圧6600V含む）は第三種電気主任技術者が必要。500kW以上の自家用では原則として常勤の選任が必要（外部委託不可の場合あり）。"
  }
];

function generateLawQuestions() {
  return LAW_SPECS.map((spec) => {
    const choiceExplanations = {};
    choiceExplanations[spec.answer] = { result: "正解", reason: spec.explanation };
    spec.choices.forEach((c) => {
      if (c === spec.answer) return;
      choiceExplanations[c] = { result: "不正解", reason: `正解は「${spec.answer}」。${spec.explanation}` };
    });

    return {
      id: nextQuestionId("h"),
      mode: "knowledge",
      category: "関係法規",
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
   第7章 維持管理・O&M（製品データに依存しない静的問題）
   出題範囲：定期点検・清掃・故障診断（IR/EL/IV検査）・性能比(PR)
   モニタリング・予防保全とプロアクティブ保全・O&M契約とSLA・保険・
   PCS/モジュール劣化と交換の目安・災害/緊急時対応・廃棄と撤去。
   ================================================================ */
const OM_SPECS = [
  {
    q: "太陽光発電システムのO&M（運用・保守）の目的として最も適切なものはどれか。",
    choices: ["電力会社への報告書を作成するため", "システムの設計変更を行うため", "モジュールの変換効率を新品同様に回復させるため", "長期にわたって安定した発電量を維持し、設備の安全性と経済性を確保するため"],
    answer: "長期にわたって安定した発電量を維持し、設備の安全性と経済性を確保するため",
    difficulty: "初級",
    explanation: "太陽光発電のO&M（Operation and Maintenance：運用・保守）の目的は、20〜30年の長期運用を通じて安全・安定した発電を維持し、発電量の最大化・損失の最小化（損失発電量の早期回復）・設備寿命の延長・投資収益率の確保を実現すること。定期点検・清掃・故障対応・データ管理が主要な活動。"
  },
  {
    q: "太陽光発電の「定期点検」の実施頻度として、経済産業省が推奨するガイドラインの標準的な内容として正しいものはどれか。",
    choices: ["4年に1回程度（または年1回）の定期的な点検が推奨されている", "定期点検に法律上の規定はない", "設置後1回のみ実施すればよい", "3ヶ月に1回の点検が義務付けられている"],
    answer: "4年に1回程度（または年1回）の定期的な点検が推奨されている",
    difficulty: "中級",
    explanation: "経済産業省の「太陽光発電設備の保守点検ガイドライン」では、設置後の定期点検として4年に1回程度（または日常点検を組み合わせ年1回程度）の目安が示されている。自家用電気工作物（高圧連系）は電気主任技術者または委託先による保安管理の周期規定がある。低圧系統では明確な法的頻度要件はないが適切な点検が推奨される。"
  },
  {
    q: "太陽光発電の「パフォーマンス評価」で使用される主要指標「PR（Performance Ratio：性能比）」の解釈として正しいものはどれか。",
    choices: ["PRはモジュール変換効率のみを示す指標", "PRは1.0以上が通常の値", "PRが高いほどシステム効率が高く損失が小さい（良好な状態）", "PRが高いほどシステムの損失が大きい"],
    answer: "PRが高いほどシステム効率が高く損失が小さい（良好な状態）",
    difficulty: "中級",
    explanation: "PR（性能比）＝実際の発電量÷（日射量×システム容量）で算出される。PR値が高い（0.8〜0.85程度が良好）ほど損失が少なく高効率に発電できている。PRが低下している場合はシステムに問題がある可能性（汚れ・故障・劣化・ミスマッチ等）を示す。定期的なPR監視が異常検知の基本指標となる。"
  },
  {
    q: "太陽光発電モジュールの「清掃（洗浄）」が必要な理由として最も適切なものはどれか。",
    choices: ["清掃は法律で義務付けられているため", "清掃することでモジュールの変換効率が新品以上になるため", "汚れ・鳥のフン・花粉・砂塵等による透過率低下が出力損失につながるため", "モジュールの外観を美しく保つため"],
    answer: "汚れ・鳥のフン・花粉・砂塵等による透過率低下が出力損失につながるため",
    difficulty: "初級",
    explanation: "モジュール表面の汚れ（ほこり・花粉・鳥のフン・黄砂等）は光の透過を妨げ発電出力を低下させる（汚れ損失：年間1〜5%程度）。清掃によりモジュール表面の光透過率を回復させ、発電量損失を低減できる。特に鳥のフンは局所的に汚れが集中してホットスポットの原因にもなる。雨で自然に洗浄される効果もある（傾斜角が大きいほど有効）。"
  },
  {
    q: "太陽光発電の「故障診断」で「パワーコンディショナのアラーム」が発生した場合の対応として正しいものはどれか。",
    choices: ["取扱説明書・エラーコード一覧でエラー内容を確認し、必要に応じて専門業者に連絡する", "PCSの電源を完全に切って放置する", "アラームは無視してよい", "すぐに機器を分解して修理する"],
    answer: "取扱説明書・エラーコード一覧でエラー内容を確認し、必要に応じて専門業者に連絡する",
    difficulty: "初級",
    explanation: "PCSのアラーム（エラーコード）が発生した場合、まず取扱説明書・エラーコード一覧表でエラーの内容（過電圧・地絡・系統異常・内部故障等）を確認する。自動復帰するものもあるが、継続する場合や重大エラーの場合は専門業者（メーカーサービス・O&M業者）に連絡して点検・修理を依頼する。"
  },
  {
    q: "太陽光発電の「発電量の経年変化」を評価する際に参考にする指標として正しいものはどれか。",
    choices: ["電力会社のスマートメーター検針値のみ", "モジュールメーカーの推奨清掃頻度", "日射量で正規化した比発電量（kWh/kWp）の経年変化", "システム設置年月日のみ"],
    answer: "日射量で正規化した比発電量（kWh/kWp）の経年変化",
    difficulty: "中級",
    explanation: "発電量の経年変化を適切に評価するには、日射量変動の影響を除くため日射量で正規化した「比発電量（kWh/kWp）」や「性能比（PR）」の経年トレンドを分析する。絶対発電量だけでは日射量の変動と性能劣化を区別できない。比発電量・PRの低下傾向が見られる場合は劣化・故障の可能性を調査する。"
  },
  {
    q: "太陽光発電の「ストリング単位の異常検知」を効率的に行う方法として適切なものはどれか。",
    choices: ["モジュールの外観のみを確認する", "全体の発電量のみを確認する", "各ストリングの電流値をモニタリングし、他のストリングとの比較で異常を検出する", "パワーコンディショナの電圧のみを確認する"],
    answer: "各ストリングの電流値をモニタリングし、他のストリングとの比較で異常を検出する",
    difficulty: "中級",
    explanation: "ストリング単位の異常検知には、接続箱またはPCSのストリングモニタリング機能で各ストリングの電流値を個別に計測・記録し、類似条件（同じ日射量・温度）の複数ストリング間で電流値を比較する。電流が著しく低いストリングがある場合は、モジュール故障・配線断線・接続不良・影の影響などの異常が疑われる。"
  },
  {
    q: "太陽光発電の「モジュール劣化」の種類として「LID（Light Induced Degradation：光誘起劣化）」の説明として正しいものはどれか。",
    choices: ["鳥のフンによる表面汚損", "製造後の初期光照射による出力低下現象（アモルファスシリコンのステープラー・ウロンスキー効果等）", "長期使用による電極腐食", "台風による機械的損傷"],
    answer: "製造後の初期光照射による出力低下現象（アモルファスシリコンのステープラー・ウロンスキー効果等）",
    difficulty: "上級",
    explanation: "LID（Light Induced Degradation）は製造後の初期光照射（日光を受けた初期段階）でモジュール出力が低下する現象。結晶シリコン太陽電池でも初年度に1〜3%程度の出力低下が起きることがある（ボロン-酸素欠陥等によるキャリア寿命低下）。アモルファスシリコンではステープラー・ウロンスキー効果として知られる初期劣化がある。"
  },
  {
    q: "太陽光発電O&Mの「予防保全（PM：Preventive Maintenance）」の具体的な例として正しいものはどれか。",
    choices: ["発電量低下が判明してから点検する", "PCSが故障してから修理する", "10年に1回だけ大規模点検を実施する", "モジュールの定期清掃・架台ボルトの定期締め付け確認・PCSのフィルター交換"],
    answer: "モジュールの定期清掃・架台ボルトの定期締め付け確認・PCSのフィルター交換",
    difficulty: "初級",
    explanation: "予防保全（PM）は故障・劣化が発生する前に定期的な点検・清掃・部品交換を行う保全手法。具体例としてモジュール定期清掃（汚れ損失低減）、架台・ボルトの締め付け確認（ゆるみ防止）、PCSの冷却フィルター交換（熱異常防止）、避雷器の外観確認などがある。事後保全（CM：Corrective Maintenance）は故障後に行う修理・交換。"
  },
  {
    q: "太陽光発電の「赤外線（IR）検査」と「EL検査」の特徴比較として正しいものはどれか。",
    choices: ["赤外線検査は発電中（昼間）に温度異常を検出し、EL検査は暗所で電流を流して発光から内部欠陥を検出する", "両検査は同じ目的で使用される", "赤外線は変換効率を改善し、ELは汚れを除去する", "赤外線検査は発電中に実施できず、ELは発電中のみ実施できる"],
    answer: "赤外線検査は発電中（昼間）に温度異常を検出し、EL検査は暗所で電流を流して発光から内部欠陥を検出する",
    difficulty: "中級",
    explanation: "赤外線（サーモグラフィー）検査は昼間の発電中に実施し、モジュールの温度分布を画像化してホットスポット・故障箇所（高温部）を検出。EL（エレクトロルミネッセンス）検査はモジュールに電流を流して発光させ（暗所が必要）、セルのひびや欠陥で発光しない領域を画像から検出。両者は相補的な検査で合わせて使用される。"
  },
  {
    q: "「O&M契約」を締結する際に含めるべき内容として最も重要でないものはどれか。",
    choices: ["O&M会社の社内食堂メニュー", "故障対応の応答時間・SLA（サービスレベル合意）", "費用・支払い条件", "点検頻度・点検項目の仕様"],
    answer: "O&M会社の社内食堂メニュー",
    difficulty: "初級",
    explanation: "O&M契約には、点検頻度・点検項目（日常/定期/臨時点検）の仕様、故障対応のSLA（応答時間・復旧時間の目標）、発電量保証・性能保証の有無、費用・支払い条件、保険・賠償責任範囲、契約期間・更新条件、データ報告の内容・頻度などが含まれる。O&M会社の社内食堂は契約内容に無関係。"
  },
  {
    q: "太陽光発電の「発電量保証（O&M保証）」の説明として正しいものはどれか。",
    choices: ["O&M事業者が一定期間の発電量または性能比（PR）の下限を保証し、未達の場合に補償するサービス", "電力会社が発電量を保証する契約", "モジュールメーカーが全量を補償する制度", "政府が発電量の変動分を補填する制度"],
    answer: "O&M事業者が一定期間の発電量または性能比（PR）の下限を保証し、未達の場合に補償するサービス",
    difficulty: "中級",
    explanation: "発電量保証はO&M事業者が提供するサービスで、契約期間中の年間発電量または性能比（PR）の下限値を設定し、実際の値が下限を下回った場合に差額を補償する。O&M業者の点検・管理品質への信頼性を示す指標となり、融資審査でも評価される場合がある。気象変動（日射量の年変動）の扱い方が保証設計の重要ポイント。"
  },
  {
    q: "太陽光発電の「配線・接続部の点検」で重要な検査として正しいものはどれか。",
    choices: ["配線の色の確認のみ", "ケーブルの製造年月日の確認", "端子の締め付けトルク確認・コネクターの嵌合確認・絶縁被覆の損傷確認・接触抵抗測定", "配線の長さを測定する"],
    answer: "端子の締め付けトルク確認・コネクターの嵌合確認・絶縁被覆の損傷確認・接触抵抗測定",
    difficulty: "中級",
    explanation: "配線・接続部の点検では、端子ネジの締め付けトルク確認（ゆるみによる接触抵抗増大・発熱防止）、PV用コネクターの嵌合確認（不完全嵌合による接触不良防止）、ケーブル被覆の損傷・亀裂確認（絶縁劣化防止）、サーモグラフィー等による発熱部位の確認、必要に応じた接触抵抗測定などが重要な点検項目。"
  },
  {
    q: "太陽光発電モジュールの「出力保証（メーカー保証）」の一般的な内容として正しいものはどれか。",
    choices: ["公称最大出力の劣化なし保証", "10年間の発電量完全保証", "一定期間後（例：25年後）の公称最大出力の80〜82%以上を保証", "設置から5年間の出力100%保証"],
    answer: "一定期間後（例：25年後）の公称最大出力の80〜82%以上を保証",
    difficulty: "中級",
    explanation: "主要モジュールメーカーの出力保証は一般に、25年後（または30年後）に公称最大出力（STC条件）の80〜82%以上を保証する内容（年間平均0.7%程度の劣化率を担保）。初年度（製品保証）は97〜98%以上を保証するものが多い。これはモジュールの長期性能維持を担保する重要な保証だが、保証書の条件を詳細に確認する必要がある。"
  },
  {
    q: "太陽光発電の「接続箱の点検」で確認すべき項目として適切でないものはどれか。",
    choices: ["ヒューズの溶断有無確認", "接続箱内への水分浸入・結露の確認", "接続箱の外部塗装の色", "逆流防止ダイオードの異常発熱確認"],
    answer: "接続箱の外部塗装の色",
    difficulty: "初級",
    explanation: "接続箱の定期点検項目には、逆流防止ダイオードの外観・発熱確認（サーモグラフィー）、ヒューズ（直流ヒューズ）の溶断・劣化確認、端子台・コネクターの締め付け・接触確認、水分浸入・結露・腐食の確認、開閉器の動作確認などが含まれる。外部塗装の色は接続箱の性能に影響しないため、点検の主要項目ではない。"
  },
  {
    q: "太陽光発電の「架台点検」で特に重要な項目として正しいものはどれか。",
    choices: ["架台のデザイン確認", "架台の色のチェック", "ボルト・ナットの緩み・腐食・変形・架台と屋根の固定部分の確認", "架台に広告が貼れるか確認"],
    answer: "ボルト・ナットの緩み・腐食・変形・架台と屋根の固定部分の確認",
    difficulty: "初級",
    explanation: "架台の定期点検では、取付けボルト・ナットの締め付けトルク確認（緩みによるモジュール脱落・転倒リスク防止）、架台部材の腐食（特に海塩粒子の多い環境）・変形・亀裂の確認、屋根との固定部分（アンカー・フック）の状態確認（雨漏り・緩み）が最重要事項。台風・積雪後は特に入念な確認が必要。"
  },
  {
    q: "太陽光発電の「PCS点検」で実施すべき項目として適切でないものはどれか。",
    choices: ["動作電流・電圧・出力の正常動作確認", "エラーログ・アラーム履歴の確認", "冷却ファン・フィルターの汚れ・動作確認", "PCS内部の電子部品を毎回分解して目視確認"],
    answer: "PCS内部の電子部品を毎回分解して目視確認",
    difficulty: "中級",
    explanation: "PCS（パワーコンディショナ）の定期点検は外観点検・動作確認が基本で、内部の電子部品を毎回分解して目視する必要はない（むしろ不必要な分解は禁物）。点検項目は動作電圧・電流・出力の確認、冷却ファン・エアフィルターの清掃・交換確認、エラーログ確認、外観（変色・臭い）確認、各部の絶縁・接地確認などが適切。"
  },
  {
    q: "太陽光発電システムの「性能比（PR）の低下」の主な原因として適切なものはどれか。",
    choices: ["電力需要の低下", "日射量の増加", "FIT買取価格の変更", "モジュール汚れ・故障、PCS効率低下、配線劣化によるシステム損失の増大"],
    answer: "モジュール汚れ・故障、PCS効率低下、配線劣化によるシステム損失の増大",
    difficulty: "中級",
    explanation: "PRの低下原因として、モジュールの汚れ・セルひびによる出力損失、PCSの効率低下（コンデンサ劣化等）、配線・コネクター接触抵抗の増加、ストリング間ミスマッチの拡大（モジュール特性ばらつきの増大）、部分的影の増加などが挙げられる。PRの定期モニタリングで異常を早期に発見し原因を特定することが重要。"
  },
  {
    q: "太陽光発電の「事業用（産業用）太陽光発電所」のO&M費用の一般的な目安として正しいものはどれか（kW・年あたり）。",
    choices: ["O&M費用は発生しない", "約50,000円/kW・年", "約100円/kW・年", "約1,000〜5,000円/kW・年程度（システム規模・立地条件による）"],
    answer: "約1,000〜5,000円/kW・年程度（システム規模・立地条件による）",
    difficulty: "上級",
    explanation: "産業用太陽光発電のO&M費用は設備規模・立地（遠隔地・積雪地等）・O&M内容により大きく異なるが、一般的な目安として1,000〜5,000円/kW・年程度が多い。この費用は年間発電量から算出すると0.5〜3円/kWh程度に相当する。O&M費用はFIT事業の収益性評価における重要なコスト要素。"
  },
  {
    q: "太陽光発電モジュールの「腐食（コロージョン）」について正しいものはどれか。",
    choices: ["水分・塩分・化学物質が浸入すると電極・配線の腐食が発生し出力低下・断線につながる", "腐食はガラス面にのみ発生する", "腐食は発電量を増加させる", "太陽電池モジュールは腐食しない"],
    answer: "水分・塩分・化学物質が浸入すると電極・配線の腐食が発生し出力低下・断線につながる",
    difficulty: "中級",
    explanation: "太陽電池モジュール内部への水分・塩分（海岸近傍）・有機溶剤等の浸入はセル電極（銀・アルミ）・リボン線（銅）の腐食を引き起こし、接触抵抗増大・断線・出力低下につながる。バックシートやフレームのシーリング材の劣化・損傷が浸水経路となる。EL検査・IV計測で腐食の影響を検出できる場合がある。"
  },
  {
    q: "太陽光発電の「ドローンによるO&M点検」のデメリットとして正しいものはどれか。",
    choices: ["電気的な詳細測定（絶縁抵抗・IV特性等）は地上での別途測定が必要", "ドローン点検はすべての異常を確実に検出できる", "ドローン点検は安全で完全な点検が可能", "ドローン点検は現地点検と全く同じ結果が得られる"],
    answer: "電気的な詳細測定（絶縁抵抗・IV特性等）は地上での別途測定が必要",
    difficulty: "中級",
    explanation: "ドローンによる赤外線・目視点検は広大な面積を短時間に点検できる効率的な手法だが、電気的な詳細測定（絶縁抵抗・IV特性・接地抵抗測定）は地上での器具使用による点検が別途必要。また接続箱内部・PCS内部の状態確認・端子締め付け確認もドローンでは対応できない。ドローン点検は地上点検の「補完・効率化ツール」。"
  },
  {
    q: "太陽光発電の「JPEA定期点検」（JPEAアドバイザーが推奨する点検）において「外観点検」で確認する主な項目として正しいものはどれか。",
    choices: ["書類・認定証の確認のみ", "モジュール表面の汚損・破損・変色、フレームの腐食・変形、架台の状態、ケーブルの被覆損傷", "発電量データの確認のみ", "電気測定値のみ"],
    answer: "モジュール表面の汚損・破損・変色、フレームの腐食・変形、架台の状態、ケーブルの被覆損傷",
    difficulty: "初級",
    explanation: "外観点検の主な確認項目はモジュール表面の汚損（汚れ・ゴミ・鳥フン）・破損（ひび・割れ）・変色・デラミネーション（剥離）、バックシートの劣化、フレームの腐食・変形、架台ボルトの緩み・腐食、ケーブル被覆の損傷・亀裂、コネクターの変色・損傷、接続箱の外観確認などを含む。"
  },
  {
    q: "太陽光発電の「メガテスト（耐電圧試験）」における直流側の試験電圧として正しいものはどれか（定格電圧の場合）。",
    choices: ["試験電圧の規定はない", "定格電圧の0.5倍", "最大システム電圧の1.5倍（または最大直流電圧+1000V程度）", "定格電圧と同じ"],
    answer: "最大システム電圧の1.5倍（または最大直流電圧+1000V程度）",
    difficulty: "上級",
    explanation: "耐電圧試験（絶縁耐力試験）の試験電圧は電技解釈により電路の最大使用電圧の1.5倍（直流）を10分間印加して絶縁破壊が生じないことを確認する（最大使用電圧×1.5倍。ただし低圧では最低500Vが必要など条件あり）。太陽光発電の直流側では最大直流電圧（例：1000V）の1.5倍=1500Vの耐電圧試験が必要な場合がある。"
  },
  {
    q: "太陽光発電の「モジュール交換」が必要になる場合として適切でないものはどれか。",
    choices: ["モジュールの年式が古い場合", "出力が保証値（25年80%以上等）を大幅に下回る場合", "セルのひびや割れでEL検査で多数の暗部が確認された場合", "バックシートの大きな亀裂・剥離が確認された場合"],
    answer: "モジュールの年式が古い場合",
    difficulty: "中級",
    explanation: "モジュール交換が必要な判断基準は、EL検査での多数のひび・断線確認、性能保証値を大幅に下回る出力低下、バックシート・封止材の大きな損傷による安全上の問題、ホットスポットによる焦損などがある。モジュールの年式が古いだけでは交換の必要性判断にはならず、実際の性能・状態を評価して判断する。"
  },
  {
    q: "太陽光発電の「O&Mデータ分析」における「プロアクティブ（予測的）保全」の説明として正しいものはどれか。",
    choices: ["発電量・設備状態のデータ分析・傾向管理により故障予兆を検知して先手を打つ保全", "保険で全損失をカバーするリスク管理", "故障発生後に修理する事後保全", "定期スケジュールのみで実施する保全"],
    answer: "発電量・設備状態のデータ分析・傾向管理により故障予兆を検知して先手を打つ保全",
    difficulty: "中級",
    explanation: "プロアクティブ保全（予測的保全・予兆保全）は、発電量・電流・温度・振動等のデータの傾向分析（Trend Analysis）やAI・機械学習を活用した異常検知により、故障が発生する前に予兆を捉えて計画的な点検・部品交換を行う先進的な保全手法。事後保全・予防保全より高い設備利用率と保全コスト削減が期待できる。"
  },
  {
    q: "太陽光発電の「避雷器（SPD）の定期確認」として正しいものはどれか。",
    choices: ["避雷器の点検は年1回でよい", "避雷器は一度設置すれば点検不要", "落雷後や定期点検時に外観確認（動作表示・変色）と絶縁性能確認を実施し、劣化・動作後品は交換する", "避雷器は法律で点検が禁止されている"],
    answer: "落雷後や定期点検時に外観確認（動作表示・変色）と絶縁性能確認を実施し、劣化・動作後品は交換する",
    difficulty: "中級",
    explanation: "避雷器（SPD）は落雷・サージ電流の通過後に消耗・劣化することがある。定期点検時や落雷後には外観確認（動作表示窓の変色、交換必要表示）と絶縁性能の確認を実施し、動作後または劣化したSPDは新品に交換する。SPDが機能していないと次の落雷で機器損傷リスクが高まる。"
  },
  {
    q: "太陽光発電の「保険」について、一般的に加入が推奨されるものとして最も適切な組み合わせはどれか。",
    choices: ["動産総合保険（機器損害）・利益保険（発電量減少による収益損失）・賠償責任保険の組み合わせ", "保険への加入は不要", "生命保険のみ", "火災保険のみ"],
    answer: "動産総合保険（機器損害）・利益保険（発電量減少による収益損失）・賠償責任保険の組み合わせ",
    difficulty: "中級",
    explanation: "太陽光発電事業で加入が推奨される保険の種類：①動産総合保険（火災・台風・落雷・盗難等による機器損害をカバー）②利益保険（機器損傷等による発電量減少期間の収益損失をカバー）③施設賠償責任保険（モジュール・架台の飛散等で第三者に損害を与えた場合の賠償）。事業規模・融資条件により必要保険が異なる。"
  },
  {
    q: "太陽光発電の「PCSの定期交換」の目安となる期間として一般的に言われているものはどれか。",
    choices: ["15〜20年程度（一部部品は早期交換が必要な場合がある）", "1〜2年", "5年ごとに全交換が義務", "設備寿命の30年まで交換不要"],
    answer: "15〜20年程度（一部部品は早期交換が必要な場合がある）",
    difficulty: "中級",
    explanation: "PCS（パワーコンディショナ）の設計寿命は一般的に15〜20年程度とされている。FIT期間（20年）中に1回の更新が必要になる可能性がある。ただし電解コンデンサ（10〜15年）・冷却ファン（5〜10年）などの消耗部品は早期の交換が必要な場合がある。PCS交換費用（100〜300万円/台等）を事業計画に織り込んでおくことが重要。"
  },
  {
    q: "太陽光発電の「積雪による発電量損失」の対策として「モジュールの向き・傾斜角」の設計が重要な理由として正しいものはどれか。",
    choices: ["傾斜角は積雪荷重に影響しない", "傾斜角20°以下が最適", "水平設置にすることで積雪が落ちやすい", "傾斜角を大きく（40〜60°）することで積雪が自然落下しやすくなり積雪損失を低減できる"],
    answer: "傾斜角を大きく（40〜60°）することで積雪が自然落下しやすくなり積雪損失を低減できる",
    difficulty: "初級",
    explanation: "積雪地域では積雪による日射遮蔽（発電量ゼロ期間）が長期化することが課題。傾斜角を大きく（40〜60°程度）することで積雪が自重で滑り落ちやすくなり、発電量損失を低減できる。ただし傾斜角増大は春〜夏の発電量が多少減少するため、年間総発電量と積雪損失低減のバランスで最適傾斜角を設定する。"
  },
  {
    q: "「太陽光発電のO&M報告書」に記載すべき内容として適切でないものはどれか。",
    choices: ["月別・年間発電量実績と計画値との比較", "日射量・性能比（PR）の推移", "実施した点検作業・発見した不具合と対応状況", "O&M担当者の個人的な感想・趣味"],
    answer: "O&M担当者の個人的な感想・趣味",
    difficulty: "初級",
    explanation: "O&M報告書には、月別・年間発電量実績と計画値の比較・差異分析、日射量・PR・比発電量の推移、実施した点検・清掃・修理作業の内容、発見した不具合と対応状況、設備の現状評価（正常・要注意・要修理等）、次期点検の予定などが記載される。担当者の個人的感想・趣味は報告書に含めない。"
  },
  {
    q: "太陽光発電のPCSが「夜間に再起動失敗アラーム」を繰り返す場合の一般的な原因として正しいものはどれか。",
    choices: ["日射量不足が原因で異常ではない", "モジュールが夜間に発電しているため", "PCS内部の電子部品（コンデンサ等）の劣化または接触不良が原因の可能性がある", "電力会社の系統が問題"],
    answer: "PCS内部の電子部品（コンデンサ等）の劣化または接触不良が原因の可能性がある",
    difficulty: "中級",
    explanation: "PCSの起動失敗・繰り返しアラームは内部部品の劣化（電解コンデンサの容量低下・リレー接点の劣化）、制御基板の異常、ファームウェアの不具合、電源回路の問題などが原因として考えられる。夜間は入力電力がないため太陽電池入力の問題ではなく、PCS内部の問題が疑われる。メーカーサービスへの連絡が必要。"
  },
  {
    q: "太陽光発電の「モジュールの耐用年数」の考え方として正しいものはどれか。",
    choices: ["法定耐用年数（税務上）と物理的耐用年数（実際の使用可能期間）は同一", "モジュールは10年で全て交換が必要", "耐用年数はメーカー保証期間と同じ", "法定耐用年数（17年等）と実際の物理的耐用年数（25〜30年以上）は異なり、適切な保守で長期使用が可能"],
    answer: "法定耐用年数（17年等）と実際の物理的耐用年数（25〜30年以上）は異なり、適切な保守で長期使用が可能",
    difficulty: "中級",
    explanation: "税務上の法定耐用年数（太陽光発電設備：17年）と実際の物理的耐用年数（適切な保守で25〜30年以上使用可能）は異なる。税務上の減価償却は法定耐用年数で計算されるが、適切なO&Mを実施すれば物理的にはFIT期間（20年）以上の運用が可能。メーカーの出力保証（25〜30年）も長期運用を前提としている。"
  },
  {
    q: "「太陽光発電の盗難対策」として実施すべき対策として正しいものはどれか。",
    choices: ["盗難防止ボルト・防犯カメラ・センサー警報・フェンス設置・保険加入", "盗難対策は不要", "盗難リスクは住宅用にのみある", "盗難が発生してから警察に連絡するだけでよい"],
    answer: "盗難防止ボルト・防犯カメラ・センサー警報・フェンス設置・保険加入",
    difficulty: "初級",
    explanation: "太陽光発電設備（特に地上設置型・産業用）の盗難（モジュール・ケーブル・銅製品等）は各地で発生している。対策として防犯カメラ（監視）・フェンス・ゲート設置（物理的防護）、盗難防止ボルト（特殊ボルト）の使用、センサー付き警報器（動体検知）、モニタリングによる異常検知、保険（動産総合保険）への加入が有効。"
  },
  {
    q: "「太陽光発電設備の災害対応（台風後）」として優先的に実施すべき対応として正しいものはどれか。",
    choices: ["まず発電量確認を行い異常がなければ点検不要", "台風後3ヶ月後に定期点検で確認すればよい", "台風後の強風・飛来物等によるモジュール・架台の損傷確認、倒壊・脱落部材の確認を優先的に実施", "保険請求のため何もしないで待つ"],
    answer: "台風後の強風・飛来物等によるモジュール・架台の損傷確認、倒壊・脱落部材の確認を優先的に実施",
    difficulty: "初級",
    explanation: "台風通過後は早期に現地で外観点検を実施し、モジュールの破損・ガラス割れ、架台の変形・部材の飛散・脱落、ケーブルの断線、フェンス・基礎の損傷等を確認する。架台・モジュールが不安定な状態では感電・落下による二次災害が発生する可能性があり、安全確認を優先する。損傷が確認された場合は速やかに専門業者と保険会社に連絡する。"
  },
  {
    q: "太陽光発電の「O&M業者の選定基準」として適切でないものはどれか。",
    choices: ["緊急時の対応体制・応答時間", "O&M業者の代表者の出身大学", "過去の実績・参照事例", "電気工事士・主任技術者等の有資格者の在籍"],
    answer: "O&M業者の代表者の出身大学",
    difficulty: "初級",
    explanation: "O&M業者の選定基準として重要なのは、有資格者（電気工事士・主任技術者・JPEA資格者等）の在籍・体制、緊急時の対応能力と応答時間、過去の実績（類似規模・同地域での実績）、提供するサービスの内容と費用対効果、使用するモニタリングシステム・点検ツールなど。代表者の出身大学は選定基準として適切でない。"
  },
  {
    q: "太陽光発電の「モジュール清掃時の注意事項」として正しいものはどれか。",
    choices: ["清掃は高圧洗浄機で勢いよく行うのが最も効果的", "強い圧力・研磨剤・有機溶剤は表面コーティングや封止材を傷める可能性があるため避け、水・柔らかい布またはモップを使用する", "清掃にはアルコール洗浄液が最適", "清掃は夏の昼間（最も汚れが落ちる）に実施する"],
    answer: "強い圧力・研磨剤・有機溶剤は表面コーティングや封止材を傷める可能性があるため避け、水・柔らかい布またはモップを使用する",
    difficulty: "初級",
    explanation: "モジュール清掃では、研磨剤入り洗剤や金属たわし・硬いブラシは表面反射防止コーティングを傷め長期的な効率低下につながる。高圧洗浄機は封止材・フレームシール部へのダメージや感電リスクがある。清掃は柔らかい布やモップ・水（必要に応じて中性洗剤）を使用し、夏の真昼（ガラス高温時）は避ける。"
  },
  {
    q: "「太陽光発電の発電記録・保存」として推奨される期間として正しいものはどれか。",
    choices: ["1週間分のみ保存すればよい", "データ保存は義務ではないため不要", "税務上の記録保存期間（5〜7年）のみ", "システム運用期間全体（20〜30年）の発電量データを保存・管理することが推奨される"],
    answer: "システム運用期間全体（20〜30年）の発電量データを保存・管理することが推奨される",
    difficulty: "中級",
    explanation: "発電記録のデータ保存は長期トレンド分析（性能評価・劣化率算出・年変動分析）、故障・事故発生時の原因究明、保証請求の根拠、投資家・融資機関への報告、O&M品質評価など多目的に活用される。運用期間全体（20〜30年）のデータを保存・管理することが推奨される。電子データでバックアップ管理することが望ましい。"
  },
  {
    q: "太陽光発電の「緊急停止手順」で最優先すべき事項として正しいものはどれか。",
    choices: ["作業者・周辺の安全確保（感電・火災からの退避）を最優先し、その後にPCSの停止・直流断路器の切断", "モジュールの取り外しを最初に実施する", "電力会社への連絡を最初に行う", "発電量の確認"],
    answer: "作業者・周辺の安全確保（感電・火災からの退避）を最優先し、その後にPCSの停止・直流断路器の切断",
    difficulty: "中級",
    explanation: "緊急時（火災・感電・架台倒壊等）の対応手順として、まず作業者・周辺人物の安全確保（危険エリアからの退避）が最優先。その後にパワーコンディショナの緊急停止・直流断路器（接続箱の遮断器）の切断により電路を遮断する。昼間は太陽電池側に電圧が残るため、消防活動のためにも電路情報（設備標識）の表示が重要。"
  },
  {
    q: "「太陽光発電の植生管理（雑草対策）」の重要性として正しいものはどれか（地上設置型）。",
    choices: ["雑草・樹木の成長によりモジュールへの影が増加して発電量が低下する可能性があるため定期管理が必要", "植生は美観のためのみ重要", "植生管理は発電量に影響しない", "地上設置型では植生は発生しない"],
    answer: "雑草・樹木の成長によりモジュールへの影が増加して発電量が低下する可能性があるため定期管理が必要",
    difficulty: "初級",
    explanation: "地上設置型太陽光発電所では雑草や周辺樹木の成長によりモジュールへの影（シェーディング）が増加し、発電量損失が発生する可能性がある。また草の成長による架台・ケーブルの接触・腐食リスクもある。定期的な草刈り・除草シート設置・防草処理（砂利敷き・防草シート）などの植生管理がO&Mの重要な作業の一つ。"
  },
  {
    q: "太陽光発電の「セルひびワレ（クラック）」の検出方法として最も効果的なものはどれか。",
    choices: ["EL検査（エレクトロルミネッセンス）または超音波検査", "目視点検で全てのひびワレを検出できる", "重量を計測する", "テスターでの電圧測定のみで検出できる"],
    answer: "EL検査（エレクトロルミネッセンス）または超音波検査",
    difficulty: "中級",
    explanation: "セル内部のひびワレ（マイクロクラック）は目視では発見困難な場合が多い。EL検査（電流を流して発光させ、ひびや欠陥部位の暗部を画像化）が最も有効な非破壊検査手法。超音波検査は封止材の剥離・ボイドの検出に使用される。IV曲線測定でも深刻なクラックは出力低下として現れるが、初期の軽微なクラックは検出困難。"
  },
  {
    q: "太陽光発電の「シャント測定（IV曲線トレーサー）」で得られる情報として正しいものはどれか。",
    choices: ["架台の強度", "発電量の20年予測値", "Voc・Isc・Vmp・Imp・Pmax・FFのI-V特性パラメータ", "モジュールの重量"],
    answer: "Voc・Isc・Vmp・Imp・Pmax・FFのI-V特性パラメータ",
    difficulty: "中級",
    explanation: "IV曲線トレーサー（I-Vカーブトレーサー）はモジュール・ストリングに電子負荷をかけながら電圧を変化させてI-V特性曲線を計測する装置。計測で得られるパラメータはVoc（開放電圧）・Isc（短絡電流）・Vmp（最大電力電圧）・Imp（最大電力電流）・Pmax（最大電力）・FF（フィルファクター）。仕様値との比較で性能・劣化を評価する。"
  },
  {
    q: "太陽光発電O&Mにおける「KPI（重要業績評価指標）」として適切なものはどれか。",
    choices: ["発電量達成率・性能比（PR）・設備利用率・故障対応時間・O&M費用対効果", "モジュールの色と外観評価のみ", "電力会社への売電総額のみ", "O&M担当者の残業時間のみ"],
    answer: "発電量達成率・性能比（PR）・設備利用率・故障対応時間・O&M費用対効果",
    difficulty: "中級",
    explanation: "O&MのKPI（重要業績評価指標）として一般的に使用されるものは、発電量達成率（計画比）、性能比（PR）の推移、設備利用率（キャパシティファクター）、故障検知から復旧までの時間（MTTR）、故障間隔（MTBF）、O&M費用対効果（kWh当たりO&Mコスト）などが挙げられる。これらを定期的に評価してO&M品質を継続改善する。"
  },
  {
    q: "太陽光発電の「パネルコーティング（防汚コーティング）」の効果として正しいものはどれか。",
    choices: ["汚れ（砂塵・花粉等）の付着を抑制し清掃頻度の低減・汚れ損失の軽減に寄与する", "PIDを完全に防止する", "変換効率を30%以上向上させる", "防水性を完全に確保してデラミネーションを防ぐ"],
    answer: "汚れ（砂塵・花粉等）の付着を抑制し清掃頻度の低減・汚れ損失の軽減に寄与する",
    difficulty: "中級",
    explanation: "防汚コーティング（光触媒コーティング・撥水コーティング等）はモジュール表面への汚れの付着を抑制し、降雨による自浄効果を高める。清掃頻度の低減とそれに伴うO&Mコスト削減・汚れ損失低減が主な効果。変換効率を直接的に大幅向上させるものではない。コーティングの持続性（耐久性）も選定時の重要なポイント。"
  },
  {
    q: "太陽光発電の「ソーラーモニタリングシステムの通信手段」として一般的に使用されるものはどれか。",
    choices: ["FAXのみ", "衛星通信のみ", "有線LAN・Wi-Fi・4G/LTE回線・RS485等の有線通信など、設置環境に合わせた通信手段", "電話回線（アナログ）のみ"],
    answer: "有線LAN・Wi-Fi・4G/LTE回線・RS485等の有線通信など、設置環境に合わせた通信手段",
    difficulty: "初級",
    explanation: "モニタリングシステムの通信手段は設置環境・規模に応じて選択される。住宅・小規模では有線LAN・Wi-Fi・4G/LTE（SIMカード）が一般的。産業用では光ファイバー・有線LAN・RS485（Modbus通信）が多い。遠隔地では4G/LTE・衛星通信が使用される。環境によっては複数の通信手段を組み合わせることもある。"
  },
  {
    q: "太陽光発電の「モジュールの微細ひびワレ（マイクロクラック）」の原因として適切なものはどれか。",
    choices: ["直流電圧が高すぎることによる電気的破壊", "輸送・施工時のハンドリングダメージ、熱サイクルによる応力、積雪・強風荷重", "発電量過多によるセル内部の膨張", "モジュールの洗浄による水分浸入"],
    answer: "輸送・施工時のハンドリングダメージ、熱サイクルによる応力、積雪・強風荷重",
    difficulty: "中級",
    explanation: "マイクロクラック（微細ひびワレ）の主な発生原因は、輸送・施工時の不適切な取り扱い（ハンドリングダメージ）、熱サイクル（温度変化による膨張・収縮の繰り返し）、積雪・強風・走行機械通過などの機械的荷重がある。マイクロクラックは初期には出力損失が少ないが、時間とともに拡大して発電量低下・断線につながることがある。"
  },
  {
    q: "「太陽光発電設備の廃棄・撤去」時に実施すべき作業として正しいものはどれか。",
    choices: ["電気的に安全に停止・切り離した後に解体・分別し、産業廃棄物として適正処理する", "撤去は電気工事士なしで誰でも実施できる", "廃棄モジュールは一般ゴミで出せる", "モジュールをそのまま埋め立て処分する"],
    answer: "電気的に安全に停止・切り離した後に解体・分別し、産業廃棄物として適正処理する",
    difficulty: "初級",
    explanation: "太陽光発電設備の撤去・廃棄時には、まず安全に電気設備を停止・切り離す（電気工事士が実施）。撤去した機器・材料（モジュール・架台・ケーブル等）は産業廃棄物として種別分離し、許可を持つ廃棄物処理業者に委託して適正処理する。廃棄費用の積立て制度（一定規模以上）に基づく費用積立ての活用も確認する。"
  },
  {
    q: "「太陽光発電のPCS更新時の注意事項」として適切なものはどれか。",
    choices: ["PCS更新は全く手続き不要で自由に実施できる", "更新後のPCS仕様が変わる場合（容量・電圧等）は系統連系に影響することがあり、電力会社への連絡・変更申請が必要な場合がある", "PCS更新はFIT認定が取り消されるため禁止", "PCS更新後は絶縁抵抗試験は不要"],
    answer: "更新後のPCS仕様が変わる場合（容量・電圧等）は系統連系に影響することがあり、電力会社への連絡・変更申請が必要な場合がある",
    difficulty: "中級",
    explanation: "PCS更新時に機器の容量・電圧・保護機能が変わる場合は系統連系条件に影響する可能性がある。この場合は電力会社への系統連系の変更申し込み・技術的確認が必要な場合がある。またFIT事業計画の変更（変更届出または変更認定）が必要な場合もある。更新後は施工後の試験確認（絶縁抵抗等）を実施する。"
  },
  {
    q: "太陽光発電の「運転データの異常検知アルゴリズム」として使用される手法として適切なものはどれか。",
    choices: ["年1回のバックアップデータ確認のみ", "目視のみ", "月に1回の人手確認のみ", "統計的手法（移動平均・標準偏差）やAI・機械学習による発電量の予測値と実測値の乖離検出"],
    answer: "統計的手法（移動平均・標準偏差）やAI・機械学習による発電量の予測値と実測値の乖離検出",
    difficulty: "上級",
    explanation: "近年のO&Mでは、モニタリングデータから統計的手法（移動平均・標準偏差・Z-score等）やAI・機械学習による発電量予測モデルを構築し、予測値と実測値の乖離を自動検知する異常検知アルゴリズムが実用化されている。閾値を超えた乖離を検知するとアラートを自動発報し、O&M担当者が迅速に対応できる体制を構築できる。"
  },
  {
    q: "太陽光発電の「塩害対策」として適切なものはどれか（海岸近傍に設置する場合）。",
    choices: ["塩害対策はコーティングのみで十分", "海岸近傍への設置は全て禁止", "塩害の影響は設置後にのみ考えればよい", "塩害仕様（SUS・アルミ合金等の架台材料選定・耐食性コネクター・防錆処理）の機器選定と定期的な腐食確認"],
    answer: "塩害仕様（SUS・アルミ合金等の架台材料選定・耐食性コネクター・防錆処理）の機器選定と定期的な腐食確認",
    difficulty: "中級",
    explanation: "海岸近傍（塩害地域）では海塩粒子による腐食が架台・ボルト・コネクター・電気端子等に発生しやすい。対策として①耐食性材料（ステンレス鋼・アルミ合金・高耐食性メッキ）の架台・部材選定②防錆コーティング③塩害対応PCS・接続箱の選定④定期的な腐食点検（腐食の早期発見・補修）が重要。"
  },
  {
    q: "「太陽光発電のO&Mコスト最適化」の方法として適切なものはどれか。",
    choices: ["O&M業務を全て内製化して外部委託をゼロにする", "リモートモニタリング活用による現地訪問頻度の最適化・ドローン点検導入・不具合の早期発見・修理による大規模損失の防止", "清掃・点検を年1回に固定する", "コスト削減のためO&M全体を停止する"],
    answer: "リモートモニタリング活用による現地訪問頻度の最適化・ドローン点検導入・不具合の早期発見・修理による大規模損失の防止",
    difficulty: "中級",
    explanation: "O&Mコスト最適化の手法として、①遠隔モニタリングの高度化（異常の早期検知→現地訪問の必要な場合のみに絞り込み）②ドローン・AI点検の活用（効率的な広域点検）③予防保全・予兆保全による大規模故障・長期停止の防止（損失発電量の最小化が最大のコスト最適化）④スケールメリット（複数物件の一括管理）などがある。"
  },
  {
    q: "太陽光発電の「EVA封止材の黄変・劣化」が進行した場合の影響として正しいものはどれか。",
    choices: ["黄変によりPIDが発生しにくくなる", "透過率低下により日射量が減少し発電量が低下する", "EVA黄変は外観変化のみで発電量に影響しない", "EVA黄変は発電量を増加させる"],
    answer: "透過率低下により日射量が減少し発電量が低下する",
    difficulty: "中級",
    explanation: "EVA封止材の黄変（黄色〜茶色の変色）は主に紫外線・熱・水分による経年劣化で発生する。黄変が進むとモジュール内の光透過率が低下し（黄色は青・紫外線域を吸収）、セルへ到達する有効日射量が減少して発電出力が低下する。また酢酸の発生によるセル電極腐食や絶縁性低下も懸念される。"
  },
  {
    q: "「太陽光発電設備の保守委託契約」（SLA：Service Level Agreement）で規定すべき応答時間の例として適切なものはどれか。",
    choices: ["応答時間はO&M業者が自由に決定する", "重大故障は報告受領後24時間以内に現地対応、軽微な不具合は5営業日以内等の応答時間目標", "応答時間の規定は不要", "全ての故障に1年以内に対応すればよい"],
    answer: "重大故障は報告受領後24時間以内に現地対応、軽微な不具合は5営業日以内等の応答時間目標",
    difficulty: "中級",
    explanation: "O&M SLA（サービスレベル合意）では故障・不具合の重大度に応じた応答時間目標を規定することが重要。例として重大故障（発電停止）は報告から24時間以内に現地対応・48時間以内に発電復旧などの目標を設定。軽微な不具合は5営業日以内の対応等。SLA違反時のペナルティ規定も含めることで契約の実効性が高まる。"
  },
  {
    q: "太陽光発電の「ランダム故障」と「経年劣化故障」の違いとして正しいものはどれか。",
    choices: ["ランダム故障は偶発的に発生（設置初期・中期）、経年劣化故障は長期使用で摩耗・劣化が蓄積して発生（バスタブ曲線の末期）", "太陽光発電に経年劣化はない", "経年劣化は予防できない", "両者は同じ故障モード"],
    answer: "ランダム故障は偶発的に発生（設置初期・中期）、経年劣化故障は長期使用で摩耗・劣化が蓄積して発生（バスタブ曲線の末期）",
    difficulty: "上級",
    explanation: "設備の故障率はバスタブ曲線（初期故障期・偶発故障期・摩耗故障期）で表される。ランダム（偶発）故障は設置初期〜中期に一定の確率で発生（コネクター損傷・突然の機器故障等）。経年劣化故障は長期使用で材料・部品の摩耗・疲労・劣化が蓄積して発生（PCSコンデンサ劣化・モジュール封止材劣化等）。適切な予防保全で経年劣化故障は遅らせることができる。"
  },
  {
    q: "「太陽光発電のOEE（Overall Equipment Effectiveness：設備総合効率）」の説明として正しいものはどれか。",
    choices: ["年間の変換効率のみを示す指標", "売電収入を設備費で割った値", "FIT単価と市場価格の比率", "可用率×性能比×品質率から算出するシステム全体の総合効率指標"],
    answer: "可用率×性能比×品質率から算出するシステム全体の総合効率指標",
    difficulty: "上級",
    explanation: "OEE（設備総合効率）は製造業で使用されるKPIを太陽光発電に応用した指標。可用率（発電可能時間÷暦時間）×性能比（実際の発電量÷理論最大発電量）×品質率（系統送電量÷実際の発電量、通常1.0）で算出。太陽光発電では主に可用率（故障停止・計画停止の影響）と性能比（損失の影響）がOEEを決定する要因。"
  },
  {
    q: "「太陽光発電の事故事例」から学ぶ点として適切なものはどれか。",
    choices: ["他の発電所での事故事例を分析し、自施設での同様リスクを事前に特定・対策することが再発防止に重要", "事故は運が悪かっただけであり分析は不要", "事故後は修理のみすれば十分", "事故事例は同業他社のことなので関係ない"],
    answer: "他の発電所での事故事例を分析し、自施設での同様リスクを事前に特定・対策することが再発防止に重要",
    difficulty: "初級",
    explanation: "JPEA・経済産業省・消防庁等が太陽光発電の事故事例を収集・公開しており、他施設での事故（火災・感電・架台倒壊・地絡等）を分析することで自施設の潜在リスクを事前に特定し対策できる。ヒヤリハット・事故の水平展開（他の発電所へのフィードバック）はO&M品質向上の重要な活動。事故から学ぶ文化が安全管理の基本。"
  },
  {
    q: "「太陽光発電のパネル自体の火災」が発生した場合の消防機関への対応として正しいものはどれか。",
    choices: ["直流電圧が残っているリスクをあらかじめ消防機関に伝え、水かけによる感電リスクに注意するよう情報提供する", "火が消えたら消防機関への事故報告は不要", "消防機関には連絡不要でO&M業者のみに連絡する", "電圧は発電停止で消えるため感電リスクはない"],
    answer: "直流電圧が残っているリスクをあらかじめ消防機関に伝え、水かけによる感電リスクに注意するよう情報提供する",
    difficulty: "上級",
    explanation: "太陽光発電モジュールは昼間に日光が当たる限り直流電圧が発生し続ける。消防活動での注水（水は電気を導通させる）による感電リスクがある。消防機関への初動連絡では設備の直流電圧の危険性（PCSを停止しても電圧は残る）を伝え、感電防止を徹底した消防活動が行われるよう協力する必要がある。"
  },
  {
    q: "「太陽光発電の地絡（アース故障）」が発生した場合の症状として正しいものはどれか。",
    choices: ["地絡は発電量の増加として現れる", "PCSが保護動作で停止・アラームを発報し、絶縁抵抗の低下として検出される", "地絡は電力会社のスマートメーターで検出できる", "地絡は外観変化のみで発電量に影響しない"],
    answer: "PCSが保護動作で停止・アラームを発報し、絶縁抵抗の低下として検出される",
    difficulty: "中級",
    explanation: "地絡（電路が大地と電気的に接続してしまう故障）が発生すると、PCSの地絡検出機能が作動して保護停止・アラーム発報する（PCS搭載の地絡検出機能または絶縁監視装置が動作）。絶縁抵抗計での測定値が規定値以下に低下していることで確認できる。地絡の継続は感電・火災リスクがあるため速やかな原因特定・修理が必要。"
  },
  {
    q: "「太陽光発電の長期O&M計画」において考慮すべき主要コスト要素として適切でないものはどれか。",
    choices: ["PCS更新費用（15〜20年目頃）", "定期点検・清掃費用", "施工業者の新入社員研修費", "廃棄・撤去費用（20〜30年目）"],
    answer: "施工業者の新入社員研修費",
    difficulty: "初級",
    explanation: "長期O&M計画のコスト要素として、定期点検・清掃費用（毎年）、PCS更新費用（15〜20年目）、モジュール・架台の修理・交換費用、モニタリングシステム更新費用、廃棄・撤去費用（20〜30年目）、保険料などが含まれる。施工業者の新入社員研修費は発電設備の運用コストに含まれない。"
  },
  {
    q: "「太陽光発電のデジタルツイン」技術の説明として正しいものはどれか。",
    choices: ["発電量を倍増させるためのデジタル制御", "太陽電池の特許をデジタルで管理する技術", "太陽電池の複製品を製造する技術", "実際の太陽光発電設備をデジタル空間で再現し、シミュレーション・予測・最適化に活用する技術"],
    answer: "実際の太陽光発電設備をデジタル空間で再現し、シミュレーション・予測・最適化に活用する技術",
    difficulty: "上級",
    explanation: "デジタルツイン（Digital Twin）は実際の物理的設備（太陽光発電所）をデジタル空間で精密に再現したモデル。センサーデータをリアルタイムで取り込み、発電量予測・故障予知・最適O&M計画策定・システム改善シミュレーション等に活用する先進技術。再エネ大規模設備のO&M高度化・効率化に期待されている。"
  },
  {
    q: "太陽光発電の「廃棄モジュールの適正処理」の観点から、日本で整備されている取り組みとして正しいものはどれか。",
    choices: ["廃棄太陽電池の回収・リサイクル制度は日本にない", "廃棄モジュールは電力会社が全て回収する", "廃棄モジュールは輸出義務がある", "JPEAが主導するリサイクル推進スキーム（エコリサイクル）や民間リサイクル事業者による回収・処理"],
    answer: "JPEAが主導するリサイクル推進スキーム（エコリサイクル）や民間リサイクル事業者による回収・処理",
    difficulty: "中級",
    explanation: "2030年以降に大量廃棄が見込まれる太陽電池モジュールの適正処理を推進するため、JPEAが「太陽電池モジュールのリサイクル」推進スキームを整備し、民間のリサイクル業者と連携している（エコリサイクル制度等）。ガラス・金属・プラスチック等への分別リサイクルが技術的に可能で、リサイクル率向上が課題。2022年の法改正で廃棄費用積立てが義務化された。"
  }
];

function generateOMQuestions() {
  return OM_SPECS.map((spec) => {
    const choiceExplanations = {};
    choiceExplanations[spec.answer] = { result: "正解", reason: spec.explanation };
    spec.choices.forEach((c) => {
      if (c === spec.answer) return;
      choiceExplanations[c] = { result: "不正解", reason: `正解は「${spec.answer}」。${spec.explanation}` };
    });

    return {
      id: nextQuestionId("i"),
      mode: "knowledge",
      category: "維持管理・O&M",
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
   第8章 販売・提案・環境（製品データに依存しない静的問題）
   出題範囲：経済性評価（単純回収年数・NPV・IRR・LCOE）・補助金と
   FIT/FIP制度の実務・消費者保護法規（特商法/割賦販売法）・環境価値
   （CO2排出・EPT/EROI・グリーン証書・RE100）・提案時の倫理と説明責任。
   ================================================================ */
const SALES_SPECS = [
  {
    q: "住宅用太陽光発電システムの経済性評価において、「単純回収年数」の計算式として正しいものはどれか。",
    choices: ["単純回収年数 = 年間収益 ÷ 初期費用", "単純回収年数 = 初期費用 ÷ 年間収益（売電収入 + 電気代削減額）", "単純回収年数 = 初期費用 × 年間収益", "単純回収年数 = （初期費用 - 補助金） × 年間収益"],
    answer: "単純回収年数 = 初期費用 ÷ 年間収益（売電収入 + 電気代削減額）",
    difficulty: "初級",
    explanation: "単純回収年数は初期投資額を年間の収益（売電収入と電気代削減額の合計）で割ることで算出する。補助金がある場合は初期費用から差し引いて計算する。"
  },
  {
    q: "太陽光発電システムの年間収益計算において、4.5kWシステム、年間発電量4,500kWh、自家消費率30%、売電単価16円/kWh、電力購入単価28円/kWhの場合、年間収益はいくらか。",
    choices: ["約72,000円", "約54,000円", "約104,400円", "約88,200円"],
    answer: "約88,200円",
    difficulty: "上級",
    explanation: "自家消費量=4,500×0.3=1,350kWh、売電量=4,500×0.7=3,150kWh。電気代削減=1,350×28=37,800円、売電収入=3,150×16=50,400円。合計=37,800+50,400=88,200円。"
  },
  {
    q: "NEDOの日射量データベースによると、東京（水平面年間日射量約1,100kWh/m²）における4.5kWシステムの年間発電量の概算として最も適切なものはどれか（システム損失率15%）。",
    choices: ["約3,200kWh", "約6,200kWh", "約4,200kWh", "約5,200kWh"],
    answer: "約4,200kWh",
    difficulty: "上級",
    explanation: "年間発電量＝システム容量×年間日射量×パフォーマンス比（1-損失率）=4.5×1,100×0.85≒4,208kWh。東京の標準的な数値として約4,200kWhが適切。"
  },
  {
    q: "顧客に太陽光発電システムを提案する際の「ライフサイクルコスト（LCC）」分析に含まれる費用として、適切でないものはどれか。",
    choices: ["年間維持管理費用", "パワーコンディショナ交換費用", "初期設置費用", "近隣住民への説明会費用"],
    answer: "近隣住民への説明会費用",
    difficulty: "中級",
    explanation: "LCC分析には初期設置費用、維持管理費用、機器交換費用、廃棄処分費用などが含まれる。近隣説明会費用は通常LCCに含めない。パワーコンディショナは10〜15年での交換が一般的に想定される。"
  },
  {
    q: "住宅用太陽光発電の「投資回収期間」が一般的に何年程度とされているか。最も適切な範囲はどれか。",
    choices: ["20〜25年", "3〜5年", "15〜20年", "7〜12年"],
    answer: "7〜12年",
    difficulty: "中級",
    explanation: "現在の設備費用・電力単価水準では、住宅用太陽光発電の投資回収期間は一般的に7〜12年程度とされている。システム寿命は20〜25年とされており、回収後は純粋な収益期間となる。"
  },
  {
    q: "国の住宅用太陽光発電に対する補助金制度として、現在（2024年度）の状況として正しいものはどれか。",
    choices: ["ZEH（ネット・ゼロ・エネルギー・ハウス）補助制度と連携した補助がある", "FIT制度との併用は禁止されているため補助金は受けられない", "国・都道府県・市区町村の3段階補助が全国一律に適用される", "国の直接補助金制度は終了しており、現在は自治体補助のみ"],
    answer: "ZEH（ネット・ゼロ・エネルギー・ハウス）補助制度と連携した補助がある",
    difficulty: "中級",
    explanation: "現在、国の住宅用太陽光単独の直接補助は終了しているが、ZEH補助などの高性能住宅関連補助と組み合わせた支援制度が継続している。また多くの自治体が独自の補助制度を実施している。"
  },
  {
    q: "令和6年度（2024年度）のFIT制度における住宅用（10kW未満）太陽光発電の買取価格として最も近いものはどれか。",
    choices: ["10円/kWh", "26円/kWh", "42円/kWh", "16円/kWh"],
    answer: "16円/kWh",
    difficulty: "中級",
    explanation: "2024年度の住宅用（10kW未満）太陽光発電のFIT買取価格は16円/kWh（10kW未満・出力制御対応機器設置義務あり）。FIT価格は制度開始以来毎年見直され低下傾向にある。"
  },
  {
    q: "自治体の太陽光発電補助金申請において、一般的に必要とされる書類として適切でないものはどれか。",
    choices: ["施工業者の建設業許可証", "隣接する全住民の同意書", "電力会社との系統連系承認書", "工事完了後の設置完了証明書または写真"],
    answer: "隣接する全住民の同意書",
    difficulty: "中級",
    explanation: "自治体補助申請では設置完了証明・系統連系承認・施工業者資格証明などが必要だが、隣接住民全員の同意書は一般的には求められない。ただし景観条例等で要求される場合は別途確認が必要。"
  },
  {
    q: "太陽光発電システムの経済性を顧客に説明する際の「電気代削減効果」算出において、考慮すべき重要な要素として最も適切なものはどれか。",
    choices: ["システムの色と外観デザイン", "施工会社の創業年数", "近隣住宅の設置状況", "自家消費率と電力購入単価の将来変動予測"],
    answer: "自家消費率と電力購入単価の将来変動予測",
    difficulty: "中級",
    explanation: "電気代削減効果は自家消費率（どの程度を自宅で使うか）と電力購入単価に依存する。電気料金は将来変動するため、保守的な予測と楽観的な予測の両方を示すことが重要。自家消費率は生活パターンで異なる。"
  },
  {
    q: "顧客への太陽光発電提案において、「NPV（正味現在価値）」を用いた投資評価の説明として正しいものはどれか。",
    choices: ["NPVが大きいほど投資回収期間が長い", "NPVは将来のキャッシュフローを名目値のまま合計する", "NPVが正の値（プラス）であれば投資価値があると判断できる", "NPVは初期費用から年間収益の単純合計を引いた値"],
    answer: "NPVが正の値（プラス）であれば投資価値があると判断できる",
    difficulty: "上級",
    explanation: "NPV（正味現在価値）は将来のキャッシュフローを現在価値に割り引いて合計し、初期投資を差し引いた値。NPV>0は投資が価値を生むことを意味する。割引率を考慮するため、単純な収益合計とは異なる。"
  },
  {
    q: "蓄電池と太陽光発電を組み合わせたシステムを顧客に提案する場合の主なメリットとして、最も適切なものはどれか。",
    choices: ["FIT買取単価が通常より高くなる", "システム保証期間が太陽光単体より必ず長くなる", "停電時でも自家消費率向上と電力供給が可能", "電気工事士資格なしで設置できる"],
    answer: "停電時でも自家消費率向上と電力供給が可能",
    difficulty: "初級",
    explanation: "蓄電池との組み合わせにより、昼間発電した余剰電力を夜間に利用でき自家消費率が向上する。また停電時にも蓄電した電力を使用できる防災メリットがある。FIT価格への影響はない。"
  },
  {
    q: "産業用（50kW以上）太陽光発電システムの経済性において、住宅用と異なる主要な特徴として正しいものはどれか。",
    choices: ["出力制御の対象となり発電量が保証されない場合がある", "電力会社との連系協議が不要である", "設置費用の消費税は非課税となる", "FIT買取価格が住宅用より高く設定されている"],
    answer: "出力制御の対象となり発電量が保証されない場合がある",
    difficulty: "中級",
    explanation: "産業用（特に50kW以上）はFIT制度における出力制御（指定ルール）の対象となり、電力系統の需給バランス調整のため出力を制限される場合がある。これにより年間発電量・収益が予測より低下するリスクがある。"
  },
  {
    q: "太陽光発電システムの顧客提案書に記載すべき「発電量シミュレーション」の説明として、適切でないものはどれか。",
    choices: ["発電量は保証値であり達成できない場合は賠償責任が生じる", "過去の気象データを基にした標準的な値を示す", "屋根の向き・傾斜角・影の影響を考慮して算出する", "NEDOの日射量データを基に算出することが推奨される"],
    answer: "発電量は保証値であり達成できない場合は賠償責任が生じる",
    difficulty: "中級",
    explanation: "発電量シミュレーションは参考値であり、気象変動により実際と異なることがある。シミュレーション値は保証値ではないことを顧客に明示することが重要。虚偽の保証は景品表示法違反になりうる。"
  },
  {
    q: "顧客への太陽光発電提案において、「景品表示法」上の問題となり得る表現として正しいものはどれか。",
    choices: ["「年間発電量の参考値は約4,500kWhです」", "「補助金を活用すると実質費用が下がります」", "「電気代が必ず毎月○○円削減されます」と断言する", "「設置費用は○○万円です（税込）」"],
    answer: "「電気代が必ず毎月○○円削減されます」と断言する",
    difficulty: "中級",
    explanation: "「必ず〇〇円削減される」という断定的な表現は、実際の効果が気象条件や生活パターンで変動するため、優良誤認を招く可能性がある景品表示法上の問題となりうる。参考値・概算であることを明示する必要がある。"
  },
  {
    q: "太陽光発電システムの「FIT制度終了後」（卒FIT）の活用方法として、顧客に提案できる選択肢として誤っているものはどれか。",
    choices: ["アグリゲーターサービスを通じた売電", "蓄電池を追加して自家消費率を高める", "電力会社や新電力会社への余剰電力売電（相対取引）", "電力会社に発電設備を強制的に買い取らせる"],
    answer: "電力会社に発電設備を強制的に買い取らせる",
    difficulty: "初級",
    explanation: "卒FIT後は電力会社への強制的な買い取り義務はない。相対取引（市場価格連動等）、自家消費拡大（蓄電池追加）、アグリゲーター活用などの選択肢がある。電力会社への強制買い取りは法的根拠がない。"
  },
  {
    q: "太陽光発電モジュールの廃棄・リサイクルに関する国の取り組みとして正しいものはどれか。",
    choices: ["廃棄パネルは全量海外輸出が義務付けられている", "太陽光パネルのリサイクルは全面的に禁止されている", "再エネ特措法改正により廃棄費用の積立制度が導入されている", "現在、太陽光パネルは一般廃棄物として処理が義務付けられている"],
    answer: "再エネ特措法改正により廃棄費用の積立制度が導入されている",
    difficulty: "中級",
    explanation: "2022年の再エネ特措法改正により、FIT・FIP認定を受けた太陽光発電設備（10kW以上）について廃棄等費用の外部積立が義務付けられた。廃棄に備えた資金確保の仕組みが制度化された。"
  },
  {
    q: "使用済み太陽光発電モジュールの廃棄において、「産業廃棄物」として処理される場合の主な有害物質として正しいものはどれか。",
    choices: ["カドミウム（CdTe系パネルの場合）や鉛（はんだ）", "アスベスト", "放射性物質", "フロンガス"],
    answer: "カドミウム（CdTe系パネルの場合）や鉛（はんだ）",
    difficulty: "中級",
    explanation: "太陽光パネルにはカドミウム（CdTe系）、鉛（はんだ接続部）、セレン（CIGS系）などの重金属が含まれる場合がある。適切な産業廃棄物処理が必要で、不適切な廃棄は廃棄物処理法違反となる。"
  },
  {
    q: "太陽光発電設備のリサイクルに関する「太陽光パネルリサイクル促進検討会」等の取り組みにおいて、リサイクル可能な主要材料として正しいものはどれか。",
    choices: ["太陽光パネルはリサイクルできない", "シリコン、アルミフレーム、ガラス、銀電極（バックコンタクト）など", "シリコン、アルミフレーム、ガラスのみ", "アルミフレームのみ"],
    answer: "シリコン、アルミフレーム、ガラス、銀電極（バックコンタクト）など",
    difficulty: "中級",
    explanation: "太陽光パネルのリサイクル可能材料にはシリコン（半導体材料）、アルミフレーム、ガラス、銀電極（高価値）、銅配線などが含まれる。技術的には高回収率が可能で、リサイクル技術の確立が進んでいる。"
  },
  {
    q: "太陽光発電の「環境便益」として、CO2削減効果の計算に用いる「電力のCO2排出係数」について正しい説明はどれか。",
    choices: ["全国一律で固定値（0.434kg-CO2/kWh）が常に使用される", "太陽光発電のCO2排出係数はゼロなので計算不要", "電力会社・年度によって異なる値が公表されている", "CO2削減量は発電量から排出係数を引き算して求める"],
    answer: "電力会社・年度によって異なる値が公表されている",
    difficulty: "中級",
    explanation: "電力のCO2排出係数は電力会社・電源構成・年度によって異なる値が環境省等から公表されている。地球温暖化対策推進法上の報告では調整後排出係数を使用する。係数は毎年変動する。"
  },
  {
    q: "太陽光発電システムの「エネルギーペイバック期間（Energy Payback Period）」として、現在の結晶シリコン系パネルの一般的な値はどれか。",
    choices: ["約5〜7年", "約1〜2年", "約10〜12年", "約15〜20年"],
    answer: "約1〜2年",
    difficulty: "中級",
    explanation: "現在の結晶シリコン系太陽光発電パネルのエネルギーペイバック期間（製造時のエネルギーを発電により回収する期間）は約1〜2年とされている。システム寿命（20〜25年）の大部分がCO2削減に貢献する。"
  },
  {
    q: "太陽光発電システムの「エネルギー収支比（Energy Return on Investment: EROI）」として、適切な値はどれか。",
    choices: ["約100倍以上", "マイナス（エネルギーを消費する一方）", "約1〜2倍（製造エネルギーとほぼ同量しか発電できない）", "約10〜20倍（製造エネルギーの10〜20倍を発電できる）"],
    answer: "約10〜20倍（製造エネルギーの10〜20倍を発電できる）",
    difficulty: "上級",
    explanation: "現代の太陽光発電システムのEROIは約10〜20倍程度とされる。エネルギーペイバック期間が1〜2年でシステム寿命が20〜25年のため、製造時の10〜20倍以上のエネルギーを生み出せる。"
  },
  {
    q: "住宅への太陽光発電システム提案において、顧客の「重要事項説明」として必ず伝えるべき内容として最も適切なものはどれか。",
    choices: ["競合他社の見積もり内容", "周辺住宅の電気代情報", "発電量の保証・シミュレーションの前提条件と変動リスク", "施工担当者の個人情報"],
    answer: "発電量の保証・シミュレーションの前提条件と変動リスク",
    difficulty: "初級",
    explanation: "顧客への重要事項説明では、発電量シミュレーションの前提条件（日射量データ、損失率等）と気象変動による変動リスク、FIT価格・制度の変更可能性、保証内容と範囲を明確に伝える必要がある。"
  },
  {
    q: "太陽光発電の「グリーン電力証書」について正しい説明はどれか。",
    choices: ["グリーン電力証書は自然エネルギーによる発電の環境価値を証書化したもの", "グリーン電力証書の購入で電気料金が無料になる", "グリーン電力証書はFIT電源から発行できない", "グリーン電力証書は政府が発行する法的強制力のある証明書"],
    answer: "グリーン電力証書は自然エネルギーによる発電の環境価値を証書化したもの",
    difficulty: "中級",
    explanation: "グリーン電力証書は自然エネルギー（太陽光、風力等）による電力の環境付加価値（CO2を排出しない価値）を切り離して証書化したもの。企業のCO2削減目標達成に活用される。FIT電源については一定の制約がある。"
  },
  {
    q: "産業用太陽光発電（FIT認定設備）の転売・名義変更において、必要な手続きとして正しいものはどれか。",
    choices: ["認定設備の譲渡には経産省の承認が必要（事業計画認定の変更申請）", "所有者が変わっても一切の手続きは不要", "電力会社への報告のみで済む", "都道府県知事への届出のみで済む"],
    answer: "認定設備の譲渡には経産省の承認が必要（事業計画認定の変更申請）",
    difficulty: "上級",
    explanation: "FIT/FIP認定を受けた発電設備を譲渡する場合、経済産業省（再生可能エネルギー電子申請）への事業計画認定変更申請が必要。手続きなく譲渡すると認定が取り消される可能性がある。"
  },
  {
    q: "太陽光発電の「カーボンニュートラル」への貢献を説明する際、正確な表現として正しいものはどれか。",
    choices: ["太陽光発電はCO2を全く排出しないため完全にカーボンフリー", "太陽光発電のCO2排出量は石炭火力と同等", "太陽光発電は発電時にCO2を排出しないが、製造・廃棄時には排出する（ライフサイクル全体では低排出）", "太陽光発電は化石燃料より多くのCO2を排出する"],
    answer: "太陽光発電は発電時にCO2を排出しないが、製造・廃棄時には排出する（ライフサイクル全体では低排出）",
    difficulty: "初級",
    explanation: "太陽光発電は運転時にはCO2を排出しないが、パネル製造・輸送・設置・廃棄の工程でCO2が排出される。ライフサイクルアセスメントでは石炭火力の約1/20〜1/50のCO2排出量となり、低炭素エネルギーとして評価される。"
  },
  {
    q: "太陽光発電の普及拡大に関連した「電力系統の問題」として、顧客に説明すべき内容として正しいものはどれか。",
    choices: ["太陽光発電は電力系統に一切影響を与えない", "太陽光発電が増えるほど電力系統は安定する", "太陽光発電を設置すると自動的に電力会社から独立できる", "太陽光発電が増えると電力系統が不安定になるリスクがあり、出力制御が必要な場合がある"],
    answer: "太陽光発電が増えると電力系統が不安定になるリスクがあり、出力制御が必要な場合がある",
    difficulty: "中級",
    explanation: "太陽光発電は天候依存の変動電源であるため、大量導入により電力系統の需給バランスが崩れるリスクがある。このため出力制御（発電量の制限）が必要な場合があり、顧客への説明として重要な事項である。"
  },
  {
    q: "顧客から「太陽光発電は本当に環境に良いのか」と質問された場合の適切な回答として、最も正確なものはどれか。",
    choices: ["「全く問題ありません。完全にクリーンです」と断言する", "環境への影響は一概に言えないため回答を避ける", "「環境への悪影響が大きいため設置を考え直すべきです」と答える", "ライフサイクルでのCO2排出量が火力発電の1/20〜1/50程度であり、エネルギーペイバック期間も1〜2年と短いことを説明する"],
    answer: "ライフサイクルでのCO2排出量が火力発電の1/20〜1/50程度であり、エネルギーペイバック期間も1〜2年と短いことを説明する",
    difficulty: "中級",
    explanation: "科学的根拠に基づいて、ライフサイクルCO2排出量が化石燃料の大幅に少ないこと、エネルギーペイバック期間が短いことを具体的数値で説明することが適切。誇張もせず、正確な情報提供が信頼構築につながる。"
  },
  {
    q: "「農地への太陽光発電設置（ソーラーシェアリング）」について顧客に説明する際、正しい内容はどれか。",
    choices: ["農地への太陽光設置は一切禁止されている", "農地へのソーラーシェアリングは補助金が受けられない", "一時転用許可を得てソーラーシェアリングが可能で、農業と発電の両立が求められる", "農地転用許可なしに設置できる"],
    answer: "一時転用許可を得てソーラーシェアリングが可能で、農業と発電の両立が求められる",
    difficulty: "中級",
    explanation: "ソーラーシェアリング（営農型太陽光発電）は農地法上の一時転用許可を取得し、農業を継続しながら上部に太陽光パネルを設置するもの。農業生産性を著しく低下させないことが許可条件。FIT認定も可能。"
  },
  {
    q: "太陽光発電の「反射光トラブル」に関する対応として、顧客への正しいアドバイスはどれか。",
    choices: ["反射光による近隣への影響を事前に検討し、問題が生じた場合の対応策も計画する", "反射光は法的に規制されていないため、どんな設置でも問題ない", "反射光トラブルは施工会社の責任であり設置者には無関係", "太陽光パネルは反射光を出さない"],
    answer: "反射光による近隣への影響を事前に検討し、問題が生じた場合の対応策も計画する",
    difficulty: "初級",
    explanation: "太陽光パネルの反射光が近隣住宅に照射されるトラブルが発生することがある。事前にシミュレーションや現地確認を行い、設置角度の調整や低反射パネルの採用などの対策を検討することが重要。"
  },
  {
    q: "太陽光発電システムの「訪問販売」における消費者保護として、クーリングオフの期間として正しいものはどれか。",
    choices: ["30日間", "8日間", "3日間", "14日間"],
    answer: "8日間",
    difficulty: "初級",
    explanation: "特定商取引法における訪問販売でのクーリングオフ期間は8日間（契約書受領日から）。太陽光発電システムの訪問販売にも適用される。消費者にクーリングオフ権利を説明する義務がある。"
  },
  {
    q: "太陽光発電システムの販売における「割賦販売法」に関して、正しい説明はどれか。",
    choices: ["現金一括払いの場合でも割賦販売法の適用を受ける", "太陽光発電は割賦販売の対象外である", "分割払いで販売する場合、割賦販売法の規制は受けない", "ローン契約を伴う場合、割賦販売法および貸金業法の規制を受ける場合がある"],
    answer: "ローン契約を伴う場合、割賦販売法および貸金業法の規制を受ける場合がある",
    difficulty: "中級",
    explanation: "太陽光発電をローン（分割払い、信販ローン等）で販売する場合、割賦販売法の適用を受ける。月賦販売、包括信用購入あっせん、個別信用購入あっせん等によって規制内容が異なる。"
  },
  {
    q: "住宅用太陽光発電システムの提案において、「ZEH（ネット・ゼロ・エネルギー・ハウス）」との関係として正しいものはどれか。",
    choices: ["ZEHは太陽光発電とは無関係な省エネ基準", "ZEH認定を受けると電気代が無料になる", "ZEHの要件として、高断熱・省エネ設備に加えて太陽光発電などの創エネが必要", "ZEHは商業施設のみに適用される基準"],
    answer: "ZEHの要件として、高断熱・省エネ設備に加えて太陽光発電などの創エネが必要",
    difficulty: "初級",
    explanation: "ZEH（ネット・ゼロ・エネルギー・ハウス）は、①高断熱・高効率設備による省エネ、②太陽光発電等による創エネを組み合わせ、年間の一次エネルギー消費量の収支をゼロ以下にする住宅。太陽光発電は中核要素。"
  },
  {
    q: "太陽光発電システムの「第三者所有モデル（TPO）」について正しい説明はどれか。",
    choices: ["政府が所有し国民に無料で提供するモデル", "電力会社以外の第三者がシステムを所有・運営し、顧客は発電電力を購入するモデル", "3社以上の会社が共同でシステムを所有するモデル", "第三者所有モデルはFIT制度に参加できない"],
    answer: "電力会社以外の第三者がシステムを所有・運営し、顧客は発電電力を購入するモデル",
    difficulty: "中級",
    explanation: "TPO（Third Party Ownership）モデルは、サービス会社がシステムを設置・所有し、顧客は電力をサービス会社から購入するPPAや、リースで設備を借りる形態。初期費用なしで太陽光発電を利用できるメリットがある。"
  },
  {
    q: "PPA（電力購入契約）モデルで太陽光発電システムを提案する際の特徴として、正しいものはどれか。",
    choices: ["サービス提供会社が設備を無償設置し、顧客は発電した電力を一定価格で購入する契約", "顧客が初期費用を全額負担し、長期契約で電気を安く購入する", "PPAはFIT制度と必ず併用しなければならない", "PPA契約期間は法律で最大5年に制限されている"],
    answer: "サービス提供会社が設備を無償設置し、顧客は発電した電力を一定価格で購入する契約",
    difficulty: "中級",
    explanation: "PPAでは事業者が顧客の屋根に無償（または低コスト）で設備を設置し、発電した電力を顧客が一定単価で購入する契約。顧客は初期費用不要で太陽光電力を利用できる。契約期間は通常10〜20年。"
  },
  {
    q: "太陽光発電設置に関する「特定商取引法」における禁止行為として正しいものはどれか。",
    choices: ["電話で事前にアポイントを取ること", "事実と異なることを告げて顧客の誤解を招くこと（不実告知）", "訪問先でカタログを置いていくこと", "契約締結後に書面を交付すること"],
    answer: "事実と異なることを告げて顧客の誤解を招くこと（不実告知）",
    difficulty: "初級",
    explanation: "特定商取引法では、不実告知（虚偽の事実を告げる行為）は禁止行為。「絶対に電気代が下がる」「補助金が必ずもらえる」等の虚偽・誇大な説明は違反となる。違反には行政処分や刑事罰が科される。"
  },
  {
    q: "太陽光発電システムを含む「省エネリフォーム」の補助金として、国土交通省が実施している補助制度として正しいものはどれか。",
    choices: ["先進的窓リノベ2024事業", "農業用太陽光補助", "太陽光限定特別補助金", "工場用太陽光設備助成"],
    answer: "先進的窓リノベ2024事業",
    difficulty: "上級",
    explanation: "「先進的窓リノベ2024事業」は国土交通省・環境省が実施する断熱窓への改修補助。太陽光発電は別途「こどもエコすまい支援事業」後継制度等で支援される場合がある。補助制度は毎年見直されるため最新情報確認が必要。"
  },
  {
    q: "産業用太陽光発電の「固定資産税」に関する特例措置として正しいものはどれか。",
    choices: ["太陽光発電設備には固定資産税が2倍かかる", "再エネ設備の固定資産税課税標準特例（軽減措置）が設けられている", "太陽光発電設備は固定資産税の対象外である", "住宅用と産業用で固定資産税率は同一"],
    answer: "再エネ設備の固定資産税課税標準特例（軽減措置）が設けられている",
    difficulty: "中級",
    explanation: "再生可能エネルギー発電設備については、地方税法の特例により固定資産税の課税標準が一定期間軽減される特例措置が設けられている（再エネ設備の種類・規模により異なる）。"
  },
  {
    q: "太陽光発電事業の「事業税」に関して、個人の場合の取り扱いとして正しいものはどれか。",
    choices: ["売電収入は雑所得または事業所得として所得税の課税対象となる場合がある", "FIT売電収入は消費税が20%課税される", "太陽光発電は個人でも必ず法人化が必要", "個人の太陽光発電収入は全て非課税"],
    answer: "売電収入は雑所得または事業所得として所得税の課税対象となる場合がある",
    difficulty: "中級",
    explanation: "個人の太陽光発電による売電収入は所得税の課税対象。規模・状況により雑所得または事業所得に区分される。また売電事業者は消費税の課税事業者になる場合もある（年間売上1,000万円超等）。"
  },
  {
    q: "太陽光発電システムの「メーカー保証」と「施工保証」の違いとして正しいものはどれか。",
    choices: ["メーカー保証は製品の出力・製品保証、施工保証は設置工事の不具合に対する保証", "メーカー保証は購入後1年間のみ有効", "両方同一の内容で、区別する必要はない", "施工保証のみが法的に義務付けられている"],
    answer: "メーカー保証は製品の出力・製品保証、施工保証は設置工事の不具合に対する保証",
    difficulty: "初級",
    explanation: "メーカー保証はモジュールの出力保証（通常20〜25年）と製品保証（通常10〜15年）からなる製品側の保証。施工保証は設置工事の不具合（雨漏り、配線ミス等）に対する施工会社側の保証。両者は異なる内容を補完する。"
  },
  {
    q: "太陽光発電システムの顧客提案において、「屋根の向き」が発電量に与える影響として正しい説明はどれか（日本の場合）。",
    choices: ["すべての屋根の向きで発電量は同一", "北向きでも南向きと同等の発電量が得られる", "真南向きが最も発電量が多く、東西向きは南向き比で約80〜85%程度", "東向きは南向きより必ず発電量が多い"],
    answer: "真南向きが最も発電量が多く、東西向きは南向き比で約80〜85%程度",
    difficulty: "初級",
    explanation: "日本（北半球）では真南向きが最も年間発電量が多い。東西向きは南向き比で約80〜85%程度の発電量。北向きは大幅に少なく約60〜70%程度。顧客の屋根形状に応じた適切なシミュレーションが重要。"
  },
  {
    q: "太陽光発電の販売活動における「電気通信事業法」との関係で、適切な説明はどれか。",
    choices: ["電話によるアポイント取得には電気通信事業法の規制は適用されない", "インターネット広告は法律の規制を受けない", "電話を使った勧誘でも特定商取引法の規制（電話勧誘販売）が適用される", "SNSを使った販促活動は全て違法である"],
    answer: "電話を使った勧誘でも特定商取引法の規制（電話勧誘販売）が適用される",
    difficulty: "中級",
    explanation: "電話による勧誘（テレアポ）で太陽光発電の契約を締結させた場合、特定商取引法の「電話勧誘販売」に該当し、書面交付義務やクーリングオフ（8日間）等の規制が適用される。"
  },
  {
    q: "顧客が太陽光発電の設置を検討する際に必要な「屋根診断」の観点として、適切でないものはどれか。",
    choices: ["屋根の積載荷重（耐荷重）の確認", "屋根の色と住宅全体のインテリアとの調和", "屋根の劣化・雨漏りリスクの確認", "屋根材の種類と施工可否の確認"],
    answer: "屋根の色と住宅全体のインテリアとの調和",
    difficulty: "初級",
    explanation: "屋根診断では技術的・安全的観点（劣化状況、屋根材の種類、構造強度・積載荷重、影の影響）が重要。インテリアとの調和は顧客の好みの問題であり、安全性・性能の観点での診断項目ではない。"
  },
  {
    q: "太陽光発電システムの「O&M契約（維持管理契約）」を顧客に提案する際のメリットとして、適切でないものはどれか。",
    choices: ["システムの長期安定稼働の確保", "定期的な点検による不具合の早期発見", "発電量低下時の原因究明と対処", "O&M費用の一切が国から補助される"],
    answer: "O&M費用の一切が国から補助される",
    difficulty: "初級",
    explanation: "O&M（Operation & Maintenance）契約のメリットは定期点検、不具合早期発見、パフォーマンス最適化、長期稼働保証など。O&M費用は基本的に事業者（所有者）が負担するものであり、国から全額補助されるわけではない。"
  },
  {
    q: "太陽光発電の「発電事業者」として、FIT制度上の義務として正しいものはどれか。",
    choices: ["認定計画に従った適切な運転・保守を行い、定期的に実績報告を行う義務", "電力会社の社員を常駐させる義務がある", "FIT期間中は設備の変更・修理を一切行ってはならない", "発電量に関係なく毎月50万円の費用を納付する義務がある"],
    answer: "認定計画に従った適切な運転・保守を行い、定期的に実績報告を行う義務",
    difficulty: "中級",
    explanation: "FIT認定事業者には、認定計画に従った適切な運転・保守、電気事業法に基づく保安規程遵守、定期自主検査の実施、経済産業省への定期報告（運転開始報告、年次報告等）などの義務がある。"
  },
  {
    q: "太陽光発電パネルのリサイクルコスト積立に関する再エネ特措法（2022年改正）の制度内容として正しいものはどれか。",
    choices: ["積立は任意であり、法的義務はない", "廃棄費用は全額国が負担するため積立は不要", "10kW以上のFIT・FIP認定設備に廃棄等費用の外部積立が義務付けられた", "全ての住宅用（10kW未満）にも外部積立が義務付けられた"],
    answer: "10kW以上のFIT・FIP認定設備に廃棄等費用の外部積立が義務付けられた",
    difficulty: "中級",
    explanation: "2022年改正再エネ特措法により、10kW以上のFIT・FIP認定太陽光発電設備について、廃棄等費用の外部積立（信託等）が義務付けられた。10kW未満の住宅用は現時点では対象外。"
  },
  {
    q: "太陽光発電の「LCOE（均等化発電コスト）」について正しい説明はどれか。",
    choices: ["LCOEはシステムの生涯コスト（初期費用＋維持費用）を総発電量で割った電力1kWhあたりのコスト", "LCOEが高いほど経済的なシステム", "LCOEの計算に割引率は考慮しない", "LCOEはシステムの初期費用のみで計算される"],
    answer: "LCOEはシステムの生涯コスト（初期費用＋維持費用）を総発電量で割った電力1kWhあたりのコスト",
    difficulty: "上級",
    explanation: "LCOE（Levelized Cost of Energy）は初期投資、O&Mコスト、廃棄コスト等の生涯コストの現在価値合計を、生涯総発電量の現在価値合計で割った値。電源間の経済性比較に使用される指標。低いほど経済的。"
  },
  {
    q: "太陽光発電の「アグリゲーション」サービスについて正しい説明はどれか。",
    choices: ["アグリゲーションは住宅用のみに適用される", "太陽光パネルを集積して大型化する技術", "複数の発電設備・蓄電池・需要家を束ねて電力市場に参加するサービス", "太陽光パネルを農地に設置する農業との複合利用"],
    answer: "複数の発電設備・蓄電池・需要家を束ねて電力市場に参加するサービス",
    difficulty: "中級",
    explanation: "アグリゲーションは、アグリゲーターが複数の分散した発電設備・蓄電池・負荷を束ねてVPP（仮想発電所）を構成し、電力市場や需給調整市場に参加するサービス。卒FIT後の収益化手段として注目される。"
  },
  {
    q: "太陽光発電設備の廃棄において、一般廃棄物と産業廃棄物の区分として正しいものはどれか。",
    choices: ["全て一般廃棄物として処理できる", "全て産業廃棄物として処理しなければならない", "住宅（家庭）から排出されるものは一般廃棄物、事業者から排出されるものは産業廃棄物", "住宅用（家庭から排出）は産業廃棄物、事業用は一般廃棄物"],
    answer: "住宅（家庭）から排出されるものは一般廃棄物、事業者から排出されるものは産業廃棄物",
    difficulty: "中級",
    explanation: "廃棄物処理法では、家庭（個人住宅）から排出される廃棄物は一般廃棄物、事業活動に伴って排出される廃棄物は産業廃棄物として区分される。住宅用でも賃貸や事業用途なら産業廃棄物扱いとなる場合がある。"
  },
  {
    q: "太陽光発電の「再エネ賦課金」について顧客から質問された場合の正しい回答はどれか。",
    choices: ["再エネ賦課金は太陽光発電を設置すると免除される", "再エネ賦課金は電力会社の利益となる", "再エネ賦課金は全ての電力消費者が負担し、再エネ電力の固定価格買取費用に充当される", "再エネ賦課金は電力使用量に関係なく一律定額"],
    answer: "再エネ賦課金は全ての電力消費者が負担し、再エネ電力の固定価格買取費用に充当される",
    difficulty: "初級",
    explanation: "再エネ賦課金（再生可能エネルギー発電促進賦課金）は全ての電力消費者が使用量に応じて負担する費用で、FIT・FIPで買い取られた再エネ電力のコストに充当される。太陽光を設置しても賦課金は免除されない（自家消費部分は負担なし）。"
  },
  {
    q: "太陽光発電に関する「電力システム改革」の背景として正しいものはどれか。",
    choices: ["原子力発電のみを推進するための改革", "電力の自由化・競争促進により再エネを含む多様な電源の参入を促進する改革", "電力の完全国有化を目的とした改革", "電力輸入を増やすための改革"],
    answer: "電力の自由化・競争促進により再エネを含む多様な電源の参入を促進する改革",
    difficulty: "中級",
    explanation: "電力システム改革（2016年の小売全面自由化、発送電分離等）は、競争促進による料金低下、電力安定供給の確保、再エネ等の多様な電源の参入促進を目的とした。太陽光発電の普及拡大とも密接に関連する。"
  },
  {
    q: "産業用太陽光発電の「土地リスク」に関する説明として正しいものはどれか。",
    choices: ["FIT認定期間中は土地を売却できない", "土地の賃借（賃貸）契約で発電所を設置した場合、賃貸借契約終了リスクを考慮する必要がある", "土地リスクはFIT制度で全て保証されている", "国有地は無条件で太陽光発電に利用できる"],
    answer: "土地の賃借（賃貸）契約で発電所を設置した場合、賃貸借契約終了リスクを考慮する必要がある",
    difficulty: "中級",
    explanation: "賃借地で太陽光発電事業を行う場合、賃貸借契約の期間満了・解除リスクがある。FIT認定期間（20年）と賃貸借契約期間の整合性確認、契約更新の見通し確認が重要なリスク管理事項。"
  },
  {
    q: "太陽光発電システムのNPV計算において、「割引率」が高くなると投資評価にどのような影響があるか。",
    choices: ["NPVが大きくなり、投資が有利に見える", "割引率はNPVに影響しない", "投資回収期間が短くなる", "NPVが小さく（またはマイナスに）なり、投資が不利に見える"],
    answer: "NPVが小さく（またはマイナスに）なり、投資が不利に見える",
    difficulty: "上級",
    explanation: "割引率が高いほど将来のキャッシュフローの現在価値が小さくなるため、NPVは低下する。長期投資（太陽光発電は20年超）では割引率の影響が大きく、高い割引率ではNPVがマイナスになりやすい。"
  },
  {
    q: "太陽光発電の「IRR（内部収益率）」について正しい説明はどれか。",
    choices: ["IRRは年間の発電量を表す", "IRRはNPVがゼロになる割引率であり、高いほど投資価値が高い", "IRRはFIT価格と同一の数値", "IRRはシステムの設置費用を表す指標"],
    answer: "IRRはNPVがゼロになる割引率であり、高いほど投資価値が高い",
    difficulty: "上級",
    explanation: "IRR（Internal Rate of Return：内部収益率）は投資の収益性を示す指標で、NPV=0となる割引率。IRRが資本コスト（融資金利等）より高ければ投資価値ありと判断できる。太陽光発電事業では7〜12%程度が一般的目標。"
  },
  {
    q: "地球温暖化対策として「再生可能エネルギー100%（RE100）」イニシアティブについて、顧客（企業）に説明する際の正しい内容はどれか。",
    choices: ["RE100に参加すると政府から補助金が支給される", "RE100は電力会社のみが参加できる", "RE100は企業が事業に使用する電力を100%再生可能エネルギーで調達することを目標とする国際イニシアティブ", "RE100は日本政府が義務付けた法的規制"],
    answer: "RE100は企業が事業に使用する電力を100%再生可能エネルギーで調達することを目標とする国際イニシアティブ",
    difficulty: "中級",
    explanation: "RE100（Renewable Energy 100%）は企業が使用電力の100%を再エネで賄うことを目標とする国際イニシアティブ。任意参加だが参加企業の信頼性・投資家評価向上に繋がる。太陽光発電の自家消費・PPA・グリーン電力証書が活用手段。"
  },
  {
    q: "太陽光発電の「フェーズドアプローチ」提案（段階的導入）について、顧客へのメリット説明として正しいものはどれか。",
    choices: ["初期投資を分散しながら技術・制度変化に対応しやすい", "段階的導入ではFIT申請ができない", "フェーズドアプローチはメーカー保証が無効になる", "段階的導入では常に一括導入より費用が安くなる"],
    answer: "初期投資を分散しながら技術・制度変化に対応しやすい",
    difficulty: "中級",
    explanation: "段階的導入のメリットは初期投資の分散（資金計画の柔軟性）と技術革新・制度変更への対応。例えば第1フェーズで太陽光を設置し、第2フェーズで蓄電池・EVを追加する形。ただし工事費が割高になる場合もある。"
  },
  {
    q: "建設業法における太陽光発電システムの設置工事業者が持つべき許可として、電気工事（電気系統）の場合に必要なものはどれか。",
    choices: ["建設業許可（電気工事業）", "旅行業登録", "宅地建物取引業免許", "食品衛生許可"],
    answer: "建設業許可（電気工事業）",
    difficulty: "中級",
    explanation: "太陽光発電システムの電気工事を請け負う場合、建設業法に基づく「電気工事業」の建設業許可が必要（500万円以上の工事の場合）。また電気工事業法に基づく電気工事業者登録も必要。"
  },
  {
    q: "太陽光発電の「電力の地産地消」モデルについて正しい説明はどれか。",
    choices: ["地産地消は離島のみで実施可能", "地産地消は地域内で発電した電力をできるだけ地域内で消費するモデル", "地産地消では売電収入が得られない", "地産地消は法律で義務付けられた電力取引方式"],
    answer: "地産地消は地域内で発電した電力をできるだけ地域内で消費するモデル",
    difficulty: "初級",
    explanation: "電力の地産地消は地域内の再エネ（太陽光等）で発電した電力を、送電ロスを最小化しながら地域内で消費するモデル。エネルギーの地域自立、送配電コスト削減、災害時のレジリエンス向上に寄与する。"
  },
  {
    q: "太陽光発電に関連する「SDGs（持続可能な開発目標）」との対応として、最も直接的に関連するゴールはどれか。",
    choices: ["ゴール2「飢餓をゼロに」", "ゴール14「海の豊かさを守ろう」", "ゴール7「エネルギーをみんなに そしてクリーンに」", "ゴール16「平和と公正をすべての人に」"],
    answer: "ゴール7「エネルギーをみんなに そしてクリーンに」",
    difficulty: "初級",
    explanation: "太陽光発電はSDGsゴール7「エネルギーをみんなに そしてクリーンに」に直接対応する。クリーンエネルギーの普及、エネルギーアクセスの改善に貢献する。また気候変動対策（ゴール13）にも大きく寄与する。"
  },
  {
    q: "顧客へのヒアリングにおいて、太陽光発電の提案を最適化するために確認すべき「電力使用パターン」の情報として最も重要なものはどれか。",
    choices: ["顧客の出身地と家族の職業", "昼間の在宅状況と電気使用量（ピーク時間帯）", "顧客の趣味や休日の過ごし方", "近隣住宅の太陽光発電設置状況"],
    answer: "昼間の在宅状況と電気使用量（ピーク時間帯）",
    difficulty: "初級",
    explanation: "自家消費率を高めるためには昼間の在宅状況が重要。共働きで昼間不在の場合は自家消費率が低く売電中心になる。在宅勤務・専業主婦・高齢者などは昼間消費が多く自家消費率が高い。提案内容の最適化に直結する情報。"
  },
  {
    q: "太陽光発電システムの「工事保険（組立保険・建設工事保険）」について正しい説明はどれか。",
    choices: ["工事保険はFIT認定の条件となっている", "設置工事中の事故や損害をカバーする保険で、施工会社が加入する", "施主（顧客）が必ず加入しなければならない法定保険", "工事保険は火災のみをカバーする"],
    answer: "設置工事中の事故や損害をカバーする保険で、施工会社が加入する",
    difficulty: "中級",
    explanation: "建設工事保険・組立保険は設置工事中の事故（部材落下、作業中破損等）や自然災害による損害をカバーする保険で、通常施工会社が加入する。完成後は設備への火災保険・動産総合保険等が必要となる。"
  },
  {
    q: "4kWの住宅用太陽光発電システムを設置する場合の概算費用として、現在（2024年頃）最も適切な範囲はどれか。",
    choices: ["約500万円以上", "約50〜80万円", "約100〜160万円", "約200〜300万円"],
    answer: "約100〜160万円",
    difficulty: "中級",
    explanation: "2024年頃の住宅用太陽光発電の設置費用は1kWあたり約25〜40万円程度であり、4kWシステムでは概算100〜160万円程度。パネルメーカー、設置条件、施工会社により大きく異なる。"
  },
  {
    q: "太陽光発電に関する「電力先物・電力市場」についての説明として正しいものはどれか。",
    choices: ["太陽光発電事業者は義務として電力先物取引に参加しなければならない", "FIP制度では市場連動型の買取が行われ、市場価格変動リスクを管理する手段として先物市場等が活用される", "電力市場は太陽光発電に関係ない", "電力先物市場は日本には存在しない"],
    answer: "FIP制度では市場連動型の買取が行われ、市場価格変動リスクを管理する手段として先物市場等が活用される",
    difficulty: "上級",
    explanation: "FIP（フィードインプレミアム）制度では参照価格（市場価格）に基づいてプレミアム額が変動するため、事業者は市場価格変動リスクを負う。日本でも2020年に電力先物市場（EEX等）が開始され、リスクヘッジに活用できる。"
  },
  {
    q: "太陽光発電の「雪害対策」として顧客に提案すべき内容として正しいものはどれか。",
    choices: ["積雪地域のパネルは屋根への設置ができない", "雪が積もっても発電量には全く影響しない", "積雪の多い地域では傾斜角を大きくして雪が落ちやすくする設計や雪止めの配置検討が有効", "積雪地域への太陽光発電設置は法律で禁止されている"],
    answer: "積雪の多い地域では傾斜角を大きくして雪が落ちやすくする設計や雪止めの配置検討が有効",
    difficulty: "初級",
    explanation: "積雪地域では、傾斜角を大きく（30°以上）することで雪が自然落下しやすくなる。また屋根からの落雪による人・物への被害防止のための雪止め設置（またはあえて雪止めを設けない設計）の検討が必要。積雪中は発電量が大幅低下する。"
  },
  {
    q: "太陽光発電の「電力の完全自家消費型」システムの特徴として正しいものはどれか。",
    choices: ["蓄電池を組み合わせて系統連系せず、発電電力を全て自家消費するオフグリッドシステムも含まれる", "完全自家消費型は住宅には適用できない", "完全自家消費型では電力会社への申請が一切不要", "FIT制度に参加することが必須"],
    answer: "蓄電池を組み合わせて系統連系せず、発電電力を全て自家消費するオフグリッドシステムも含まれる",
    difficulty: "中級",
    explanation: "完全自家消費型には系統連系しないオフグリッドシステム（蓄電池必須）と、系統連系しながら余剰電力を売電せず全量自家消費する方式がある。オフグリッドは電力の安定性確保が課題だが、電力会社手続きが不要なケースもある。"
  },
  {
    q: "太陽光発電アドバイザーとして顧客に最終的な提案を行う際の総合的な姿勢として、最も適切なものはどれか。",
    choices: ["デメリットやリスクは説明せず、メリットだけを強調して契約を急がせる", "顧客の質問には答えず、標準的なプランだけを提示する", "売上を最大化するために顧客に最も高額なシステムを必ず勧める", "顧客ニーズ・予算・生活スタイルに合わせた最適なシステムを提案し，正確な情報とリスクも含めて誠実に説明する"],
    answer: "顧客ニーズ・予算・生活スタイルに合わせた最適なシステムを提案し，正確な情報とリスクも含めて誠実に説明する",
    difficulty: "初級",
    explanation: "太陽光発電アドバイザーとして最も重要なのは、顧客のニーズと状況を把握し、メリット・デメリット・リスクを含む正確な情報を誠実に提供すること。顧客の長期的な利益を考えた提案が信頼関係を構築し、業界の健全な発展につながる。"
  }
];

function generateSalesQuestions() {
  return SALES_SPECS.map((spec) => {
    const choiceExplanations = {};
    choiceExplanations[spec.answer] = { result: "正解", reason: spec.explanation };
    spec.choices.forEach((c) => {
      if (c === spec.answer) return;
      choiceExplanations[c] = { result: "不正解", reason: `正解は「${spec.answer}」。${spec.explanation}` };
    });

    return {
      id: nextQuestionId("j"),
      mode: "knowledge",
      category: "販売・提案・環境",
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
  generateEquipmentQuestions,
  generateConstructionQuestions,
  generateGridPolicyQuestions,
  generateLawQuestions,
  generateOMQuestions,
  generateSalesQuestions,
  isUnknownValue
};
