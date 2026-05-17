# searxng-mcp 強化実装計画

## ゴール

1. **検索品質の向上** — ハイブリッド検索 (BM25 + ベクトル) + リランク
2. **速度の確保** — 外部 API 依存ゼロ、in-process / 隣接サービスのみ
3. **LLM コンテキスト削減** — page 全体ではなくクエリ関連チャンクのみを渡す
4. **堅牢化** — SSRF・型安全・並行性のバグを潰す

## 非ゴール

- LLM のローカル実行（要約 LLM は外部 OpenAI 互換 API のまま）
- x86 専用の最適化（ARM ネイティブで動くもののみ採用）
- LLMLingua-2 等の重量級プロンプト圧縮

## Phase 1: 削減・堅牢化 ✅（2026-05-16 完了）

既存コードの重大バグ修正と自前実装の OSS 置換。

| ID | タスク | ファイル | 状態 |
|----|--------|----------|------|
| 1.1 | SSRF ガード強化（ipaddr.js + DNS解決） | fetch.ts | ✅ |
| 1.2 | throttle 並行性バグ修正（nextAvailable方式） | search.ts | ✅ |
| 1.3 | チャンキング OSS 化（@langchain/textsplitters） | chunker.ts | ✅ |
| 1.4 | HTML 抽出フォールバック整理（Readability追加） | fetch.ts | ✅ |
| 1.5 | キャッシュ修正（SCAN, key, buffer, 破損掃除） | cache.ts, fetch.ts | ✅ |
| 1.6 | LLM レスポンス zod 検証 | llm.ts, types.ts | ✅ |
| 1.9 | GitHub URL 修正（ブランチスラッシュ, squirrel-girl） | fetch.ts | ✅ |
| 1.10 | pino ログ導入 | logger.ts + 各ファイル | ✅ |
| 1.11 | README / package.json 整合 | README.md, package.json | ✅ |

## Phase 2: ベクトル層導入 ✅（2026-05-16 完了）

| ID | タスク | ファイル | 状態 |
|----|--------|----------|------|
| 2.1 | docker-compose.example.yml（TEI×2） | docker/docker-compose.example.yml | ✅ |
| 2.2 | 環境変数追加 | config.ts | ✅ |
| 2.3 | リランカー TEI 移行 | reranker.ts | ✅ |
| 2.4 | LanceDB セットアップ | vectorstore.ts | ✅ |
| 2.5 | 埋め込みクライアント | embedder.ts | ✅ |
| 2.7 | 新ツール vector_search | tools.ts | ✅ |
| 2.8 | 既存ツール use_chunks opt-in | tools.ts, llm.ts | ✅ |
| 2.10 | 起動時ヘルスチェック | index.ts | ✅ |

## Phase 3: コンテキスト削減 ✅（2026-05-16 完了）

| ID | タスク | ファイル | 状態 |
|----|--------|----------|------|
| 3.2 | fetch_url モード追加 | tools.ts | ✅ |
| 3.3 | js-tiktoken 導入 | tokenizer.ts | ✅ |
| 3.4 | 動的 fetch_count 調整 | llm.ts, config.ts | ✅ |
| 3.5 | 環境変数で全体制御 | config.ts | ✅ |

## Phase 4: 運用品質（任意・未着手）

| ID | タスク | 備考 |
|----|--------|------|
| 4.1 | ベクトルストア GC | 長期運用対策 |
| 4.2 | リランカー in-process フォールバック | transformers.js で軽量モデル |
| 4.3 | Prometheus メトリクス | 別 HTTP ポート |
| 4.4 | 評価ハーネス | nDCG/Recall@k 測定 |

## 依存関係追加計画

| 依存 | バージョン | Phase | 種別 | サイズ | ARM64 |
|------|-----------|-------|------|--------|-------|
| ipaddr.js | ^2.2 | 1 | runtime | 42KB | ✅ pure JS |
| @langchain/textsplitters | ^0.3 | 1 | runtime | ~200KB | ✅ pure JS |
| @mozilla/readability | ^0.5 | 1 | runtime | ~50KB | ✅ pure JS |
| pino | ^9 | 1 | runtime | ~150KB | ✅ pure JS |

| @lancedb/lancedb | ^0.27 | 2 | runtime | ~1.3MB JS + ~15MB native | ✅ prebuilt |
| apache-arrow | >=15 <=18 | 2 | peer | ~5MB | ✅ pure JS |
| js-tiktoken | ^1 | 3 | runtime | ~2MB WASM | ✅ WASM |

## マイグレーション戦略

- **Phase 1**: npm update で完了。既存ユーザー影響なし。
- **Phase 2 →**: `ENABLE_VECTOR_STORE=true` を明示的に設定するまでベクトル機能は無効。
- **破壊的変更**: Phase 2 公開時に 3.x → 4.0。
