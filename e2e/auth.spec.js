const { test, expect } = require('@playwright/test');
const { adminApi, createScenario, loginUi, BASE } = require('./helpers');

test.describe('ログインと権限', () => {
  test('パスワード違いでログイン → エラーメッセージが表示されログインできない', async ({ page }) => {
    await loginUi(page, 'sato', 'wrong-password');
    await expect(page.getByRole('alert')).toHaveText('IDまたはパスワードが違います');
    await expect(page).toHaveURL(`${BASE}/`);
  });

  test('作業員でログイン → 作業員画面へ移動し、管理画面URLを直打ちしても作業員画面に戻される', async ({ page }) => {
    await loginUi(page, 'sato', 'Ichinohe-Sato-2026');
    await expect(page).toHaveURL(/\/staff$/);
    await expect(page.getByRole('heading', { name: '佐藤 一郎 さん' })).toBeVisible();
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/staff$/);
  });

  test('作業員は管理APIと他人の作業にアクセスできず、未ログインはAPIが401になる', async ({ page, request }) => {
    const api = await adminApi();
    const other = await createScenario(api);
    await loginUi(page, 'sato', 'Ichinohe-Sato-2026');
    await expect(page).toHaveURL(/\/staff$/);
    expect((await page.request.get('/api/admin/dashboard')).status()).toBe(403);
    expect((await page.request.post('/api/admin/users', { data: { login_id: 'hacker', name: 'x', password: 'password123' } })).status()).toBe(403);
    expect((await page.request.get(`/api/staff/jobs/${other.jobId}`)).status()).toBe(404);
    expect((await request.get('/api/staff/today')).status()).toBe(401);
  });

  test('検知器連携APIは正しいAPIキーが無いと測定値を受け付けない', async ({ request }) => {
    const r1 = await request.post('/api/device/alcohol', { data: { device_id: 'X', login_id: 'sato', value_mgl: 0 } });
    expect(r1.status()).toBe(401);
    const r2 = await request.post('/api/device/alcohol', { headers: { 'X-Device-Key': 'wrong-key' }, data: { device_id: 'X', login_id: 'sato', value_mgl: 0 } });
    expect(r2.status()).toBe(401);
  });
});
