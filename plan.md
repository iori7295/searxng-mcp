# searxng-mcp 強化実装計画

## ゴール

1. **検索品質の向上** — ハイブリッド検索 (BM25 + ベクトル) + リランク
2. **速度の確保** — 外部 API 依存ゼロ、in-process / 隣接サービスのみ
3. **LLM コンテキスト削減** — page 全体ではなくクエリ関連チャンクのみを渡す
4. **堅牢化** — SSRF・型安全・並行性のバグを潰す

## Phase 1-7 ✅

既存実装済み（2025-05-17 完了）。Phase 4-7 はコードレビュー4回分の修正。

## Phase 8: Linkup 対抗 — 設定最適化 + 検索カバレッジ改善 🟡

SearXNG は 251 のエンジンを内蔵しているが、現状 google と wikipedia のみが稼働。
engine の設定チューニングと throttle 調整でコード変更なしに検索カバレッジを数倍にできる。

| ID | タスク | ファイル | 状態 |
|----|--------|----------|------|
| 8.1 | SearXNG settings.yml で brave/duckduckgo/qwant 等の engine 有効化 | settings.yml (外部) | ⚠️ 要手動設定 |
| 8.2 | SEARCH_MIN_INTERVAL_MS を 2000→500 に調整（自前 SearXNG 前提） | config.ts | ✅ |

## Phase 9: 検索品質強化コア 🟡

Linkup 対抗と差別化を両立する中核機能群。

| ID | タスク | ファイル | 優先度 |
|----|--------|----------|--------|
| 9.1 | reranker type キャッシュ — Jina/TEI 検出を初回のみにし、毎リクエストの無駄な5秒タイムアウトを削除 | reranker.ts | **High** ✅ |
| 9.2 | infoboxes / answers / suggestions 露出 — SearXNG 既存レスポンスの未使用フィールドを検索結果に追加 | types.ts, search.ts, tools.ts | **High** ✅ |
| 9.3 | クロスクエリ知識 — 過去 fetch 結果の Valkey cache を search 結果に織り込み、"Previously fetched" マーク付きで表示（ENABLE_VECTOR_STORE 不要） | search.ts | **High** ✅ |
| 9.4 | MMR 簡易多様化 — 同一ドメインの結果が上位に固まるのを防ぐ（ドメインベース簡易版、TEI 不要） | reranker.ts | Medium ✅ |
| 9.5 | search_and_* の fetchPool 拡大 — rerank 対象プールが実質 6件 で止まっているのを改善 | tools.ts | Medium ✅ |
| 9.6 | expand 時の RRF 無駄処理修正 — variants が空なら RRF をスキップ | search.ts | Low ✅ |

### Phase 9 補足

- 9.1 は TEI ユーザーが毎リクエスト Jina → TEI fallback で **5秒ロス** している問題の修正
- 9.3 が「無料セルフホストで有料に勝つ」差別化の本丸。他 MCP にはできない独自機能
- 9.4 は全 MCP 検索サーバで未実装の差別化領域。ドメインベース簡易版で30行

## Phase 10: さらなる強化 🟡

| ID | タスク | ファイル | 優先度 |
|----|--------|----------|--------|
| 10.1 | chunker.ts separator 拡張（日本語句読点対応） | chunker.ts | Low ✅ |
| 10.2 | formatResults surrogate pair 対策 | tools.ts | Low ✅ |
| 10.3 | pdf-parse 動的 import の起動時 warmup | fetch.ts | Low ⬜ |
| 10.4 | transformers.js fallback (TEI が無い環境向け in-process embedding) | embedder.ts | Low ⬜ |
| 10.5 | background prefetch（注意: circuit breaker と排他制御必須） | search.ts, fetch.ts | Low ⬜ |

## Phase 11: 最終コードレビュー対応 🟡

| ID | タスク | ファイル | 優先度 |
|----|--------|----------|--------|
| 11.1 | undici globalDispatcher keep-alive 設定 (新規依存ゼロ) | index.ts | ★★★ ✅ |
| 11.2 | vectorstore where AND 結合 (domain + sinceDays 上書きバグ修正) | vectorstore.ts | ★★★ ✅ |
| 11.3 | throttle → p-queue 置換 (レースコンディション解消) | search.ts | ★★★ ✅ |
| 11.4 | SSRF TOCTOU (undici Agent connect フック) | fetch.ts | ★★★ ⬜ |
| 11.5 | jsonrepair 導入 (extractJson 置換) | llm.ts | ★★★ ✅ |
| 11.6 | Valkey retryStrategy (自動再接続) | cache.ts | ★★ ✅ |
| 11.7 | JSON 応答サイズ制限 (Firecrawl/Crawl4AI) | fetch.ts | ★★ ✅ |
| 11.8 | rerank chunk 上限 64 (TEI 413 対策) | llm.ts | ★★ ✅ |
| 11.9 | Zod safeParse for SearXNG 応答 | search.ts | ★★ ⬜ |
| 11.10 | pino redact (API キーマスク) | logger.ts | ★★ ✅ |
| 11.11 | redirect location.trim() | fetch.ts | ★ ✅ |
| 11.12 | surrogate pair Array.from 対応 | tools.ts, search.ts | ★ ✅ |
| 11.13 | linkedom document 共有 (Defuddle/Readability) | fetch.ts | ★ ⬜ |
| 11.14 | tokenizer → gpt-tokenizer | tokenizer.ts | ★ ⬜ |

## 不採用（検討済み）

| ID | タスク | 理由 |
|----|--------|------|
| 9.3a | ONNX MiniML 常時稼働 | in-process embedding は起動時 +200MB / 2-5秒の cold start コスト。既存 TEI Docker が動いている環境では不要。fallback パスとして Phase 10.4 |
| 9.3b | 純粋な snippet 拡張 (250→800) | search 単体の軽量性を損なう。代わりに 9.3 で過去 fetch 済みの結果があればその本文を snippet に注入する方式に再定義 |
| 10.2a | throttle の bottleneck ライブラリ置き換え | 現状の手書き throttle で実用上問題なし。Phase 8 で 500ms に短縮するのでさらに緩和 |
