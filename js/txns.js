// ============================================================================
// txns.js — 交易的狀態機與驗證（§1、§5、§6）
// 狀態（§15 四態）：
//   pending     待確認 / 待補（用 pending_reason 記原因）
//   confirmed   已確認（使用者按確認入帳）
//   locked      已鎖定（使用者「修正」過 → §5 修正即上鎖）
//   await_match 待配對（主紀錄已成立、等事後驗證；查重段使用）
//
// 保護原則（§1.4）：confirmed 與 locked 都「不得被程式/AI 自動覆寫」；
//   只有使用者主動修改才會變動。isProtected() 給未來的自動流程當守門員。
// ============================================================================
export const STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  LOCKED: 'locked',
  AWAIT_MATCH: 'await_match',
};

export const STATUS_LABEL = {
  pending: '待確認',
  confirmed: '已確認',
  locked: '已鎖定',
  await_match: '待配對',
};

// 受保護：自動流程不可動（除非使用者主動改）
export function isProtected(status) {
  return status === STATUS.CONFIRMED || status === STATUS.LOCKED;
}

// 依表單欄位算出「待補/待確認」問題清單（§5、§6）
// form: { type, date, amount, from_account_id, to_account_id, category_id, merchant, ... }
export function findIssues(form) {
  const issues = [];
  // 缺金額 → 待補（§6：唯一會擋入帳的缺漏）
  if (form.amount === '' || form.amount == null || isNaN(Number(form.amount)) || Number(form.amount) <= 0) {
    issues.push({ field: 'amount', level: 'block', text: '待補：缺金額' });
  }
  // 日期一定要有（預設今天，理論上不會缺）
  if (!form.date) issues.push({ field: 'date', level: 'block', text: '待補：缺日期' });

  // 付款 / 收款來源：入帳必填（§5）。沒選 → block 級，不能變已確認、不計餘額，只能存待確認草稿。
  // kind: 'source' 用來在確認卡顯示「待確認」而非「待補」。
  if (form.type === 'expense' || form.type === 'receivable') {
    if (!form.from_account_id) issues.push({ field: 'from_account_id', level: 'block', kind: 'source', text: '待確認：哪個帳戶付款？（入帳必填）' });
  } else if (form.type === 'income') {
    if (!form.to_account_id) issues.push({ field: 'to_account_id', level: 'block', kind: 'source', text: '待確認：錢進哪個帳戶？（入帳必填）' });
  } else if (form.type === 'transfer') {
    if (!form.from_account_id) issues.push({ field: 'from_account_id', level: 'block', kind: 'source', text: '待確認：從哪個帳戶搬出？（入帳必填）' });
    if (!form.to_account_id) issues.push({ field: 'to_account_id', level: 'block', kind: 'source', text: '待確認：搬進哪個帳戶？（入帳必填）' });
    if (form.from_account_id && form.to_account_id && form.from_account_id === form.to_account_id) {
      issues.push({ field: 'to_account_id', level: 'block', text: '內部移動的來源與目標不能是同一個帳戶' });
    }
  }
  // 地點/店家：選填，缺了不標問題（§6）
  return issues;
}

// 是否可以「確認入帳」：沒有 block 級問題才行（待確認層級不擋，但會記在狀態裡）
export function canConfirm(issues) {
  return !issues.some((i) => i.level === 'block');
}

// 由表單 + 問題清單，組出要寫入的交易物件
// nowISO 由呼叫端（app 層）以系統時間提供；txns 層不取時間，保持單純可測。
export function buildRecord(form, issues, nowISO, opts = {}) {
  const hasBlock = issues.some((i) => i.level === 'block');
  const hasConfirm = issues.some((i) => i.level === 'confirm');

  let status;
  if (hasBlock) {
    status = STATUS.PENDING;                // 缺金額/缺來源等 → 一律待確認草稿，連「修正上鎖」也不能蓋過
  } else if (opts.forceLocked) {
    status = STATUS.LOCKED;                 // 使用者「修正」既有資料且資料齊全 → 上鎖
  } else if (hasConfirm) {
    status = STATUS.PENDING;                // 其他待確認，先存，不猜
  } else {
    status = STATUS.CONFIRMED;             // 一切齊全 → 確認入帳
  }

  const pending_reason = (status === STATUS.PENDING)
    ? issues.map((i) => i.text).join('；')
    : '';

  const rec = {
    date: form.date,
    type: form.type,
    amount: (form.amount === '' || form.amount == null) ? null : Number(form.amount),
    from_account_id: form.from_account_id || null,
    to_account_id: form.to_account_id || null,
    category_id: form.category_id || null,
    party_tag: form.party_tag || '',
    vehicle_tag: form.vehicle_tag || '',
    merchant: (form.merchant || '').trim(),   // 選填，可空
    note: (form.note || '').trim(),
    status,
    pending_reason,
    invoice_no: form.invoice_no || null,      // 查重段使用
    screenshot_id: form.screenshot_id || null,
    related_txn_id: form.related_txn_id || null,
    updated_at: nowISO,
    locked_at: status === STATUS.LOCKED ? nowISO : (form.locked_at || null),
  };
  if (opts.isNew) rec.created_at = nowISO;
  return rec;
}
