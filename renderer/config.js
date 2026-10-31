/* config.js — 環境ごとの設定。編集後はブラウザを再読み込みするだけで反映されます。
 * URLクエリでも一時的に上書きできます: http://localhost:8080/?model=chat-large
 */
window.RITSU_CONFIG = {
  // LLM API のベースURL。既定の /llm は nginx が LiteLLM へ中継する(接続先とキーは .env)
  llmUrl: '/llm',
  // LiteLLM の model_name: chat(gemma3:4b・2ノード分散) / chat-large(gemma3:12b)
  llmModel: 'chat',
  llmTimeoutSec: 30,

  // 会話が無い間の暇つぶし行動の間隔[秒]。この間隔ごとに「しゃべる」か「モーションだけ」を抽選する
  //   しゃべる間隔 ≒ 平均間隔 ÷ idleSpeakChance、LLM の独り言の間隔 ≒ しゃべる間隔 ÷ llmIdleChance
  //   既定値: 平均15秒 → しゃべるのは約20秒に1回、LLM の独り言は約30秒に1回
  idleMinSec: 10,
  idleMaxSec: 20,
  // 暇つぶし1回あたりの、しゃべる確率(0〜1)。残りはモーションだけ・無言で振り向く
  idleSpeakChance: 0.75,
  // しゃべるときに、LLM に今の状況(時間帯・季節・行事・目の前の人)から独り言を作らせる確率(0〜1)。
  // 残りは用意したセリフ・物音への反応。0 にすると会話以外で LLM を呼ばない
  llmIdleChance: 0.67,
  // 人が来た・目が合った・近づいた・居てくれるときの反応を、LLM が状況を見て決める(セリフ・動き・何もしない)。
  // false にすると用意したセリフだけで反応する。LLM が4秒以内に答えないときも用意したセリフになる
  llmReact: true,
  // 挨拶・声かけのやり方を、そのあと話しかけてもらえたか・居てもらえた時間で学ぶ(結果は data/log に記録)。
  // false にすると毎回ランダムに選ぶ
  learn: true,

  // 天気(Open-Meteo、APIキー不要)。設置場所の緯度・経度にする。null にすると天気を使わない
  //   UNO Q からインターネット(api.open-meteo.com)へ20分ごとに問い合わせる
  weather: { lat: 35.68, lon: 139.76, place: '東京', refreshMin: 20 },

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
