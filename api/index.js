// Vercel 用のエントリポイント（デモ公開）。
// Vercel のサーバは書き込みが /tmp しかできず、一定時間で消えるため、
// 起動のたびに /tmp にDBを作り、デモデータを入れて動かす。
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/johkasou-data';
process.env.DEMO_MODE = process.env.DEMO_MODE || '1';

const { initDemoIfEmpty } = require('../src/seed');
const { app } = require('../src/server');

initDemoIfEmpty();
module.exports = app;
