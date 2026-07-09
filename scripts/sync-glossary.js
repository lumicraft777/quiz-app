/* ================================================================
   scripts/sync-glossary.js
   ----------------------------------------------------------------
   glossary-data.js の内容をSupabaseの glossary テーブルへ書き込む。

   使い方（sync-questions.jsと同じ .env を使う）:
     node scripts/sync-glossary.js

   将来スプレッドシートに「用語集」シートを追加したくなったら、
   glossary-data.js を読む代わりにそのシートを読み込むよう
   このファイルを書き換えればよい（question-generator.js /
   sync-questions.js と同じ構成パターン）。
   ================================================================ */

const fs = require("fs");
const path = require("path");
const terms = require("./glossary-data.js");

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
    if (!(key in process.env)) process.env[key] = value;
  });
}
loadEnvFile();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("エラー: .env に SUPABASE_URL と SUPABASE_SECRET_KEY を設定してください（.env.example参照）。");
  process.exit(1);
}

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

async function main() {
  console.log(`用語集を書き込み中... (${terms.length}件)`);

  console.log("glossaryテーブルを全件削除中...");
  await supabaseRequest("glossary?term=not.is.null", { method: "DELETE" });

  await supabaseRequest("glossary", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(terms)
  });

  console.log("同期完了！");
}

main().catch((err) => {
  console.error("同期中にエラーが発生しました:", err.message);
  process.exit(1);
});
