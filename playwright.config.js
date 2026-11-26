// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const PORT = 3100;

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1, // サーバ・DBを共有するため直列実行（各テストは自前のデータを作るので相互依存はなし）
  forbidOnly: true,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Pixel 7'],
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'off',
  },
  webServer: {
    command: 'node --no-warnings e2e/test-server.js',
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), APP_SECRET: 'e2e-secret' },
    timeout: 30_000,
  },
});
