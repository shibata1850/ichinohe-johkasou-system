'use strict';
process.removeAllListeners('warning'); // node:sqlite の ExperimentalWarning を抑止

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');

const { db, DATA_DIR, getSettings, setSetting, tx } = require('./db');
const {
  hashPassword, verifyPassword, makeTankQrPayload, parseTankQrPayload,
  distanceM, parsePosition, nowIso, todayJst, fmtJst, savePhotoDataUrl, httpError,
} = require('./util');
const CHECKLISTS = require('../public/shared/checklists.js');

// 初回起動時に検知器連携APIキーを発行
if (!getSettings().device_api_key) setSetting('device_api_key', crypto.randomBytes(24).toString('base64url'));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));

// ---------- セキュリティヘッダ ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://cyberjapandata.gsi.go.jp",
    "connect-src 'self' https://msearch.gsi.go.jp",
    "media-src 'self' blob:",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});

// ---------- セッション ----------
const SESSION_DAYS = 30;
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}
app.use((req, _res, next) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) {
    const row = db.prepare(`
      SELECT u.id, u.login_id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`).get(token, Date.now());
    if (row) { req.user = row; req.sessionToken = token; }
  }
  next();
});

// 状態を変更するAPIは JSON 必須（クロスサイトのフォーム送信によるCSRFを防ぐ）
app.use('/api', (req, _res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return next(httpError(415, 'Content-Type は application/json にしてください'));
  }
  next();
});

const requireLogin = (req, _res, next) => (req.user ? next() : next(httpError(401, 'ログインしてください')));
const requireAdmin = (req, _res, next) => {
  if (!req.user) return next(httpError(401, 'ログインしてください'));
  if (req.user.role !== 'admin') return next(httpError(403, '管理者のみ利用できます'));
  next();
};
const wrap = (fn) => (req, res, next) => {
  try {
    const r = fn(req, res, next);
    if (r && typeof r.then === 'function') r.catch(next);
  } catch (e) { next(e); }
};

function addAlert(level, type, message, userId = null, jobId = null) {
  db.prepare('INSERT INTO alerts(level, type, user_id, job_id, message, created_at) VALUES (?,?,?,?,?,?)')
    .run(level, type, userId, jobId, message, nowIso());
}

// ---------- 認証 ----------
const loginFailures = new Map(); // key -> {count, until}
app.post('/api/login', wrap((req, res) => {
  const loginId = String(req.body?.login_id || '').trim();
  const password = String(req.body?.password || '');
  const key = `${loginId}|${req.ip}`;
  const f = loginFailures.get(key);
  if (f && f.count >= 10 && f.until > Date.now()) throw httpError(429, 'ログイン失敗が続いたため15分間ロックしています');
  const user = db.prepare('SELECT * FROM users WHERE login_id = ? AND active = 1').get(loginId);
  if (!user || !verifyPassword(password, user.password_hash)) {
    const cur = f && f.until > Date.now() ? f : { count: 0 };
    loginFailures.set(key, { count: cur.count + 1, until: Date.now() + 15 * 60 * 1000 });
    throw httpError(401, 'IDまたはパスワードが違います');
  }
  loginFailures.delete(key);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES (?,?,?)')
    .run(token, user.id, Date.now() + SESSION_DAYS * 86400 * 1000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
  res.json({ id: user.id, login_id: user.login_id, name: user.name, role: user.role });
}));
app.post('/api/logout', wrap((req, res) => {
  if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
}));
app.get('/api/me', requireLogin, (req, res) => res.json(req.user));

// ---------- 共通：ジオフェンス判定 ----------
function checkGeofence(customer, pos, settings) {
  const maxAcc = Number(settings.max_accuracy_m);
  const distance = Math.round(distanceM(pos.lat, pos.lng, customer.lat, customer.lng));
  if (pos.acc > maxAcc) {
    return { ok: false, distance, reason: `位置情報の精度が低すぎます（誤差 約${Math.round(pos.acc)}m）。屋外で数秒待ってから再取得してください。` };
  }
  if (distance > customer.radius_m) {
    return { ok: false, distance, reason: `現場から約${distance}m離れています（許容範囲 ${customer.radius_m}m）。現場に到着してから操作してください。` };
  }
  return { ok: true, distance };
}

function requirePos(body) {
  const pos = parsePosition(body);
  if (!pos) throw httpError(400, '位置情報が取得できていません。スマートフォンの位置情報をオンにしてください。');
  return pos;
}

// ---------- アルコールチェック ----------
function judgeAlcohol(value, settings) {
  return value > Number(settings.alcohol_threshold_mgl) ? 'fail' : 'pass';
}

/** 検知器から届いた未使用の測定値（有効時間内の最新） */
function latestDeviceReading(loginId, settings) {
  const since = new Date(Date.now() - Number(settings.device_reading_valid_minutes) * 60000).toISOString();
  return db.prepare(`SELECT * FROM device_readings WHERE login_id = ? AND used = 0 AND received_at >= ?
    ORDER BY received_at DESC LIMIT 1`).get(loginId, since);
}

/**
 * 出勤・退勤時のアルコールチェックを記録する。
 * 不合格でも記録は必ず残す（記録簿として1年保存が必要なため）。
 */
function recordAlcoholCheck(user, kind, alcohol, pos, settings) {
  const source = alcohol?.source;
  let value; let deviceId = null; let readingId = null; let photo = null;
  if (source === 'device') {
    const reading = latestDeviceReading(user.login_id, settings);
    if (!reading || reading.id !== Number(alcohol.reading_id)) {
      throw httpError(409, '検知器の測定結果が見つからないか、有効期限が切れています。もう一度測定してください。');
    }
    value = reading.value_mgl; deviceId = reading.device_id; readingId = reading.id;
  } else if (source === 'manual') {
    if (settings.allow_manual_alcohol !== '1') throw httpError(403, '手入力は無効です。検知器で測定してください。');
    value = Number(alcohol.value_mgl);
    if (!Number.isFinite(value) || value < 0 || value > 5) throw httpError(400, '測定値を正しく入力してください（例：0.00）');
    if (!alcohol.photo) throw httpError(400, '手入力の場合は、検知器の表示と本人の顔が写った写真が必要です。');
    deviceId = String(alcohol.device_id || '').slice(0, 64) || null;
    photo = alcohol.photo;
  } else {
    throw httpError(400, 'アルコールチェックの結果がありません');
  }
  const result = judgeAlcohol(value, settings);
  const id = tx(() => {
    const r = db.prepare(`INSERT INTO alcohol_checks(user_id, kind, value_mgl, result, source, device_id, device_reading_id, lat, lng, acc, checked_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(user.id, kind, value, result, source, deviceId, readingId, pos.lat, pos.lng, pos.acc, nowIso());
    const checkId = Number(r.lastInsertRowid);
    if (readingId) db.prepare('UPDATE device_readings SET used = 1 WHERE id = ?').run(readingId);
    if (photo) {
      const file = savePhotoDataUrl(photo);
      db.prepare('INSERT INTO photos(owner_user_id, kind, ref_id, file, created_at) VALUES (?,?,?,?,?)')
        .run(user.id, 'alcohol', checkId, file, nowIso());
    }
    return checkId;
  });
  if (result === 'fail') {
    addAlert('danger', 'alcohol', `${user.name} さん：アルコール検知 ${value.toFixed(2)} mg/L（${kind === 'clock_in' ? '出勤前' : '退勤時'}）。運転・作業をさせないでください。`, user.id);
  }
  return { id, value, result };
}

// 検知器連携API（検知器メーカーのクラウド・中継アプリ等から呼び出す）
app.post('/api/device/alcohol', wrap((req, res) => {
  const settings = getSettings();
  const key = String(req.headers['x-device-key'] || '');
  const expected = settings.device_api_key;
  if (!key || key.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
    throw httpError(401, 'APIキーが不正です');
  }
  res.status(201).json(insertDeviceReading(req.body));
}));
function insertDeviceReading(body) {
  const loginId = String(body?.login_id || '').trim();
  const value = Number(body?.value_mgl);
  const deviceId = String(body?.device_id || '').trim().slice(0, 64);
  if (!loginId || !deviceId || !Number.isFinite(value) || value < 0 || value > 5) throw httpError(400, 'login_id, device_id, value_mgl が必要です');
  if (!db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(loginId)) throw httpError(404, '該当する従業員がいません');
  const measuredAt = body?.measured_at && !Number.isNaN(Date.parse(body.measured_at)) ? new Date(body.measured_at).toISOString() : nowIso();
  const r = db.prepare('INSERT INTO device_readings(device_id, login_id, value_mgl, measured_at, received_at) VALUES (?,?,?,?,?)')
    .run(deviceId, loginId, value, measuredAt, nowIso());
  return { id: Number(r.lastInsertRowid), login_id: loginId, value_mgl: value };
}

// ---------- 従業員（スマホ）API ----------
const staff = express.Router();
staff.use(requireLogin);

function todayAttendance(userId) {
  return db.prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?').get(userId, todayJst());
}
function requireOnDuty(userId) {
  const a = todayAttendance(userId);
  if (!a || !a.clock_in_at) throw httpError(403, '出勤（アルコールチェック）が済んでいません。先に出勤してください。');
  if (a.clock_out_at) throw httpError(403, '本日は退勤済みです。');
  return a;
}

function jobView(job) {
  const type = CHECKLISTS.types[job.work_type];
  return {
    ...job,
    requires_tank: !!(type && type.requiresTank),
    min_photos: type ? type.minPhotos : 0,
  };
}
const JOB_SELECT = `
  SELECT j.*, c.name AS customer_name, c.address, c.phone AS customer_phone, c.lat, c.lng, c.radius_m, c.notes AS customer_notes,
         t.label AS tank_label, t.model AS tank_model, t.capacity AS tank_capacity, u.name AS assignee_name
  FROM jobs j JOIN customers c ON c.id = j.customer_id
  LEFT JOIN tanks t ON t.id = j.tank_id
  JOIN users u ON u.id = j.assignee_id`;

staff.get('/today', wrap((req, res) => {
  const s = getSettings();
  const jobs = db.prepare(`${JOB_SELECT} WHERE j.assignee_id = ? AND j.scheduled_date = ? AND j.status != 'cancelled' ORDER BY j.id`)
    .all(req.user.id, todayJst()).map(jobView);
  const att = todayAttendance(req.user.id);
  let inCheck = null; let outCheck = null;
  if (att?.clock_in_alcohol_id) inCheck = db.prepare('SELECT value_mgl, result, checked_at FROM alcohol_checks WHERE id = ?').get(att.clock_in_alcohol_id);
  if (att?.clock_out_alcohol_id) outCheck = db.prepare('SELECT value_mgl, result, checked_at FROM alcohol_checks WHERE id = ?').get(att.clock_out_alcohol_id);
  res.json({
    user: req.user,
    date: todayJst(),
    attendance: att || null,
    clock_in_check: inCheck,
    clock_out_check: outCheck,
    jobs,
    settings: {
      allow_manual_alcohol: s.allow_manual_alcohol === '1',
      tracking_interval_sec: Number(s.tracking_interval_sec),
      max_accuracy_m: Number(s.max_accuracy_m),
      alcohol_threshold_mgl: Number(s.alcohol_threshold_mgl),
      min_stay_minutes: Number(s.min_stay_minutes),
    },
  });
}));

staff.get('/device-reading', wrap((req, res) => {
  const r = latestDeviceReading(req.user.login_id, getSettings());
  res.json(r ? { id: r.id, device_id: r.device_id, value_mgl: r.value_mgl, measured_at: r.measured_at } : null);
}));

staff.post('/clock-in', wrap((req, res) => {
  const s = getSettings();
  const pos = requirePos(req.body);
  if (pos.acc > Number(s.max_accuracy_m)) throw httpError(422, `位置情報の精度が低すぎます（誤差 約${Math.round(pos.acc)}m）。`);
  const existing = todayAttendance(req.user.id);
  if (existing?.clock_in_at) throw httpError(409, '本日はすでに出勤済みです');
  const check = recordAlcoholCheck(req.user, 'clock_in', req.body.alcohol, pos, s);
  if (check.result === 'fail') {
    return res.status(422).json({ error: `アルコールが検知されました（${check.value.toFixed(2)} mg/L）。出勤できません。運転せず、すぐに管理者へ連絡してください。`, alcohol: check });
  }
  db.prepare(`INSERT INTO attendance(user_id, work_date, clock_in_at, clock_in_lat, clock_in_lng, clock_in_acc, clock_in_alcohol_id)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(user_id, work_date) DO UPDATE SET clock_in_at = excluded.clock_in_at, clock_in_lat = excluded.clock_in_lat,
      clock_in_lng = excluded.clock_in_lng, clock_in_acc = excluded.clock_in_acc, clock_in_alcohol_id = excluded.clock_in_alcohol_id`)
    .run(req.user.id, todayJst(), nowIso(), pos.lat, pos.lng, pos.acc, check.id);
  db.prepare('INSERT INTO locations(user_id, lat, lng, acc, recorded_at) VALUES (?,?,?,?,?)').run(req.user.id, pos.lat, pos.lng, pos.acc, nowIso());
  res.json({ ok: true, alcohol: check });
}));

staff.post('/clock-out', wrap((req, res) => {
  const s = getSettings();
  const pos = requirePos(req.body);
  const att = requireOnDuty(req.user.id);
  const check = recordAlcoholCheck(req.user, 'clock_out', req.body.alcohol, pos, s);
  // 退勤時は検知されても退勤自体は記録する（帰宅運転をさせないよう管理者へ通知済み）
  db.prepare(`UPDATE attendance SET clock_out_at = ?, clock_out_lat = ?, clock_out_lng = ?, clock_out_acc = ?, clock_out_alcohol_id = ? WHERE id = ?`)
    .run(nowIso(), pos.lat, pos.lng, pos.acc, check.id, att.id);
  res.json({ ok: true, alcohol: check });
}));

staff.post('/location', wrap((req, res) => {
  const pos = requirePos(req.body);
  const att = todayAttendance(req.user.id);
  if (!att?.clock_in_at || att.clock_out_at) return res.json({ ok: true, recorded: false }); // 勤務時間外は記録しない
  db.prepare('INSERT INTO locations(user_id, lat, lng, acc, recorded_at) VALUES (?,?,?,?,?)').run(req.user.id, pos.lat, pos.lng, pos.acc, nowIso());
  res.json({ ok: true, recorded: true });
}));

function loadOwnJob(req) {
  const job = db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(Number(req.params.id));
  if (!job || (job.assignee_id !== req.user.id && req.user.role !== 'admin')) throw httpError(404, '作業が見つかりません');
  if (job.status === 'cancelled') throw httpError(409, 'この作業は取り消されています');
  return jobView(job);
}

staff.get('/jobs/:id', wrap((req, res) => {
  const job = loadOwnJob(req);
  const report = db.prepare('SELECT * FROM reports WHERE job_id = ?').get(job.id);
  res.json({ job, report: report ? { ...report, checklist: JSON.parse(report.checklist_json) } : null, checklist: CHECKLISTS.types[job.work_type] || null });
}));

staff.post('/jobs/:id/arrive', wrap((req, res) => {
  const s = getSettings();
  const job = loadOwnJob(req);
  requireOnDuty(req.user.id);
  if (job.status === 'completed') throw httpError(409, 'この作業は報告済みです');
  const pos = requirePos(req.body);
  const g = checkGeofence(job, pos, s);
  if (!g.ok) {
    if (g.distance > job.radius_m) addAlert('warning', 'geofence', `${req.user.name} さん：${job.customer_name} の到着操作を現場外（約${g.distance}m）で実行`, req.user.id, job.id);
    return res.status(422).json({ error: g.reason, distance: g.distance, radius_m: job.radius_m });
  }
  if (job.status === 'scheduled') {
    db.prepare(`UPDATE jobs SET status = 'arrived', arrived_at = ?, arrived_lat = ?, arrived_lng = ?, arrived_acc = ?, arrived_distance = ? WHERE id = ?`)
      .run(nowIso(), pos.lat, pos.lng, pos.acc, g.distance, job.id);
  }
  db.prepare('INSERT INTO locations(user_id, lat, lng, acc, recorded_at) VALUES (?,?,?,?,?)').run(req.user.id, pos.lat, pos.lng, pos.acc, nowIso());
  res.json({ ok: true, distance: g.distance });
}));

staff.post('/jobs/:id/scan', wrap((req, res) => {
  const s = getSettings();
  const job = loadOwnJob(req);
  requireOnDuty(req.user.id);
  if (!job.requires_tank || !job.tank_id) throw httpError(400, 'この作業はQR読み取りの対象外です');
  if (job.status === 'scheduled') throw httpError(409, '先に「現場到着」を位置情報で確認してください');
  if (job.status === 'completed') throw httpError(409, 'この作業は報告済みです');
  const pos = requirePos(req.body);
  const g = checkGeofence(job, pos, s);
  if (!g.ok) {
    if (g.distance > job.radius_m) addAlert('warning', 'geofence', `${req.user.name} さん：${job.customer_name} のQR読み取りを現場外（約${g.distance}m）で実行`, req.user.id, job.id);
    return res.status(422).json({ error: g.reason, distance: g.distance });
  }
  const parsed = parseTankQrPayload(req.body.qr);
  if (!parsed) {
    addAlert('warning', 'qr', `${req.user.name} さん：${job.customer_name} で無効なQRコードを読み取り`, req.user.id, job.id);
    throw httpError(422, 'このQRコードは当社の浄化槽QRではありません');
  }
  const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(parsed.tankId);
  if (!tank || !tank.active) throw httpError(422, 'このQRコードの浄化槽は登録されていません');
  if (tank.qr_version !== parsed.version) {
    addAlert('warning', 'qr', `${req.user.name} さん：再発行前の古いQRコードを読み取り（${job.customer_name}）`, req.user.id, job.id);
    throw httpError(422, 'このQRコードは再発行により無効になっています。新しいQRラベルを読み取ってください。');
  }
  if (tank.id !== job.tank_id) {
    addAlert('warning', 'qr', `${req.user.name} さん：${job.customer_name} の作業で別の浄化槽のQRを読み取り`, req.user.id, job.id);
    throw httpError(422, '別の浄化槽のQRコードです。作業対象の浄化槽を確認してください。');
  }
  db.prepare(`UPDATE jobs SET status = 'scanned', scanned_at = ?, scanned_lat = ?, scanned_lng = ?, scanned_acc = ?, scanned_distance = ? WHERE id = ?`)
    .run(nowIso(), pos.lat, pos.lng, pos.acc, g.distance, job.id);
  res.json({ ok: true, distance: g.distance, tank_label: tank.label });
}));

function validateChecklist(def, input) {
  const out = {};
  for (const item of def.items) {
    const raw = input?.[item.key];
    const empty = raw === undefined || raw === null || String(raw).trim() === '';
    if (empty) {
      if (item.required) throw httpError(400, `「${item.label}」を入力してください`);
      continue;
    }
    if (item.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n) || (item.min !== undefined && n < item.min) || (item.max !== undefined && n > item.max)) {
        throw httpError(400, `「${item.label}」の値が範囲外です（${item.min}〜${item.max}）`);
      }
      out[item.key] = n;
    } else if (item.type === 'select') {
      if (!item.options.includes(raw)) throw httpError(400, `「${item.label}」の選択肢が不正です`);
      out[item.key] = raw;
    } else {
      out[item.key] = String(raw).slice(0, 500);
    }
  }
  return out;
}

staff.post('/jobs/:id/report', wrap((req, res) => {
  const s = getSettings();
  const job = loadOwnJob(req);
  requireOnDuty(req.user.id);
  const def = CHECKLISTS.types[job.work_type];
  if (!def) throw httpError(500, '作業種別の定義がありません');
  if (job.status === 'completed') throw httpError(409, 'この作業は報告済みです');
  if (job.status === 'scheduled') throw httpError(409, '先に「現場到着」を位置情報で確認してください');
  if (def.requiresTank && job.status !== 'scanned') throw httpError(409, '浄化槽のQRコードを読み取ってから報告してください');
  const minStay = Number(s.min_stay_minutes);
  const stayedMin = (Date.now() - Date.parse(job.arrived_at)) / 60000;
  if (stayedMin < minStay) {
    throw httpError(409, `到着から${minStay}分経過するまで報告できません（あと約${Math.ceil(minStay - stayedMin)}分）`);
  }
  const pos = requirePos(req.body);
  const g = checkGeofence(job, pos, s);
  if (!g.ok) {
    if (g.distance > job.radius_m) addAlert('warning', 'geofence', `${req.user.name} さん：${job.customer_name} の報告送信を現場外（約${g.distance}m）で実行`, req.user.id, job.id);
    return res.status(422).json({ error: `報告は現場で送信してください。${g.reason}`, distance: g.distance });
  }
  const checklist = validateChecklist(def, req.body.checklist);
  const photos = Array.isArray(req.body.photos) ? req.body.photos : [];
  if (photos.length < def.minPhotos) throw httpError(400, `写真を${def.minPhotos}枚以上添付してください（槽内の状況など）`);
  if (photos.length > 6) throw httpError(400, '写真は6枚までです');
  const comment = String(req.body.comment || '').slice(0, 2000);
  const files = photos.map(savePhotoDataUrl);
  const reportId = tx(() => {
    const r = db.prepare(`INSERT INTO reports(job_id, user_id, checklist_json, comment, lat, lng, acc, distance, submitted_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(job.id, req.user.id, JSON.stringify(checklist), comment, pos.lat, pos.lng, pos.acc, g.distance, nowIso());
    const id = Number(r.lastInsertRowid);
    for (const f of files) {
      db.prepare('INSERT INTO photos(owner_user_id, kind, ref_id, file, created_at) VALUES (?,?,?,?,?)').run(req.user.id, 'report', id, f, nowIso());
    }
    db.prepare(`UPDATE jobs SET status = 'completed', completed_at = ? WHERE id = ?`).run(nowIso(), job.id);
    return id;
  });
  // 異常項目は管理者へ通知
  const abnormal = def.items.filter((it) => it.type === 'select' && checklist[it.key] && checklist[it.key] !== it.options[0]);
  if (abnormal.length) {
    addAlert('info', 'report', `${job.customer_name}：要確認項目あり（${abnormal.map((a) => `${a.label}=${checklist[a.key]}`).join('、')}）`, req.user.id, job.id);
  }
  res.json({ ok: true, report_id: reportId });
}));

app.use('/api/staff', staff);

// ---------- 管理者API ----------
const admin = express.Router();
admin.use(requireAdmin);

admin.get('/dashboard', wrap((req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayJst();
  const users = db.prepare(`SELECT id, login_id, name, role FROM users WHERE active = 1 AND role = 'staff' ORDER BY id`).all();
  const dayStart = new Date(Date.parse(`${date}T00:00:00+09:00`)).toISOString();
  const dayEnd = new Date(Date.parse(`${date}T00:00:00+09:00`) + 86400000).toISOString();
  const staffRows = users.map((u) => {
    const att = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?').get(u.id, date);
    const inCheck = att?.clock_in_alcohol_id ? db.prepare('SELECT * FROM alcohol_checks WHERE id = ?').get(att.clock_in_alcohol_id) : null;
    const outCheck = att?.clock_out_alcohol_id ? db.prepare('SELECT * FROM alcohol_checks WHERE id = ?').get(att.clock_out_alcohol_id) : null;
    const failed = db.prepare(`SELECT * FROM alcohol_checks WHERE user_id = ? AND result = 'fail' AND checked_at >= ? AND checked_at < ? ORDER BY id DESC LIMIT 1`)
      .get(u.id, dayStart, dayEnd);
    const last = db.prepare('SELECT lat, lng, acc, recorded_at FROM locations WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(u.id);
    const jobStats = db.prepare(`SELECT COUNT(*) AS total, SUM(status = 'completed') AS done FROM jobs WHERE assignee_id = ? AND scheduled_date = ? AND status != 'cancelled'`).get(u.id, date);
    return { ...u, attendance: att || null, clock_in_check: inCheck, clock_out_check: outCheck, last_failed_check: failed || null, last_location: last || null, jobs_total: jobStats.total, jobs_done: jobStats.done || 0 };
  });
  const jobs = db.prepare(`${JOB_SELECT} WHERE j.scheduled_date = ? AND j.status != 'cancelled' ORDER BY u.id, j.id`).all(date).map(jobView);
  const alerts = db.prepare(`SELECT a.*, u.name AS user_name FROM alerts a LEFT JOIN users u ON u.id = a.user_id WHERE a.resolved = 0 ORDER BY a.id DESC LIMIT 100`).all();
  const customers = db.prepare('SELECT id, name, address, lat, lng, radius_m FROM customers WHERE active = 1').all();
  res.json({ date, staff: staffRows, jobs, alerts, customers });
}));

admin.post('/alerts/:id/resolve', wrap((req, res) => {
  db.prepare('UPDATE alerts SET resolved = 1 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

admin.get('/locations', wrap((req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayJst();
  const start = new Date(Date.parse(`${date}T00:00:00+09:00`)).toISOString();
  const end = new Date(Date.parse(`${date}T00:00:00+09:00`) + 86400000).toISOString();
  res.json(db.prepare('SELECT lat, lng, acc, recorded_at FROM locations WHERE user_id = ? AND recorded_at >= ? AND recorded_at < ? ORDER BY id')
    .all(Number(req.query.user_id), start, end));
}));

// --- 従業員 ---
admin.get('/users', wrap((_req, res) => {
  res.json(db.prepare('SELECT id, login_id, name, role, phone, active, created_at FROM users ORDER BY active DESC, id').all());
}));
function validateUserInput(b, isNew) {
  const loginId = String(b.login_id || '').trim();
  const name = String(b.name || '').trim();
  const role = b.role === 'admin' ? 'admin' : 'staff';
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(loginId)) throw httpError(400, 'ログインIDは半角英数字3〜32文字で入力してください');
  if (!name) throw httpError(400, '氏名を入力してください');
  if ((isNew || b.password) && String(b.password || '').length < 8) throw httpError(400, 'パスワードは8文字以上にしてください');
  return { loginId, name, role, phone: String(b.phone || '').trim() };
}
admin.post('/users', wrap((req, res) => {
  const v = validateUserInput(req.body, true);
  if (db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(v.loginId)) throw httpError(409, 'そのログインIDは使われています');
  const r = db.prepare('INSERT INTO users(login_id, name, role, phone, password_hash) VALUES (?,?,?,?,?)')
    .run(v.loginId, v.name, v.role, v.phone, hashPassword(req.body.password));
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));
admin.put('/users/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const v = validateUserInput(req.body, false);
  if (db.prepare('SELECT 1 FROM users WHERE login_id = ? AND id != ?').get(v.loginId, id)) throw httpError(409, 'そのログインIDは使われています');
  const active = req.body.active === false || req.body.active === 0 ? 0 : 1;
  if (id === req.user.id && (active === 0 || v.role !== 'admin')) throw httpError(400, '自分自身の管理者権限・有効状態は変更できません');
  db.prepare('UPDATE users SET login_id = ?, name = ?, role = ?, phone = ?, active = ? WHERE id = ?').run(v.loginId, v.name, v.role, v.phone, active, id);
  if (req.body.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), id);
  if (active === 0 || req.body.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  res.json({ ok: true });
}));

// --- 顧客・浄化槽 ---
function validateCustomer(b) {
  const name = String(b.name || '').trim();
  const lat = Number(b.lat); const lng = Number(b.lng);
  const radius = Math.round(Number(b.radius_m || getSettings().default_radius_m));
  if (!name) throw httpError(400, '顧客名を入力してください');
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw httpError(400, '地図で浄化槽の位置を指定してください');
  if (!(radius >= 20 && radius <= 1000)) throw httpError(400, '許容範囲は20〜1000mで指定してください');
  return { name, kana: String(b.kana || '').trim(), address: String(b.address || '').trim(), phone: String(b.phone || '').trim(), lat, lng, radius, notes: String(b.notes || '').trim() };
}
admin.get('/customers', wrap((_req, res) => {
  res.json(db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM tanks t WHERE t.customer_id = c.id AND t.active = 1) AS tank_count
    FROM customers c WHERE c.active = 1 ORDER BY c.kana, c.name`).all());
}));
admin.get('/customers/:id', wrap((req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id));
  if (!c) throw httpError(404, '顧客が見つかりません');
  c.tanks = db.prepare('SELECT * FROM tanks WHERE customer_id = ? AND active = 1 ORDER BY id').all(c.id);
  res.json(c);
}));
admin.post('/customers', wrap((req, res) => {
  const v = validateCustomer(req.body);
  const r = db.prepare('INSERT INTO customers(name, kana, address, phone, lat, lng, radius_m, notes) VALUES (?,?,?,?,?,?,?,?)')
    .run(v.name, v.kana, v.address, v.phone, v.lat, v.lng, v.radius, v.notes);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));
admin.put('/customers/:id', wrap((req, res) => {
  const v = validateCustomer(req.body);
  db.prepare('UPDATE customers SET name = ?, kana = ?, address = ?, phone = ?, lat = ?, lng = ?, radius_m = ?, notes = ? WHERE id = ?')
    .run(v.name, v.kana, v.address, v.phone, v.lat, v.lng, v.radius, v.notes, Number(req.params.id));
  res.json({ ok: true });
}));
admin.post('/customers/:id/archive', wrap((req, res) => {
  db.prepare('UPDATE customers SET active = 0 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));
admin.post('/customers/:id/tanks', wrap((req, res) => {
  const label = String(req.body.label || '').trim();
  if (!label) throw httpError(400, '浄化槽の名称を入力してください');
  if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(Number(req.params.id))) throw httpError(404, '顧客が見つかりません');
  const r = db.prepare('INSERT INTO tanks(customer_id, label, model, capacity) VALUES (?,?,?,?)')
    .run(Number(req.params.id), label, String(req.body.model || '').trim(), String(req.body.capacity || '').trim());
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));
admin.put('/tanks/:id', wrap((req, res) => {
  const label = String(req.body.label || '').trim();
  if (!label) throw httpError(400, '浄化槽の名称を入力してください');
  db.prepare('UPDATE tanks SET label = ?, model = ?, capacity = ? WHERE id = ?')
    .run(label, String(req.body.model || '').trim(), String(req.body.capacity || '').trim(), Number(req.params.id));
  res.json({ ok: true });
}));
admin.post('/tanks/:id/archive', wrap((req, res) => {
  db.prepare('UPDATE tanks SET active = 0 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));
admin.post('/tanks/:id/reissue-qr', wrap((req, res) => {
  db.prepare('UPDATE tanks SET qr_version = qr_version + 1 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));
// QRラベル印刷用データ
admin.get('/qr-labels', wrap(async (req, res) => {
  const ids = String(req.query.tank_ids || '').split(',').map(Number).filter(Boolean);
  const rows = ids.length
    ? db.prepare(`SELECT t.*, c.name AS customer_name, c.address FROM tanks t JOIN customers c ON c.id = t.customer_id WHERE t.id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : db.prepare(`SELECT t.*, c.name AS customer_name, c.address FROM tanks t JOIN customers c ON c.id = t.customer_id WHERE t.customer_id = ? AND t.active = 1`).all(Number(req.query.customer_id));
  const out = [];
  for (const t of rows) {
    const payload = makeTankQrPayload(t.id, t.qr_version);
    const svg = await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    out.push({ tank_id: t.id, label: t.label, model: t.model, capacity: t.capacity, customer_name: t.customer_name, address: t.address, qr_version: t.qr_version, payload, svg });
  }
  res.json(out);
}));

// --- 作業予定 ---
function validateJob(b) {
  const customerId = Number(b.customer_id);
  const assigneeId = Number(b.assignee_id);
  const date = String(b.scheduled_date || '');
  const workType = String(b.work_type || '');
  const def = CHECKLISTS.types[workType];
  if (!db.prepare('SELECT 1 FROM customers WHERE id = ? AND active = 1').get(customerId)) throw httpError(400, '顧客を選択してください');
  if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(assigneeId)) throw httpError(400, '担当者を選択してください');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, '作業日を指定してください');
  if (!def) throw httpError(400, '作業種別を選択してください');
  let tankId = b.tank_id ? Number(b.tank_id) : null;
  if (tankId && !db.prepare('SELECT 1 FROM tanks WHERE id = ? AND customer_id = ? AND active = 1').get(tankId, customerId)) throw httpError(400, '浄化槽がこの顧客のものではありません');
  if (def.requiresTank && !tankId) throw httpError(400, `「${workType}」は対象の浄化槽を選択してください（QR読み取りに使います）`);
  if (!def.requiresTank && !tankId) tankId = null;
  return { customerId, assigneeId, date, workType, tankId, memo: String(b.memo || '').trim() };
}
admin.get('/jobs', wrap((req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : todayJst();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : from;
  res.json(db.prepare(`${JOB_SELECT} WHERE j.scheduled_date BETWEEN ? AND ? ORDER BY j.scheduled_date, u.id, j.id`).all(from, to).map(jobView));
}));
admin.post('/jobs', wrap((req, res) => {
  const v = validateJob(req.body);
  const r = db.prepare('INSERT INTO jobs(customer_id, tank_id, assignee_id, scheduled_date, work_type, memo) VALUES (?,?,?,?,?,?)')
    .run(v.customerId, v.tankId, v.assigneeId, v.date, v.workType, v.memo);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));
admin.put('/jobs/:id', wrap((req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(req.params.id));
  if (!job) throw httpError(404, '作業が見つかりません');
  if (job.status !== 'scheduled') throw httpError(409, '着手済みの作業は変更できません');
  const v = validateJob(req.body);
  db.prepare('UPDATE jobs SET customer_id = ?, tank_id = ?, assignee_id = ?, scheduled_date = ?, work_type = ?, memo = ? WHERE id = ?')
    .run(v.customerId, v.tankId, v.assigneeId, v.date, v.workType, v.memo, job.id);
  res.json({ ok: true });
}));
admin.post('/jobs/:id/cancel', wrap((req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(req.params.id));
  if (!job) throw httpError(404, '作業が見つかりません');
  if (job.status === 'completed') throw httpError(409, '報告済みの作業は取り消せません');
  db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ?`).run(job.id);
  res.json({ ok: true });
}));

// --- 作業報告 ---
admin.get('/reports', wrap((req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : todayJst();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : from;
  res.json(db.prepare(`${JOB_SELECT.replace('SELECT j.*', 'SELECT j.*, r.id AS report_id, r.submitted_at, r.distance AS report_distance')}
    JOIN reports r ON r.job_id = j.id WHERE j.scheduled_date BETWEEN ? AND ? ORDER BY r.submitted_at DESC`).all(from, to));
}));
admin.get('/reports/:jobId', wrap((req, res) => {
  const job = db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(Number(req.params.jobId));
  if (!job) throw httpError(404, '作業が見つかりません');
  const report = db.prepare('SELECT * FROM reports WHERE job_id = ?').get(job.id);
  const photos = report ? db.prepare(`SELECT file FROM photos WHERE kind = 'report' AND ref_id = ?`).all(report.id).map((p) => `/uploads/${p.file}`) : [];
  res.json({ job: jobView(job), report: report ? { ...report, checklist: JSON.parse(report.checklist_json) } : null, photos, checklist: CHECKLISTS.types[job.work_type] || null });
}));

// --- 勤怠・アルコール記録 ---
function rangeQuery(req) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : todayJst();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : from;
  return { from, to };
}
function attendanceRows(from, to) {
  return db.prepare(`
    SELECT a.*, u.name, u.login_id,
      ci.value_mgl AS in_value, ci.result AS in_result, ci.source AS in_source, ci.device_id AS in_device,
      co.value_mgl AS out_value, co.result AS out_result, co.source AS out_source, co.device_id AS out_device
    FROM attendance a JOIN users u ON u.id = a.user_id
    LEFT JOIN alcohol_checks ci ON ci.id = a.clock_in_alcohol_id
    LEFT JOIN alcohol_checks co ON co.id = a.clock_out_alcohol_id
    WHERE a.work_date BETWEEN ? AND ? ORDER BY a.work_date DESC, u.id`).all(from, to);
}
function alcoholRows(from, to) {
  const start = new Date(Date.parse(`${from}T00:00:00+09:00`)).toISOString();
  const end = new Date(Date.parse(`${to}T00:00:00+09:00`) + 86400000).toISOString();
  return db.prepare(`SELECT ac.*, u.name, u.login_id,
      (SELECT file FROM photos p WHERE p.kind = 'alcohol' AND p.ref_id = ac.id LIMIT 1) AS photo
    FROM alcohol_checks ac JOIN users u ON u.id = ac.user_id
    WHERE ac.checked_at >= ? AND ac.checked_at < ? ORDER BY ac.checked_at DESC`).all(start, end);
}
admin.get('/attendance', wrap((req, res) => {
  const { from, to } = rangeQuery(req);
  res.json({ attendance: attendanceRows(from, to), alcohol: alcoholRows(from, to) });
}));
function csvSend(res, filename, header, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(`﻿${body}\r\n`); // BOM付き：Excelで文字化けしない
}
const srcLabel = (s) => (s === 'device' ? '検知器連携' : s === 'manual' ? '手入力（写真あり）' : '');
admin.get('/attendance.csv', wrap((req, res) => {
  const { from, to } = rangeQuery(req);
  csvSend(res, `勤怠_${from}_${to}.csv`,
    ['日付', '氏名', 'ログインID', '出勤時刻', '出勤時アルコール(mg/L)', '判定', '退勤時刻', '退勤時アルコール(mg/L)', '判定', '出勤位置', '退勤位置'],
    attendanceRows(from, to).map((a) => [a.work_date, a.name, a.login_id, fmtJst(a.clock_in_at), a.in_value?.toFixed(2), a.in_result === 'pass' ? '合格' : a.in_result ? '不合格' : '',
      fmtJst(a.clock_out_at), a.out_value?.toFixed(2), a.out_result === 'pass' ? '合格' : a.out_result ? '不合格' : '',
      a.clock_in_lat ? `${a.clock_in_lat.toFixed(6)} ${a.clock_in_lng.toFixed(6)}` : '', a.clock_out_lat ? `${a.clock_out_lat.toFixed(6)} ${a.clock_out_lng.toFixed(6)}` : '']));
}));
admin.get('/alcohol.csv', wrap((req, res) => {
  const { from, to } = rangeQuery(req);
  csvSend(res, `アルコールチェック記録簿_${from}_${to}.csv`,
    ['確認日時', '運転者（氏名）', 'ログインID', '区分', '確認方法', '検知器ID', '測定値(mg/L)', '酒気帯びの有無', '確認位置', '確認者'],
    alcoholRows(from, to).map((r) => [fmtJst(r.checked_at), r.name, r.login_id, r.kind === 'clock_in' ? '出勤（運転前）' : '退勤（運転後）',
      srcLabel(r.source), r.device_id || '', r.value_mgl.toFixed(2), r.result === 'pass' ? '無' : '有',
      r.lat ? `${r.lat.toFixed(6)} ${r.lng.toFixed(6)}` : '', 'システム自動判定']));
}));

// --- 設定 ---
const EDITABLE_SETTINGS = ['alcohol_threshold_mgl', 'allow_manual_alcohol', 'device_reading_valid_minutes', 'default_radius_m', 'max_accuracy_m', 'min_stay_minutes', 'tracking_interval_sec'];
admin.get('/settings', wrap((_req, res) => res.json(getSettings())));
admin.put('/settings', wrap((req, res) => {
  const limits = {
    alcohol_threshold_mgl: [0, 0.5], device_reading_valid_minutes: [1, 60], default_radius_m: [20, 1000],
    max_accuracy_m: [10, 500], min_stay_minutes: [0, 120], tracking_interval_sec: [15, 600], allow_manual_alcohol: [0, 1],
  };
  for (const k of EDITABLE_SETTINGS) {
    if (req.body[k] === undefined) continue;
    const n = Number(req.body[k]);
    const [lo, hi] = limits[k];
    if (!Number.isFinite(n) || n < lo || n > hi) throw httpError(400, `${k} は ${lo}〜${hi} の範囲で指定してください`);
    setSetting(k, k === 'alcohol_threshold_mgl' ? n.toFixed(2) : String(Math.round(n)));
  }
  res.json(getSettings());
}));
admin.post('/settings/regenerate-device-key', wrap((_req, res) => {
  setSetting('device_api_key', crypto.randomBytes(24).toString('base64url'));
  res.json(getSettings());
}));
// 検知器を導入するまでの動作確認用（検知器APIと同じ処理を管理画面から呼ぶ）
admin.post('/device-simulate', wrap((req, res) => {
  res.status(201).json(insertDeviceReading({ ...req.body, device_id: req.body.device_id || 'SIMULATOR-01' }));
}));

app.use('/api/admin', admin);

// ---------- 写真（認可付き配信） ----------
app.get('/uploads/:file', requireLogin, wrap((req, res) => {
  const file = path.basename(req.params.file);
  const photo = db.prepare('SELECT * FROM photos WHERE file = ?').get(file);
  if (!photo || (req.user.role !== 'admin' && photo.owner_user_id !== req.user.id)) throw httpError(404, 'Not found');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(DATA_DIR, 'uploads', file));
}));

// ---------- 画面 ----------
const PUB = path.join(__dirname, '..', 'public');
app.use('/vendor/jsQR.js', (_req, res) => res.sendFile(require.resolve('jsqr/dist/jsQR.js')));
app.use('/vendor/leaflet', express.static(path.join(path.dirname(require.resolve('leaflet/package.json')), 'dist')));
app.get('/staff', (_req, res) => res.sendFile(path.join(PUB, 'staff.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(PUB, 'admin.html')));
app.get('/admin/qr-print', (_req, res) => res.sendFile(path.join(PUB, 'qr-print.html')));
app.use(express.static(PUB, { index: 'index.html' }));

// ---------- エラーハンドラ ----------
app.use('/api', (_req, _res, next) => next(httpError(404, 'APIが見つかりません')));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error(err);
  const message = status >= 500 && !err.status ? 'サーバでエラーが発生しました' : err.message;
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return res.status(status).json({ error: message, ...(err.extra || {}) });
  res.status(status).send(message);
});

// ---------- 起動 ----------
function start() {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  if (process.env.HTTPS_KEY && process.env.HTTPS_CERT) {
    const https = require('node:https');
    https.createServer({ key: fs.readFileSync(process.env.HTTPS_KEY), cert: fs.readFileSync(process.env.HTTPS_CERT) }, app)
      .listen(port, host, () => console.log(`作業管理システム起動: https://${host}:${port}`));
  } else {
    app.listen(port, host, () => console.log(`作業管理システム起動: http://${host}:${port}`));
  }
}
if (require.main === module) {
  const { ensureInitialAdmin } = require('./seed');
  ensureInitialAdmin();
  start();
}

module.exports = { app, start };
