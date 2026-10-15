/* config.js — 環境ごとの設定。編集後はブラウザを再読み込みするだけで反映されます。
 * URLクエリでも一時的に上書きできます: http://localhost:8080/?model=chat-large
 */
window.RITSU_CONFIG = {
  // LLM API のベースURL。既定の /llm は nginx が LiteLLM へ中継する(接続先とキーは .env)
  llmUrl: '/llm',
  // LiteLLM の model_name: chat(gemma3:4b・2ノード分散) / chat-large(gemma3:12b)
  llmModel: 'chat',
  llmTimeoutSec: 30,

  // 暇つぶし行動(独り言・ダンス)の間隔[秒]
  idleMinSec: 25,
  idleMaxSec: 60,
};
