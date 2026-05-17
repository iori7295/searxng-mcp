# searxng-mcp 強化実装計画

## ゴール

1. **検索品質の向上** — ハイブリッド検索 (BM25 + ベクトル) + リランク
2. **速度の確保** — 外部 API 依存ゼロ、in-process / 隣接サービスのみ
3. **LLM コンテキスト削減** — page 全体ではなくクエリ関連チャンクのみを渡す
4. **堅牢化** — SSRF・型安全・並行性のバグを潰す

## Phase 1-3 ✅

既存実装済み（2025-05-16 完了）。

## Phase 4: Code Review Fixes (1st pass) ✅

コードレビュー検証後に抽出した修正項目。2025-05-17 完了。

| ID | タスク | ファイル | 状態 |
|----|--------|----------|------|
| 4.1 | rawFetch ストリーミングバッファ制限 | fetch.ts | ✅ |
| 4.2 | 起動時 health check を fire-and-forget 化 | index.ts | ✅ |
| 4.3 | cacheSet("", 0) → cacheDel | cache.ts, search.ts, fetch.ts | ✅ |
| 4.4 | vectorstore SQL injection 対策 | vectorstore.ts | ✅ |
| 4.5 | parseInt NaN ガード + console.warn 修正 | config.ts | ✅ |
| 4.6 | applyDomainFilters 一発スキャン化 | domains.ts | ✅ |
| 4.7 | tokenizer 遅延初期化 | tokenizer.ts | ✅ |

## Phase 5: Code Review Fixes (2nd pass) 🟡（本タスク）

2回目のコードレビュー検証後に抽出した修正項目 + 不採用判断の記録。

### 修正予定

| ID | タスク | ファイル | 状態 |
|----|--------|----------|------|
| 5.1 | domain フィルタバリデーション失敗時は空配列を返す（無警告通過しない） | vectorstore.ts | ✅ |
| 5.2 | cacheClear DEL をバッチ分割 + UNLINK に変更 | cache.ts | ✅ |
| 5.3 | indexToVectorStore .catch(() => {}) に logger.warn 追加 | fetch.ts | ✅ |
| 5.4 | README に Crawl4AI を cascade 説明に追記 | README.md | ✅ |
| 5.5 | domains.ts watcher コメント修正（再セットアップしないと明記） | domains.ts | ✅ |

### 不採用（検討済み）

| ID | タスク | 理由 |
|----|--------|------|
| 5.x | throttle: 例外時にトークン消費 | 実害軽微。SearXNG ダウン時の他リクエスト遅延は数秒。修正コストに見合わない |
| 5.x | pollCrawl4aiTask abort 応答性向上 | JS の仕様上 Promise リークは発生しない。最大2-5秒の応答遅延は polling 設計で許容範囲 |
| 5.x | githubFetch branch 右削り探索 | GitHub API rate limit (60/h unauthenticated) の制約下で現状のワンショット試行 + fallback が現実的 |
| 5.x | fetchCacheKey 集約 | 動作は正しい。cache.ts と fetch.ts の分散はコード品質領域で機能影響なし |
| 5.x | parseInt \|\| default の 0 falsy | CACHE_TTL_SECONDS=0 は Redis EX 0 がエラーになる。他の変数も 0 設定は実用上不要。複雑化に見合わない |
| 5.x | TextDecoder が UTF-8 固定 (Shift_JIS非対応) | 事前存在バグ、修正は非自明。現代のウェブはほぼ UTF-8。Defuddle/Readability の DOM 経路でも charset は気にしない |
| 5.x | PDF Content-Length 事前チェック | 悪意ある巨大 PDF に対し現在の 5MB ストリーミング制限で十分。事前チェックは最適化の域 |
| 5.x | clear_cache スコープの README 明記 | search:/fetch: プレフィックスで分離済み。共有 Valkey 運用は想定外。README が肥大化するだけ |
