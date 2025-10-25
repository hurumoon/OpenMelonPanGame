# めろんぱんさばいば〜 (公開ソース版)

5人で遊べる Vampire Survivors ライクのオンラインゲーム。PHP単体（内蔵サーバ）+ Server-Sent Events で多くの環境で動作するように設計。

機能:
- ロビー: 部屋作成/入室、公開中の部屋一覧
- 部屋: キャラ選択、ステージ選択、ショップ、メンバー表示、開始
- ステージ: シンプルな2D自機と追尾敵、ステータスHUD、設定(ポーズ)、終了→リザルト
- リザルト: 結果表示と部屋復帰

- 初回アクセス時にプロジェクト直下の `var/store` ディレクトリが自動生成されます。
- SSE が途切れる/流れない場合は、Apache の出力圧縮やバッファ設定の影響を受けることがあります。`api.php?action=events` への圧縮をオフにする、もしくは `@ob_flush(); flush();` の直後に届いているかを確認してください。

## 構成
- public/index.html, style.css, js/*: フロントエンドUIとミニゲーム（ES Modules に分割済み）
- public/api.php: PHP製のSSE+REST的API
- public/config.php, logger.php: 環境/ログ設定とロガー（レベル: debug/info/warn/error）
- var/: ランタイムのJSON（`store/` 配下）とイベントログ（`logs/` 配下）が生成されます

## ステージ補正と難易度補正

- ステージ補正: 各ステージの `mobHpMul` などにより敵のHP倍率が変化します。
- 難易度補正: `difficultyDefs` の設定により以下のパラメーターが変化します。
  - 敵HP (`hpMul`)
  - 敵の出現数/出現速度 (`spawnMul`)
  - 弾の発射頻度 (`bulletMul`)
  - 弾のダメージ (`bulletDmgMul`)
  - 最大敵数や大型敵/ボスのHP (`maxEnemies`, `tankHpMul`, `midBossHpMul`, `bossHpMul`)

## ログと環境切替
- `public/.env` で環境とログレベルを制御します。
	- VLG_ENV: `development` or `production`
	- VLG_LOG_LEVEL: `debug` | `info` | `warn` | `error`
- ログ出力先: `var/logs/YYYY-MM-DD.log`（JSON行）

## 注意
現行版とソースコードが異なる場合があります（例えばフォントやBGMは抜かれています）
https://pixelpassion.jp/MelonPanGame/

ソースコードはMITライセンスですが、イラストとシナリオの著作権は放棄していません。
