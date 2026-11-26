'use strict';
process.removeAllListeners('warning');
const crypto = require('node:crypto');
const { db, tx } = require('./db');
const { hashPassword, todayJst } = require('./util');

/** 従業員が1人もいなければ初期管理者を作る（本番の初回起動用） */
function ensureInitialAdmin() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  db.prepare('INSERT INTO users(login_id, name, role, password_hash) VALUES (?,?,?,?)').run('admin', '管理者', 'admin', hashPassword(password));
  console.log('──────────────────────────────────────────');
  console.log(' 初期管理者を作成しました');
  console.log('   ログインID : admin');
  console.log(`   パスワード : ${password}`);
  console.log(' ログイン後、「従業員」画面でパスワードを変更してください。');
  console.log('──────────────────────────────────────────');
}

/**
 * デモデータ投入（npm run seed）。既存データは消去される。
 * 顧客はすべて架空。位置は岩手県一戸町周辺。
 */
function seedDemo() {
  const date = todayJst();
  tx(() => {
    for (const t of ['photos', 'reports', 'jobs', 'tanks', 'customers', 'locations', 'alerts', 'device_readings', 'attendance', 'alcohol_checks', 'sessions', 'users']) {
      db.exec(`DELETE FROM ${t}`);
    }
    db.exec("DELETE FROM sqlite_sequence");
    const addUser = db.prepare('INSERT INTO users(login_id, name, role, phone, password_hash) VALUES (?,?,?,?,?)');
    addUser.run('admin', '事務所 管理者', 'admin', '', hashPassword('admin1234'));
    const sato = Number(addUser.run('sato', '佐藤 一郎', 'staff', '090-0000-0001', hashPassword('sato1234')).lastInsertRowid);
    const takahashi = Number(addUser.run('takahashi', '高橋 健太', 'staff', '090-0000-0002', hashPassword('takahashi1234')).lastInsertRowid);

    const addCustomer = db.prepare('INSERT INTO customers(name, kana, address, phone, lat, lng, radius_m, notes) VALUES (?,?,?,?,?,?,?,?)');
    const addTank = db.prepare('INSERT INTO tanks(customer_id, label, model, capacity) VALUES (?,?,?,?)');
    const c1 = Number(addCustomer.run('（デモ）山田 太郎 様', 'やまだ たろう', '岩手県二戸郡一戸町一戸（デモ住所）', '0195-00-0001', 40.2066, 141.2951, 100, '犬あり。敷地奥に浄化槽').lastInsertRowid);
    const c2 = Number(addCustomer.run('（デモ）一戸町 ○○集会所', 'いちのへちょう しゅうかいじょ', '岩手県二戸郡一戸町（デモ住所）', '0195-00-0002', 40.2121, 141.2898, 80, '鍵は区長宅で借りる').lastInsertRowid);
    const c3 = Number(addCustomer.run('（デモ）鈴木商店 様', 'すずきしょうてん', '岩手県二戸郡一戸町（デモ住所）', '0195-00-0003', 40.1985, 141.3012, 100, '').lastInsertRowid);
    const t1 = Number(addTank.run(c1, '合併処理浄化槽', 'デモ型式 K-5', '5人槽').lastInsertRowid);
    const t2 = Number(addTank.run(c2, '合併処理浄化槽', 'デモ型式 K-10', '10人槽').lastInsertRowid);
    const t3 = Number(addTank.run(c3, '合併処理浄化槽（店舗）', 'デモ型式 K-7', '7人槽').lastInsertRowid);

    const addJob = db.prepare('INSERT INTO jobs(customer_id, tank_id, assignee_id, scheduled_date, work_type, memo) VALUES (?,?,?,?,?,?)');
    addJob.run(c1, t1, sato, date, '保守点検', '前回、ブロワ異音の指摘あり');
    addJob.run(c2, t2, sato, date, '清掃', '');
    addJob.run(c3, t3, takahashi, date, '保守点検', '');
  });
  console.log('デモデータを投入しました。');
  console.log('  管理者  : admin / admin1234');
  console.log('  作業員  : sato / sato1234 、 takahashi / takahashi1234');
}

if (require.main === module) seedDemo();

module.exports = { ensureInitialAdmin, seedDemo };
