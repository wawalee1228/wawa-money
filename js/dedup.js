// ============================================================================
// dedup.js — 對帳查重三層比對（§7）
// 核心觀念：發票/扣款是「事後驗證」既有紀錄，不是新記一筆。
// 鐵則：
//   - 金額相同也「絕不自動合併」；≤視窗天數內一律問使用者、不自動併。
//   - 已確認/已鎖定的紀錄，自動流程只能「標記建議」，不可改它的資料。
// ============================================================================
import { daysBetween } from './date.js';

function normSerial(s) { return String(s || '').replace(/[\s-]/g, '').toUpperCase(); }

// recon：對帳輸入 { amount, date, merchant, invoice_no }
// txns ：既有交易（呼叫端應先濾掉已軟刪除的）
// windowDays：對帳日期視窗（預設 10）
// 回傳：
//   { layer:1, match }                         有發票/序號對得上 → 已驗證
//   { layer:2, candidates:[{txn,dayDiff,merchantUnknown}] }  疑似重複，給使用者判斷
//   { layer:3 }                                對不到 → 可能漏記
export function matchReconcile(recon, txns, windowDays = 10) {
  // 第 1 層：發票號 / 交易序號對得上 → 自動同一筆
  if (recon.invoice_no) {
    const key = normSerial(recon.invoice_no);
    const match = txns.find((t) => t.invoice_no && normSerial(t.invoice_no) === key);
    if (match) return { layer: 1, match };
  }

  // 第 2 層：無序號，但「金額相同 + 店家相同 + 日期差 ≤ 視窗」→ 疑似重複（不自動合併）
  if (recon.amount != null) {
    const candidates = [];
    for (const t of txns) {
      if (t.amount == null) continue;
      if (Number(t.amount) !== Number(recon.amount)) continue;          // 金額必須相同
      const dd = daysBetween(recon.date, t.date);
      if (!isFinite(dd) || Math.abs(dd) > windowDays) continue;          // 日期差 ≤ 視窗
      // 店家：兩邊都有才要求相同；任一邊缺店家 → 視為相容，但標註「店家資訊不足」
      const bothHaveMerchant = recon.merchant && t.merchant;
      if (bothHaveMerchant && recon.merchant !== t.merchant) continue;   // 同金額不同店家 ≠ 同一筆
      candidates.push({ txn: t, dayDiff: dd, merchantUnknown: !bothHaveMerchant });
    }
    if (candidates.length) {
      // 日期越近排越前
      candidates.sort((a, b) => Math.abs(a.dayDiff) - Math.abs(b.dayDiff));
      return { layer: 2, candidates };
    }
  }

  // 第 3 層：對不到任何紀錄 → 可能漏記
  return { layer: 3 };
}
