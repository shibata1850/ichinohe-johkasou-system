// 管理画面（事務所PC・タブレット向け）
(function () {
  const { api, toast, esc, fmtTime, fmtDateTime, todayStr, statusLabel, statusClass } = window.App;
  const CHECKLISTS = window.CHECKLISTS;
  const view = document.getElementById('view');
  const DEFAULT_CENTER = [40.2066, 141.2951]; // 岩手県一戸町
  let refreshTimer = null;
  let me = null;

  document.getElementById('logoutBtn').addEventListener('click', () => window.App.logout());

  // ---------- ダイアログ ----------
  const dlg = document.getElementById('dlg');
  const dlgBody = document.getElementById('dlgBody');
  const dlgFoot = document.getElementById('dlgFoot');
  document.getElementById('dlgClose').onclick = () => dlg.close();
  /**
   * @param {string} title
   * @param {string} html
   * @param {{saveLabel?:string, onSave?:Function, wide?:boolean}} opt onSave が true を返すと閉じる
   */
  function openDialog(title, html, opt = {}) {
    document.getElementById('dlgTitle').textContent = title;
    dlgBody.innerHTML = html;
    dlgFoot.innerHTML = '';
    dlg.style.width = opt.wide ? 'min(96vw, 1000px)' : '';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = opt.onSave ? 'キャンセル' : '閉じる';
    cancel.onclick = () => dlg.close();
    dlgFoot.appendChild(cancel);
    if (opt.onSave) {
      const save = document.createElement('button');
      save.type = 'button'; save.className = 'btn btn-primary'; save.textContent = opt.saveLabel || '保存';
      save.onclick = async () => {
        save.disabled = true;
        try { if ((await opt.onSave()) !== false) dlg.close(); } catch (e) { toast(e.message, 'danger'); } finally { save.disabled = false; }
      };
      dlgFoot.appendChild(save);
    }
    dlg.showModal();
    return dlg;
  }
  const val = (id) => document.getElementById(id).value.trim();

  // ---------- 地図 ----------
  function makeMap(el, center = DEFAULT_CENTER, zoom = 14) {
    const map = L.map(el, { scrollWheelZoom: true }).setView(center, zoom);
    L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
    }).addTo(map);
    return map;
  }
  const dot = (latlng, color, r = 8) => L.circleMarker(latlng, { radius: r, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 });
  const STATUS_COLOR = { scheduled: '#7b8a95', arrived: '#0b6e8a', scanned: '#c58a00', completed: '#1f7a46' };

  // ---------- ルーティング ----------
  async function route() {
    clearInterval(refreshTimer);
    const tab = (location.hash || '#dashboard').slice(1).split('/')[0];
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${tab}`));
    const fn = { dashboard: renderDashboard, jobs: renderJobs, customers: renderCustomers, reports: renderReports, attendance: renderAttendance, users: renderUsers, settings: renderSettings }[tab] || renderDashboard;
    try { await fn(); } catch (e) { view.innerHTML = `<div class="notice danger">${esc(e.message)}</div>`; }
  }
  window.addEventListener('hashchange', route);

  // ================= ダッシュボード =================
  let dashDate = todayStr();
  async function renderDashboard() {
    const d = await api('GET', `/api/admin/dashboard?date=${dashDate}`);
    const onDuty = d.staff.filter((s) => s.attendance && s.attendance.clock_in_at).length;
    const alcoholNg = d.staff.filter((s) => s.last_failed_check).length;
    const done = d.jobs.filter((j) => j.status === 'completed').length;
    const staffState = (s) => {
      if (s.last_failed_check && !(s.attendance && s.attendance.clock_in_at)) return '<span class="badge danger">アルコール検知・出勤不可</span>';
      if (!s.attendance || !s.attendance.clock_in_at) return '<span class="badge">未出勤</span>';
      if (s.attendance.clock_out_at) return '<span class="badge brand">退勤</span>';
      return '<span class="badge ok">勤務中</span>';
    };
    const alc = (c) => (c ? `<span class="num">${c.value_mgl.toFixed(2)}</span> <span class="badge ${c.result === 'pass' ? 'ok' : 'danger'}">${c.result === 'pass' ? '合格' : '検知'}</span>` : '-');
    view.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <h1 class="grow" style="margin:0">ダッシュボード</h1>
        <label class="row small">表示日 <input type="date" id="dashDate" value="${dashDate}" style="width:auto"></label>
        <button class="btn btn-sm" id="dashRefresh">更新</button>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="label">出勤</div><div class="value">${onDuty} / ${d.staff.length}</div></div>
        <div class="kpi ${alcoholNg ? 'danger' : ''}"><div class="label">アルコール検知</div><div class="value">${alcoholNg}</div></div>
        <div class="kpi"><div class="label">作業完了</div><div class="value">${done} / ${d.jobs.length}</div></div>
        <div class="kpi ${d.alerts.some((a) => a.level === 'danger') ? 'danger' : ''}"><div class="label">未対応アラート</div><div class="value">${d.alerts.length}</div></div>
      </div>
      <div class="grid grid-3-1">
        <section class="card"><h2>現在地・作業マップ</h2><div id="dashMap" class="map"></div>
          <p class="muted small" style="margin:.5em 0 0">● 色：灰=未着手 青=到着 黄=QR確認 緑=報告済 ／ 赤い点=従業員の最終位置 ／ 円=ジオフェンス範囲</p></section>
        <section class="card"><h2>アラート</h2><div id="alerts">${d.alerts.length ? d.alerts.map((a) => `
          <div class="alert-item">
            <span class="badge ${a.level}">${a.level === 'danger' ? '危険' : a.level === 'warning' ? '注意' : '確認'}</span>
            <div class="grow small"><div>${esc(a.message)}</div><div class="muted num">${fmtDateTime(a.created_at)}</div></div>
            <button class="btn btn-sm" data-resolve="${a.id}">対応済</button>
          </div>`).join('') : '<p class="muted small">未対応のアラートはありません。</p>'}</div></section>
      </div>
      <section class="card"><h2>従業員</h2><div class="table-wrap"><table>
        <thead><tr><th>氏名</th><th>状態</th><th>出勤</th><th>出勤時アルコール(mg/L)</th><th>退勤</th><th>退勤時アルコール</th><th>作業</th><th>最終位置</th><th></th></tr></thead>
        <tbody>${d.staff.map((s) => `<tr>
          <td>${esc(s.name)}</td><td>${staffState(s)}</td>
          <td class="num">${fmtTime(s.attendance?.clock_in_at) || '-'}</td><td>${alc(s.clock_in_check || s.last_failed_check)}</td>
          <td class="num">${fmtTime(s.attendance?.clock_out_at) || '-'}</td><td>${alc(s.clock_out_check)}</td>
          <td class="num">${s.jobs_done}/${s.jobs_total}</td>
          <td class="small num">${s.last_location ? `${fmtDateTime(s.last_location.recorded_at)}<br><span class="muted">誤差${Math.round(s.last_location.acc)}m</span>` : '-'}</td>
          <td><button class="btn btn-sm" data-track="${s.id}">軌跡</button></td></tr>`).join('') || '<tr><td colspan="9" class="muted">従業員が登録されていません</td></tr>'}</tbody></table></div></section>
      <section class="card"><h2>作業の進捗</h2><div class="table-wrap"><table>
        <thead><tr><th>担当</th><th>顧客</th><th>種別</th><th>状態</th><th>到着（距離）</th><th>QR確認（距離）</th><th>完了</th></tr></thead>
        <tbody>${d.jobs.map((j) => `<tr class="clickable" data-job="${j.id}">
          <td>${esc(j.assignee_name)}</td><td>${esc(j.customer_name)}</td><td>${esc(j.work_type)}</td>
          <td><span class="badge ${statusClass[j.status]}">${statusLabel[j.status]}</span></td>
          <td class="num">${j.arrived_at ? `${fmtTime(j.arrived_at)}（${Math.round(j.arrived_distance)}m）` : '-'}</td>
          <td class="num">${j.requires_tank ? (j.scanned_at ? `${fmtTime(j.scanned_at)}（${Math.round(j.scanned_distance)}m）` : '-') : '対象外'}</td>
          <td class="num">${fmtTime(j.completed_at) || '-'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">この日の作業予定はありません</td></tr>'}</tbody></table></div></section>`;

    document.getElementById('dashDate').onchange = (e) => { dashDate = e.target.value || todayStr(); renderDashboard(); };
    document.getElementById('dashRefresh').onclick = renderDashboard;
    view.querySelectorAll('[data-resolve]').forEach((b) => { b.onclick = async () => { await api('POST', `/api/admin/alerts/${b.dataset.resolve}/resolve`, {}); renderDashboard(); }; });
    view.querySelectorAll('[data-job]').forEach((tr) => { tr.onclick = () => showReport(Number(tr.dataset.job)); });

    // 地図
    const map = makeMap(document.getElementById('dashMap'));
    const bounds = [];
    for (const c of d.customers) {
      L.circle([c.lat, c.lng], { radius: c.radius_m, color: '#0b6e8a', weight: 1, fillOpacity: 0.06 }).addTo(map);
    }
    for (const j of d.jobs) {
      dot([j.lat, j.lng], STATUS_COLOR[j.status] || '#7b8a95', 9).addTo(map)
        .bindPopup(`<b>${esc(j.customer_name)}</b><br>${esc(j.work_type)}｜${esc(j.assignee_name)}<br>${statusLabel[j.status]}`);
      bounds.push([j.lat, j.lng]);
    }
    for (const s of d.staff) {
      if (!s.last_location) continue;
      const ll = [s.last_location.lat, s.last_location.lng];
      L.circle(ll, { radius: s.last_location.acc, color: '#b42318', weight: 1, fillOpacity: 0.08 }).addTo(map);
      dot(ll, '#b42318', 7).addTo(map).bindTooltip(`${esc(s.name)}（${fmtTime(s.last_location.recorded_at)}）`, { permanent: true, direction: 'right', offset: [8, 0] });
      bounds.push(ll);
    }
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    let trackLayer = null;
    view.querySelectorAll('[data-track]').forEach((b) => {
      b.onclick = async () => {
        const pts = await api('GET', `/api/admin/locations?user_id=${b.dataset.track}&date=${dashDate}`);
        if (trackLayer) trackLayer.remove();
        if (!pts.length) { toast('この日の位置記録はありません'); return; }
        trackLayer = L.layerGroup([
          L.polyline(pts.map((p) => [p.lat, p.lng]), { color: '#b42318', weight: 3, opacity: 0.7 }),
          ...pts.map((p) => L.circleMarker([p.lat, p.lng], { radius: 3, color: '#b42318' }).bindTooltip(fmtTime(p.recorded_at))),
        ]).addTo(map);
        map.fitBounds(pts.map((p) => [p.lat, p.lng]), { padding: [40, 40], maxZoom: 16 });
        document.getElementById('dashMap').scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
    });
    refreshTimer = setInterval(() => { if (!dlg.open && document.visibilityState === 'visible') renderDashboard(); }, 60000);
  }

  // ================= 作業予定 =================
  let jobRange = { from: todayStr(), to: todayStr() };
  async function renderJobs() {
    const jobs = await api('GET', `/api/admin/jobs?from=${jobRange.from}&to=${jobRange.to}`);
    view.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <h1 class="grow" style="margin:0">作業予定</h1>
        <label class="row small">期間 <input type="date" id="jFrom" value="${jobRange.from}" style="width:auto"> 〜 <input type="date" id="jTo" value="${jobRange.to}" style="width:auto"></label>
        <button class="btn btn-primary" id="addJob">＋ 作業を登録</button>
      </div>
      <section class="card"><div class="table-wrap"><table>
        <thead><tr><th>日付</th><th>担当</th><th>顧客</th><th>浄化槽</th><th>種別</th><th>状態</th><th>メモ</th><th></th></tr></thead>
        <tbody>${jobs.map((j) => `<tr>
          <td class="num">${esc(j.scheduled_date)}</td><td>${esc(j.assignee_name)}</td><td>${esc(j.customer_name)}</td><td>${esc(j.tank_label || '-')}</td>
          <td>${esc(j.work_type)}</td><td><span class="badge ${statusClass[j.status]}">${statusLabel[j.status]}</span></td><td class="small">${esc(j.memo || '')}</td>
          <td style="white-space:nowrap">${j.status === 'scheduled' ? `<button class="btn btn-sm" data-edit="${j.id}">編集</button> <button class="btn btn-sm" data-cancel="${j.id}">取消</button>` : ''}
            ${j.status === 'completed' ? `<button class="btn btn-sm" data-report="${j.id}">報告を見る</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">作業予定はありません</td></tr>'}</tbody></table></div></section>`;
    const reload = () => { jobRange = { from: val('jFrom') || todayStr(), to: val('jTo') || val('jFrom') || todayStr() }; renderJobs(); };
    document.getElementById('jFrom').onchange = reload;
    document.getElementById('jTo').onchange = reload;
    document.getElementById('addJob').onclick = () => jobDialog(null);
    view.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => jobDialog(jobs.find((j) => j.id === Number(b.dataset.edit))); });
    view.querySelectorAll('[data-report]').forEach((b) => { b.onclick = () => showReport(Number(b.dataset.report)); });
    view.querySelectorAll('[data-cancel]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('この作業予定を取り消しますか？')) return;
        try { await api('POST', `/api/admin/jobs/${b.dataset.cancel}/cancel`, {}); toast('取り消しました'); renderJobs(); } catch (e) { toast(e.message, 'danger'); }
      };
    });
  }
  async function jobDialog(job) {
    const [users, customers] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/customers')]);
    const staff = users.filter((u) => u.active && u.role === 'staff');
    openDialog(job ? '作業予定の編集' : '作業予定の登録', `
      <div class="form-grid">
        <label class="field"><span>作業日</span><input type="date" id="jDate" value="${esc(job ? job.scheduled_date : jobRange.from)}"></label>
        <label class="field"><span>担当者</span><select id="jAssignee"><option value="">選択してください</option>${staff.map((u) => `<option value="${u.id}" ${job && job.assignee_id === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
        <label class="field"><span>顧客</span><select id="jCustomer"><option value="">選択してください</option>${customers.map((c) => `<option value="${c.id}" ${job && job.customer_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label class="field"><span>作業種別</span><select id="jType">${Object.keys(CHECKLISTS.types).map((t) => `<option ${job && job.work_type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label class="field full"><span>浄化槽（QR読み取りの対象）</span><select id="jTank"><option value="">（顧客を選択してください）</option></select></label>
        <label class="field full"><span>メモ（作業員に表示）</span><input id="jMemo" value="${esc(job ? job.memo || '' : '')}"></label>
      </div>`, {
      onSave: async () => {
        const body = { scheduled_date: val('jDate'), assignee_id: val('jAssignee'), customer_id: val('jCustomer'), work_type: val('jType'), tank_id: val('jTank') || null, memo: val('jMemo') };
        if (job) await api('PUT', `/api/admin/jobs/${job.id}`, body); else await api('POST', '/api/admin/jobs', body);
        toast('保存しました', 'ok');
        renderJobs();
      },
    });
    const loadTanks = async () => {
      const cid = val('jCustomer');
      const sel = document.getElementById('jTank');
      if (!cid) { sel.innerHTML = '<option value="">（顧客を選択してください）</option>'; return; }
      const c = await api('GET', `/api/admin/customers/${cid}`);
      sel.innerHTML = `<option value="">なし</option>${c.tanks.map((t) => `<option value="${t.id}" ${job && job.tank_id === t.id ? 'selected' : ''}>${esc(t.label)} ${esc(t.capacity || '')}</option>`).join('')}`;
      if (!job && c.tanks.length === 1) sel.value = String(c.tanks[0].id);
    };
    document.getElementById('jCustomer').onchange = loadTanks;
    loadTanks();
  }

  // ================= 顧客・浄化槽 =================
  async function renderCustomers() {
    const list = await api('GET', '/api/admin/customers');
    view.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <h1 class="grow" style="margin:0">顧客・浄化槽</h1>
        <input type="search" id="cSearch" placeholder="名前・住所で絞り込み" style="width:240px">
        <button class="btn btn-primary" id="addCustomer">＋ 顧客を登録</button>
      </div>
      <div class="grid grid-3-1">
        <section class="card"><div class="table-wrap"><table>
          <thead><tr><th>顧客名</th><th>住所</th><th>許容範囲</th><th>浄化槽</th></tr></thead>
          <tbody id="cBody">${list.map((c) => `<tr class="clickable" data-cid="${c.id}" data-q="${esc((c.name + c.kana + c.address).toLowerCase())}">
            <td>${esc(c.name)}<div class="muted small">${esc(c.kana || '')}</div></td><td class="small">${esc(c.address || '')}</td><td class="num">${c.radius_m}m</td><td class="num">${c.tank_count}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">顧客が登録されていません</td></tr>'}</tbody></table></div></section>
        <section class="card"><h2>位置一覧</h2><div id="cMap" class="map"></div></section>
      </div>`;
    document.getElementById('addCustomer').onclick = () => customerDialog(null);
    view.querySelectorAll('[data-cid]').forEach((tr) => { tr.onclick = () => customerDialog(Number(tr.dataset.cid)); });
    document.getElementById('cSearch').oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      view.querySelectorAll('[data-cid]').forEach((tr) => { tr.classList.toggle('hidden', q && !tr.dataset.q.includes(q)); });
    };
    const map = makeMap(document.getElementById('cMap'));
    const pts = list.map((c) => {
      L.circle([c.lat, c.lng], { radius: c.radius_m, color: '#0b6e8a', weight: 1, fillOpacity: 0.08 }).addTo(map);
      dot([c.lat, c.lng], '#0b6e8a').addTo(map).bindPopup(esc(c.name));
      return [c.lat, c.lng];
    });
    if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
  }

  async function customerDialog(id) {
    const settings = await api('GET', '/api/admin/settings');
    const c = id ? await api('GET', `/api/admin/customers/${id}`) : { name: '', kana: '', address: '', phone: '', lat: null, lng: null, radius_m: Number(settings.default_radius_m), notes: '', tanks: [] };
    openDialog(id ? '顧客の編集' : '顧客の登録', `
      <div class="form-grid">
        <label class="field"><span>顧客名</span><input id="cName" value="${esc(c.name)}"></label>
        <label class="field"><span>ふりがな</span><input id="cKana" value="${esc(c.kana || '')}"></label>
        <label class="field full"><span>住所</span>
          <div class="row"><input id="cAddress" class="grow" value="${esc(c.address || '')}" style="flex:1"><button type="button" class="btn btn-sm" id="geocode">住所から地図を検索</button></div></label>
        <label class="field"><span>電話番号</span><input id="cPhone" value="${esc(c.phone || '')}"></label>
        <label class="field"><span>許容範囲（m）<small class="muted">この範囲内でないと到着・QR・報告ができません</small></span><input id="cRadius" type="number" min="20" max="1000" step="10" value="${c.radius_m}"></label>
        <div class="full"><p class="small" style="margin:0 0 4px"><b>浄化槽の位置</b>：地図をクリック（またはピンをドラッグ）して、浄化槽の場所を正確に指定してください。</p>
          <div id="cEditMap" class="map map-sm"></div>
          <p class="small muted num" id="cPosText" style="margin:.3em 0 0">${c.lat ? `緯度 ${c.lat.toFixed(6)} / 経度 ${c.lng.toFixed(6)}` : '未指定'}</p></div>
        <label class="field full"><span>注意事項（作業員に表示）</span><input id="cNotes" value="${esc(c.notes || '')}" placeholder="例：犬あり、鍵の場所 など"></label>
      </div>
      ${id ? `<hr style="border:none;border-top:1px solid var(--line)">
      <h3>浄化槽</h3>
      <div class="table-wrap"><table><thead><tr><th>名称</th><th>型式</th><th>人槽</th><th>QR版</th><th></th></tr></thead>
        <tbody>${c.tanks.map((t) => `<tr><td>${esc(t.label)}</td><td>${esc(t.model || '')}</td><td>${esc(t.capacity || '')}</td><td class="num">v${t.qr_version}</td>
          <td style="white-space:nowrap"><a class="btn btn-sm" href="/admin/qr-print?tank_ids=${t.id}" target="_blank" rel="noopener">QR印刷</a>
          <button type="button" class="btn btn-sm" data-reissue="${t.id}">QR再発行</button>
          <button type="button" class="btn btn-sm" data-archive-tank="${t.id}">削除</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">浄化槽が未登録です</td></tr>'}</tbody></table></div>
      <div class="form-grid" style="margin-top:8px">
        <label class="field"><span>浄化槽の名称</span><input id="tLabel" placeholder="例：合併処理浄化槽"></label>
        <label class="field"><span>型式</span><input id="tModel"></label>
        <label class="field"><span>人槽</span><input id="tCapacity" placeholder="例：5人槽"></label>
        <div class="field" style="align-self:end"><button type="button" class="btn" id="addTank">＋ 浄化槽を追加</button></div>
      </div>
      <div class="row"><a class="btn btn-sm" href="/admin/qr-print?customer_id=${id}" target="_blank" rel="noopener">この顧客のQRラベルをまとめて印刷</a>
        <button type="button" class="btn btn-sm btn-danger" id="archiveCustomer">顧客を削除</button></div>` : '<p class="muted small">浄化槽（QRコード）は、顧客を保存した後に登録できます。</p>'}`, {
      wide: true,
      onSave: async () => {
        if (pos.lat === null) throw new Error('地図をクリックして浄化槽の位置を指定してください');
        const body = { name: val('cName'), kana: val('cKana'), address: val('cAddress'), phone: val('cPhone'), radius_m: Number(val('cRadius')), notes: val('cNotes'), lat: pos.lat, lng: pos.lng };
        if (id) await api('PUT', `/api/admin/customers/${id}`, body);
        else {
          const r = await api('POST', '/api/admin/customers', body);
          toast('保存しました。続けて浄化槽を登録してください。', 'ok');
          dlg.close();
          renderCustomers();
          customerDialog(r.id);
          return false;
        }
        toast('保存しました', 'ok');
        renderCustomers();
      },
    });
    const pos = { lat: c.lat, lng: c.lng };
    const map = makeMap(document.getElementById('cEditMap'), c.lat ? [c.lat, c.lng] : DEFAULT_CENTER, c.lat ? 17 : 13);
    let marker = null; let circle = null;
    const place = (lat, lng) => {
      pos.lat = lat; pos.lng = lng;
      const r = Number(val('cRadius')) || 100;
      if (!marker) {
        marker = L.marker([lat, lng], { draggable: true, icon: L.divIcon({ className: '', html: '<div style="width:18px;height:18px;border-radius:50%;background:#b42318;border:3px solid #fff;box-shadow:0 0 0 1px #b42318"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(map);
        marker.on('dragend', () => { const ll = marker.getLatLng(); place(ll.lat, ll.lng); });
        circle = L.circle([lat, lng], { radius: r, color: '#b42318', weight: 1, fillOpacity: 0.1 }).addTo(map);
      } else { marker.setLatLng([lat, lng]); circle.setLatLng([lat, lng]); circle.setRadius(r); }
      document.getElementById('cPosText').textContent = `緯度 ${lat.toFixed(6)} / 経度 ${lng.toFixed(6)}`;
    };
    if (c.lat) place(c.lat, c.lng);
    map.on('click', (e) => place(e.latlng.lat, e.latlng.lng));
    document.getElementById('cRadius').oninput = () => { if (circle) circle.setRadius(Number(val('cRadius')) || 100); };
    setTimeout(() => map.invalidateSize(), 50);
    document.getElementById('geocode').onclick = async () => {
      const q = val('cAddress');
      if (!q) { toast('住所を入力してください'); return; }
      try {
        // 国土地理院の住所検索API（無料・登録不要）
        const r = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`).then((x) => x.json());
        if (!r.length) { toast('住所が見つかりませんでした。地図をクリックして指定してください。'); return; }
        const [lng, lat] = r[0].geometry.coordinates;
        map.setView([lat, lng], 17);
        place(lat, lng);
        toast('おおよその位置を設定しました。浄化槽の正確な位置にピンを動かしてください。');
      } catch (_) { toast('住所検索に失敗しました。地図をクリックして指定してください。', 'danger'); }
    };
    if (!id) return;
    document.getElementById('addTank').onclick = async () => {
      try {
        await api('POST', `/api/admin/customers/${id}/tanks`, { label: val('tLabel'), model: val('tModel'), capacity: val('tCapacity') });
        toast('浄化槽を追加しました', 'ok');
        customerDialog(id);
      } catch (e) { toast(e.message, 'danger'); }
    };
    dlgBody.querySelectorAll('[data-reissue]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('QRコードを再発行すると、今貼ってあるQRラベルは使えなくなります。再発行しますか？')) return;
        await api('POST', `/api/admin/tanks/${b.dataset.reissue}/reissue-qr`, {});
        toast('再発行しました。新しいラベルを印刷して貼り替えてください。', 'ok');
        customerDialog(id);
      };
    });
    dlgBody.querySelectorAll('[data-archive-tank]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('この浄化槽を削除しますか？（過去の報告は残ります）')) return;
        await api('POST', `/api/admin/tanks/${b.dataset.archiveTank}/archive`, {});
        customerDialog(id);
      };
    });
    document.getElementById('archiveCustomer').onclick = async () => {
      if (!confirm(`「${c.name}」を削除しますか？（過去の報告は残ります）`)) return;
      await api('POST', `/api/admin/customers/${id}/archive`, {});
      dlg.close();
      renderCustomers();
    };
  }

  // ================= 作業報告 =================
  let repRange = { from: todayStr(), to: todayStr() };
  async function renderReports() {
    const list = await api('GET', `/api/admin/reports?from=${repRange.from}&to=${repRange.to}`);
    view.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <h1 class="grow" style="margin:0">作業報告</h1>
        <label class="row small">期間 <input type="date" id="rFrom" value="${repRange.from}" style="width:auto"> 〜 <input type="date" id="rTo" value="${repRange.to}" style="width:auto"></label>
      </div>
      <section class="card"><div class="table-wrap"><table>
        <thead><tr><th>報告日時</th><th>顧客</th><th>種別</th><th>担当</th><th>到着時の距離</th><th>QR時の距離</th><th>報告時の距離</th></tr></thead>
        <tbody>${list.map((r) => `<tr class="clickable" data-job="${r.id}">
          <td class="num">${fmtDateTime(r.submitted_at)}</td><td>${esc(r.customer_name)}</td><td>${esc(r.work_type)}</td><td>${esc(r.assignee_name)}</td>
          <td class="num">${Math.round(r.arrived_distance)}m</td><td class="num">${r.scanned_at ? Math.round(r.scanned_distance) + 'm' : '-'}</td><td class="num">${Math.round(r.report_distance)}m</td></tr>`).join('') || '<tr><td colspan="7" class="muted">この期間の報告はありません</td></tr>'}</tbody></table></div></section>`;
    const reload = () => { repRange = { from: val('rFrom') || todayStr(), to: val('rTo') || val('rFrom') || todayStr() }; renderReports(); };
    document.getElementById('rFrom').onchange = reload;
    document.getElementById('rTo').onchange = reload;
    view.querySelectorAll('[data-job]').forEach((tr) => { tr.onclick = () => showReport(Number(tr.dataset.job)); });
  }

  async function showReport(jobId) {
    const { job, report, photos, checklist } = await api('GET', `/api/admin/reports/${jobId}`);
    const r = report;
    openDialog(`${job.customer_name}｜${job.work_type}`, `
      <div class="grid grid-2">
        <div>
          <p class="small" style="margin-top:0">担当：${esc(job.assignee_name)}　作業日：<span class="num">${esc(job.scheduled_date)}</span>　<span class="badge ${statusClass[job.status]}">${statusLabel[job.status]}</span></p>
          <h3>記録の流れ</h3>
          <ul class="timeline small">
            <li>到着確認：${job.arrived_at ? `<span class="num">${fmtDateTime(job.arrived_at)}</span>（現場から${Math.round(job.arrived_distance)}m／誤差${Math.round(job.arrived_acc)}m）` : '未'}</li>
            ${job.requires_tank ? `<li>QR読み取り：${job.scanned_at ? `<span class="num">${fmtDateTime(job.scanned_at)}</span>（${Math.round(job.scanned_distance)}m／誤差${Math.round(job.scanned_acc)}m）` : '未'}</li>` : ''}
            <li>報告送信：${r ? `<span class="num">${fmtDateTime(r.submitted_at)}</span>（${Math.round(r.distance)}m／誤差${Math.round(r.acc)}m）` : '未'}</li>
            ${job.arrived_at && r ? `<li>現場滞在：約${Math.round((Date.parse(r.submitted_at) - Date.parse(job.arrived_at)) / 60000)}分</li>` : ''}
          </ul>
          <div id="repMap" class="map map-sm"></div>
        </div>
        <div>
          ${r && checklist ? `<h3>点検結果</h3><table><tbody>${checklist.items.map((it) => {
            const v = r.checklist[it.key];
            const abnormal = it.type === 'select' && v && v !== it.options[0];
            return `<tr><th>${esc(it.label)}</th><td class="num">${abnormal ? `<span class="badge warn">${esc(v)}</span>` : esc(v ?? '')}${it.unit && v !== undefined ? ' ' + esc(it.unit) : ''}</td></tr>`;
          }).join('')}</tbody></table>
          ${r.comment ? `<h3 style="margin-top:12px">特記事項</h3><p class="small">${esc(r.comment)}</p>` : ''}
          <h3 style="margin-top:12px">写真</h3><div class="photo-grid">${photos.map((p) => `<a href="${esc(p)}" target="_blank" rel="noopener"><img src="${esc(p)}" alt="報告写真"></a>`).join('') || '<span class="muted small">なし</span>'}</div>`
          : '<p class="muted">まだ報告されていません。</p>'}
        </div>
      </div>`, { wide: true });
    const map = makeMap(document.getElementById('repMap'), [job.lat, job.lng], 17);
    L.circle([job.lat, job.lng], { radius: job.radius_m, color: '#0b6e8a', weight: 1, fillOpacity: 0.08 }).addTo(map);
    dot([job.lat, job.lng], '#0b6e8a', 7).addTo(map).bindTooltip('浄化槽');
    if (job.arrived_lat) dot([job.arrived_lat, job.arrived_lng], '#7b8a95', 6).addTo(map).bindTooltip('到着');
    if (job.scanned_lat) dot([job.scanned_lat, job.scanned_lng], '#c58a00', 6).addTo(map).bindTooltip('QR');
    if (r && r.lat) dot([r.lat, r.lng], '#1f7a46', 6).addTo(map).bindTooltip('報告');
    setTimeout(() => map.invalidateSize(), 50);
  }

  // ================= 勤怠・アルコール =================
  let attRange = { from: todayStr(), to: todayStr() };
  async function renderAttendance() {
    const { attendance, alcohol } = await api('GET', `/api/admin/attendance?from=${attRange.from}&to=${attRange.to}`);
    const res = (r) => (r ? `<span class="badge ${r === 'pass' ? 'ok' : 'danger'}">${r === 'pass' ? '合格' : '検知'}</span>` : '');
    view.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <h1 class="grow" style="margin:0">勤怠・アルコールチェック記録</h1>
        <label class="row small">期間 <input type="date" id="aFrom" value="${attRange.from}" style="width:auto"> 〜 <input type="date" id="aTo" value="${attRange.to}" style="width:auto"></label>
        <a class="btn btn-sm" href="/api/admin/attendance.csv?from=${attRange.from}&to=${attRange.to}">勤怠CSV</a>
        <a class="btn btn-sm" href="/api/admin/alcohol.csv?from=${attRange.from}&to=${attRange.to}">アルコール記録簿CSV</a>
      </div>
      <div class="notice info small">アルコールチェックの記録は1年間の保存が必要です（道路交通法施行規則）。CSVは定期的に保存してください。</div>
      <section class="card"><h2>勤怠</h2><div class="table-wrap"><table>
        <thead><tr><th>日付</th><th>氏名</th><th>出勤</th><th>出勤時(mg/L)</th><th>退勤</th><th>退勤時(mg/L)</th></tr></thead>
        <tbody>${attendance.map((a) => `<tr><td class="num">${esc(a.work_date)}</td><td>${esc(a.name)}</td>
          <td class="num">${fmtTime(a.clock_in_at)}</td><td class="num">${a.in_value !== null ? a.in_value.toFixed(2) : ''} ${res(a.in_result)}</td>
          <td class="num">${fmtTime(a.clock_out_at) || '-'}</td><td class="num">${a.out_value !== null ? a.out_value.toFixed(2) : ''} ${res(a.out_result)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">記録はありません</td></tr>'}</tbody></table></div></section>
      <section class="card"><h2>アルコールチェック（全件・不合格含む）</h2><div class="table-wrap"><table>
        <thead><tr><th>確認日時</th><th>氏名</th><th>区分</th><th>方法</th><th>検知器</th><th>測定値(mg/L)</th><th>判定</th><th>写真</th></tr></thead>
        <tbody>${alcohol.map((c) => `<tr><td class="num">${fmtDateTime(c.checked_at)}</td><td>${esc(c.name)}</td><td>${c.kind === 'clock_in' ? '出勤（運転前）' : '退勤（運転後）'}</td>
          <td>${c.source === 'device' ? '検知器連携' : '手入力'}</td><td>${esc(c.device_id || '')}</td><td class="num">${c.value_mgl.toFixed(2)}</td><td>${res(c.result)}</td>
          <td>${c.photo ? `<a href="/uploads/${esc(c.photo)}" target="_blank" rel="noopener">表示</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">記録はありません</td></tr>'}</tbody></table></div></section>`;
    const reload = () => { attRange = { from: val('aFrom') || todayStr(), to: val('aTo') || val('aFrom') || todayStr() }; renderAttendance(); };
    document.getElementById('aFrom').onchange = reload;
    document.getElementById('aTo').onchange = reload;
  }

  // ================= 従業員 =================
  async function renderUsers() {
    const users = await api('GET', '/api/admin/users');
    view.innerHTML = `
      <div class="row" style="margin-bottom:12px"><h1 class="grow" style="margin:0">従業員</h1><button class="btn btn-primary" id="addUser">＋ 従業員を登録</button></div>
      <section class="card"><div class="table-wrap"><table>
        <thead><tr><th>氏名</th><th>ログインID</th><th>権限</th><th>電話</th><th>状態</th></tr></thead>
        <tbody>${users.map((u) => `<tr class="clickable" data-uid="${u.id}"><td>${esc(u.name)}</td><td>${esc(u.login_id)}</td><td>${u.role === 'admin' ? '管理者' : '作業員'}</td><td>${esc(u.phone || '')}</td>
          <td>${u.active ? '<span class="badge ok">有効</span>' : '<span class="badge">無効</span>'}</td></tr>`).join('')}</tbody></table></div></section>`;
    document.getElementById('addUser').onclick = () => userDialog(null);
    view.querySelectorAll('[data-uid]').forEach((tr) => { tr.onclick = () => userDialog(users.find((u) => u.id === Number(tr.dataset.uid))); });
  }
  function userDialog(u) {
    openDialog(u ? '従業員の編集' : '従業員の登録', `
      <div class="form-grid">
        <label class="field"><span>氏名</span><input id="uName" value="${esc(u ? u.name : '')}"></label>
        <label class="field"><span>ログインID（半角英数字）</span><input id="uLogin" value="${esc(u ? u.login_id : '')}" autocapitalize="off"></label>
        <label class="field"><span>権限</span><select id="uRole"><option value="staff">作業員</option><option value="admin" ${u && u.role === 'admin' ? 'selected' : ''}>管理者</option></select></label>
        <label class="field"><span>電話番号</span><input id="uPhone" value="${esc(u ? u.phone || '' : '')}"></label>
        <label class="field"><span>${u ? '新しいパスワード（変更する場合のみ）' : 'パスワード（8文字以上）'}</span><input id="uPw" type="password" autocomplete="new-password"></label>
        ${u ? `<label class="field"><span>状態</span><select id="uActive"><option value="1">有効</option><option value="0" ${u.active ? '' : 'selected'}>無効（退職など）</option></select></label>` : ''}
      </div>
      <p class="small muted">検知器と連携する場合、検知器側に登録する利用者IDは「ログインID」と同じにしてください。</p>`, {
      onSave: async () => {
        const body = { name: val('uName'), login_id: val('uLogin'), role: val('uRole'), phone: val('uPhone'), password: document.getElementById('uPw').value };
        if (u) { body.active = val('uActive') === '1'; await api('PUT', `/api/admin/users/${u.id}`, body); } else await api('POST', '/api/admin/users', body);
        toast('保存しました', 'ok');
        renderUsers();
      },
    });
  }

  // ================= 設定 =================
  async function renderSettings() {
    const [s, users] = await Promise.all([api('GET', '/api/admin/settings'), api('GET', '/api/admin/users')]);
    const endpoint = `${location.origin}/api/device/alcohol`;
    view.innerHTML = `
      <h1>設定</h1>
      <div class="grid grid-2">
        <section class="card"><h2>運用ルール</h2>
          <label class="field"><span>アルコール判定の基準値（mg/L）：この値を超えたら不合格</span><input id="sThreshold" type="number" step="0.01" min="0" max="0.5" value="${esc(s.alcohol_threshold_mgl)}"></label>
          <label class="field"><span>検知器の測定値を使える時間（分）</span><input id="sValid" type="number" min="1" max="60" value="${esc(s.device_reading_valid_minutes)}"></label>
          <label class="field"><span>手入力（写真必須）を許可</span><select id="sManual"><option value="1">許可する</option><option value="0" ${s.allow_manual_alcohol === '1' ? '' : 'selected'}>許可しない（検知器連携のみ）</option></select></label>
          <label class="field"><span>顧客登録時の許容範囲の初期値（m）</span><input id="sRadius" type="number" min="20" max="1000" value="${esc(s.default_radius_m)}"></label>
          <label class="field"><span>受け付ける位置情報の精度（誤差 m 以内）</span><input id="sAcc" type="number" min="10" max="500" value="${esc(s.max_accuracy_m)}"></label>
          <label class="field"><span>到着から報告までの最低滞在時間（分）</span><input id="sStay" type="number" min="0" max="120" value="${esc(s.min_stay_minutes)}"></label>
          <label class="field"><span>勤務中の位置送信間隔（秒）</span><input id="sInterval" type="number" min="15" max="600" value="${esc(s.tracking_interval_sec)}"></label>
          <button class="btn btn-primary" id="saveSettings">設定を保存</button>
        </section>
        <section class="card"><h2>アルコール検知器との連携</h2>
          <p class="small">クラウド連携型の検知器や、検知器と通信する中継アプリから、測定結果を次のAPIへ送信すると、作業員のスマホで「検知器の測定結果を取り込む」から出勤できます。</p>
          <label class="field"><span>送信先URL</span><input readonly value="${esc(endpoint)}"></label>
          <label class="field"><span>APIキー（ヘッダ X-Device-Key）</span><div class="row"><input readonly id="apiKey" value="${esc(s.device_api_key)}" style="flex:1"><button class="btn btn-sm" id="regenKey">再発行</button></div></label>
          <details class="small"><summary style="cursor:pointer">送信例</summary><pre style="white-space:pre-wrap;word-break:break-all;background:var(--surface-2);padding:8px;border-radius:8px">curl -X POST ${esc(endpoint)} \\
  -H "Content-Type: application/json" \\
  -H "X-Device-Key: (APIキー)" \\
  -d '{"device_id":"ALC-01","login_id":"sato","value_mgl":0.00}'</pre></details>
          <hr style="border:none;border-top:1px solid var(--line)">
          <h3>検知器シミュレーター（動作確認用）</h3>
          <p class="small muted">検知器を導入する前の動作確認に使います。選んだ従業員が検知器で測定したことにします。</p>
          <div class="form-grid">
            <label class="field"><span>従業員</span><select id="simUser">${users.filter((u) => u.active).map((u) => `<option value="${esc(u.login_id)}">${esc(u.name)}</option>`).join('')}</select></label>
            <label class="field"><span>測定値（mg/L）</span><input id="simValue" type="number" step="0.01" min="0" value="0.00"></label>
          </div>
          <button class="btn" id="simSend">測定結果を送信</button>
        </section>
      </div>`;
    document.getElementById('saveSettings').onclick = async () => {
      try {
        await api('PUT', '/api/admin/settings', {
          alcohol_threshold_mgl: val('sThreshold'), device_reading_valid_minutes: val('sValid'), allow_manual_alcohol: val('sManual'),
          default_radius_m: val('sRadius'), max_accuracy_m: val('sAcc'), min_stay_minutes: val('sStay'), tracking_interval_sec: val('sInterval'),
        });
        toast('設定を保存しました', 'ok');
      } catch (e) { toast(e.message, 'danger'); }
    };
    document.getElementById('regenKey').onclick = async () => {
      if (!confirm('APIキーを再発行すると、検知器側の設定も変更が必要です。再発行しますか？')) return;
      const r = await api('POST', '/api/admin/settings/regenerate-device-key', {});
      document.getElementById('apiKey').value = r.device_api_key;
    };
    document.getElementById('simSend').onclick = async () => {
      try {
        await api('POST', '/api/admin/device-simulate', { login_id: val('simUser'), value_mgl: Number(val('simValue')) });
        toast('測定結果を送信しました', 'ok');
      } catch (e) { toast(e.message, 'danger'); }
    };
  }

  // ---------- 起動 ----------
  (async () => {
    try {
      me = await api('GET', '/api/me');
      if (me.role !== 'admin') { location.href = '/staff'; return; }
      document.getElementById('me').textContent = me.name;
      route();
    } catch (_) { /* api() が 401 時にログイン画面へ移動 */ }
  })();
})();
