/* ================================================================
   scripts/sync-questions.js
   ----------------------------------------------------------------
   Googleスプレッドシート → 問題生成 → Supabaseの questions テーブルへ
   書き込む、同期用スクリプト（Node.jsで実行する管理者向けツール）。

   使い方：
     1. battery-quiz-app フォルダに .env を作る（.env.example を参考に）
        SUPABASE_URL=https://xxxxx.supabase.co
        SUPABASE_SECRET_KEY=sb_secret_...
     2. フォルダ内で実行:
        node scripts/sync-questions.js

   何をするか：
     ・スプレッドシートを読み込み、question-generator.js の
       ロジックで知識問題・実践提案問題を生成する
     ・questions テーブルを一旦全件削除し、生成した問題を入れ直す
       （answer_history は question_id に外部キー制約＋ON DELETE CASCADEが
       張ってあるので、削除された問題に紐づく回答履歴も自動的に消える。
       スプレッドシートの内容が大きく変わった場合は、ユーザーの
       不正解/正解リストの一部がリセットされることがある点に注意）

   ★ secret keyはRLSを無視できる管理者権限のキーです。
     このスクリプト以外（アプリ本体・ブラウザ側のコード）では
     絶対に使わないでください。
   ================================================================ */

const fs = require("fs");
const path = require("path");
const {
  SHEET_CONFIG,
  loadProductsFromSheet,
  resetQuestionIdCounter,
  generateKnowledgeQuestions,
  generatePracticeQuestions,
  generateBasicConceptQuestions
} = require("../question-generator.js");

// ---- .env を読み込む（外部ライブラリは使わず、最低限の手書きパーサーで済ませる） ----
function loadEnvFile() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) return;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!(key in process.env)) process.env[key] = value; // 既存の環境変数を優先する
  });
}
loadEnvFile();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("エラー: .env に SUPABASE_URL と SUPABASE_SECRET_KEY を設定してください（.env.example参照）。");
  process.exit(1);
}

// ---- Supabase REST APIへの共通リクエスト関数 ----
async function supabaseRequest(pathAndQuery, options) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(options && options.headers)
    }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabaseリクエスト失敗 (${res.status}) ${pathAndQuery}: ${body}`);
  }
  return res;
}

// アプリ内部の問題オブジェクト（camelCase）→ questionsテーブルの行（snake_case）に変換
function toRow(q) {
  return {
    id: q.id,
    mode: q.mode,
    category: q.category,
    difficulty: q.difficulty,
    question: q.question,
    customer_scenario:
      q.customerScenario && typeof q.customerScenario === "object" ? q.customerScenario : null,
    choices: q.choices,
    answer: q.answer,
    explanation: q.explanation,
    choice_explanations: q.choiceExplanations || null,
    source_manufacturer: q.sourceManufacturer || null,
    source_product: q.sourceProduct || null
  };
}

// 配列を指定サイズごとに分割する（一度に大量のINSERTを投げないため）
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function main() {
  console.log("スプレッドシートを読み込み中...");
  let allProducts = [];
  let knowledgeQuestions = [];
  let practiceQuestions = [];

  resetQuestionIdCounter();

  // 初級：スプレッドシートの製品データに依存しない、静的な基礎知識問題
  const basicConceptQuestions = generateBasicConceptQuestions();
  console.log(`  [基礎知識（初級）] ${basicConceptQuestions.length}問を生成`);
  knowledgeQuestions = knowledgeQuestions.concat(basicConceptQuestions);

  for (const conf of SHEET_CONFIG) {
    const products = await loadProductsFromSheet(conf);
    console.log(`  [${conf.name}] ${products.length}製品を取得`);
    if (conf.type === "battery") {
      allProducts = allProducts.concat(products);
      knowledgeQuestions = knowledgeQuestions.concat(generateKnowledgeQuestions(products));
      practiceQuestions = practiceQuestions.concat(generatePracticeQuestions(products));
    }
  }

  if (allProducts.length === 0) {
    console.error("エラー: スプレッドシートから製品データを1件も取得できませんでした。同期を中止します。");
    process.exit(1);
  }

  const allQuestions = knowledgeQuestions.concat(practiceQuestions);
  console.log(`生成完了: 知識問題${knowledgeQuestions.length}問 + 実践提案問題${practiceQuestions.length}問 = 合計${allQuestions.length}問`);

  console.log("questionsテーブルを全件削除中...");
  await supabaseRequest("questions?id=not.is.null", { method: "DELETE" });

  console.log("questionsテーブルへ書き込み中...");
  const rows = allQuestions.map(toRow);
  const batches = chunk(rows, 200);
  for (let i = 0; i < batches.length; i++) {
    await supabaseRequest("questions", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(batches[i])
    });
    console.log(`  ${Math.min((i + 1) * 200, rows.length)} / ${rows.length} 件 書き込み完了`);
  }

  console.log("同期完了！");
}

main().catch((err) => {
  console.error("同期中にエラーが発生しました:", err.message);
  process.exit(1);
});
