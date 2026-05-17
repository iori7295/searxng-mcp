# searxng-mcp 強化実装計画

## ゴール

1. **検索品質の向上** — ハイブリッド検索 (BM25 + ベクトル) + リランク
2. **速度の確保** — 外部 API 依存ゼロ、in-process / 隣接サービスのみ
3. **LLM コンテキスト削減** — page 全体ではなくクエリ関連チャンクのみを渡す
4. **堅牢化** — SSRF・型安全・並行性のバグを潰す

## Phase 1-3 ✅

既存実装済み（2025-05-16 完了）。

## Phase 4: Code Review Fixes 🟡（本タスク）

コードレビュー検証後に抽出した、真に修正すべき項目。

| ID | タスク | ファイル | 状態 |
|----|--------|----------|------|
| 4.1 | rawFetch ストリーミングバッファ制限 | fetch.ts | ✅ |
| 4.2 | 起動時 health check を fire-and-forget 化 | index.ts | ✅ |
| 4.3 | cacheSet("", 0) → cacheDel | cache.ts, search.ts, fetch.ts | ✅ |
| 4.4 | vectorstore SQL injection 対策 | vectorstore.ts | ✅ |
| 4.5 | parseInt NaN ガード + console.warn 修正 | config.ts | ✅ |
| 4.6 | applyDomainFilters 一発スキャン化 | domains.ts | ✅ |
| 4.7 | tokenizer 遅延初期化 | tokenizer.ts | ✅ |
