// 作業種別ごとの点検・報告項目。ブラウザ（入力フォーム生成）とサーバ（入力検証）の両方で使う。
// 項目を増やしたいときはここだけ編集すればよい。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CHECKLISTS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const tankInspection = [
    { key: 'odor', label: '臭気', type: 'select', options: ['異常なし', 'やや有り', '強い'], required: true },
    { key: 'effluent', label: '放流水の外観', type: 'select', options: ['透明', 'やや濁り', '濁り'], required: true },
    { key: 'transparency', label: '透視度', type: 'number', unit: 'cm', min: 0, max: 100, step: 1, required: true },
    { key: 'ph', label: 'pH', type: 'number', min: 0, max: 14, step: 0.1, required: true },
    { key: 'chlorine', label: '残留塩素', type: 'number', unit: 'mg/L', min: 0, max: 10, step: 0.1, required: true },
    { key: 'disinfectant', label: '消毒剤', type: 'select', options: ['補充済', '残量十分', '要補充'], required: true },
    { key: 'blower', label: 'ブロワ稼働', type: 'select', options: ['正常', '異音あり', '停止'], required: true },
    { key: 'scum', label: 'スカム・汚泥', type: 'select', options: ['適正', 'やや多い', '清掃が必要'], required: true },
    { key: 'water_level', label: '槽内水位', type: 'select', options: ['正常', '高い', '低い'], required: true },
    { key: 'damage', label: '破損・漏水', type: 'select', options: ['なし', 'あり'], required: true },
    { key: 'insects', label: '害虫の発生', type: 'select', options: ['なし', 'あり'], required: true },
  ];
  const cleaning = [
    { key: 'pump_volume', label: '引抜量', type: 'number', unit: 'm³', min: 0, max: 50, step: 0.1, required: true },
    { key: 'cleaned_units', label: '清掃した単位装置', type: 'text', required: true, placeholder: '例：沈殿分離槽、嫌気ろ床槽' },
    { key: 'water_filled', label: '張り水', type: 'select', options: ['実施', '未実施'], required: true },
    { key: 'damage', label: '破損・漏水', type: 'select', options: ['なし', 'あり'], required: true },
  ];
  const legalInspection = [
    { key: 'appearance', label: '外観検査', type: 'select', options: ['適正', '要注意', '不適正'], required: true },
    { key: 'water_quality', label: '水質検査', type: 'select', options: ['適正', '要注意', '不適正'], required: true },
    { key: 'documents', label: '書類検査（点検・清掃記録）', type: 'select', options: ['確認済', '不備あり'], required: true },
  ];
  const general = [
    { key: 'work_done', label: '作業内容', type: 'text', required: true, placeholder: '実施した作業' },
  ];
  return {
    // requiresTank=true の作業は、浄化槽のQR読み取りが必須
    types: {
      '保守点検': { requiresTank: true, minPhotos: 1, items: tankInspection },
      '清掃': { requiresTank: true, minPhotos: 1, items: cleaning },
      '法定検査立会い': { requiresTank: true, minPhotos: 1, items: legalInspection },
      '修理・その他': { requiresTank: false, minPhotos: 0, items: general },
    },
  };
});
