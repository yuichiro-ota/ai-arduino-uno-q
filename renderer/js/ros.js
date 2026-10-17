/* =========================================================================
 * ros.js — rosbridge (nginx の /rosbridge 経由) への接続ヘルパー
 *   roslibjs は切断後に自動で再接続しないため、再接続と購読のやり直しをここで行う。
 *   画面の律(main.js)と iPhone の入力ページ(remote.html)で共用する。
 * ========================================================================= */

class RitsuRos {
  /** onState(connected) で接続状態を通知 */
  constructor(url, onState) {
    this.url = url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rosbridge`;
    this.onState = onState || (() => {});
    this.subs = [];        // { name, type, cb, topic }
    this.pubs = {};        // name -> ROSLIB.Topic
    this.connected = false;
    this._connect();
  }

  _connect() {
    this.ros = new ROSLIB.Ros({ url: this.url });
    this.ros.on('connection', () => {
      this.connected = true;
      this.pubs = {};
      for (const s of this.subs) this._subscribe(s);
      this.onState(true);
    });
    const retry = () => {
      if (this._retrying) return;
      this._retrying = true;
      this.connected = false;
      this.onState(false);
      setTimeout(() => { this._retrying = false; this._connect(); }, 3000);
    };
    this.ros.on('close', retry);
    this.ros.on('error', retry);
  }

  _subscribe(s) {
    s.topic = new ROSLIB.Topic({ ros: this.ros, name: s.name, messageType: s.type });
    s.topic.subscribe(s.cb);
  }

  /** 購読(再接続しても自動で購読し直す) */
  sub(name, type, cb) {
    const s = { name, type, cb };
    this.subs.push(s);
    if (this.connected) this._subscribe(s);
  }

  /** 発行。未接続なら捨てる */
  pub(name, type, msg) {
    if (!this.connected) return false;
    if (!this.pubs[name]) this.pubs[name] = new ROSLIB.Topic({ ros: this.ros, name, messageType: type });
    this.pubs[name].publish(new ROSLIB.Message(msg));
    return true;
  }
}
window.RitsuRos = RitsuRos;
