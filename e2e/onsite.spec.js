const { test, expect, devices } = require('@playwright/test');
const { OFFICE, adminApi, ok, createScenario, makeQrVideo, launchPhoneWithCamera, loginUi, clockInViaApi, dummyPhoto } = require('./helpers');

test.use({ geolocation: OFFICE, permissions: ['geolocation'] });

const FULL_CHECKLIST = { odor: '異常なし', effluent: '透明', transparency: 30, ph: 7.0, chlorine: 0.5, disinfectant: '補充済', blower: '正常', scum: '適正', water_level: '正常', damage: 'なし', insects: 'なし' };

test.describe('現場到着（位置情報）とQR点検', () => {
  test('現場から約5km離れた場所で到着ボタン → 拒否され、QR読み取りも押せないまま', async ({ page }) => {
    const api = await adminApi();
    const sc = await createScenario(api);
    await loginUi(page, sc.login, sc.password);
    await expect(page.getByText('未出勤')).toBeVisible();
    await clockInViaApi(page, api, sc.login);
    await page.goto(`/staff#job/${sc.jobId}`);
    await page.getByRole('button', { name: '現在地で到着を確認' }).click();
    await expect(page.locator('#arriveMsg')).toContainText('離れています');
    await expect(page.locator('#jobStatus')).toHaveText('未着手');
    await expect(page.getByRole('button', { name: '蓋を開けてQRを読み取る' })).toBeDisabled();
  });

  test('現場にいても位置精度が悪い（誤差300m）と到着できない', async ({ page, context }) => {
    const api = await adminApi();
    const sc = await createScenario(api);
    await loginUi(page, sc.login, sc.password);
    await expect(page.getByText('未出勤')).toBeVisible();
    await clockInViaApi(page, api, sc.login);
    await context.setGeolocation({ ...sc.site, accuracy: 300 });
    await page.goto(`/staff#job/${sc.jobId}`);
    await page.getByRole('button', { name: '現在地で到着を確認' }).click();
    await expect(page.locator('#arriveMsg')).toContainText('精度が低すぎます');
    await expect(page.locator('#jobStatus')).toHaveText('未着手');
  });

  test('現場到着 → 蓋裏のQRをカメラで読み取り → 点検記録と写真 → 現場で報告送信 → 管理画面で報告・距離・写真を確認できる', async () => {
    const api = await adminApi();
    const sc = await createScenario(api);
    const video = await makeQrVideo(sc.qrPayload);
    const { browser, context } = await launchPhoneWithCamera(video, OFFICE);
    try {
      const page = await context.newPage();
      await loginUi(page, sc.login, sc.password);
      await expect(page.getByText('未出勤')).toBeVisible();
      await clockInViaApi(page, api, sc.login);
      await page.goto(`/staff#job/${sc.jobId}`);
      await expect(page.getByRole('button', { name: '蓋を開けてQRを読み取る' })).toBeDisabled();
      await expect(page.getByText('QRコードを読み取ると入力できます。')).toBeVisible();

      // 現場へ移動して到着
      await context.setGeolocation(sc.site);
      await page.getByRole('button', { name: '現在地で到着を確認' }).click();
      await expect(page.locator('#jobStatus')).toHaveText('到着済');

      // QR読み取り（偽カメラにQRが映っている）
      await page.getByRole('button', { name: '蓋を開けてQRを読み取る' }).click();
      await expect(page.locator('#jobStatus')).toHaveText('QR確認済', { timeout: 15_000 });
      await expect(page.locator('#scanner')).toBeHidden();

      // 必須項目が空のまま送信 → 案内が出て送信されない
      await page.getByRole('button', { name: '現場で報告を送信' }).click();
      await expect(page.getByText('「臭気」を入力してください')).toBeVisible();

      await page.getByLabel('臭気').selectOption('異常なし');
      await page.getByLabel('放流水の外観').selectOption('透明');
      await page.getByLabel('透視度（cm）').fill('30');
      await page.getByLabel('pH').fill('7.0');
      await page.getByLabel('残留塩素（mg/L）').fill('0.5');
      await page.getByLabel('消毒剤').selectOption('補充済');
      await page.getByLabel('ブロワ稼働').selectOption('異音あり');
      await page.getByLabel('スカム・汚泥').selectOption('適正');
      await page.getByLabel('槽内水位').selectOption('正常');
      await page.getByLabel('破損・漏水').selectOption('なし');
      await page.getByLabel('害虫の発生').selectOption('なし');

      // 写真なしでは送信できない
      await page.getByRole('button', { name: '現場で報告を送信' }).click();
      await expect(page.getByText('写真を1枚以上添付してください')).toBeVisible();

      await page.getByLabel(/写真（槽内の状況など）/).setInputFiles({ name: 'inside.png', mimeType: 'image/png', buffer: await dummyPhoto() });
      await expect(page.locator('#photoGrid img')).toHaveCount(1);
      await page.getByLabel(/特記事項/).fill('ブロワ異音のため次回交換を提案');
      await page.getByRole('button', { name: '現場で報告を送信' }).click();
      await expect(page.locator('#jobStatus')).toHaveText('報告済');
      await expect(page.getByText('この作業は報告済みです。')).toBeVisible();

      // 管理画面で確認
      const adminCtx = await browser.newContext({ ...devices['Desktop Chrome'], locale: 'ja-JP', timezoneId: 'Asia/Tokyo', baseURL: 'http://localhost:3100' });
      const adminPage = await adminCtx.newPage();
      await loginUi(adminPage, 'admin', 'admin1234');
      await expect(adminPage.locator('#alerts')).toContainText(`${sc.customerName}：要確認項目あり（ブロワ稼働=異音あり）`);
      await adminPage.getByRole('link', { name: '作業報告' }).click();
      await adminPage.getByRole('row').filter({ hasText: sc.customerName }).click();
      const dialog = adminPage.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: '点検結果' })).toBeVisible();
      await expect(dialog).toContainText('異音あり');
      await expect(dialog).toContainText('ブロワ異音のため次回交換を提案');
      await expect(dialog).toContainText('QR読み取り：');
      await expect(dialog.getByRole('img', { name: '報告写真' })).toHaveCount(1);
      // 写真は認可付きで配信される（管理者は見られる）
      const src = await dialog.getByRole('img', { name: '報告写真' }).getAttribute('src');
      expect((await adminPage.request.get(src)).status()).toBe(200);
      await adminCtx.close();
    } finally {
      await browser.close();
    }
  });

  test('別の浄化槽のQRを読み取る → 拒否され、管理者にアラートが出る', async () => {
    const api = await adminApi();
    const sc = await createScenario(api);
    const otherTank = await createScenario(api);
    const video = await makeQrVideo(otherTank.qrPayload);
    const { browser, context } = await launchPhoneWithCamera(video, sc.site);
    try {
      const page = await context.newPage();
      await loginUi(page, sc.login, sc.password);
      await expect(page.getByText('未出勤')).toBeVisible();
      await clockInViaApi(page, api, sc.login);
      await page.goto(`/staff#job/${sc.jobId}`);
      await page.getByRole('button', { name: '現在地で到着を確認' }).click();
      await expect(page.locator('#jobStatus')).toHaveText('到着済');
      await page.getByRole('button', { name: '蓋を開けてQRを読み取る' }).click();
      await expect(page.locator('#scanMsg')).toHaveText('別の浄化槽のQRコードです。作業対象の浄化槽を確認してください。', { timeout: 15_000 });
      await page.getByRole('button', { name: 'やめる' }).click();
      await expect(page.locator('#jobStatus')).toHaveText('到着済');
      const dash = await ok(api.get('/api/admin/dashboard'));
      expect(dash.alerts.some((a) => a.job_id === sc.jobId && a.message.includes('別の浄化槽のQR'))).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test('QRを再発行すると古いQRラベルは読み取っても無効になる', async ({ page }) => {
    const api = await adminApi();
    const sc = await createScenario(api);
    await loginUi(page, sc.login, sc.password);
    await expect(page.getByText('未出勤')).toBeVisible();
    await clockInViaApi(page, api, sc.login);
    const pos = { lat: sc.site.latitude, lng: sc.site.longitude, acc: 8 };
    await ok(page.request.post(`/api/staff/jobs/${sc.jobId}/arrive`, { data: pos }));
    await ok(api.post(`/api/admin/tanks/${sc.tankId}/reissue-qr`, { data: {} }));
    const r = await page.request.post(`/api/staff/jobs/${sc.jobId}/scan`, { data: { ...pos, qr: sc.qrPayload } });
    expect(r.status()).toBe(422);
    expect((await r.json()).error).toContain('再発行により無効');
    // 改ざんしたQR（槽IDだけ書き換え）も無効
    const forged = sc.qrPayload.replace(/^JKQR1\.\d+\./, `JKQR1.${sc.tankId + 1}.`);
    expect((await page.request.post(`/api/staff/jobs/${sc.jobId}/scan`, { data: { ...pos, qr: forged } })).status()).toBe(422);
  });

  test('QRを読む前・現場外・最低滞在時間前は、報告をAPIで直接送っても受け付けない', async ({ page }) => {
    const api = await adminApi();
    const sc = await createScenario(api);
    await loginUi(page, sc.login, sc.password);
    await expect(page.getByText('未出勤')).toBeVisible();
    await clockInViaApi(page, api, sc.login);
    const onsite = { lat: sc.site.latitude, lng: sc.site.longitude, acc: 8 };
    const body = { ...onsite, checklist: FULL_CHECKLIST, photos: [`data:image/png;base64,${(await dummyPhoto()).toString('base64')}`] };

    await ok(page.request.post(`/api/staff/jobs/${sc.jobId}/arrive`, { data: onsite }));
    const noQr = await page.request.post(`/api/staff/jobs/${sc.jobId}/report`, { data: body });
    expect(noQr.status()).toBe(409);
    expect((await noQr.json()).error).toContain('QRコードを読み取ってから');

    await ok(page.request.post(`/api/staff/jobs/${sc.jobId}/scan`, { data: { ...onsite, qr: sc.qrPayload } }));
    const far = await page.request.post(`/api/staff/jobs/${sc.jobId}/report`, { data: { ...body, lat: OFFICE.latitude, lng: OFFICE.longitude } });
    expect(far.status()).toBe(422);
    expect((await far.json()).error).toContain('報告は現場で送信してください');

    await ok(api.put('/api/admin/settings', { data: { min_stay_minutes: 5 } }));
    try {
      const early = await page.request.post(`/api/staff/jobs/${sc.jobId}/report`, { data: body });
      expect(early.status()).toBe(409);
      expect((await early.json()).error).toContain('経過するまで報告できません');
    } finally {
      await ok(api.put('/api/admin/settings', { data: { min_stay_minutes: 0 } }));
    }
    await ok(page.request.post(`/api/staff/jobs/${sc.jobId}/report`, { data: body }));
  });
});
