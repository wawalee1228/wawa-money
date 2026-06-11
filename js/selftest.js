// ============================================================================
// selftest.js — 自我檢測（§17.4 驗收：餘額計算正確）
// 用「記憶體內的假資料」驗證計算引擎，完全不碰真實帳本，不寫入資料庫。
// 目的：證明三種交易類型對總資產的影響正確、且餘額是「即時算」出來的。
// ============================================================================
import { accountBalance, totalAssets, custodyTotal, netWorth } from './calc.js';

function makeFixture() {
  const accounts = [
    { id: 1, name: '中信',   include_in_total: true,  custody: false, archived: false, opening_balance: 1000 },
    { id: 2, name: '現金',   include_in_total: true,  custody: false, archived: false, opening_balance: 500 },
    { id: 3, name: '錢包',   include_in_total: true,  custody: false, archived: false, opening_balance: 0 },
    { id: 4, name: '信用卡', include_in_total: false, custody: false, archived: false, opening_balance: 0 },
    { id: 5, name: '哥哥保管金', include_in_total: false, custody: true, archived: false, opening_balance: 800 },
  ];
  return accounts;
}

export function runSelfTests() {
  const A = makeFixture();
  const results = [];
  const T = (desc, pass, detail) => results.push({ desc, pass, detail });
  const eq = (a, b) => Number(a) === Number(b);

  // 期初：總資產 = 1000+500+0+0 = 1500（信用卡非資產、哥哥保管金另列，皆不計）
  T('期初總資產不含信用卡與哥哥保管金',
    eq(totalAssets(A, []), 1500),
    `應 1500，得 ${totalAssets(A, [])}`);
  T('哥哥保管金另列 = 800',
    eq(custodyTotal(A, []), 800),
    `應 800，得 ${custodyTotal(A, [])}`);

  // 收入：客人付現金 +300 → 現金帳戶 & 總資產都 +300
  {
    const txns = [{ type: 'income', to_account_id: 2, amount: 300, status: 'confirmed' }];
    T('收入：總資產增加',
      eq(totalAssets(A, txns), 1800), `應 1800，得 ${totalAssets(A, txns)}`);
    T('收入：進帳帳戶餘額增加',
      eq(accountBalance(A[1], txns), 800), `現金應 800，得 ${accountBalance(A[1], txns)}`);
  }

  // 支出：刷中信 -450 → 中信 & 總資產都 -450
  {
    const txns = [{ type: 'expense', from_account_id: 1, amount: 450, status: 'confirmed' }];
    T('支出：總資產減少',
      eq(totalAssets(A, txns), 1050), `應 1050，得 ${totalAssets(A, txns)}`);
    T('支出：付款帳戶餘額減少',
      eq(accountBalance(A[0], txns), 550), `中信應 550，得 ${accountBalance(A[0], txns)}`);
  }

  // 內部移動：中信 → 錢包儲值 200 → 總資產不變
  {
    const txns = [{ type: 'transfer', from_account_id: 1, to_account_id: 3, amount: 200, status: 'confirmed' }];
    T('內部移動：總資產不變（儲值錢包）',
      eq(totalAssets(A, txns), 1500), `應 1500，得 ${totalAssets(A, txns)}`);
    T('內部移動：來源帳戶 −、目標帳戶 +',
      eq(accountBalance(A[0], txns), 800) && eq(accountBalance(A[2], txns), 200),
      `中信應 800（得 ${accountBalance(A[0], txns)}）、錢包應 200（得 ${accountBalance(A[2], txns)}）`);
  }

  // §2.4 B 模式：繳卡費 = 支出，從現金出，不碰信用卡帳戶
  {
    const txns = [{ type: 'expense', from_account_id: 2, amount: 8000, status: 'confirmed' }];
    T('信用卡 B 模式：繳卡費記支出（從現金出，不碰信用卡非資產帳戶）',
      eq(accountBalance(A[2 - 1], txns), 500 - 8000) && eq(accountBalance(A[3], txns), 0),
      `現金應 ${500 - 8000}（得 ${accountBalance(A[1], txns)}）、信用卡帳戶應 0（得 ${accountBalance(A[3], txns)}）`);
  }

  // 待補/草稿不動帳：status=pending 不計入
  {
    const txns = [{ type: 'expense', from_account_id: 1, amount: 999, status: 'pending' }];
    T('未確認（待補/待確認）不動帳',
      eq(totalAssets(A, txns), 1500), `應仍 1500，得 ${totalAssets(A, txns)}`);
  }

  // 待配對（已成立、等事後驗證）要計入
  {
    const txns = [{ type: 'expense', from_account_id: 1, amount: 100, status: 'await_match' }];
    T('待配對（主紀錄已成立）要計入',
      eq(totalAssets(A, txns), 1400), `應 1400，得 ${totalAssets(A, txns)}`);
  }

  // 不存快取餘額：同一份交易算兩次結果一致（證明每次都是重算）
  {
    const txns = [
      { type: 'income', to_account_id: 2, amount: 300, status: 'confirmed' },
      { type: 'expense', from_account_id: 1, amount: 450, status: 'confirmed' },
    ];
    const r1 = totalAssets(A, txns);
    const r2 = totalAssets(A, txns);
    T('餘額為即時重算（重複計算結果一致、無快取殘留）',
      eq(r1, r2) && eq(r1, 1350), `兩次應皆 1350，得 ${r1} / ${r2}`);
  }

  // 淨值：無負債時 = 總資產；有負債時 = 總資產 − 負債
  {
    const nw0 = netWorth(A, [], []);
    T('淨值：未填負債時 = 總資產（不亂算）',
      nw0.hasDebts === false && eq(nw0.net, 1500), `應 1500 且 hasDebts=false，得 ${nw0.net}/${nw0.hasDebts}`);
    const debts = [
      { status: 'active', remaining_principal: 200000 },
      { status: 'active', remaining_terms: 10, monthly_amount: 5000 }, // 月繳×期數 = 50000
      { status: 'settled_archived', remaining_principal: 99999 },       // 結清封存不計
    ];
    const nw1 = netWorth(A, [], debts);
    T('淨值：有負債時 = 總資產 − 負債（剩餘期數以 月繳×期數 估，結清不計）',
      eq(nw1.debts, 250000) && eq(nw1.net, 1500 - 250000),
      `負債應 250000（得 ${nw1.debts}）、淨值應 ${1500 - 250000}（得 ${nw1.net}）`);
  }

  // 應收款（§B）：借出扣帳、不虛減淨值、收回沖銷補回且非收入
  {
    const txns = [{ type: 'receivable', from_account_id: 2, amount: 300, status: 'confirmed' }];
    T('應收款：借出從來源帳戶扣（錢確實離手）',
      eq(accountBalance(A[1], txns), 200), `現金應 200，得 ${accountBalance(A[1], txns)}`);
    T('應收款：帳戶面總資產減少',
      eq(totalAssets(A, txns), 1200), `應 1200，得 ${totalAssets(A, txns)}`);
    const nwr = netWorth(A, txns, []);
    T('應收款：淨值含應收資產、不因借出虛減',
      eq(nwr.receivables, 300) && eq(nwr.net, 1500), `應收應 300（得 ${nwr.receivables}）、淨值應 1500（得 ${nwr.net}）`);
  }
  {
    const txns = [{ type: 'receivable', from_account_id: 2, amount: 300, status: 'confirmed', settled: true, settled_to_account_id: 2 }];
    const nws = netWorth(A, txns, []);
    T('收回沖銷：餘額補回原帳戶、非收入、淨值不變',
      eq(accountBalance(A[1], txns), 500) && eq(nws.receivables, 0) && eq(nws.net, 1500),
      `現金應 500（得 ${accountBalance(A[1], txns)}）、應收應 0、淨值應 1500（得 ${nws.net}）`);
  }

  // 歷史匯入（§B）：不動任何餘額；歷史應收款收回時才入帳
  {
    const txns = [
      { type: 'expense', from_account_id: 2, amount: 300, status: 'confirmed', historical: true },
      { type: 'income', to_account_id: 1, amount: 5000, status: 'confirmed', historical: true },
      { type: 'receivable', from_account_id: 2, amount: 3000, status: 'confirmed', historical: true },
    ];
    T('歷史匯入：支出/收入/應收都不動餘額',
      eq(accountBalance(A[1], txns), 500) && eq(accountBalance(A[0], txns), 1000) && eq(totalAssets(A, txns), 1500),
      `現金應 500（得 ${accountBalance(A[1], txns)}）、中信應 1000（得 ${accountBalance(A[0], txns)}）、總資產應 1500（得 ${totalAssets(A, txns)}）`);
    const nwh = netWorth(A, txns, []);
    T('歷史應收款：列應收資產（淨值 +3000）',
      eq(nwh.receivables, 3000) && eq(nwh.net, 4500), `應收應 3000（得 ${nwh.receivables}）、淨值應 4500（得 ${nwh.net}）`);
  }
  {
    const txns = [{ type: 'receivable', from_account_id: 2, amount: 3000, status: 'confirmed', historical: true, settled: true, settled_to_account_id: 2 }];
    T('歷史應收款收回沖銷：錢真的進來才入帳',
      eq(accountBalance(A[1], txns), 3500), `現金應 3500，得 ${accountBalance(A[1], txns)}`);
  }

  const passed = results.filter((r) => r.pass).length;
  return { results, passed, total: results.length, allPass: passed === results.length };
}
