(function () {
  const { api, esc } = window.App;
  document.getElementById('printBtn').onclick = () => window.print();
  const q = new URLSearchParams(location.search);
  const params = q.get('tank_ids') ? `tank_ids=${encodeURIComponent(q.get('tank_ids'))}` : `customer_id=${encodeURIComponent(q.get('customer_id') || '')}`;
  api('GET', `/api/admin/qr-labels?${params}`).then((labels) => {
    const box = document.getElementById('labels');
    if (!labels.length) { box.innerHTML = '<p class="muted">印刷する浄化槽がありません。</p>'; return; }
    // svg はサーバ（qrcode ライブラリ）が生成したもの
    box.innerHTML = labels.map((l) => `
      <div class="qr-label" data-payload="${esc(l.payload)}">
        ${l.svg}
        <div>
          <div class="t1">${esc(l.customer_name)}</div>
          <div class="t2">${esc(l.label)} ${esc(l.capacity || '')}</div>
          <div class="t2" style="margin-top:2mm">点検時に読み取り／蓋の裏側に貼付</div>
          <div class="t2" style="margin-top:2mm">一戸浄化槽　No.${l.tank_id}-v${l.qr_version}</div>
        </div>
      </div>`).join('');
  }).catch((e) => { document.getElementById('labels').innerHTML = `<div class="notice danger">${esc(e.message)}</div>`; });
})();
