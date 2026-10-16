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
  // 画面のこちら側をのぞき込む間隔[秒](会話が無い間。話しかけられたら数え直し)
  peekMinSec: 60,
  peekMaxSec: 120,

  // 描画の重さ(GPUが固まる/重いときに下げる)。URLに ?lite=1 で下記を全部軽量側にして試せる
  // 1項目ずつ試すとき: ?pr=0.75(解像度) / ?aa=0(アンチエイリアス) / ?pet=0(花びら) / ?sm=1(単純な材質)
  pixelRatio: 1.5,         // 描画解像度の倍率上限。1未満で画面より粗く描いて軽くする
  antialias: true,         // ふちのギザギザ補正
  petals: 40,              // 桜の花びらの数
  simpleMaterials: false,  // trueでVRMのトゥーンシェーダー/輪郭線をやめ、単純な材質で描く
};
