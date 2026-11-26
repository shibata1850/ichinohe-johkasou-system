// 作業員（スマートフォン）画面
(function () {
  const { api, getPosition, resizeImage, toast, esc, fmtTime, statusLabel, statusClass } = window.App;
  const CHECKLISTS = window.CHECKLISTS;
  const view = document.getElementById('view');
  const topTitle = document.getElementById('topTitle');
  const backBtn = document.getElementById('backBtn');
  const geoBanner = document.getElementById('geoBanner');

  let today = null;          // /api/staff/today の結果
  let lastPos = null;        // 直近の位置
  let geoError = null;
  let lastSentAt = 0;

  document.getElementById('logoutBtn').addEventListener('click', () => window.App.logout());
  backBtn.addEventListener('click', () => { location.hash = '#home'; });

  const onDuty = () => !!(today && today.attendance && today.attendance.clock_in_at && !today.attendance.clock_out_at);

  // ---------- 位置情報の常時監視（勤務中は会社へ送信） ----------
  function startWatch() {
    if (!('geolocation' in navigator)) { showGeoError('この端末・ブラウザは位置情報に対応していません'); return; }
    if (!window.isSecureContext) { showGeoError('位置情報を使うには https のアドレスで開いてください'); return; }
    window.App.geo.watch((pos) => {
      lastPos = pos;
      geoError = null;
      geoBanner.classList.add('hidden');
      updateGeoStatus();
      maybeSendLocation();
    }, (e) => {
      showGeoError(e.code === 1
        ? '位置情報がオフ、または許可されていません。スマートフォンの設定で位置情報をオンにし、このサイトに位置情報の利用を許可してください。位置情報が無いと出勤・作業報告はできません。'
        : '現在地を取得できていません。電波の良い場所でお待ちください。');
    });
  }
  function showGeoError(msg) {
    geoError = msg;
    geoBanner.textContent = msg;
    geoBanner.classList.remove('hidden');
    updateGeoStatus();
  }
  function updateGeoStatus() {
    const el = document.getElementById('geoStatus');
    if (!el) return;
    if (geoError) el.innerHTML = '<span class="badge danger">位置情報 オフ</span>';
    else if (lastPos) el.innerHTML = `<span class="badge ok">位置情報 オン</span> <span class="muted small num">誤差 約${Math.round(lastPos.acc)}m</span>`;
    else el.innerHTML = '<span class="badge">位置情報 取得中…</span>';
  }
  async function maybeSendLocation() {
    if (!onDuty() || !lastPos) return;
    const interval = (today.settings.tracking_interval_sec || 60) * 1000;
    if (Date.now() - lastSentAt < interval) return;
    lastSentAt = Date.now();
    try { await api('POST', '/api/staff/location', lastPos); } catch (_) { lastSentAt = 0; }
  }
  setInterval(maybeSendLocation, 15000);

  // ---------- ルーティング ----------
  async function loadToday() { today = await api('GET', '/api/staff/today'); }
  async function route() {
    stopScan();
    const h = location.hash || '#home';
    backBtn.classList.toggle('hidden', h === '#home');
    try {
      await loadToday();
      if (h === '#clock-in' || h === '#clock-out') return renderAlcohol(h === '#clock-in' ? 'clock_in' : 'clock_out');
      const m = /^#job\/(\d+)$/.exec(h);
      if (m) return renderJob(Number(m[1]));
      return renderHome();
    } catch (e) {
      view.innerHTML = `<div class="notice danger">${esc(e.message)}</div><button class="btn" id="retry">再読み込み</button>`;
      document.getElementById('retry').onclick = route;
    }
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (location.hash || '#home') === '#home') route(); });

  // ---------- ホーム ----------
  function renderHome() {
    topTitle.textContent = '一戸浄化槽 作業管理';
    const a = today.attendance;
    let attHtml;
    if (!a || !a.clock_in_at) {
      attHtml = `
        <p><span class="badge">未出勤</span></p>
        <p class="muted small">出勤時にアルコールチェックを行います。検知器を用意してください。</p>
        <a class="btn btn-primary btn-lg" href="#clock-in">出勤する（アルコールチェック）</a>`;
    } else if (!a.clock_out_at) {
      attHtml = `
        <p><span class="badge ok">勤務中</span> <span class="num">出勤 ${fmtTime(a.clock_in_at)}</span></p>
        <p class="small">出勤時アルコール：<b class="num">${today.clock_in_check ? today.clock_in_check.value_mgl.toFixed(2) : '-'} mg/L</b> <span class="badge ok">合格</span></p>
        <p class="muted small">勤務中は、この画面を開いている間の位置情報が会社に送信されます。</p>
        <a class="btn btn-lg" href="#clock-out">退勤する（アルコールチェック）</a>`;
    } else {
      attHtml = `<p><span class="badge brand">退勤済</span> <span class="num">${fmtTime(a.clock_in_at)} 〜 ${fmtTime(a.clock_out_at)}</span></p>
        <p class="small">退勤時アルコール：<b class="num">${today.clock_out_check ? today.clock_out_check.value_mgl.toFixed(2) : '-'} mg/L</b></p>`;
    }
    const jobs = today.jobs;
    const done = jobs.filter((j) => j.status === 'completed').length;
    const jobsHtml = jobs.length ? jobs.map((j) => `
      <a class="card job-card" href="#job/${j.id}" ${onDuty() ? '' : 'aria-disabled="true"'}>
        <div class="row">
          <div class="grow">
            <div style="font-weight:700">${esc(j.customer_name)}</div>
            <div class="muted small">${esc(j.work_type)}${j.tank_label ? '｜' + esc(j.tank_label) : ''}</div>
            <div class="muted small">${esc(j.address || '')}</div>
          </div>
          <span class="badge ${statusClass[j.status]}">${statusLabel[j.status]}</span>
        </div>
      </a>`).join('') : '<p class="muted">本日の作業予定はありません。</p>';
    view.innerHTML = `
      <section class="card">
        <div class="row"><div class="grow"><h1 style="margin:0">${esc(today.user.name)} さん</h1><div class="muted small num">${esc(today.date)}</div></div><div id="geoStatus"></div></div>
        <hr style="border:none;border-top:1px solid var(--line);margin:12px 0">
        ${attHtml}
      </section>
      <h2>本日の作業 <span class="muted small num">${done}/${jobs.length}件 完了</span></h2>
      ${onDuty() || !jobs.length ? '' : '<div class="notice info small">作業を始めるには、先に出勤（アルコールチェック）をしてください。</div>'}
      <div id="jobList">${jobsHtml}</div>`;
    if (!onDuty()) view.querySelectorAll('.job-card').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); toast('先に出勤してください', 'danger'); }));
    updateGeoStatus();
  }

  // ---------- アルコールチェック（出勤・退勤） ----------
  function renderAlcohol(kind) {
    const isIn = kind === 'clock_in';
    const a = today.attendance;
    if (isIn && a && a.clock_in_at) { location.hash = '#home'; return; }
    if (!isIn && (!a || !a.clock_in_at || a.clock_out_at)) { location.hash = '#home'; return; }
    topTitle.textContent = isIn ? '出勤（アルコールチェック）' : '退勤（アルコールチェック）';
    let selected = null; // {source:'device', reading_id} | {source:'manual', ...}
    let manualPhoto = null;
    view.innerHTML = `
      <h1>${isIn ? '出勤前' : '退勤時'}のアルコールチェック</h1>
      <section class="card">
        <h2>1. 現在地</h2>
        <div id="geoStatus"></div>
      </section>
      <section class="card">
        <h2>2. 検知器で測定</h2>
        <p class="small">アルコール検知器に息を吹き込んで測定してください。測定結果は自動で会社に送られます。</p>
        <button type="button" class="btn btn-primary" id="fetchDevice" style="width:100%">検知器の測定結果を取り込む</button>
        <div id="deviceResult" style="margin-top:12px"></div>
        ${today.settings.allow_manual_alcohol ? `
        <details id="manualBox" style="margin-top:12px">
          <summary class="small" style="cursor:pointer;font-weight:600">検知器と連携できない場合（手入力＋写真）</summary>
          <div style="margin-top:12px">
            <label class="field"><span>測定値（mg/L）</span><input id="manualValue" type="number" inputmode="decimal" step="0.01" min="0" max="5" placeholder="0.00"></label>
            <label class="field"><span>検知器の番号（任意）</span><input id="manualDevice" placeholder="例：ALC-01"></label>
            <label class="field"><span>写真（検知器の表示と自分の顔が一緒に写るように）</span><input id="manualPhoto" type="file" accept="image/*" capture="user"></label>
            <img id="manualPreview" class="hidden" alt="撮影した写真" style="max-width:160px;border-radius:8px">
            <button type="button" class="btn" id="useManual" style="width:100%;margin-top:8px">手入力の値を使う</button>
          </div>
        </details>` : ''}
      </section>
      <div id="alcErr" class="notice danger hidden" role="alert"></div>
      <button type="button" class="btn btn-primary btn-lg" id="submitAlc" disabled>${isIn ? 'この結果で出勤する' : 'この結果で退勤する'}</button>`;
    updateGeoStatus();
    const submitBtn = document.getElementById('submitAlc');
    const resultBox = document.getElementById('deviceResult');
    const showSelected = (value, label) => {
      const over = value > today.settings.alcohol_threshold_mgl;
      resultBox.innerHTML = `<div class="notice ${over ? 'danger' : 'ok'}"><b class="num">${value.toFixed(2)} mg/L</b>（${esc(label)}）</div>`;
      submitBtn.disabled = false;
    };
    document.getElementById('fetchDevice').onclick = async () => {
      resultBox.innerHTML = '<p class="muted small">確認中…</p>';
      try {
        const r = await api('GET', '/api/staff/device-reading');
        if (!r) {
          resultBox.innerHTML = '<div class="notice warn small">まだ測定結果が届いていません。検知器で測定してから、もう一度押してください。</div>';
          return;
        }
        selected = { source: 'device', reading_id: r.id };
        showSelected(r.value_mgl, `検知器 ${r.device_id}・${fmtTime(r.measured_at)}測定`);
      } catch (e) { resultBox.innerHTML = `<div class="notice danger small">${esc(e.message)}</div>`; }
    };
    if (today.settings.allow_manual_alcohol) {
      document.getElementById('manualPhoto').onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        manualPhoto = await resizeImage(f, 1024);
        const img = document.getElementById('manualPreview');
        img.src = manualPhoto; img.classList.remove('hidden');
      };
      document.getElementById('useManual').onclick = () => {
        const v = Number(document.getElementById('manualValue').value);
        if (document.getElementById('manualValue').value === '' || !Number.isFinite(v) || v < 0) { toast('測定値を入力してください', 'danger'); return; }
        if (!manualPhoto) { toast('検知器の表示と顔が写った写真を撮影してください', 'danger'); return; }
        selected = { source: 'manual', value_mgl: v, device_id: document.getElementById('manualDevice').value, photo: manualPhoto };
        showSelected(v, '手入力・写真あり');
      };
    }
    submitBtn.onclick = async () => {
      const err = document.getElementById('alcErr');
      err.classList.add('hidden');
      submitBtn.disabled = true;
      submitBtn.textContent = '送信中…';
      try {
        const pos = await getPosition();
        const r = await api('POST', `/api/staff/${isIn ? 'clock-in' : 'clock-out'}`, { ...pos, alcohol: selected });
        renderAlcoholResult(kind, r.alcohol);
      } catch (e) {
        if (e.data && e.data.alcohol) return renderAlcoholResult(kind, e.data.alcohol, e.message);
        err.textContent = e.message;
        err.classList.remove('hidden');
        submitBtn.disabled = false;
        submitBtn.textContent = isIn ? 'この結果で出勤する' : 'この結果で退勤する';
      }
    };
  }

  function renderAlcoholResult(kind, alc, errorMsg) {
    const ok = alc.result === 'pass';
    const isIn = kind === 'clock_in';
    view.innerHTML = `
      <div class="status-big ${ok ? 'ok' : 'danger'}" role="status">
        <div class="value">${alc.value.toFixed(2)} mg/L</div>
        <div style="font-size:1.3rem;font-weight:800">${ok ? (isIn ? '合格・出勤しました' : '退勤しました') : 'アルコール検知'}</div>
      </div>
      ${ok ? '' : `<div class="notice danger" style="margin-top:16px"><b>${esc(errorMsg || '運転・作業をしないでください。')}</b><br>管理者に通知されました。車両を運転せず、管理者の指示に従ってください。</div>`}
      <a class="btn btn-lg ${ok ? 'btn-primary' : ''}" href="#home" style="margin-top:16px">${ok && isIn ? '今日の作業へ' : 'ホームへ戻る'}</a>`;
  }

  // ---------- 作業詳細 ----------
  async function renderJob(id) {
    const { job, report, checklist } = await api('GET', `/api/staff/jobs/${id}`);
    topTitle.textContent = job.customer_name;
    const nav = `https://www.google.com/maps/dir/?api=1&destination=${job.lat},${job.lng}`;
    const st = job.status;
    const arrived = st !== 'scheduled';
    const scanned = st === 'scanned' || st === 'completed';
    const completed = st === 'completed';
    const needQr = job.requires_tank;
    const canReport = needQr ? scanned : arrived;
    const stepClass = (done, active) => (done ? 'step done' : active ? 'step active' : 'step locked');
    const minStay = today.settings.min_stay_minutes || 0;
    const reportAt = arrived ? new Date(Date.parse(job.arrived_at) + minStay * 60000) : null;

    view.innerHTML = `
      <section class="card">
        <div class="row"><h1 class="grow" style="margin:0">${esc(job.customer_name)}</h1><span class="badge ${statusClass[st]}" id="jobStatus">${statusLabel[st]}</span></div>
        <p class="small" style="margin:.5em 0 0">${esc(job.work_type)}${job.tank_label ? `｜${esc(job.tank_label)} ${esc(job.tank_capacity || '')}` : ''}</p>
        <p class="muted small" style="margin:0">${esc(job.address || '')}</p>
        ${job.memo ? `<div class="notice info small" style="margin-top:8px">${esc(job.memo)}</div>` : ''}
        ${job.customer_notes ? `<p class="small" style="margin:.5em 0 0">注意事項：${esc(job.customer_notes)}</p>` : ''}
        <div class="row" style="margin-top:12px">
          <a class="btn btn-sm" href="${nav}" target="_blank" rel="noopener">地図アプリで道案内</a>
          ${job.customer_phone ? `<a class="btn btn-sm" href="tel:${esc(job.customer_phone)}">電話する</a>` : ''}
          <span id="geoStatus"></span>
        </div>
      </section>
      ${onDuty() || completed ? '' : '<div class="notice danger">出勤（アルコールチェック）が済んでいないため、作業操作はできません。</div>'}
      <section class="card">
        <ol class="steps">
          <li class="${stepClass(arrived, !arrived)}">
            <div class="step-no">1</div>
            <div>
              <h3>現場到着（位置情報で確認）</h3>
              ${arrived
                ? `<p class="small" style="margin:0">到着 <span class="num">${fmtTime(job.arrived_at)}</span>（現場から約<span class="num">${Math.round(job.arrived_distance)}</span>m）</p>`
                : `<p class="small muted">現場（半径${job.radius_m}m以内）に着いたら押してください。</p>
                   <button type="button" class="btn btn-primary" id="arriveBtn" style="width:100%" ${onDuty() ? '' : 'disabled'}>現在地で到着を確認</button>`}
              <div id="arriveMsg"></div>
            </div>
          </li>
          ${needQr ? `
          <li class="${stepClass(scanned, arrived && !scanned)}">
            <div class="step-no">2</div>
            <div>
              <h3>浄化槽のQRコード読み取り</h3>
              ${scanned
                ? `<p class="small" style="margin:0">QR確認 <span class="num">${fmtTime(job.scanned_at)}</span>（現場から約<span class="num">${Math.round(job.scanned_distance)}</span>m）</p>`
                : `<p class="small muted">QRコードは<b>浄化槽の蓋の裏側</b>に貼ってあります。蓋を開けて槽内を確認してから読み取ってください。</p>
                   <button type="button" class="btn btn-primary" id="scanBtn" style="width:100%" ${arrived && onDuty() ? '' : 'disabled'}>蓋を開けてQRを読み取る</button>
                   ${arrived ? '' : '<p class="small muted" style="margin:.5em 0 0">※先に現場到着の確認が必要です</p>'}`}
              <div id="scanResult"></div>
            </div>
          </li>` : ''}
          <li class="${stepClass(completed, canReport && !completed)}">
            <div class="step-no">${needQr ? 3 : 2}</div>
            <div>
              <h3>点検記録・作業報告</h3>
              <div id="reportArea"></div>
            </div>
          </li>
        </ol>
      </section>`;
    updateGeoStatus();

    const arriveBtn = document.getElementById('arriveBtn');
    if (arriveBtn) arriveBtn.onclick = () => runWithPos(arriveBtn, document.getElementById('arriveMsg'), async (pos) => {
      const r = await api('POST', `/api/staff/jobs/${id}/arrive`, pos);
      toast(`到着を確認しました（現場から約${r.distance}m）`, 'ok');
      route();
    });
    const scanBtn = document.getElementById('scanBtn');
    if (scanBtn) scanBtn.onclick = () => startScan(id);

    const area = document.getElementById('reportArea');
    if (completed && report) {
      area.innerHTML = `<p class="small" style="margin:0">報告送信 <span class="num">${fmtTime(report.submitted_at)}</span></p>
        <div class="notice ok small" style="margin-top:8px">この作業は報告済みです。お疲れさまでした。</div>
        ${renderChecklistSummary(checklist, report.checklist)}
        ${report.comment ? `<p class="small">特記事項：${esc(report.comment)}</p>` : ''}`;
    } else if (!canReport) {
      area.innerHTML = `<p class="small muted">${needQr ? 'QRコードを読み取ると入力できます。' : '現場到着の確認後に入力できます。'}</p>`;
    } else {
      renderReportForm(area, job, checklist, reportAt);
    }
  }

  function renderChecklistSummary(def, values) {
    if (!def) return '';
    return `<table style="margin-top:8px"><tbody>${def.items.map((it) => `<tr><th>${esc(it.label)}</th><td class="num">${esc(values[it.key] ?? '')}${it.unit ? ' ' + esc(it.unit) : ''}</td></tr>`).join('')}</tbody></table>`;
  }

  function renderReportForm(area, job, def, reportAt) {
    const photos = [];
    const fields = def.items.map((it) => {
      const id = `f_${it.key}`;
      let input;
      if (it.type === 'select') {
        input = `<select id="${id}" name="${it.key}" ${it.required ? 'required' : ''}><option value="">選択してください</option>${it.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
      } else if (it.type === 'number') {
        input = `<input id="${id}" name="${it.key}" type="number" inputmode="decimal" step="${it.step || 'any'}" min="${it.min ?? ''}" max="${it.max ?? ''}" ${it.required ? 'required' : ''}>`;
      } else {
        input = `<input id="${id}" name="${it.key}" placeholder="${esc(it.placeholder || '')}" ${it.required ? 'required' : ''}>`;
      }
      return `<label class="field"><span>${esc(it.label)}${it.unit ? `（${esc(it.unit)}）` : ''}${it.required ? '' : '（任意）'}</span>${input}</label>`;
    }).join('');
    area.innerHTML = `
      <form id="reportForm" novalidate>
        <div class="form-grid">${fields}</div>
        <label class="field"><span>写真（槽内の状況など）${def.minPhotos ? `・${def.minPhotos}枚以上必須` : '（任意）'}</span>
          <input type="file" id="photoInput" accept="image/*" capture="environment" multiple></label>
        <div class="photo-grid" id="photoGrid"></div>
        <label class="field" style="margin-top:12px"><span>特記事項（任意）</span><textarea id="comment" maxlength="2000" placeholder="お客様への伝達事項、次回の注意点など"></textarea></label>
        ${reportAt && reportAt > new Date() ? `<p class="small muted">※ ${fmtTime(reportAt.toISOString())} 以降に送信できます（最低滞在時間 ${today.settings.min_stay_minutes}分）</p>` : ''}
        <div id="reportMsg"></div>
        <button type="submit" class="btn btn-ok btn-lg" id="submitReport">現場で報告を送信</button>
      </form>`;
    const grid = document.getElementById('photoGrid');
    const drawPhotos = () => {
      grid.innerHTML = photos.map((p, i) => `<div style="position:relative"><img src="${p}" alt="添付写真${i + 1}"><button type="button" class="btn btn-sm" data-del="${i}" style="position:absolute;top:4px;right:4px;min-height:28px;padding:0 8px" aria-label="写真${i + 1}を削除">×</button></div>`).join('');
      grid.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { photos.splice(Number(b.dataset.del), 1); drawPhotos(); }; });
    };
    document.getElementById('photoInput').onchange = async (e) => {
      for (const f of e.target.files) {
        if (photos.length >= 6) { toast('写真は6枚までです', 'danger'); break; }
        try { photos.push(await resizeImage(f)); } catch (ex) { toast(ex.message, 'danger'); }
      }
      e.target.value = '';
      drawPhotos();
    };
    const form = document.getElementById('reportForm');
    form.onsubmit = (e) => {
      e.preventDefault();
      const values = {};
      for (const it of def.items) {
        const el = form.elements[it.key];
        const v = el.value.trim();
        if (it.required && !v) { el.focus(); toast(`「${it.label}」を入力してください`, 'danger'); return; }
        values[it.key] = v;
      }
      if (photos.length < def.minPhotos) { toast(`写真を${def.minPhotos}枚以上添付してください`, 'danger'); return; }
      const btn = document.getElementById('submitReport');
      runWithPos(btn, document.getElementById('reportMsg'), async (pos) => {
        await api('POST', `/api/staff/jobs/${job.id}/report`, { ...pos, checklist: values, photos, comment: document.getElementById('comment').value });
        toast('報告を送信しました', 'ok');
        route();
      });
    };
  }

  /** 現在地を取得してから処理を実行。失敗時はメッセージ欄に表示 */
  async function runWithPos(btn, msgEl, fn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '現在地を確認中…';
    msgEl.innerHTML = '';
    try {
      const pos = await getPosition();
      btn.textContent = '送信中…';
      await fn(pos);
    } catch (e) {
      msgEl.innerHTML = `<div class="notice danger small" role="alert" style="margin-top:8px">${esc(e.message)}</div>`;
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ---------- QRスキャン（カメラ映像をリアルタイム解析。画像ファイルからの読み取りは不可） ----------
  const scanner = document.getElementById('scanner');
  const video = document.getElementById('scanVideo');
  const canvas = document.getElementById('scanCanvas');
  const scanMsg = document.getElementById('scanMsg');
  let stream = null; let scanTimer = null; let busy = false; let ignoreUntil = 0; let ignoreText = '';

  async function startScan(jobId) {
    scanMsg.textContent = '';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    } catch (e) {
      toast('カメラを起動できません。ブラウザの設定でカメラの使用を許可してください。', 'danger');
      return;
    }
    scanner.classList.remove('hidden');
    video.srcObject = stream;
    await video.play().catch(() => {});
    busy = false;
    const tick = async () => {
      if (!stream) return;
      if (!busy && video.readyState >= 2 && video.videoWidth) {
        const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code && code.data && !(code.data === ignoreText && Date.now() < ignoreUntil)) {
          await onDecoded(jobId, code.data);
        }
      }
      scanTimer = setTimeout(tick, 150);
    };
    tick();
  }
  async function onDecoded(jobId, text) {
    busy = true;
    scanMsg.textContent = 'QRコードを確認中…（現在地も確認しています）';
    try {
      const pos = await getPosition();
      const r = await api('POST', `/api/staff/jobs/${jobId}/scan`, { ...pos, qr: text });
      stopScan();
      toast(`QRコードを確認しました：${r.tank_label}`, 'ok');
      route();
    } catch (e) {
      scanMsg.textContent = e.message;
      ignoreText = text; ignoreUntil = Date.now() + 4000; // 同じQRの連続送信を防ぐ
      busy = false;
    }
  }
  function stopScan() {
    clearTimeout(scanTimer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    scanner.classList.add('hidden');
  }
  document.getElementById('scanCancel').onclick = stopScan;

  startWatch();
  route();
})();
