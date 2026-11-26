'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./db');

// ---------- 秘密鍵（QR署名・その他） ----------
// 環境変数 APP_SECRET が無ければ data/secret.key を自動生成して永続化する。
function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}
const SECRET = loadSecret();

// ---------- パスワード ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const calc = crypto.scryptSync(pw, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === calc.length && crypto.timingSafeEqual(calc, expected);
}

// ---------- 浄化槽QRコード ----------
// QRの中身: "JKQR1.<tankId>.<version>.<署名>"
// 署名は サーバ秘密鍵 で HMAC したもの。槽ID を書き換えた偽QRや、
// 再発行（version+1）で無効化した古いQRは読み取っても受け付けない。
function qrSignature(tankId, version) {
  return crypto.createHmac('sha256', SECRET).update(`tank:${tankId}:v${version}`).digest('base64url').slice(0, 22);
}
function makeTankQrPayload(tankId, version) {
  return `JKQR1.${tankId}.${version}.${qrSignature(tankId, version)}`;
}
function parseTankQrPayload(text) {
  const m = /^JKQR1\.(\d+)\.(\d+)\.([A-Za-z0-9_-]{22})$/.exec(String(text || '').trim());
  if (!m) return null;
  const tankId = Number(m[1]);
  const version = Number(m[2]);
  const sig = m[3];
  const expected = qrSignature(tankId, version);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return { tankId, version };
}

// ---------- 位置 ----------
/** 2点間の距離(m)。ハバーサイン公式 */
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** クライアントから届いた位置情報の妥当性チェック。不正なら null */
function parsePosition(body) {
  const lat = Number(body?.lat);
  const lng = Number(body?.lng);
  const acc = Number(body?.acc);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, acc: Number.isFinite(acc) && acc >= 0 ? acc : 9999 };
}

// ---------- 日時（日本時間） ----------
function nowIso() {
  return new Date().toISOString();
}
/** 日本時間の YYYY-MM-DD */
function todayJst(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(d);
}
function fmtJst(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(iso));
}

// ---------- 写真保存 ----------
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
/** data:image/jpeg;base64,... を保存してファイル名を返す */
function savePhotoDataUrl(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw httpError(400, '写真データの形式が正しくありません');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_PHOTO_BYTES) throw httpError(400, '写真のサイズが大きすぎます（4MBまで）');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(DATA_DIR, 'uploads', name), buf);
  return name;
}

function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

module.exports = {
  SECRET, hashPassword, verifyPassword,
  makeTankQrPayload, parseTankQrPayload,
  distanceM, parsePosition,
  nowIso, todayJst, fmtJst,
  savePhotoDataUrl, httpError,
};
