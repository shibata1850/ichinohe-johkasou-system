const { test, expect, devices } = require('@playwright/test');
const { loginUi, todayJst } = require('./helpers');

test.use({ ...devices['Desktop Chrome'], locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });

test.describe('管理画面：顧客・浄化槽・QR・作業予定', () => {
  test('顧客を地図で位置指定して登録 → 浄化槽を追加 → QRラベルが印刷画面に出る → 作業予定を登録すると作業員の本日の作業に表示される', async ({ page, context, browser }) => {
    const name = `管理E2E顧客${Date.now() % 100000}`;
    await loginUi(page, 'admin', 'Ichinohe-Admin-2026');
    await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
    await page.getByRole('link', { name: '顧客・浄化槽' }).click();
    await page.getByRole('button', { name: '＋ 顧客を登録' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('顧客名').fill(name);
    await dialog.getByLabel('住所').fill('岩手県二戸郡一戸町（テスト）');

    // 位置未指定では保存できない
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('地図をクリックして浄化槽の位置を指定してください')).toBeVisible();

    await dialog.locator('#cEditMap').click({ position: { x: 200, y: 150 } });
    await expect(dialog.locator('#cPosText')).toContainText('緯度');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('続けて浄化槽を登録してください')).toBeVisible();

    // 浄化槽を追加
    await expect(dialog.getByRole('heading', { name: '浄化槽', exact: true })).toBeVisible();
    await dialog.getByLabel('浄化槽の名称').fill('合併処理浄化槽');
    await dialog.getByLabel('人槽').fill('5人槽');
    await dialog.getByRole('button', { name: '＋ 浄化槽を追加' }).click();
    await expect(dialog.getByRole('row').filter({ hasText: '合併処理浄化槽' })).toContainText('v1');

    // QRラベル印刷（別タブ）
    const [printPage] = await Promise.all([
      context.waitForEvent('page'),
      dialog.getByRole('link', { name: 'QR印刷' }).click(),
    ]);
    const label = printPage.locator('.qr-label');
    await expect(label).toHaveCount(1);
    await expect(label).toContainText(name);
    await expect(label).toContainText('蓋の裏側に貼付');
    await expect(label.locator('svg')).toBeVisible();
    expect(await label.getAttribute('data-payload')).toMatch(/^JKQR1\.\d+\.1\./);
    await printPage.close();
    await dialog.getByRole('button', { name: 'キャンセル' }).click();

    // 作業予定を登録（佐藤さん・本日）
    await page.getByRole('link', { name: '作業予定' }).click();
    await page.getByRole('button', { name: '＋ 作業を登録' }).click();
    await dialog.getByLabel('担当者').selectOption({ label: '佐藤 一郎' });
    await dialog.getByLabel(/^顧客/).selectOption({ label: name });
    await dialog.getByLabel('作業種別').selectOption('保守点検');
    await expect(dialog.getByLabel('浄化槽（QR読み取りの対象）')).toHaveValue(/\d+/); // 浄化槽が1つなら自動選択
    await dialog.getByLabel('メモ（作業員に表示）').fill('E2E登録');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('row').filter({ hasText: name })).toContainText('未着手');

    // 作業員の画面に出る
    const staffCtx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ja-JP', geolocation: { latitude: 40.2, longitude: 141.29, accuracy: 10 }, permissions: ['geolocation'] });
    const staffPage = await staffCtx.newPage();
    await loginUi(staffPage, 'sato', 'Ichinohe-Sato-2026');
    await expect(staffPage.locator('#jobList')).toContainText(name);
    await staffCtx.close();
  });

  test('浄化槽を選ばずに「保守点検」を登録しようとすると、QR対象の浄化槽が必要とエラーになる', async ({ page }) => {
    await loginUi(page, 'admin', 'Ichinohe-Admin-2026');
    await page.getByRole('link', { name: '作業予定' }).click();
    await page.getByRole('button', { name: '＋ 作業を登録' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('担当者').selectOption({ label: '高橋 健太' });
    await dialog.getByLabel(/^顧客/).selectOption({ label: '（デモ）鈴木商店 様' });
    await expect(dialog.getByLabel('浄化槽（QR読み取りの対象）')).toHaveValue(/\d+/);
    await dialog.getByLabel('浄化槽（QR読み取りの対象）').selectOption({ label: 'なし' });
    await dialog.getByLabel('作業日').fill(todayJst());
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('「保守点検」は対象の浄化槽を選択してください')).toBeVisible();
  });

  test('従業員を登録すると、そのIDでログインして作業員画面を使える', async ({ page, browser }) => {
    const login = `new${Date.now() % 100000}`;
    await loginUi(page, 'admin', 'Ichinohe-Admin-2026');
    await page.getByRole('link', { name: '従業員' }).click();
    await page.getByRole('button', { name: '＋ 従業員を登録' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('氏名').fill('新人 太郎');
    await dialog.getByLabel('ログインID（半角英数字）').fill(login);
    await dialog.getByLabel('パスワード（8文字以上）').fill('short');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('パスワードは8文字以上にしてください')).toBeVisible();
    await dialog.getByLabel('パスワード（8文字以上）').fill('newpassword1');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('row').filter({ hasText: login })).toContainText('作業員');

    const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ja-JP' });
    const p = await ctx.newPage();
    await loginUi(p, login, 'newpassword1');
    await expect(p.getByRole('heading', { name: '新人 太郎 さん' })).toBeVisible();
    await ctx.close();
  });
});

test.describe('管理画面：現場での顧客登録・ログインの無効化', () => {
  test('顧客登録で「現在地を浄化槽の位置にする」を押すと、管理者の現在地が位置として入る', async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices['Desktop Chrome'], locale: 'ja-JP', geolocation: { latitude: 39.7036, longitude: 141.1527, accuracy: 12 }, permissions: ['geolocation'] });
    const page = await ctx.newPage();
    await loginUi(page, 'admin', 'Ichinohe-Admin-2026');
    await page.getByRole('link', { name: '顧客・浄化槽' }).click();
    await page.getByRole('button', { name: '＋ 顧客を登録' }).click();
    await page.getByRole('button', { name: '現在地を浄化槽の位置にする' }).click();
    await expect(page.locator('#cPosText')).toHaveText('緯度 39.703600 / 経度 141.152700');
    await expect(page.getByText('現在地を設定しました（誤差 約12m）')).toBeVisible();
    await ctx.close();
  });

  test('管理者が作業員のパスワードを変更すると、その作業員のログイン中の画面はログアウト扱いになる', async ({ browser }) => {
    const { adminApi, createScenario, ok } = require('./helpers');
    const api = await adminApi();
    const sc = await createScenario(api);
    const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'ja-JP' });
    const p = await ctx.newPage();
    await loginUi(p, sc.login, sc.password);
    await expect(p).toHaveURL(/\/staff$/);
    expect((await p.request.get('/api/me')).status()).toBe(200);
    await ok(api.put(`/api/admin/users/${sc.userId}`, { data: { login_id: sc.login, name: 'x', role: 'staff', password: 'changed-pass-1' } }));
    expect((await p.request.get('/api/me')).status()).toBe(401);
    await ctx.close();
  });
});
