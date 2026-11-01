/*
 * ritsu-base — 律の台車(メカナム4輪)のモーター制御。UNO Q の STM32 側で動かす
 *
 *   L298N 2枚で Yahboom 520 エンコーダーモーター(12V・減速1:40・300rpm・ホール式 11ライン)を4個動かす。
 *   Linux 側の ROS 2 ノード(ros/ritsu_base.py)が Bridge で呼ぶ:
 *     base_set(fl, fr, rl, rr)  車輪の速さ [パルス/秒] を指令する(A相の立ち上がり: 車輪1回転 = 11×40 = 440)
 *     base_pwm(fl, fr, rl, rr)  PWM を直接出す(-255〜255。配線・向きの確かめ用)
 *     どちらも今の状態を "パルス数,パルス数,パルス数,パルス数,異常,B相" の文字列で返す
 *       パルス数は回った向きで増減する累計。異常はロックで止めた車輪のビット(1=左前 2=右前 4=左後 8=右後)
 *       B相は向きを B相で読めている車輪のビット(0 の車輪は、自分で回した向きに回ったとみなす)
 *
 *   安全のため:
 *     - 指令が CMD_TIMEOUT_MS 来なければ止まる(Linux 側が止まっても走り続けない)
 *     - PWM は PWM_MAX まで(L298N は1チャンネル 2A まで。モーターはロックすると 4A 流れる)
 *     - 強く回しているのに STALL_MS 回らなければ、その車輪を止める(次に 0 を指令すると戻る)
 *
 *   エンコーダーは A相の立ち上がりを数え、そのときの B相で回った向きを決める(押されて逆に回っても正しく数える)。
 *   B相の極性は配線で変わるので、最初に回したとき(B_LEARN パルス)に回した向きと比べて合わせる。
 *   その後、回した向きとほとんど合わなくなったら(線が外れた・極性が途中で変わった) B相を使うのをやめる。
 */
#include <Arduino_RouterBridge.h>

// ---- ピン(EN は PWM の出るピン) ----
struct WheelPins { uint8_t en, in1, in2, enc, encB; };
const WheelPins PINS[4] = {
  {3, 2, 4, 5, A4},     // 左前
  {11, 7, 8, 6, A5},    // 右前
  {10, A0, A1, 12, 0},  // 左後
  {9, A2, A3, 13, 1},   // 右後
};

const unsigned long CMD_TIMEOUT_MS = 500;
const int PWM_MAX = 220;             // 12V のバッテリーで約10V 相当
const float FF_PER_PULSE = 255.0 / 2000.0;   // 速さ→PWM の見込み(全開で約2000パルス/秒)
const float KP = 0.08, KI = 0.6;     // 速さのずれを PWM に足す割合
const unsigned long LOOP_MS = 20;    // 速さを測って PWM を決め直す間隔(50回/秒)
const int STALL_PWM = 150;           // これ以上で回していて
const float STALL_SPEED = 40;        // これより遅い[パルス/秒]状態が
const unsigned long STALL_MS = 1000; // これだけ続いたらロックとみなす
const int B_LEARN = 200;             // B相の極性を決めるのに使うパルス数(回して数えた分)
const float B_AGREE = 0.9;           // 回した向きとこれだけ合えば B相を信じる

volatile long pulses[4];             // 累計(向き付き)
volatile int8_t spin[4] = {1, 1, 1, 1};  // 今回している向き(止めても最後の向きで数える)
volatile int target[4];              // 指令 [パルス/秒]
volatile int rawPwm[4];              // base_pwm の値
volatile bool rawMode = false;
volatile unsigned long lastCmd = 0;
volatile uint8_t fault = 0;
volatile int8_t bPol[4];             // B相の極性 1 / -1。0 はまだ決まっていない
volatile bool bOk[4] = {true, true, true, true};   // B相で向きを読むか
volatile int bAgree[4], bTotal[4];   // 回しているときに B相の向きが回した向きと合った数 / 数えた数

float integ[4];
long lastPulses[4];
unsigned long stallSince[4];
unsigned long lastLoop = 0;

volatile bool driving[4];            // PWM を出している(このときだけ B相の向きを回した向きと比べる)

void onPulse(int i) {
  const int8_t b = digitalRead(PINS[i].encB) ? 1 : -1;
  if (driving[i]) { bTotal[i]++; if (b == spin[i] * (bPol[i] ? bPol[i] : 1)) bAgree[i]++; }
  pulses[i] += (bOk[i] && bPol[i]) ? b * bPol[i] : spin[i];
}
void onPulse0() { onPulse(0); }
void onPulse1() { onPulse(1); }
void onPulse2() { onPulse(2); }
void onPulse3() { onPulse(3); }
void (*const ON_PULSE[4])() = {onPulse0, onPulse1, onPulse2, onPulse3};

void drive(int i, int pwm) {
  pwm = constrain(pwm, -PWM_MAX, PWM_MAX);
  if (pwm > 0)      { digitalWrite(PINS[i].in1, HIGH); digitalWrite(PINS[i].in2, LOW);  spin[i] = 1; }
  else if (pwm < 0) { digitalWrite(PINS[i].in1, LOW);  digitalWrite(PINS[i].in2, HIGH); spin[i] = -1; }
  else              { digitalWrite(PINS[i].in1, LOW);  digitalWrite(PINS[i].in2, LOW); }   // 惰性で止まる
  analogWrite(PINS[i].en, abs(pwm));
  driving[i] = pwm != 0;
}

// B相の極性を決める・見張る(loop から)
void checkB(int i) {
  if (!bOk[i] || bTotal[i] < B_LEARN) return;
  const float agree = (float)bAgree[i] / bTotal[i];
  if (!bPol[i]) {                                   // 最初: 合う向きを極性にする(+1 で比べている)
    if (agree >= B_AGREE) bPol[i] = 1;
    else if (agree <= 1 - B_AGREE) bPol[i] = -1;
    else bOk[i] = false;                            // どちらとも言えない = B相が読めていない
  } else if (agree < 1 - B_AGREE) {
    bOk[i] = false;
  }
  bAgree[i] = bTotal[i] = 0;
}

String state() {
  String s;
  for (int i = 0; i < 4; i++) { s += String(pulses[i]); s += ','; }
  s += String(fault); s += ',';
  uint8_t b = 0;
  for (int i = 0; i < 4; i++) if (bOk[i] && bPol[i]) b |= 1 << i;
  s += String(b);
  return s;
}

String base_set(int fl, int fr, int rl, int rr) {
  const int v[4] = {fl, fr, rl, rr};
  for (int i = 0; i < 4; i++) {
    target[i] = v[i];
    if (v[i] == 0) fault &= ~(1 << i);
  }
  rawMode = false;
  lastCmd = millis();
  return state();
}

String base_pwm(int fl, int fr, int rl, int rr) {
  const int v[4] = {fl, fr, rl, rr};
  for (int i = 0; i < 4; i++) {
    rawPwm[i] = v[i];
    if (v[i] == 0) fault &= ~(1 << i);
  }
  rawMode = true;
  lastCmd = millis();
  return state();
}

void setup() {
  for (int i = 0; i < 4; i++) {
    // EN に pinMode() をすると、UNO Q (Zephyr) では analogWrite() の PWM が出なくなるので呼ばない
    pinMode(PINS[i].in1, OUTPUT);
    pinMode(PINS[i].in2, OUTPUT);
    drive(i, 0);
    pinMode(PINS[i].enc, INPUT_PULLUP);
    pinMode(PINS[i].encB, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(PINS[i].enc), ON_PULSE[i], RISING);
  }
  Bridge.begin();
  Bridge.provide("base_set", base_set);
  Bridge.provide("base_pwm", base_pwm);
}

void loop() {
  const unsigned long now = millis();
  if (now - lastLoop < LOOP_MS) return;
  const float dt = (now - lastLoop) / 1000.0;
  lastLoop = now;
  const bool alive = now - lastCmd < CMD_TIMEOUT_MS;

  for (int i = 0; i < 4; i++) {
    const long p = pulses[i];
    const float speed = (p - lastPulses[i]) / dt;      // [パルス/秒] 向き付き
    lastPulses[i] = p;

    int pwm = 0;
    if (alive && !(fault & (1 << i))) {
      if (rawMode) {
        pwm = rawPwm[i];
      } else if (target[i] != 0) {
        const float err = target[i] - speed;
        integ[i] = constrain(integ[i] + err * dt, -PWM_MAX / KI, PWM_MAX / KI);
        pwm = (int)(target[i] * FF_PER_PULSE + KP * err + KI * integ[i]);
        if (target[i] > 0) pwm = max(pwm, 0); else pwm = min(pwm, 0);   // 逆回しでブレーキはかけない
      }
    }
    if (pwm == 0) integ[i] = 0;

    // ロック: 強く回しているのに回らない
    if (abs(pwm) >= STALL_PWM && fabs(speed) < STALL_SPEED) {
      if (!stallSince[i]) stallSince[i] = now;
      else if (now - stallSince[i] > STALL_MS) { fault |= 1 << i; pwm = 0; integ[i] = 0; }
    } else {
      stallSince[i] = 0;
    }
    drive(i, pwm);
    checkB(i);
  }
}
