// E2Eテスト用の共通処理
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const QRCode = require('qrcode');
const { chromium, request: pwRequest, devices } = require('@playwright/test');

const BASE = 'http://localhost:3100';
// 事務所（出勤場所）と、現場から約5km離れた地点
const OFFICE = { latitude: 40.2300, longitude: 141.2700, accuracy: 10 };
let seq = Date.now() % 1000000;

const todayJst = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());

/** 管理者としてログイン済みの API クライアント */
async function adminApi() {
  const api = await pwRequest.newContext({ baseURL: BASE });
  const r = await api.post('/api/login', { data: { login_id: 'admin', password: 'admin1234' } });
  if (!r.ok()) throw new Error('admin login failed');
  return api;
}

async function ok(resPromise) {
  const r = await resPromise;
  if (!r.ok()) throw new Error(`${r.url()} -> ${r.status()} ${await r.text()}`);
  return r.json();
}

/**
 * テスト専用の作業員・顧客・浄化槽・本日の作業を1セット作る。
 * 顧客位置は他テストと重ならないよう少しずつずらす。
 */
async function createScenario(api, { workType = '保守点検', radius = 100 } = {}) {
  const n = ++seq;
  const login = `e2e${n}`;
  const password = 'password123';
  const user = await ok(api.post('/api/admin/users', { data: { login_id: login, name: `テスト作業員${n}`, role: 'staff', password } }));
  const site = { latitude: 40.20 + (n % 50) * 0.001, longitude: 141.29, accuracy: 8 };
  const customerName = `E2E顧客${n}`;
  const customer = await ok(api.post('/api/admin/customers', { data: { name: customerName, address: '岩手県二戸郡一戸町（テスト）', lat: site.latitude, lng: site.longitude, radius_m: radius } }));
  const tank = await ok(api.post(`/api/admin/customers/${customer.id}/tanks`, { data: { label: `テスト浄化槽${n}`, capacity: '5人槽' } }));
  const job = await ok(api.post('/api/admin/jobs', { data: { customer_id: customer.id, tank_id: tank.id, assignee_id: user.id, scheduled_date: todayJst(), work_type: workType } }));
  const [label] = await ok(api.get(`/api/admin/qr-labels?tank_ids=${tank.id}`));
  return { login, password, userId: user.id, customerId: customer.id, customerName, tankId: tank.id, jobId: job.id, site, qrPayload: label.payload };
}

async function deviceKey(api) {
  return (await ok(api.get('/api/admin/settings'))).device_api_key;
}

/** 検知器APIへ測定値を送る（検知器メーカー側クラウドの代わり） */
async function pushDeviceReading(api, login, value) {
  const key = await deviceKey(api);
  const r = await api.post('/api/device/alcohol', { headers: { 'X-Device-Key': key }, data: { device_id: 'TEST-ALC', login_id: login, value_mgl: value } });
  if (r.status() !== 201) throw new Error(`device api ${r.status()}`);
}

/**
 * QRコードを映した偽カメラ映像（y4m）を作る。
 * Chromium は日本語を含むパスの映像ファイルを開けないため、ASCII の一時パスに書き出す。
 */
function makeQrVideo(payload) {
  const file = path.join(os.tmpdir(), `johkasou-qr-${process.pid}-${++seq}.y4m`);
  const png = file.replace(/\.y4m$/, '.png');
  return QRCode.toFile(png, payload, { width: 360, margin: 4 }).then(() => {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', png, '-t', '2', '-r', '10',
      '-vf', 'pad=640:480:(ow-iw)/2:(oh-ih)/2:white,format=yuv420p', file]);
    return file;
  });
}

/** 偽カメラ付きのスマホブラウザを起動 */
async function launchPhoneWithCamera(videoFile, geolocation) {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${videoFile}`],
  });
  const context = await browser.newContext({
    ...devices['Pixel 7'], baseURL: BASE, locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
    geolocation, permissions: ['geolocation', 'camera'],
  });
  return { browser, context };
}

async function loginUi(page, login, password) {
  await page.goto('/');
  await page.getByLabel('ログインID').fill(login);
  await page.getByLabel('パスワード').fill(password);
  await page.getByRole('button', { name: 'ログイン' }).click();
}

/** UIを使わずに出勤を済ませる（出勤そのものを検証しないテスト用） */
async function clockInViaApi(page, api, login) {
  await pushDeviceReading(api, login, 0);
  const reading = await ok(page.request.get('/api/staff/device-reading'));
  await ok(page.request.post('/api/staff/clock-in', { data: { lat: OFFICE.latitude, lng: OFFICE.longitude, acc: 10, alcohol: { source: 'device', reading_id: reading.id } } }));
}

/** ダミー写真（PNG） */
const dummyPhoto = () => QRCode.toBuffer('photo', { width: 200 });

module.exports = { BASE, OFFICE, todayJst, adminApi, ok, createScenario, pushDeviceReading, deviceKey, makeQrVideo, launchPhoneWithCamera, loginUi, clockInViaApi, dummyPhoto };
