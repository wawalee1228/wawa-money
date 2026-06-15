// ============================================================================
// report.js — 報表/月報的純計算（§11.1）。不畫圖、不碰 DOM，方便測。
// 只算「成立」的交易（confirmed/locked/await_match），排除軟刪除與待補/待確認。
// 內部移動不算收支，但會反映在「帳戶出入」。
// ============================================================================
import { ymd } from './date.js';

const COUNTED = new Set(['confirmed', 'locked', 'await_match']);

// 期間範圍：本月 / 上月 / 近3個月 / 自訂
export function periodRange(kind, now = new Date(), custom = {}) {
  const y = now.getFullYear(), m = now.getMonth();
  const mStart = (yy, mm) => ymd(new Date(yy, mm, 1));
  const mEnd = (yy, mm) => ymd(new Date(yy, mm + 1, 0));
  if (kind === 'lastMonth') {
    const d = new Date(y, m - 1, 1);
    return { start: mStart(d.getFullYear(), d.getMonth()), end: mEnd(d.getFullYear(), d.getMonth()), label: `${d.getFullYear()}年${d.getMonth() + 1}月` };
  }
  if (kind === 'last3') {
    const d = new Date(y, m - 2, 1);
    return { start: mStart(d.getFullYear(), d.getMonth()), end: mEnd(y, m), label: '近 3 個月' };
  }
  if (kind === 'custom') {
    return { start: custom.start || mStart(y, m), end: custom.end || mEnd(y, m), label: '自訂範圍' };
  }
  // thisMonth（預設）
  return { start: mStart(y, m), end: mEnd(y, m), label: `${y}年${m + 1}月` };
}

// 期間 + 篩選（分類/店家）下的彙總
export function computeReport(txns, accounts, categories, filters) {
  const { start, end, categoryId = null, merchant = null, excludeCatIds = null } = filters;
  const catName = (id) => categories.find((c) => String(c.id) === String(id))?.name || '未分類';
  const catGroup = (id) => { const c = categories.find((x) => String(x.id) === String(id)); return c && c.group4 ? c.group4 : null; };

  // 可選排除某些分類（例：呆帳/餘額校正——非真消費，看「真實支出」時排除）
  const exSet = (excludeCatIds && excludeCatIds.length) ? new Set(excludeCatIds.map(String)) : null;
  const base = txns.filter((t) => !t.deleted && COUNTED.has(t.status) && t.date >= start && t.date <= end
    && !(exSet && exSet.has(String(t.category_id))));
  // 分類篩選是「型別範圍」：選收入類（i 開頭）→ 只縮收入、支出照常；選支出類 → 只縮支出、收入照常
  const isIncCat = categoryId != null && String(categoryId).startsWith('i');
  const filtered = base.filter((t) => {
    if (merchant != null && (t.merchant || '') !== merchant) return false;
    if (categoryId == null) return true;
    if (isIncCat) return t.type !== 'income' || String(t.category_id) === String(categoryId);
    return t.type !== 'expense' || String(t.category_id) === String(categoryId);
  });

  let income = 0, expense = 0, skipped = 0;
  const catMap = new Map(), grpMap = new Map(), merMap = new Map(), incMap = new Map();
  const flow = new Map();
  const addFlow = (id, key, amt) => { if (id == null) return; const f = flow.get(id) || { in: 0, out: 0 }; f[key] += amt; flow.set(id, f); };
  // 保管金帳戶（§B）：用它付＝扣保管金但「不算 Wawa 支出」；錢進它＝保管金增加但「不算收入」。
  // 都仍顯示在帳戶出入，明細也照記。
  const custodyIds = new Set((accounts || []).filter((a) => a.custody).map((a) => a.id));

  for (const t of filtered) {
    try { // 健壯性：單筆怪資料安全略過，絕不讓整個報表掛掉
    const amt = Number(t.amount || 0);
    if (!isFinite(amt)) { skipped++; continue; }
    if (t.type === 'income') {
      addFlow(t.to_account_id, 'in', amt);
      if (!custodyIds.has(t.to_account_id)) { // 進保管金不算收入（i3 不會出現在統計）
        income += amt;
        const ik = t.category_id != null ? String(t.category_id) : 'i4';
        incMap.set(ik, (incMap.get(ik) || 0) + amt);
      }
    } else if (t.type === 'expense') {
      addFlow(t.from_account_id, 'out', amt);
      if (!custodyIds.has(t.from_account_id)) { // 保管金支出不入支出/分類/4群統計
        expense += amt;
        catMap.set(t.category_id, (catMap.get(t.category_id) || 0) + amt);
        // 各主分類已全數分群；只有「沒選分類」的支出才會落到「未分類」
        const g = catGroup(t.category_id) || '未分類';
        grpMap.set(g, (grpMap.get(g) || 0) + amt);
        const mk = t.merchant || '（無店家）';
        merMap.set(mk, (merMap.get(mk) || 0) + amt);
      }
    } else if (t.type === 'transfer') {
      addFlow(t.from_account_id, 'out', amt); addFlow(t.to_account_id, 'in', amt);
    } else if (t.type === 'receivable') {
      // 應收款：不計入支出/收入與分類/4群統計（§B），只反映帳戶出入；
      // 收回沖銷且收回日也在範圍內時，計一筆流入（非收入）。
      addFlow(t.from_account_id, 'out', amt);
      if (t.settled && t.settled_date && t.settled_date >= start && t.settled_date <= end) {
        addFlow(t.settled_to_account_id || t.from_account_id, 'in', amt);
      }
    }
    } catch (err) { skipped++; } // 單筆出錯 → 略過，不影響其他統計
  }

  const byCategory = [...catMap].map(([id, amount]) => ({ id, name: catName(id), amount })).sort((a, b) => b.amount - a.amount);
  const byGroup4 = [...grpMap].map(([group, amount]) => ({ group, amount })).sort((a, b) => b.amount - a.amount);
  const byMerchant = [...merMap].map(([merchant, amount]) => ({ merchant, amount })).sort((a, b) => b.amount - a.amount);
  const accountFlow = [...flow].map(([id, f]) => {
    const a = accounts.find((x) => x.id === id);
    return { id, name: a ? a.name : `#${id}`, inflow: f.in, outflow: f.out, net: f.in - f.out };
  }).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  const byIncomeCat = [...incMap].map(([id, amount]) => ({ id, amount })).sort((a, b) => b.amount - a.amount);
  return { income, expense, net: income - expense, byCategory, byGroup4, byMerchant, byIncomeCat, accountFlow, count: filtered.length, skipped };
}
