// ============================================================================
// calc.js — 餘額即時計算引擎（純函式，不碰資料庫、不存任何快取餘額）
// 最高原則 1：餘額、總資產、淨值一律由交易「即時計算」得出。
//
// 交易方向約定（對應 §3）：
//   收入 income    ：錢從外面進來 → 進「to_account_id」帳戶，總資產 +。
//   支出 expense   ：錢真的離開   → 從「from_account_id」帳戶出，總資產 −。
//   內部移動 transfer：自己帳戶間搬 → from_account_id − / to_account_id +，總資產不變。
//
// ⚠ §2.4 例外：先生信用卡 B 模式「繳卡費」記為「支出」(type=expense, 主分類3)，
//   from = 付款來源帳戶（現金/貸款帳戶），不碰信用卡這個非資產帳戶。此邏輯由
//   上面的 expense 規則自然涵蓋，這裡不需特例。
// ============================================================================

// 計入餘額的交易狀態：待補/草稿不算，確認或鎖定才動帳。
// 但「待配對」是已成立的主紀錄等待事後驗證，仍應計入。
const COUNTED_STATUSES = new Set(['confirmed', 'locked', 'await_match']);

// 單一帳戶餘額 = 期初餘額 + 流入 − 流出
export function accountBalance(account, txns, opts = {}) {
  const onlyCounted = opts.onlyCounted !== false; // 預設只算「成立」的交易
  let bal = Number(account.opening_balance || 0);
  for (const t of txns) {
    if (t.deleted) continue; // 軟刪除的交易不計入餘額（可復原）
    if (onlyCounted && !COUNTED_STATUSES.has(t.status)) continue;
    if (t.historical) {
      // 歷史匯入：不動任何餘額（期初餘額已是匯入後的現況）。
      // 唯一例外：歷史應收款「收回沖銷」是今天之後的真實入帳 → 加回收款帳戶。
      if (t.type === 'receivable' && t.settled && (t.settled_to_account_id || t.from_account_id) === account.id) {
        bal += Number(t.amount || 0);
      }
      continue;
    }
    const amt = Number(t.amount || 0);
    if (t.type === 'income') {
      if (t.to_account_id === account.id) bal += amt;
    } else if (t.type === 'expense') {
      if (t.from_account_id === account.id) bal -= amt;
    } else if (t.type === 'transfer') {
      if (t.from_account_id === account.id) bal -= amt;
      if (t.to_account_id === account.id) bal += amt;
    } else if (t.type === 'receivable') {
      // 應收款/暫借款：錢確實離手 → 扣來源帳戶；「收回沖銷」後補回收款帳戶（非收入）
      if (t.from_account_id === account.id) bal -= amt;
      if (t.settled && (t.settled_to_account_id || t.from_account_id) === account.id) bal += amt;
    }
  }
  return bal;
}

// 未收回的應收款合計（應收資產；淨值用，§B 不因借出而虛減）
export function receivablesOutstanding(txns) {
  return (txns || [])
    .filter((t) => !t.deleted && COUNTED_STATUSES.has(t.status) && t.type === 'receivable' && !t.settled)
    .reduce((s, t) => s + Number(t.amount || 0), 0);
}

// 各帳戶餘額一覽（含 0 餘額）
export function allBalances(accounts, txns, opts = {}) {
  return accounts.map((a) => ({ account: a, balance: accountBalance(a, txns, opts) }));
}

// 總資產 = 所有「算進總資產且未封存」帳戶餘額加總（簽帳卡不另計；哥哥保管金另列排除）
export function totalAssets(accounts, txns, opts = {}) {
  return accounts
    .filter((a) => a.include_in_total && !a.archived)
    .reduce((sum, a) => sum + accountBalance(a, txns, opts), 0);
}

// 哥哥保管金（另列）
export function custodyTotal(accounts, txns, opts = {}) {
  return accounts
    .filter((a) => a.custody && !a.archived)
    .reduce((sum, a) => sum + accountBalance(a, txns, opts), 0);
}

// 負債餘額合計（§11.1）：有剩餘本金用本金；只有剩餘期數者，以 月繳×期數 估算（偏保守）。
// 只計 active 負債（結清封存的不計）。
export function debtsOutstanding(debts) {
  return (debts || [])
    .filter((d) => d.status === 'active')
    .reduce((sum, d) => {
      if (d.remaining_principal != null && d.remaining_principal !== '') {
        return sum + Number(d.remaining_principal || 0);
      }
      if (d.remaining_terms != null && d.remaining_terms !== '') {
        return sum + Number(d.monthly_amount || 0) * Number(d.remaining_terms || 0);
      }
      return sum;
    }, 0);
}

// 淨值 = 總資產 ＋ 應收資產（未收回的借出）− 負債餘額
// 應收款借出後現金面變少，但淨值不因借出而虛減（§B）。
export function netWorth(accounts, txns, debts, opts = {}) {
  const assets = totalAssets(accounts, txns, opts);
  const receivables = receivablesOutstanding(txns);
  const hasDebts = (debts || []).some((d) => d.status === 'active');
  if (!hasDebts) return { hasDebts: false, assets, receivables, debts: 0, net: assets + receivables };
  const liab = debtsOutstanding(debts);
  return { hasDebts: true, assets, receivables, debts: liab, net: assets + receivables - liab };
}
