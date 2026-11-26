// 画面共通のユーティリティ
(function () {
  async function api(method, url, body) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(url, opt);
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) data = await res.json();
    if (!res.ok) {
      if (res.status === 401 && !url.endsWith('/api/login')) {
        location.href = '/?next=' + encodeURIComponent(location.pathname + location.hash);
      }
      const err = new Error((data && data.error) || `通信エラー（${res.status}）`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---------- 位置情報 ----------
  // 常時監視（watchPosition）と、操作時の最新位置取得（getCurrentPosition）を1か所で管理する。
  // 監視中に maximumAge:0 で取得すると、端末が静止していると新しい測位を待ち続けてしまう
  // ブラウザがあるため、取得の間だけ監視を止める。
  const toPos = (p) => ({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy });
  const geo = {
    watchId: null, onUpdate: null, onError: null,
    /** 常時監視を開始する */
    watch(onUpdate, onError) {
      this.onUpdate = onUpdate; this.onError = onError;
      this._start();
    },
    _start() {
      if (!this.onUpdate || this.watchId !== null || !('geolocation' in navigator)) return;
      this.watchId = navigator.geolocation.watchPosition(
        (p) => this.onUpdate(toPos(p)),
        (e) => this.onError && this.onError(e),
        { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 },
      );
    },
    _stop() {
      if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    },
  };

  /** 現在地を1回取得（高精度・キャッシュなし） */
  function getPosition(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) return reject(new Error('この端末・ブラウザは位置情報に対応していません'));
      if (!window.isSecureContext) return reject(new Error('位置情報は https で開いた場合のみ利用できます'));
      geo._stop();
      navigator.geolocation.getCurrentPosition(
        (p) => { const pos = toPos(p); geo._start(); if (geo.onUpdate) geo.onUpdate(pos); resolve(pos); },
        (e) => { geo._start(); reject(new Error(geoErrorMessage(e))); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs },
      );
    });
  }
  function geoErrorMessage(e) {
    if (e.code === 1) return '位置情報の利用が許可されていません。ブラウザの設定で、このサイトの位置情報を「許可」にしてください。';
    if (e.code === 2) return '現在地を取得できませんでした。電波の良い屋外で再度お試しください。';
    if (e.code === 3) return '現在地の取得に時間がかかっています。もう一度お試しください。';
    return '位置情報を取得できませんでした';
  }

  /** 写真を長辺 maxSize px の JPEG に縮小して dataURL で返す（通信量を抑える） */
  function resizeImage(file, maxSize = 1200, quality = 0.72) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
      img.src = url;
    });
  }

  function toast(msg, type = '') {
    let box = document.getElementById('toast');
    if (!box) { box = document.createElement('div'); box.id = 'toast'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), type === 'danger' ? 6000 : 3500);
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '');
  const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const todayStr = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
  const statusLabel = { scheduled: '未着手', arrived: '到着済', scanned: 'QR確認済', completed: '報告済', cancelled: '取消' };
  const statusClass = { scheduled: '', arrived: 'brand', scanned: 'warn', completed: 'ok', cancelled: '' };

  async function logout() {
    try { await api('POST', '/api/logout', {}); } catch (_) { /* ignore */ }
    location.href = '/';
  }

  window.App = { api, geo, getPosition,resizeImage, toast, esc, fmtTime, fmtDateTime, todayStr, statusLabel, statusClass, logout };
})();
