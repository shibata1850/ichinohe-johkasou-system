// E2E用サーバ：一時ディレクトリに新しいDBを作り、デモデータを入れて起動する（本番データには触れない）
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.DATA_DIR = path.join(os.tmpdir(), `johkasou-e2e-${process.env.PORT || 3100}`);
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const { seedDemo } = require('../src/seed');
const { setSetting } = require('../src/db');
seedDemo();
setSetting('min_stay_minutes', '0'); // 最低滞在時間はテストで個別に検証する
require('../src/server').start();
