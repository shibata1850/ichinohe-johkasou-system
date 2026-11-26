const { test, expect, devices } = require('@playwright/test');
const { OFFICE, todayJst, adminApi, createScenario, pushDeviceReading, loginUi, clockInViaApi, dummyPhoto } = require('./helpers');

test.use({ geolocation: OFFICE, permissions: ['geolocation'] });

test.describe('アルコールチェック付き出退勤', () => {
  test('管理画面の検知器シミュレーターで0.00を送信 → 作業員が取り込んで出勤でき、ホームに勤務中・合格と表示される', async ({ page, browser }) => {
    const api = await adminApi();
    const sc = await createScenario(api);

    // 管理者：検知器シミュレーターから測定結果を送る
    const adminCtx = await browser.newContext({ ...devices['Desktop Chrome'], locale: 'ja-JP' });
    const adminPage = await adminCtx.newPage();
    await loginUi(adminPage, 'admin', 'admin1234');
    await adminPage.getByRole('link', { name: '設定' }).click();
    await adminPage.getByLabel('従業員').selectOption(sc.login);
    await adminPage.getByLabel('測定値（mg/L）').fill('0.00');
    await adminPage.getByRole('button', { name: '測定結果を送信' }).click();
    await expect(adminPage.getByText('測定結果を送信しました')).toBeVisible();
    await adminCtx.close();

    // 作業員：出勤
    await loginUi(page, sc.login, sc.password);
    await expect(page.getByText('未出勤')).toBeVisible();
    await page.getByRole('link', { name: '出勤する（アルコールチェック）' }).click();
    await expect(page.getByRole('button', { name: 'この結果で出勤する' })).toBeDisabled();
    await page.getByRole('button', { name: '検知器の測定結果を取り込む' }).click();
    await expect(page.locator('#deviceResult')).toContainText('0.00 mg/L');
    await page.getByRole('button', { name: 'この結果で出勤する' }).click();
    await expect(page.getByText('合格・出勤しました')).toBeVisible();
    await page.getByRole('link', { name: '今日の作業へ' }).click();
    await expect(page.getByText('勤務中', { exact: true })).toBeVisible();
    await expect(page.locator('#jobList')).toContainText(sc.customerName);
  });

  test('アルコール0.15mg/L検知 → 出勤できず赤画面、管理ダッシュボードに「出勤不可」と危険アラートが出る', async ({ page, browser }) => {
    const api = await adminApi();
    const sc = await createScenario(api);
    await pushDeviceReading(api, sc.login, 0.15);

    await loginUi(page, sc.login, sc.password);
    await page.getByRole('link', { name: '出勤する（アルコールチェック）' }).click();
    await page.getByRole('button', { name: '検知器の測定結果を取り込む' }).click();
    await page.getByRole('button', { name: 'この結果で出勤する' }).click();
    await expect(page.getByText('アルコール検知', { exact: true })).toBeVisible();
    await expect(page.locator('.status-big .value')).toHaveText('0.15 mg/L');
    await expect(page.getByText('管理者に通知されました')).toBeVisible();

    // 出勤していないので作業APIは拒否される
    expect((await page.request.post(`/api/staff/jobs/${sc.jobId}/arrive`, { data: { lat: sc.site.latitude, lng: sc.site.longitude, acc: 5 } })).status()).toBe(403);

    const adminCtx = await browser.newContext({ ...devices['Desktop Chrome'], locale: 'ja-JP' });
    const adminPage = await adminCtx.newPage();
    await loginUi(adminPage, 'admin', 'admin1234');
    await expect(adminPage.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
    // 従業員表の行（「軌跡」ボタンがある行）
    const row = adminPage.getByRole('row').filter({ hasText: `テスト作業員${sc.login.slice(3)}` }).filter({ has: adminPage.getByRole('button', { name: '軌跡' }) });
    await expect(row).toContainText('アルコール検知・出勤不可');
    await expect(adminPage.locator('#alerts')).toContainText('アルコール検知 0.15 mg/L');
    await adminCtx.close();
  });

  test('検知器と連携できない場合の手入力 → 写真が無いと使えず、顔と表示の写真を付けると出勤できる', async ({ page }) => {
    const api = await adminApi();
    const sc = await createScenario(api);
    await loginUi(page, sc.login, sc.password);
    await page.getByRole('link', { name: '出勤する（アルコールチェック）' }).click();
    await page.getByText('検知器と連携できない場合（手入力＋写真）').click();
    await page.getByLabel('測定値（mg/L）').fill('0.00');
    await page.getByRole('button', { name: '手入力の値を使う' }).click();
    await expect(page.getByText('検知器の表示と顔が写った写真を撮影してください')).toBeVisible();
    await expect(page.getByRole('button', { name: 'この結果で出勤する' })).toBeDisabled();

    await page.getByLabel(/写真（検知器の表示と自分の顔/).setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: await dummyPhoto() });
    await expect(page.locator('#manualPreview')).toBeVisible();
    await page.getByRole('button', { name: '手入力の値を使う' }).click();
    await page.getByRole('button', { name: 'この結果で出勤する' }).click();
    await expect(page.getByText('合格・出勤しました')).toBeVisible();
  });

  test('出勤前は作業を開けず、「先に出勤してください」と案内される', async ({ page }) => {
    const api = await adminApi();
    const sc = await createScenario(api);
    await loginUi(page, sc.login, sc.password);
    await expect(page.getByText('作業を始めるには、先に出勤（アルコールチェック）をしてください。')).toBeVisible();
    await page.locator('#jobList').getByText(sc.customerName).click();
    await expect(page.getByText('先に出勤してください')).toBeVisible();
    await expect(page).toHaveURL(/\/staff$/);
  });

  test('退勤時もアルコールチェックが必要 → 退勤後、勤怠CSVとアルコール記録簿CSVに出退勤・測定値が出力される', async ({ page }) => {
    const api = await adminApi();
    const sc = await createScenario(api);
    await loginUi(page, sc.login, sc.password);
    await expect(page.getByText('未出勤')).toBeVisible();
    await clockInViaApi(page, api, sc.login);
    await page.reload();

    await pushDeviceReading(api, sc.login, 0);
    await page.getByRole('link', { name: '退勤する（アルコールチェック）' }).click();
    await page.getByRole('button', { name: '検知器の測定結果を取り込む' }).click();
    await page.getByRole('button', { name: 'この結果で退勤する' }).click();
    await expect(page.getByText('退勤しました')).toBeVisible();
    await page.getByRole('link', { name: 'ホームへ戻る' }).click();
    await expect(page.getByText('退勤済')).toBeVisible();

    const d = todayJst();
    const csv = await (await api.get(`/api/admin/attendance.csv?from=${d}&to=${d}`)).text();
    const line = csv.split('\r\n').find((l) => l.includes(sc.login));
    expect(line).toBeTruthy();
    expect(line.split(',')[4]).toBe('0.00'); // 出勤時アルコール
    expect(line.split(',')[7]).toBe('0.00'); // 退勤時アルコール
    const alc = await (await api.get(`/api/admin/alcohol.csv?from=${d}&to=${d}`)).text();
    expect(alc.split('\r\n').filter((l) => l.includes(sc.login))).toHaveLength(2);
    expect(alc).toContain('酒気帯びの有無');
  });
});
