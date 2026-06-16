// ============================================================================
// ui.js — 畫面渲染
// 分頁：總覽 / 記一筆（輸入→確認卡→上鎖）/ 明細 / 設定（含自我檢測）
// 介面以「越簡單越好」為原則（§15）。
// ============================================================================
import * as db from './db.js';
import { allBalances, totalAssets, custodyTotal, netWorth, accountBalance, debtValidPaymentCount, debtRemainingTerms } from './calc.js';
import { runSelfTests } from './selftest.js';
import { todayStr, formatWithWeekday, weekdayZh, parseRelativeDate, daysBetween } from './date.js';
import { STATUS, STATUS_LABEL, isProtected, findIssues, canConfirm, buildRecord } from './txns.js';
import { parseText, scanInvoice, classifyLine, splitMultiExpense } from './parse.js';
import { matchReconcile } from './dedup.js';
import { createBackupObject, restoreFromObject, saveBackupFile, backupFilename, readBackupFile } from './backup.js';
import { periodRange, computeReport } from './report.js';

const OWNER_LABEL = { wawa: 'Wawa', husband: '先生', child: '孩子' };
const TYPE_LABEL = { bank: '銀行帳戶', cash: '現金', wallet: '數位錢包', payment_tool: '支付工具（非資產）' };
const TXTYPE_LABEL = { income: '收入', expense: '支出', transfer: '內部移動', receivable: '應收款（借出）' };

// 分類清單一律依「顯示排序 sort」呈現（內部 id 永不變；§A 編號與名稱脫鉤）
function catsSorted(categories) { return [...(categories || [])].sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999)); }

// 內部移動的明細顯示名（取代「未分類」；純顯示、不影響統計）
function transferLabel(t, accounts) {
  const fa = accounts.find((a) => a.id === t.from_account_id);
  const ta = accounts.find((a) => a.id === t.to_account_id);
  if (ta && ta.type === 'wallet') return '儲值';
  if (ta && ta.type === 'cash' && fa && fa.type !== 'cash') return '領現金';   // 帳戶→現金
  if (fa && fa.type === 'cash' && ta && ta.type !== 'cash') return '存現金';   // 現金→帳戶
  return '帳戶間轉帳';
}

// 搜尋用：寬鬆正規化（小寫＋全形英數轉半形）
function normSearch(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

// 內部移動帳戶顯示（依附轉帳沿用、單邊、全空→帳戶未指定）
function transferSrcDisplay(t, accounts, txById) {
  let from = t.from_account_id, to = t.to_account_id;
  if ((from == null || to == null) && t.related_txn_id != null && txById) {
    const p = txById.get(t.related_txn_id);
    if (p) { if (from == null) from = p.from_account_id; if (to == null) to = p.to_account_id; }
  }
  const nm = (id) => accounts.find((a) => a.id === id)?.name || '?';
  if (from != null && to != null) return `${nm(from)} → ${nm(to)}`;
  if (from != null) return `${nm(from)} 轉出`;
  if (to != null) return `轉入 ${nm(to)}`;
  return '（帳戶未指定）';
}

// 一筆交易的摘要列內容（.txn-main）——明細與對帳搜尋共用
function txnSummaryHTML(t, accounts, allCats, txById) {
  const catName = (id) => allCats.find((c) => String(c.id) === String(id))?.name || '未分類';
  const acctName = (id) => accounts.find((a) => a.id === id)?.name || '?';
  const sign = (t.type === 'expense' || t.type === 'receivable') ? '-' : (t.type === 'income' ? '+' : '⇄ ');
  const cls = (t.type === 'expense' || t.type === 'receivable') ? 'neg' : (t.type === 'income' ? 'pos' : '');
  const src = t.type === 'income' ? `→ ${acctName(t.to_account_id)}`
    : t.type === 'transfer' ? transferSrcDisplay(t, accounts, txById)
    : `${acctName(t.from_account_id)}`;
  const catShow = t.type === 'transfer' ? transferLabel(t, accounts) : catName(t.category_id);
  const title = t.merchant || catShow || TXTYPE_LABEL[t.type];
  const tags = [t.party_tag, t.vehicle_tag].filter(Boolean).join('・');
  const recvTag = t.type !== 'receivable' ? '' : (t.settled ? '・<span style="color:var(--ok)">已收回</span>' : '・<span style="color:var(--bad);font-weight:700">待收款</span>');
  const histTag = t.historical ? '・<span style="color:var(--muted)">歷史/不影響餘額</span>' : '';
  return `<div class="txn-main">
      <div class="txn-top"><span class="txn-title">${escapeHtml(title)}</span>
        <span class="amt ${cls}">${sign}${money(t.amount).replace('-', '')}</span></div>
      <div class="txn-sub">${formatWithWeekday(t.date)}・${TXTYPE_LABEL[t.type]}・${escapeHtml(src)}</div>
      <div class="txn-sub">${escapeHtml(catShow)}${tags ? '・' + escapeHtml(tags) : ''}${t.verified ? '・<span style="color:var(--ok)">✅已驗證</span>' : ''}${recvTag}${histTag}</div>
    </div>`;
}

// 一筆交易的可搜尋文字（項目/店家/備註/金額/分類名/帳戶名）
function txnSearchText(t, accounts, allCats) {
  const catName = (id) => allCats.find((c) => String(c.id) === String(id))?.name || '';
  const acctName = (id) => accounts.find((a) => a.id === id)?.name || '';
  return normSearch([t.merchant, t.note, t.import_line, t.amount, catName(t.category_id),
    acctName(t.from_account_id), acctName(t.to_account_id), TXTYPE_LABEL[t.type]].filter((x) => x != null && x !== '').join(' '));
}

function money(n) {
  if (n == null || n === '') return '—';
  const v = Math.round(Number(n || 0));
  return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US');
}
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
function nowISO() { return new Date().toISOString(); }
// 呆帳/餘額校正主分類 id（§8 對帳）；找不到時退回 13
async function badDebtCatId() { return await db.metaGet('baddebt_category_id', 13); }

// 期數重算（治本）：對受影響的負債，把 remaining_terms 設成「起點 − 有效繳款筆數」。
// 新增/修正/改來源/刪除/復原繳款後都呼叫；同一筆不會重複扣，刪除自動回補。
async function recomputeDebtTerms(debtIds) {
  const ids = [...new Set((debtIds || []).filter((x) => x != null).map(String))];
  if (!ids.length) return;
  const [txns, debts] = await Promise.all([db.getAll('transactions'), db.getAll('debts')]);
  for (const idStr of ids) {
    const d = debts.find((x) => String(x.id) === idStr);
    if (!d || d.terms_baseline == null) continue; // 沒在追蹤期數的不動
    const nv = debtRemainingTerms(d, txns);
    if (nv !== d.remaining_terms) {
      const before = d.remaining_terms;
      d.remaining_terms = nv;
      await db.put('debts', d);
      await db.logChange({ ts: nowISO(), entity: 'debts', entity_id: d.id, action: 'recompute_terms', before: { remaining_terms: before }, after: { remaining_terms: nv }, note: `期數重算＝起點 ${d.terms_baseline} − 有效繳款 ${debtValidPaymentCount(d.id, txns)}` });
    }
  }
}
const COUNTED_UI = new Set(['confirmed', 'locked', 'await_match']);

// 由 app.js 注入的分頁切換函式
let navigate = () => {};
export function setNavigate(fn) { navigate = fn; }

// 「修正」用的編輯狀態
let editingId = null;
// 明細→看詳情/修正→返回時，捲回剛剛那一筆（保留位置）
let listAnchorId = null;
let listAnchorScrollY = 0;
export function clearListAnchor() { listAnchorId = null; listAnchorScrollY = 0; }
// 對帳「可能漏記 → 記一筆」帶進記一筆頁的預填草稿（一次性）
let prefillDraft = null;
// 明細頁篩選：'all' | 'todo'（只看待補/待確認草稿）
let listFilter = 'all';
// 明細搜尋關鍵字（即時過濾）
let listSearchKw = '';
export function clearEditing() { editingId = null; }
export async function beginEdit(id) { editingId = id; listAnchorId = id; listAnchorScrollY = window.scrollY || 0; navigate('entry'); }

// ---------------------------------------------------------------- 總覽
export async function renderOverview(view) {
  const [accounts, txns, debts, bills] = await Promise.all([
    db.getAll('accounts'), db.getAll('transactions'), db.getAll('debts'), db.getAll('bills'),
  ]);
  const active = accounts.filter((a) => !a.archived).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const assets = totalAssets(active, txns);
  const custody = custodyTotal(active, txns);
  const nw = netWorth(active, txns, debts);

  view.innerHTML = '';

  // 備份提醒（§10）：距上次備份超過 N 天（或從未備份）→ 提醒手動備份
  const settings = await db.metaGet('settings', {});
  const remindDays = settings.backup_remind_days ?? 7;
  const lastBackup = await db.metaGet('last_backup_at', null);
  const hasData = txns.length > 0;
  if (hasData) {
    let msg = null;
    if (!lastBackup) msg = '你還沒備份過。建議到「設定 → 雲端備份」備份一份到 iCloud。';
    else {
      const days = Math.floor((Date.now() - new Date(lastBackup).getTime()) / 86400000);
      if (days >= remindDays) msg = `上次備份是 ${days} 天前，建議到「設定 → 雲端備份」再備份一份。`;
    }
    if (msg) {
      const b = el(`<div class="todo-banner"><span>💾 ${msg}</span><button class="btn sm" id="goBackup">去備份</button></div>`);
      b.querySelector('#goBackup').addEventListener('click', () => navigate('settings'));
      view.appendChild(b);
    }
  }

  // Part 4：計入總資產的帳戶若餘額為負 → 頂部溫和提示（多半是某筆繳款記錯來源），點擊跳明細篩該帳戶
  {
    const negAccts = active.filter((a) => a.include_in_total && !a.custody && a.type !== 'payment_tool' && accountBalance(a, txns) < 0);
    for (const a of negAccts) {
      const bal = accountBalance(a, txns);
      const b = el(`<div class="todo-banner" style="background:#fef2f2;border-color:#fecaca;color:#b91c1c">
        <span>⚠ 「${escapeHtml(a.name)}」餘額 <b style="color:#b91c1c">${money(bal)}</b>，可能有筆繳款記錯來源</span>
        <button class="btn sm" data-negacct="${a.id}">點此查看</button></div>`);
      b.querySelector('[data-negacct]').addEventListener('click', () => { listSearchKw = a.name; clearListAnchor(); navigate('list'); });
      view.appendChild(b);
    }
  }

  view.appendChild(el(`<section class="card">
    <h2>總資產（即時計算）</h2>
    <div class="big-total ${assets < 0 ? 'neg' : ''}">${money(assets)}</div>
    <div class="note">＝ 所有「算進總資產」帳戶餘額加總（簽帳卡不另計）。哥哥保管金另列。</div>
    ${nw.receivables > 0 ? `<div class="kv"><span class="name">應收款（借出待收回）</span><span class="amt">+${money(nw.receivables)}</span></div>` : ''}
    ${nw.hasDebts ? `<div class="kv"><span class="name">負債餘額</span><span class="amt neg">${money(-nw.debts)}</span></div>` : ''}
    ${(nw.hasDebts || nw.receivables > 0) ? `<div class="kv"><span class="name">淨值（資產＋應收−負債）</span><span class="amt ${nw.net < 0 ? 'neg' : ''}">${money(nw.net)}</span></div>`
      : `<div class="note">（尚未填負債，淨值＝總資產；填了負債後這裡會出現淨值）</div>`}
  </section>`));

  const rptBtn = el(`<div class="row" style="margin-bottom:16px;gap:10px">
    <button class="btn ghost" id="goReport">📊 看月報 / 報表</button>
    <button class="btn ghost" id="goCalc">🧮 計算機 / 篩選加總</button></div>`);
  rptBtn.querySelector('#goReport').addEventListener('click', () => navigate('report'));
  rptBtn.querySelector('#goCalc').addEventListener('click', () => navigate('calc'));
  view.appendChild(rptBtn);

  // ===== 近期帳單卡（§11.2）：未來 10 天內到期＋逾期未繳（一律顯示，防漏繳）；勾掉＝本月完成，下月自動重來 =====
  {
    const activeBills = bills.filter((b) => b.status === 'active');
    if (activeBills.length) {
      const today = new Date();
      const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
      const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const dim = (y, m) => new Date(y, m + 1, 0).getDate();
      const monthTotal = activeBills.reduce((s, b) => s + Number(b.amount || 0), 0);
      const doneCnt = activeBills.filter((b) => b.done_month === thisMonth).length;

      const rows = activeBills.map((b) => {
        const done = b.done_month === thisMonth;
        const dueThis = new Date(today.getFullYear(), today.getMonth(), Math.min(b.pay_day, dim(today.getFullYear(), today.getMonth())));
        const overdue = !done && dueThis < startToday;
        const due = (dueThis >= startToday || done || overdue) ? dueThis
          : new Date(today.getFullYear(), today.getMonth() + 1, Math.min(b.pay_day, dim(today.getFullYear(), today.getMonth() + 1)));
        const daysLeft = Math.round((due - startToday) / 86400000);
        return { b, done, overdue, due, daysLeft };
      }).filter((r) => r.done || r.overdue || r.daysLeft <= 10)
        .sort((a, b2) => a.due - b2.due);

      const card = el(`<section class="card"><h2>近期帳單（10 天內）</h2>
        <div class="kv"><span class="name">本月固定支出總額</span><span class="amt">${money(monthTotal)}</span></div>
        <div class="kv"><span class="name">本月已繳</span><span class="sub">${doneCnt} / ${activeBills.length} 筆</span></div></section>`);
      // 單列建構（含勾選/記一筆 handler），未繳與已繳共用同一段
      const buildRow = (r) => {
        const when = r.done ? '本月已繳' : (r.overdue ? `<span style="color:var(--bad);font-weight:700">逾期 ${Math.round((startToday - r.due) / 86400000)} 天（${r.due.getMonth() + 1}/${r.due.getDate()}）</span>`
          : (r.daysLeft === 0 ? '<b>今天到期</b>' : `${r.due.getMonth() + 1}/${r.due.getDate()}（${r.daysLeft} 天後）`));
        const row = el(`<div class="bill-row ${r.done ? 'done' : ''}">
          <input type="checkbox" class="bill-check" ${r.done ? 'checked' : ''}>
          <span class="bill-main"><span class="bill-name">${escapeHtml(r.b.name)}</span><br><span class="txn-sub">${when}・${money(r.b.amount)}</span></span>
          <button class="btn sm ${r.done ? 'ghost' : ''}" data-pay>記一筆</button>
        </div>`);
        row.querySelector('.bill-check').addEventListener('change', async (e) => {
          const before = { ...r.b };
          r.b.done_month = e.target.checked ? thisMonth : null;
          await db.put('bills', r.b);
          await db.logChange({ ts: nowISO(), entity: 'bills', entity_id: r.b.id, action: e.target.checked ? 'mark_paid' : 'unmark_paid', before, after: { ...r.b }, note: `帳單${e.target.checked ? '勾選已繳' : '取消已繳'}（${thisMonth}）` });
          navigate('overview');
        });
        row.querySelector('[data-pay]')?.addEventListener('click', () => {
          // Part 3 防重複：本月已標已繳，再記一筆要再確認一次
          if (r.done && !confirm(`「${r.b.name}」本月已標示繳過了，確定再記一筆？（避免重複記帳；若是上次記錯要改，建議去明細修正那一筆）`)) return;
          prefillDraft = {
            type: 'expense', date: todayStr(), amount: r.b.amount,
            from_account_id: r.b.from_account_id || null, to_account_id: null,
            category_id: r.b.category_id ?? null, merchant: r.b.name,
            debt_id: r.b.debt_id || null, party_tag: '', vehicle_tag: '',
            source_bill_id: r.b.id,   // 從帳單卡「記一筆」帶來；入帳成功後自動標本月已繳
          };
          clearEditing();
          navigate('entry');
        });
        return row;
      };

      // 功能 B：未繳款攤開排上面；已繳收合成一條折疊列排下方（每次進總覽都重置：未繳開、已繳收）
      const undoneRows = rows.filter((r) => !r.done);
      const doneRows = rows.filter((r) => r.done);
      if (!undoneRows.length) {
        card.appendChild(el('<div class="note">目前沒有待繳帳單 ✓</div>'));
      } else {
        for (const r of undoneRows) card.appendChild(buildRow(r));
      }
      if (doneRows.length) {
        const head = el(`<div class="kv bill-collapse" style="cursor:pointer">
          <span class="name" style="color:var(--muted);font-weight:500">已繳 ${doneRows.length} 筆 <span class="collapse-chev" style="font-size:13px">▸</span></span></div>`);
        const body = el('<div style="display:none"></div>');
        for (const r of doneRows) body.appendChild(buildRow(r));
        head.addEventListener('click', () => {
          const open = body.style.display === 'none';
          body.style.display = open ? '' : 'none';
          head.querySelector('.collapse-chev').textContent = open ? '▾' : '▸';
        });
        card.appendChild(head);
        card.appendChild(body);
      }
      view.appendChild(card);
    }
  }

  // ===== 負債卡（§2.5）：已知本金合計＋每月還款＋各筆（遠東房貸合併一組可展開）=====
  {
    const act = debts.filter((d) => d.status === 'active');
    if (act.length) {
      const knownTotal = act.reduce((s, d) => s + (d.remaining_principal != null ? Number(d.remaining_principal) : 0), 0);
      const monthlyTotal = act.reduce((s, d) => s + Number(d.monthly_amount || 0), 0);
      const pendCnt = act.filter((d) => d.remaining_principal == null).length;
      const estPend = act.filter((d) => d.remaining_principal == null && d.remaining_terms != null)
        .reduce((s, d) => s + Number(d.monthly_amount || 0) * Number(d.remaining_terms || 0), 0);

      const dCard = el(`<section class="card"><h2>負債（§2.5）</h2>
        <div class="kv"><span class="name">總負債（本金已知）</span><span class="amt neg">${money(knownTotal)}</span></div>
        ${pendCnt ? `<div class="kv"><span class="name">本金待補 ${pendCnt} 筆（先以月付×期數估）</span><span class="sub">約 ${money(estPend)}（計入淨值）</span></div>` : ''}
        <div class="kv"><span class="name">每月還款總額</span><span class="amt">${money(monthlyTotal)}</span></div></section>`);

      const progress = (d) => d.total_terms != null && d.remaining_terms != null
        ? `已還 ${d.total_terms - d.remaining_terms}/${d.total_terms} 期`
        : (d.remaining_terms != null ? `剩 ${d.remaining_terms} 期` : '');
      const debtRow = (d, indent) => el(`<div class="kv" ${indent ? 'style="padding-left:18px"' : ''}>
        <span><span class="name">${escapeHtml(d.name)}</span><br><span class="sub">月付 ${money(d.monthly_amount)}・每月 ${d.pay_day} 日${progress(d) ? '・' + progress(d) : ''}${d.split_note || ''}</span></span>
        <span class="amt ${d.remaining_principal != null ? 'neg' : ''}">${d.remaining_principal != null ? (d.principal_estimated ? `約 ${money(d.remaining_principal)}<span class="sub">（估算）</span>` : money(d.remaining_principal)) : '本金待補'}</span></div>`);

      // 分組：group 相同者合併一列，可展開
      const groups = new Map();
      for (const d of act) {
        const key = d.group || '';
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(d);
      }
      for (const [gname, list] of groups) {
        if (list.length < 2) continue;
        const gP = list.reduce((s, d) => s + (d.remaining_principal != null ? Number(d.remaining_principal) : 0), 0);
        const gM = list.reduce((s, d) => s + Number(d.monthly_amount || 0), 0);
        const head = el(`<div class="kv" style="cursor:pointer">
          <span><span class="name">${escapeHtml(gname)}（${list.length} 段）<span class="collapse-chev" style="font-size:15px">+</span></span><br><span class="sub">月付合計 ${money(gM)}・每月 ${list[0].pay_day} 日</span></span>
          <span class="amt neg">${money(gP)}</span></div>`);
        const body = el('<div style="display:none"></div>');
        for (const d of list) body.appendChild(debtRow(d, true));
        head.addEventListener('click', () => {
          const open = body.style.display === 'none';
          body.style.display = open ? '' : 'none';
          head.querySelector('.collapse-chev').textContent = open ? '−' : '+';
        });
        dCard.appendChild(head); dCard.appendChild(body);
      }
      for (const d of act) { if (!(d.group && (groups.get(d.group) || []).length >= 2)) dCard.appendChild(debtRow(d, false)); }
      view.appendChild(dCard);
    }
  }

  const balances = allBalances(active.filter((a) => !a.custody), txns);
  const byOwner = {};
  for (const b of balances) (byOwner[b.account.owner] ||= []).push(b);
  for (const owner of ['wawa', 'husband', 'child']) {
    if (!byOwner[owner]) continue;
    const sec = el(`<section class="card"><h2>${OWNER_LABEL[owner]} 帳戶</h2></section>`);
    for (const { account, balance } of byOwner[owner]) {
      sec.appendChild(el(`<div class="kv">
        <span><span class="name">${account.name}</span><br><span class="sub">${TYPE_LABEL[account.type] || account.type}${account.include_in_total ? '' : '・不計入總資產'}</span></span>
        <span class="amt ${balance < 0 ? 'neg' : ''}">${money(balance)}</span></div>`));
    }
    view.appendChild(sec);
  }

  // ===== 呆帳 / 帳實差額卡（§8 對帳）：累積校正總額，可展開看每筆，點筆看詳情 =====
  {
    const reconTx = txns.filter((t) => !t.deleted && t.is_reconcile && COUNTED_UI.has(t.status));
    if (reconTx.length) {
      const signed = (t) => (t.type === 'income' ? Number(t.amount || 0) : -Number(t.amount || 0));
      const total = reconTx.reduce((s, t) => s + signed(t), 0);
      const card = el(`<section class="card"><h2 style="cursor:pointer">呆帳 / 帳實差額（§8）<span class="collapse-chev" style="font-size:15px">　+</span></h2>
        <div class="kv"><span class="name">累積呆帳總額（${reconTx.length} 筆校正）</span><span class="amt ${total < 0 ? 'neg' : 'pos'}">${money(total)}</span></div>
        <div class="note">對帳補差累積；點標題展開看每筆校正（哪天、哪個帳戶、差多少）。呆帳非真消費，月報可一鍵排除。</div></section>`);
      const body = el('<div style="display:none"></div>');
      for (const t of reconTx.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))) {
        const acctId = t.type === 'income' ? t.to_account_id : t.from_account_id;
        const an = accounts.find((x) => x.id === acctId)?.name || '?';
        const row = el(`<div class="kv" style="padding-left:6px;cursor:pointer">
          <span><span class="name">${escapeHtml(an)}</span><br><span class="sub">${formatWithWeekday(t.date)}・${escapeHtml(t.note || '')}</span></span>
          <span class="amt ${t.type === 'income' ? 'pos' : 'neg'}">${t.type === 'income' ? '+' : '-'}${money(t.amount).replace('-', '')}</span></div>`);
        row.addEventListener('click', () => beginEdit(t.id));
        body.appendChild(row);
      }
      card.appendChild(body);
      card.querySelector('h2').addEventListener('click', () => {
        const open = body.style.display === 'none';
        body.style.display = open ? '' : 'none';
        card.querySelector('.collapse-chev').textContent = open ? '　−' : '　+';
      });
      view.appendChild(card);
    }
  }

  // 哥哥保管金：獨立餘額＋明細（§B）。用它付＝扣保管金、不算 Wawa 支出；錢進它＝不算收入。
  {
    const CNT = new Set(['confirmed', 'locked', 'await_match']);
    const custodyIds = new Set(accounts.filter((a) => a.custody).map((a) => a.id));
    const cTxns = txns
      .filter((t) => !t.deleted && CNT.has(t.status) && (custodyIds.has(t.from_account_id) || custodyIds.has(t.to_account_id)))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const cCard = el(`<section class="card">
      <h2>哥哥保管金（另列，不算家庭可用錢）</h2>
      <div class="kv"><span class="name">保管金餘額</span><span class="amt">${money(custody)}</span></div>
      <div class="note">用保管金買的東西會扣這裡、<b>不會</b>計入月報支出；孩子拿錢來保管記「收入→哥哥保管金」，不算 Wawa 收入。</div></section>`);
    if (cTxns.length) {
      cCard.appendChild(el(`<div class="group-title">保管金明細（近 ${Math.min(cTxns.length, 10)} 筆）</div>`));
      for (const t of cTxns.slice(0, 10)) {
        const out = custodyIds.has(t.from_account_id);
        const title = t.merchant || t.note || TXTYPE_LABEL[t.type] || '';
        cCard.appendChild(el(`<div class="kv"><span><span class="name">${escapeHtml(title)}</span><br><span class="sub">${formatWithWeekday(t.date)}</span></span>
          <span class="amt ${out ? 'neg' : 'pos'}">${out ? '-' : '+'}${money(t.amount).replace('-', '')}</span></div>`));
      }
    }
    view.appendChild(cCard);
  }

  // 應收清單（§B）：未收回的借出，標紅待收款；收回用「收回沖銷」，不是新收入
  const COUNTED_R = new Set(['confirmed', 'locked', 'await_match']);
  const recvs = txns.filter((t) => !t.deleted && t.type === 'receivable' && COUNTED_R.has(t.status) && !t.settled);
  if (recvs.length) {
    const rc = el(`<section class="card"><h2>應收清單（${recvs.length} 筆待收款）</h2>
      <div class="note">借出時帳戶已照扣；這裡列「誰還欠多少」。收回按「收回沖銷」結清（補回帳戶、不記收入）。</div></section>`);
    for (const t of recvs) {
      const acctOpts = active.filter((a) => !a.custody).map((a) =>
        `<option value="${a.id}" ${a.id === t.from_account_id ? 'selected' : ''}>${a.name}</option>`).join('');
      const row = el(`<div class="recv-row">
        <div class="recv-main"><span class="recv-who">${escapeHtml(t.merchant || t.note || '（未填對象）')}</span>
          <span class="recv-amt">${money(t.amount)}</span></div>
        <div class="txn-sub">${formatWithWeekday(t.date)}・從 ${active.find((a) => a.id === t.from_account_id)?.name || '?'} 借出・<span style="color:var(--bad);font-weight:700">待收款</span></div>
        <div class="recv-act"><select data-to>${acctOpts}</select><button class="btn sm" data-settle>收回沖銷</button></div>
      </div>`);
      row.querySelector('[data-settle]').addEventListener('click', async () => {
        const toId = Number(row.querySelector('[data-to]').value);
        const toName = active.find((a) => a.id === toId)?.name || '?';
        if (!confirm(`確認已收回 ${money(t.amount)}？\n將補回「${toName}」，結清這筆應收（不記成收入）。`)) return;
        await settleReceivable(t.id, toId);
      });
      rc.appendChild(row);
    }
    view.appendChild(rc);
  }

  // 待辦：待確認/待補的筆數
  const pending = txns.filter((t) => t.status === STATUS.PENDING && !t.deleted);
  if (pending.length) {
    view.appendChild(el(`<div class="warnbox">有 ${pending.length} 筆「待確認 / 待補」尚未完成，去「明細」點開補齊。</div>`));
  }
}

// ---------------------------------------------------------------- 報表 / 月報（§11.1）
// 報表頁狀態（重整報表頁時保留）
let reportState = { kind: 'thisMonth', custom: { start: '', end: '' }, dim: '12', categoryId: null, merchant: null, excludeBadDebt: false };
// 計算機狀態（自由區間＋複選分類＋複選店家）
let calcState = { start: '', end: '', cats: new Set(), merchants: new Set() };
// 圖表配色：深綠／香檳金／中性色階，不用彩虹
const RPAL = ['#1F2B28', '#4F6B52', '#B8954A', '#7A8F84', '#C9B892', '#566B62', '#A99C82', '#9A5B4C', '#6E6450', '#8C8A7E', '#3A4A44', '#DCCDA8'];

function pieSVG(slices) {
  const total = slices.reduce((s, x) => s + x.amount, 0);
  if (total <= 0) return '<div class="note">這個範圍沒有支出資料。</div>';
  const cx = 110, cy = 110, r = 100, ir = 60;
  let ang = -Math.PI / 2, paths = '';
  slices.forEach((s, i) => {
    const frac = s.amount / total;
    const a2 = ang + frac * 2 * Math.PI;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(ang), y1 = cy + r * Math.sin(ang);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const xi1 = cx + ir * Math.cos(a2), yi1 = cy + ir * Math.sin(a2);
    const xi2 = cx + ir * Math.cos(ang), yi2 = cy + ir * Math.sin(ang);
    const d = `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L${xi1.toFixed(1)} ${yi1.toFixed(1)} A${ir} ${ir} 0 ${large} 0 ${xi2.toFixed(1)} ${yi2.toFixed(1)} Z`;
    paths += `<path d="${d}" fill="${s.color}" stroke="#fff" stroke-width="1.5" data-i="${i}" style="cursor:pointer"></path>`;
    if (frac > 0.06) {
      const mid = (ang + a2) / 2, lr = (r + ir) / 2;
      paths += `<text x="${(cx + lr * Math.cos(mid)).toFixed(1)}" y="${(cy + lr * Math.sin(mid)).toFixed(1)}" font-size="11" fill="#fff" text-anchor="middle" dominant-baseline="central" style="pointer-events:none">${Math.round(frac * 100)}%</text>`;
    }
    ang = a2;
  });
  return `<svg viewBox="0 0 220 220" width="100%" style="max-width:240px" class="pie">${paths}
    <text x="110" y="103" text-anchor="middle" font-size="12" fill="#8C8A7E">支出合計</text>
    <text x="110" y="125" text-anchor="middle" font-size="17" font-weight="700" fill="#1F2B28" font-family="'Noto Serif TC',serif">${money(total)}</text></svg>`;
}

function barsHTML(slices) {
  if (!slices.length) return '<div class="note">沒有資料。</div>';
  const max = Math.max(...slices.map((s) => s.amount), 1);
  return slices.map((s) => {
    const w = Math.max(3, Math.round((s.amount / max) * 100));
    return `<div class="bar-row"><div class="bar-label">${escapeHtml(s.label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${w}%;background:${s.color}"></div></div>
      <div class="bar-val">${money(s.amount)}</div></div>`;
  }).join('');
}

// 安全殼：報表渲染任何一步出錯，都顯示錯誤卡而不是整頁死掉（資料不受影響）
export async function renderReport(view) {
  try {
    await renderReportInner(view);
  } catch (e) {
    console.error('[Wawa] renderReport failed:', e);
    view.innerHTML = '';
    const card = el(`<section class="card"><h2>報表載入失敗</h2>
      <div class="warnbox">渲染時遇到錯誤（已攔下，資料不受影響）：<br><code>${escapeHtml(e && (e.message || String(e)))}</code></div>
      <button class="btn ghost" id="rptBack">← 回總覽</button></section>`);
    card.querySelector('#rptBack').addEventListener('click', () => navigate('overview'));
    view.appendChild(card);
  }
}

async function renderReportInner(view) {
  const [accountsAll, txns, categories, debts, g4names, incomeCats] = await Promise.all([
    db.getAll('accounts'), db.getAll('transactions'), db.metaGet('categories', []), db.getAll('debts'),
    db.metaGet('group4_names', {}), db.metaGet('income_categories', []),
  ]);
  const isIncFilter = reportState.categoryId != null && String(reportState.categoryId).startsWith('i');
  const active = accountsAll.filter((a) => !a.archived);
  const range = periodRange(reportState.kind, new Date(), reportState.custom);
  const badCatId = await db.metaGet('baddebt_category_id', 13);
  const rep = computeReport(txns, accountsAll, categories, { start: range.start, end: range.end, categoryId: reportState.categoryId, merchant: reportState.merchant, excludeCatIds: reportState.excludeBadDebt ? [badCatId] : null });
  const nw = netWorth(active, txns, debts);
  const assets = totalAssets(active, txns);
  const catName = (id) => [...categories, ...incomeCats].find((c) => String(c.id) === String(id))?.name || '';
  const incName = (id) => incomeCats.find((c) => String(c.id) === String(id))?.name || '其他';

  // 期間內所有店家（給篩選下拉）
  const periodMerchants = [...new Set(txns
    .filter((t) => !t.deleted && t.type === 'expense' && t.date >= range.start && t.date <= range.end && t.merchant)
    .map((t) => t.merchant))].sort();

  // 圖表的分解資料（圓餅＋長條共用）。篩「收入類」只縮收入卡，支出圓餅照常。
  let slices, breakTitle;
  if (reportState.categoryId != null && !isIncFilter) {
    slices = rep.byMerchant.map((x) => ({ label: x.merchant, amount: x.amount }));
    breakTitle = `店家佔比（${catName(reportState.categoryId)}）`;
  } else if (reportState.dim === '4') {
    slices = rep.byGroup4.map((x) => ({
      label: g4names[x.group] ? `${x.group} ${g4names[x.group]}`
        : (x.group === '未分類' ? '未分類（沒選分類的支出）' : `群 ${x.group}`),
      amount: x.amount,
    }));
    breakTitle = '4 群佔比';
  } else {
    slices = rep.byCategory.map((x) => ({ label: x.name, amount: x.amount }));
    breakTitle = `${categories.length} 類佔比`;
  }
  slices.forEach((s, i) => { s.color = RPAL[i % RPAL.length]; });
  const totalExp = slices.reduce((s, x) => s + x.amount, 0);

  view.innerHTML = '';
  const back = el(`<div class="row" style="margin-bottom:12px"><button class="btn ghost" id="backOv">← 回總覽</button></div>`);
  back.querySelector('#backOv').addEventListener('click', () => navigate('overview'));
  view.appendChild(back);

  // ---- 篩選 ----
  const filt = el(`<section class="card"><h2>報表範圍：${range.label}</h2>
    <div class="seg" id="rngSeg">
      ${[['thisMonth', '本月'], ['lastMonth', '上月'], ['last3', '近3月'], ['custom', '自訂']].map(([k, l]) => `<button type="button" class="seg-btn ${reportState.kind === k ? 'on' : ''}" data-k="${k}">${l}</button>`).join('')}
    </div>
    ${reportState.kind === 'custom' ? `<div class="row">
      <label class="field"><span class="lab">起</span><input id="cStart" type="date" value="${reportState.custom.start || range.start}"></label>
      <label class="field"><span class="lab">迄</span><input id="cEnd" type="date" value="${reportState.custom.end || range.end}"></label></div>` : ''}
    <label class="field"><span class="lab">只看某分類</span><select id="fCat"><option value="">全部分類</option>
      <optgroup label="收入類">
      ${incomeCats.map((c) => `<option value="${c.id}" ${String(reportState.categoryId) === String(c.id) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
      </optgroup>
      <optgroup label="支出類">
      ${catsSorted(categories).map((c) => `<option value="${c.id}" ${String(reportState.categoryId) === String(c.id) ? 'selected' : ''}>${c.name}</option>`).join('')}
      </optgroup></select></label>
    <label class="field"><span class="lab">只看某店家</span><select id="fMer"><option value="">全部店家</option>
      ${periodMerchants.map((m) => `<option value="${escapeHtml(m)}" ${reportState.merchant === m ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}</select></label>
    <label class="inline-check field"><input type="checkbox" id="fExBad" ${reportState.excludeBadDebt ? 'checked' : ''}/> <span>排除呆帳/餘額校正（只看真實消費）</span></label>
  </section>`);
  filt.querySelectorAll('#rngSeg .seg-btn').forEach((b) => b.addEventListener('click', () => { reportState.kind = b.dataset.k; renderReport(view); }));
  if (reportState.kind === 'custom') {
    filt.querySelector('#cStart')?.addEventListener('change', (e) => { reportState.custom.start = e.target.value; renderReport(view); });
    filt.querySelector('#cEnd')?.addEventListener('change', (e) => { reportState.custom.end = e.target.value; renderReport(view); });
  }
  filt.querySelector('#fCat').addEventListener('change', (e) => {
    const v = e.target.value;
    reportState.categoryId = v ? (String(v).startsWith('i') ? v : Number(v)) : null;
    reportState.merchant = null;
    renderReport(view);
  });
  filt.querySelector('#fMer').addEventListener('change', (e) => { reportState.merchant = e.target.value || null; renderReport(view); });
  filt.querySelector('#fExBad').addEventListener('change', (e) => { reportState.excludeBadDebt = e.target.checked; renderReport(view); });
  view.appendChild(filt);

  // ---- 收入 / 支出 / 結餘 ----
  view.appendChild(el(`<section class="card"><h2>收支總覽</h2>
    <div class="sum3">
      <div class="sum-item"><div class="sum-lab">收入</div><div class="sum-val pos">${money(rep.income)}</div></div>
      <div class="sum-item"><div class="sum-lab">支出</div><div class="sum-val neg">${money(rep.expense)}</div></div>
      <div class="sum-item"><div class="sum-lab">結餘</div><div class="sum-val ${rep.net < 0 ? 'neg' : ''}">${money(rep.net)}</div></div>
    </div>
    ${(rep.byIncomeCat || []).filter((x) => x.amount > 0).length ? `<div class="note" style="text-align:center">收入拆分：${rep.byIncomeCat.filter((x) => x.amount > 0).map((x) => `${escapeHtml(incName(x.id))} ${money(x.amount)}`).join('／')}</div>` : ''}
    <div class="kv"><span class="name">總資產（目前）</span><span class="amt">${money(assets)}</span></div>
    ${nw.hasDebts ? `<div class="kv"><span class="name">淨值（資產＋應收−負債）</span><span class="amt ${nw.net < 0 ? 'neg' : ''}">${money(nw.net)}</span></div>`
      : `<div class="note">淨值：填了負債後顯示（資產＋應收−負債）。</div>`}
    <div class="note">收入/支出/結餘只算這個範圍；內部移動不計收支。${reportState.categoryId != null ? '（已篩分類）' : ''}${reportState.merchant ? '（已篩店家）' : ''}</div>
  </section>`));

  // 空範圍提示：這個範圍沒有支出時，告訴使用者最近的支出在哪個月（避免誤以為報表壞掉）
  if (rep.expense === 0 && reportState.categoryId == null && !reportState.merchant) {
    const CNT = new Set(['confirmed', 'locked', 'await_match']);
    const lastExp = txns
      .filter((t) => !t.deleted && t.type === 'expense' && CNT.has(t.status) && t.date)
      .map((t) => t.date).sort().pop();
    if (lastExp && (lastExp < range.start || lastExp > range.end)) {
      const hint = el(`<div class="todo-banner"><span>📭 ${range.label} 沒有支出紀錄；最近一筆支出在 <b>${formatWithWeekday(lastExp)}</b>。</span>
        <button class="btn sm" id="goLastM">看那個月</button></div>`);
      hint.querySelector('#goLastM').addEventListener('click', () => {
        reportState.kind = 'custom';
        reportState.custom = { start: lastExp.slice(0, 8) + '01', end: lastExp.slice(0, 7) + '-31' };
        renderReport(view);
      });
      view.appendChild(hint);
    } else if (!lastExp) {
      view.appendChild(el(`<div class="note">還沒有任何支出紀錄，下面的圖表會是空的。</div>`));
    }
  }
  if (rep.skipped) {
    view.appendChild(el(`<div class="warnbox">有 ${rep.skipped} 筆資料格式異常，統計時已安全略過（其他數字不受影響）。</div>`));
  }

  // ---- 圓餅 ----
  const pieCard = el(`<section class="card"><h2>${breakTitle}</h2>
    ${(reportState.categoryId == null || isIncFilter) ? `<div class="seg" id="dimSeg" style="max-width:240px">
      <button type="button" class="seg-btn ${reportState.dim === '12' ? 'on' : ''}" data-d="12">${categories.length} 類</button>
      <button type="button" class="seg-btn ${reportState.dim === '4' ? 'on' : ''}" data-d="4">4 群</button></div>` : ''}
    <div class="pie-wrap">${pieSVG(slices)}</div>
    <div class="note" id="pieDetail">點圓餅或下方項目看金額與占比。</div>
    <div id="pieLegend"></div>
  </section>`);
  if (reportState.categoryId == null || isIncFilter) pieCard.querySelectorAll('#dimSeg .seg-btn').forEach((b) => b.addEventListener('click', () => { reportState.dim = b.dataset.d; renderReport(view); }));
  const legend = pieCard.querySelector('#pieLegend');
  const detail = pieCard.querySelector('#pieDetail');
  const showDetail = (i) => { const s = slices[i]; const pct = totalExp ? Math.round(s.amount / totalExp * 100) : 0; detail.innerHTML = `<b style="color:${s.color}">${escapeHtml(s.label)}</b>：${money(s.amount)}（${pct}%）`; };
  slices.forEach((s, i) => {
    const pct = totalExp ? Math.round(s.amount / totalExp * 100) : 0;
    const row = el(`<div class="legend-row" data-i="${i}"><span class="legend-dot" style="background:${s.color}"></span><span class="legend-name">${escapeHtml(s.label)}</span><span class="legend-amt">${money(s.amount)}　${pct}%</span></div>`);
    row.addEventListener('click', () => showDetail(i));
    legend.appendChild(row);
  });
  view.appendChild(pieCard);
  pieCard.querySelectorAll('.pie path').forEach((p) => p.addEventListener('click', () => showDetail(Number(p.dataset.i))));

  // ---- 長條（花最多排行）----
  view.appendChild(el(`<section class="card"><h2>花最多排行</h2><div class="bars">${barsHTML(slices)}</div></section>`));

  // ---- 帳戶出入 ----
  const afCard = el(`<section class="card"><h2>帳戶出入（這期間）</h2>
    <div class="kv" style="color:var(--muted);font-size:12.5px"><span>帳戶</span><span>流入 / 流出 / 淨變動</span></div></section>`);
  if (!rep.accountFlow.length) afCard.appendChild(el('<div class="note">這個範圍沒有帳戶異動。</div>'));
  for (const f of rep.accountFlow) {
    afCard.appendChild(el(`<div class="kv"><span class="name">${f.name}</span>
      <span class="sub"><span class="pos">+${money(f.inflow)}</span> / <span class="neg">-${money(f.outflow)}</span> / <b class="${f.net < 0 ? 'neg' : 'pos'}">${f.net < 0 ? '' : '+'}${money(f.net)}</b></span></div>`));
  }
  view.appendChild(afCard);
}

// ---------------------------------------------------------------- 計算機 / 篩選加總（純查詢）
export async function renderCalc(view) {
  const [accounts, txns, categories, incomeCats] = await Promise.all([
    db.getAll('accounts'), db.getAll('transactions'), db.metaGet('categories', []), db.metaGet('income_categories', []),
  ]);
  const COUNTED = new Set(['confirmed', 'locked', 'await_match']);
  const base = txns.filter((t) => !t.deleted && COUNTED.has(t.status));
  // 預設區間：本月
  if (!calcState.start || !calcState.end) {
    const now = new Date(); const p = (x) => String(x).padStart(2, '0');
    calcState.start = `${now.getFullYear()}-${p(now.getMonth() + 1)}-01`;
    calcState.end = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate())}`;
  }
  const merchants = [...new Set(base.filter((t) => t.merchant).map((t) => t.merchant))].sort();

  view.innerHTML = '';
  const back = el(`<div class="row" style="margin-bottom:12px"><button class="btn ghost" id="calcBack">← 回總覽</button></div>`);
  back.querySelector('#calcBack').addEventListener('click', () => navigate('overview'));
  view.appendChild(back);

  // 區間
  view.appendChild(el(`<section class="card"><h2>計算機 / 篩選加總（純查詢，不影響餘額）</h2>
    <div class="row">
      <label class="field"><span class="lab">開始日</span><input id="cStart" type="date" value="${calcState.start}"></label>
      <label class="field"><span class="lab">結束日</span><input id="cEnd" type="date" value="${calcState.end}"></label>
    </div></section>`));

  // 分類複選（收入類/支出類分組）
  const catCard = el(`<section class="card"><h2>分類（複選；不勾＝全部）</h2>
    <div class="group-title">收入類</div><div class="chk-grid" id="incChks"></div>
    <div class="group-title">支出類</div><div class="chk-grid" id="expChks"></div></section>`);
  const mkChk = (id, name) => {
    const c = el(`<label class="chk"><input type="checkbox" value="${id}" ${calcState.cats.has(String(id)) ? 'checked' : ''}> <span>${escapeHtml(name)}</span></label>`);
    c.querySelector('input').addEventListener('change', (e) => { e.target.checked ? calcState.cats.add(String(id)) : calcState.cats.delete(String(id)); recompute(); });
    return c;
  };
  incomeCats.forEach((c) => catCard.querySelector('#incChks').appendChild(mkChk(c.id, c.name)));
  catsSorted(categories).forEach((c) => catCard.querySelector('#expChks').appendChild(mkChk(c.id, c.name)));
  view.appendChild(catCard);

  // 店家複選
  const merCard = el(`<section class="card"><h2>店家（複選；不勾＝全部）</h2><div class="chk-grid scroll" id="merChks"></div></section>`);
  if (!merchants.length) merCard.querySelector('#merChks').appendChild(el('<div class="note">沒有店家資料。</div>'));
  merchants.forEach((m) => {
    const c = el(`<label class="chk"><input type="checkbox" value="${escapeHtml(m)}" ${calcState.merchants.has(m) ? 'checked' : ''}> <span>${escapeHtml(m)}</span></label>`);
    c.querySelector('input').addEventListener('change', (e) => { e.target.checked ? calcState.merchants.add(m) : calcState.merchants.delete(m); recompute(); });
    merCard.querySelector('#merChks').appendChild(c);
  });
  view.appendChild(merCard);

  // 即時加總結果
  const resCard = el(`<section class="card" style="border-color:var(--gold)"><h2>加總結果（即時）</h2><div id="calcResult"></div></section>`);
  view.appendChild(resCard);

  function recompute() {
    const f = base.filter((t) => {
      if (t.date < calcState.start || t.date > calcState.end) return false;
      if (calcState.cats.size && !calcState.cats.has(String(t.category_id))) return false;
      if (calcState.merchants.size && !calcState.merchants.has(t.merchant || '')) return false;
      return true;
    });
    let inc = 0, exp = 0, incN = 0, expN = 0;
    for (const t of f) {
      const a = Number(t.amount || 0);
      if (t.type === 'income') { inc += a; incN += 1; }
      else if (t.type === 'expense') { exp += a; expN += 1; }
    }
    const r = resCard.querySelector('#calcResult');
    r.innerHTML = `
      <div class="kv"><span class="name">符合筆數</span><span class="amt">${f.length} 筆</span></div>
      ${incN ? `<div class="kv"><span class="name">收入加總（${incN} 筆）</span><span class="amt pos">${money(inc)}</span></div>` : ''}
      ${expN ? `<div class="kv"><span class="name">支出加總（${expN} 筆）</span><span class="amt neg">${money(exp)}</span></div>` : ''}
      ${(incN && expN) ? `<div class="kv"><span class="name">收−支</span><span class="amt ${inc - exp < 0 ? 'neg' : ''}">${money(inc - exp)}</span></div>` : ''}
      <div class="note">區間 ${calcState.start} ~ ${calcState.end}${calcState.cats.size ? '・已篩 ' + calcState.cats.size + ' 個分類' : ''}${calcState.merchants.size ? '・已篩 ' + calcState.merchants.size + ' 個店家' : ''}。內部移動/應收不計收支。</div>`;
  }
  view.querySelector('#cStart').addEventListener('change', (e) => { calcState.start = e.target.value; recompute(); });
  view.querySelector('#cEnd').addEventListener('change', (e) => { calcState.end = e.target.value; recompute(); });
  recompute();
}

// ---------------------------------------------------------------- 記一筆（輸入 → 確認卡 → 上鎖）
export async function renderEntry(view) {
  const accounts = (await db.getAll('accounts')).filter((a) => !a.archived).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const cards = await db.getAll('cards');
  const categories = await db.metaGet('categories', []);
  const partyTags = await db.metaGet('party_tags', []);
  const vehicleTags = await db.metaGet('vehicle_tags', []);
  const sourceDefaults = await db.metaGet('source_defaults', {});
  const storeCategoryMap = await db.metaGet('store_category_map', {});
  const keywordRules = await db.metaGet('keyword_category_rules', []);
  const activeDebts = (await db.getAll('debts')).filter((d) => d.status === 'active');
  const incomeCats = await db.metaGet('income_categories', []);

  // 編輯（修正）模式：載入既有資料；或對帳帶進來的預填草稿（非編輯、視為新一筆）
  let rec = null;
  if (editingId != null) rec = await db.get('transactions', editingId);
  const isEdit = !!rec;

  // Part 2 防呆：算各帳戶「現在餘額」，確認卡用來預估「扣這筆後會不會變負」。
  // 編輯時排除這筆本身（避免自己扣自己重複計）；歷史交易不影響餘額故不警告。
  const allTxnsForBal = await db.getAll('transactions');
  const txnsForBal = isEdit ? allTxnsForBal.filter((t) => t.id !== editingId) : allTxnsForBal;
  const balancesById = {};
  for (const a of accounts) balancesById[a.id] = accountBalance(a, txnsForBal);
  const skipNegCheck = !!(isEdit && rec && rec.historical); // 歷史不動餘額 → 不警告
  if (!isEdit && prefillDraft) { rec = prefillDraft; prefillDraft = null; } // 一次性消耗
  // 從帳單卡「記一筆」帶來的來源帳單：入帳成功後自動把該帳單標記為本月已繳（編輯模式不適用）
  const sourceBillId = (!isEdit && rec && rec.source_bill_id) || null;

  const acctOptions = (sel) => `<option value="">—請選擇—</option>` +
    accounts.map((a) => `<option value="${a.id}" ${String(sel) === String(a.id) ? 'selected' : ''}>${a.name}（${OWNER_LABEL[a.owner] || ''}）</option>`).join('');
  const catOptions = (sel) => `<option value="">—未分類—</option>` +
    catsSorted(categories).map((c) => `<option value="${c.id}" ${String(sel) === String(c.id) ? 'selected' : ''}>${c.name}</option>`).join('');
  const incCatOptions = (sel) => `<option value="">—未分類—</option>` +
    incomeCats.map((c) => `<option value="${c.id}" ${String(sel) === String(c.id) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  const tagOptions = (arr, sel) => `<option value="">—無—</option>` +
    arr.map((t) => `<option value="${t}" ${sel === t ? 'selected' : ''}>${t}</option>`).join('');

  const curType = rec?.type || 'expense';
  view.innerHTML = '';

  if (!isEdit) {
    const b = el(`<div class="row" style="margin-bottom:10px"><button class="btn ghost" id="goBatch">📋 改用批次貼多行（一次多筆）</button></div>`);
    b.querySelector('#goBatch').addEventListener('click', () => { clearEditing(); navigate('batch'); });
    view.appendChild(b);
  }

  if (isEdit) {
    const backRow = el(`<div class="row" style="margin-bottom:10px"><button class="btn ghost" id="backToList">← 返回明細</button></div>`);
    backRow.querySelector('#backToList').addEventListener('click', () => { clearEditing(); navigate('list'); });
    view.appendChild(backRow);
    const prot = isProtected(rec.status);
    view.appendChild(el(`<div class="warnbox">這一筆 #${rec.id}（目前狀態：${STATUS_LABEL[rec.status]}）的詳情。改了欄位按下方「確認修正」才會變動${prot ? '；這筆已受保護，只有你手動改才會動' : ''}。看完直接按上面「← 返回明細」即可。</div>`));
  }

  const form = el(`<section class="card">
    <h2>${isEdit ? '修正這一筆' : '記一筆'}</h2>

    ${isEdit ? '' : `<div class="parse-box">
      <div class="lab">貼上文字 / 截圖辨識文字（規則自動填草稿，認不準的留空給你補）</div>
      <textarea id="f_paste" rows="2" placeholder="例：前天在全聯刷玉山卡 $450　或　把扣款截圖用 iOS 長按選字複製貼來"></textarea>
      <button type="button" class="btn sm" id="btnParse">自動解析</button>
      <div class="note" id="parseNotes"></div>
    </div>`}

    <div class="seg" id="segType">
      ${['expense', 'income', 'transfer', 'receivable'].map((t) => `<button type="button" class="seg-btn ${t === curType ? 'on' : ''}" data-t="${t}">${t === 'receivable' ? '應收/借出' : TXTYPE_LABEL[t]}</button>`).join('')}
    </div>

    <label class="field"><span class="lab">日期（預設今天；之後可改）</span>
      <input id="f_date" type="date" value="${rec?.date || todayStr()}" /></label>
    <div class="rel-row">
      <input id="f_rel" placeholder="用講的：昨天 / 前天 / 三天前 / 上週三" />
      <button type="button" class="btn sm ghost" id="btnRel">換算</button>
    </div>
    <div class="note" id="relHint"></div>
    <div class="note" id="weekdayHint"></div>

    <label class="field"><span class="lab">金額</span>
      <input id="f_amount" type="number" inputmode="decimal" placeholder="必填；沒填會標『待補』" value="${rec?.amount ?? ''}" /></label>

    <label class="field" id="wrap_from"><span class="lab" id="lab_from">付款來源帳戶</span>
      <select id="f_from">${acctOptions(rec?.from_account_id)}</select></label>

    <label class="field" id="wrap_to"><span class="lab" id="lab_to">收款 / 目標帳戶</span>
      <select id="f_to">${acctOptions(rec?.to_account_id)}</select></label>

    <label class="field"><span class="lab" id="lab_cat">主分類（§4.1）</span>
      <select id="f_cat">${curType === 'income' ? incCatOptions(rec?.category_id) : catOptions(rec?.category_id)}</select></label>

    <label class="field"><span class="lab">關聯負債（繳貸款時選；本金會跟著遞減）</span>
      <select id="f_debt"><option value="">—無—</option>
      ${activeDebts.map((d) => `<option value="${d.id}" ${String(rec?.debt_id) === String(d.id) ? 'selected' : ''}>${escapeHtml(d.name)}（月付 ${money(d.monthly_amount)}）</option>`).join('')}</select></label>

    <div class="row">
      <label class="field"><span class="lab">對象標籤</span><select id="f_party">${tagOptions(partyTags, rec?.party_tag)}</select></label>
      <label class="field"><span class="lab">車輛標籤</span><select id="f_vehicle">${tagOptions(vehicleTags, rec?.vehicle_tag)}</select></label>
    </div>

    <label class="field"><span class="lab">地點 / 店家（選填，沒有就留空）</span>
      <input id="f_merchant" placeholder="外送/網購可留空" value="${rec?.merchant ? rec.merchant.replace(/"/g, '&quot;') : ''}" /></label>

    <label class="field"><span class="lab">備註（選填）</span>
      <input id="f_note" value="${rec?.note ? rec.note.replace(/"/g, '&quot;') : ''}" /></label>

    <div class="entry-err" id="entryErr" style="display:none"></div>
    <button class="btn" id="btnPreview">${isEdit ? '預覽修正' : '產生確認卡'}</button>
    ${isEdit ? '<button class="btn ghost" id="btnCancelEdit" style="margin-top:8px">取消修正</button>' : ''}
  </section>`);
  view.appendChild(form);

  const confirmHost = el(`<div id="confirmHost"></div>`);
  view.appendChild(confirmHost);

  // --- 互動 ---
  let typeNow = curType;
  let assumptions = {};  // 解析時「預設帶入、需你確認」的欄位
  // 分類下拉依型別切換時各自記住的選擇
  let lastExpCat = curType === 'income' ? '' : String(rec?.category_id ?? '');
  let lastIncCat = curType === 'income' ? String(rec?.category_id ?? '') : '';
  const $ = (id) => form.querySelector('#' + id);
  if (curType === 'income') $('f_cat').dataset.mode = 'income';

  // 使用者手動改了帳戶選擇 → 該欄位的「預設假設」即失效（不再提示）
  ['f_from', 'f_to'].forEach((fid) => {
    const fieldKey = fid === 'f_from' ? 'from_account_id' : 'to_account_id';
    form.querySelector('#' + fid).addEventListener('change', () => { delete assumptions[fieldKey]; });
  });

  function refreshTypeUI() {
    // income：只需目標帳戶；expense/receivable：只需來源；transfer：兩者
    const showFrom = typeNow === 'expense' || typeNow === 'transfer' || typeNow === 'receivable';
    const showTo = typeNow === 'income' || typeNow === 'transfer';
    $('wrap_from').style.display = showFrom ? '' : 'none';
    $('wrap_to').style.display = showTo ? '' : 'none';
    $('lab_from').textContent = typeNow === 'transfer' ? '從哪個帳戶搬出' : (typeNow === 'receivable' ? '借出從哪個帳戶/現金扣' : '付款來源帳戶');
    $('lab_to').textContent = typeNow === 'transfer' ? '搬進哪個帳戶' : (typeNow === 'income' ? '錢進哪個帳戶' : '目標帳戶');
    const mLab = form.querySelector('#f_merchant')?.closest('label')?.querySelector('.lab');
    if (mLab) mLab.textContent = typeNow === 'receivable' ? '借給誰（建議填，應收清單會顯示）' : '地點 / 店家（選填，沒有就留空）';
    // 收入 ↔ 支出切換時換分類清單（各自記住上次選擇）
    const catSel = $('f_cat');
    const wantIncome = typeNow === 'income';
    const isIncomeNow = catSel.dataset.mode === 'income';
    if (wantIncome !== isIncomeNow) {
      if (isIncomeNow) lastIncCat = catSel.value; else lastExpCat = catSel.value;
      catSel.innerHTML = wantIncome ? incCatOptions(lastIncCat) : catOptions(lastExpCat);
      catSel.dataset.mode = wantIncome ? 'income' : 'expense';
      $('lab_cat').textContent = wantIncome ? '收入分類' : '主分類（§4.1）';
    }
  }
  function refreshWeekday() {
    const d = $('f_date').value;
    $('weekdayHint').textContent = d ? `這天是 ${weekdayZh(d)}（程式依日期自動算，供你交叉檢查）` : '';
  }
  form.querySelectorAll('#segType .seg-btn').forEach((b) => b.addEventListener('click', () => {
    typeNow = b.dataset.t;
    form.querySelectorAll('#segType .seg-btn').forEach((x) => x.classList.toggle('on', x === b));
    refreshTypeUI();
  }));
  $('f_date').addEventListener('change', () => { refreshWeekday(); $('relHint').textContent = ''; });

  // 日期回推（§6）：把「昨天/前天/三天前/上週三」換算成實際日期，填進日期欄、顯示星期幾交叉檢查
  function doRel() {
    const raw = $('f_rel').value.trim();
    if (!raw) return;
    const r = parseRelativeDate(raw, new Date());
    if (!r) {
      $('relHint').innerHTML = `<span style="color:var(--warn)">「${raw}」判不準（例如單講「週三」分不清這週或上週），請直接用上面的日期選。</span>`;
      return;
    }
    $('f_date').value = r.date;
    refreshWeekday();
    $('relHint').innerHTML = `已換算：<b>${raw} → ${formatWithWeekday(r.date)}</b>（程式用今天回推；請在確認卡再核對一次）`;
  }
  $('btnRel').addEventListener('click', doRel);
  $('f_rel').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doRel(); } });

  // 貼上文字 → 規則自動解析 → 填草稿（§1.2、§9）；認不準留空，不腦補
  const btnParse = form.querySelector('#btnParse');
  if (btnParse) btnParse.addEventListener('click', async () => {
    const raw = form.querySelector('#f_paste').value.trim();
    if (!raw) return;
    // 解析當下重讀最新設定（預設來源／店家記憶／關鍵字規則），避免用到 render 當時的舊快照
    const freshDefaults = await db.metaGet('source_defaults', {});
    const freshStoreMap = await db.metaGet('store_category_map', {});
    const freshKwRules = await db.metaGet('keyword_category_rules', []);
    const { draft, notes, assumptions: asmp } = parseText(raw, { accounts, cards, sourceDefaults: freshDefaults, storeCategoryMap: freshStoreMap, keywordRules: freshKwRules, categories }, new Date());
    typeNow = draft.type;
    assumptions = asmp || {};
    form.querySelectorAll('#segType .seg-btn').forEach((x) => x.classList.toggle('on', x.dataset.t === typeNow));
    refreshTypeUI();
    $('f_date').value = draft.date || todayStr();
    refreshWeekday();
    $('f_amount').value = (draft.amount != null) ? draft.amount : '';
    $('f_merchant').value = draft.merchant || '';
    $('f_from').value = draft.from_account_id ? String(draft.from_account_id) : '';
    $('f_to').value = draft.to_account_id ? String(draft.to_account_id) : '';
    $('f_cat').value = draft.category_id ? String(draft.category_id) : '';
    $('parseNotes').innerHTML = '<b>規則解析結果（請核對、補空欄，再產生確認卡）：</b><br>' + notes.map((n) => '• ' + n).join('<br>');
  });

  refreshTypeUI();
  refreshWeekday();

  function collect() {
    return {
      type: typeNow,
      date: $('f_date').value,
      amount: $('f_amount').value,
      from_account_id: $('f_from').value ? Number($('f_from').value) : null,
      to_account_id: $('f_to').value ? Number($('f_to').value) : null,
      category_id: $('f_cat').value ? (String($('f_cat').value).startsWith('i') ? $('f_cat').value : Number($('f_cat').value)) : null,
      party_tag: $('f_party').value,
      vehicle_tag: $('f_vehicle').value,
      merchant: $('f_merchant').value,
      note: $('f_note').value,
      // 保留既有的事後驗證欄位
      invoice_no: rec?.invoice_no || null,
      screenshot_id: rec?.screenshot_id || null,
      related_txn_id: rec?.related_txn_id || null,
      locked_at: rec?.locked_at || null,
      debt_id: $('f_debt').value ? Number($('f_debt').value) : null,
      source_bill_id: sourceBillId,   // 入帳成功後用來連動帳單「本月已繳」（buildRecord 不會寫進交易）
    };
  }

  $('btnPreview').addEventListener('click', () => {
    const f = collect();
    // income 不需要 from；transfer 兩者；expense/receivable 不需要 to —— 清掉不相干欄位避免誤判
    if (f.type === 'income') f.from_account_id = null;
    if (f.type === 'expense' || f.type === 'receivable') f.to_account_id = null;

    // Feature 1：付款來源「必填才能產生確認卡」。沒選 → 直接擋住，不產生確認卡、也不存草稿。
    const srcMissing = ((f.type === 'expense' || f.type === 'receivable') && !f.from_account_id)
      || (f.type === 'income' && !f.to_account_id)
      || (f.type === 'transfer' && (!f.from_account_id || !f.to_account_id));
    const errBox = $('entryErr');
    if (srcMissing) {
      const what = f.type === 'income' ? '收款帳戶' : (f.type === 'transfer' ? '來源與目標帳戶' : '付款來源');
      errBox.textContent = `⛔ 請先選${what}，才能產生確認卡（來源是入帳必填）。`;
      errBox.style.display = '';
      confirmHost.innerHTML = '';
      errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    errBox.style.display = 'none';

    const issues = findIssues(f);
    // 若該欄位現值已不等於當初預設值，假設失效
    const liveAsmp = {};
    if (assumptions.from_account_id && f.from_account_id) liveAsmp.from_account_id = assumptions.from_account_id;
    if (assumptions.to_account_id && f.to_account_id) liveAsmp.to_account_id = assumptions.to_account_id;
    renderConfirmCard(confirmHost, f, issues, accounts, [...categories, ...incomeCats], isEdit, rec, liveAsmp, activeDebts, skipNegCheck ? null : balancesById);
    confirmHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  if (isEdit) form.querySelector('#btnCancelEdit')?.addEventListener('click', () => { clearEditing(); navigate('list'); });
}

// 確認卡（§5、§6：顯示 日期＋星期幾＋地點＋項目＋金額＋付款來源；確認才寫入）
function renderConfirmCard(host, f, issues, accounts, categories, isEdit, rec, assumptions = {}, debts = [], balancesById = null) {
  const acctName = (id) => accounts.find((a) => a.id === id)?.name || '（未選）';
  const catName = (id) => categories.find((c) => c.id === id)?.name || '（未分類）';
  const blocks = issues.filter((i) => i.level === 'block');
  const confirms = issues.filter((i) => i.level === 'confirm');
  const clean = blocks.length === 0 && confirms.length === 0;

  // §6 確認句
  const dateTxt = formatWithWeekday(f.date);
  const amtTxt = f.amount ? money(f.amount) : '＿＿';
  const where = f.merchant ? `在 ${f.merchant} ` : '';
  let sentence;
  if (f.type === 'expense') sentence = `你是說 ${dateTxt} ${where}花了 ${amtTxt}？`;
  else if (f.type === 'income') sentence = `你是說 ${dateTxt} 有一筆 ${amtTxt} 收入進「${acctName(f.to_account_id)}」？`;
  else if (f.type === 'receivable') sentence = `你是說 ${dateTxt} 借出 ${amtTxt} 給「${f.merchant || '＿＿'}」？（不算支出，列應收清單待收回）`;
  else sentence = `你是說 ${dateTxt} 把 ${amtTxt} 從「${acctName(f.from_account_id)}」搬到「${acctName(f.to_account_id)}」？`;

  const srcLine = f.type === 'income'
    ? `<div class="kv"><span class="name">收款帳戶</span><span>${acctName(f.to_account_id)}</span></div>`
    : f.type === 'transfer'
      ? `<div class="kv"><span class="name">來源 → 目標</span><span>${acctName(f.from_account_id)} → ${acctName(f.to_account_id)}</span></div>`
      : `<div class="kv"><span class="name">付款來源</span><span>${acctName(f.from_account_id)}</span></div>`;

  host.innerHTML = '';
  const card = el(`<section class="card confirm">
    <h2>確認卡</h2>
    <div class="sentence">${sentence}</div>
    <div class="kv"><span class="name">類型</span><span>${TXTYPE_LABEL[f.type]}</span></div>
    <div class="kv"><span class="name">日期（星期）</span><span>${dateTxt}</span></div>
    <div class="kv"><span class="name">地點 / 店家</span><span>${f.merchant || '（空，選填）'}</span></div>
    <div class="kv"><span class="name">項目 / 分類</span><span>${catName(f.category_id)}</span></div>
    <div class="kv"><span class="name">金額</span><span class="amt">${f.amount ? money(f.amount) : '（待補）'}</span></div>
    ${srcLine}
    <div class="kv"><span class="name">標籤</span><span>${[f.party_tag, f.vehicle_tag].filter(Boolean).join('、') || '（無）'}</span></div>
    ${f.note ? `<div class="kv"><span class="name">備註</span><span>${f.note}</span></div>` : ''}
  </section>`);

  // §B：來源是保管金 → 提醒「扣保管金、不算 Wawa 支出」
  const fromAcc = accounts.find((a) => a.id === f.from_account_id);
  if (fromAcc && fromAcc.custody) {
    card.appendChild(el(`<div class="warnbox" style="background:#F4F6F1;border-color:#DEE5D8;color:#3D5244">ℹ 付款來源是「${fromAcc.name}」：會扣保管金餘額並記在明細，但<b>不會</b>計入月報的支出與分類/4群統計。</div>`));
  }

  // §2.5 負債繳款：本利拆分（已知利率自動估、可手動改；利率未知 → 全額暫不扣本金、標待拆）
  const debt = f.debt_id ? debts.find((d) => d.id === f.debt_id) : null;
  if (debt && f.type === 'expense' && f.amount) {
    const amt = Number(f.amount);
    let estI = '', estP = '', splitNote;
    if (debt.rate != null && debt.remaining_principal != null) {
      const i = Math.max(0, Math.round(Number(debt.remaining_principal) * Number(debt.rate) / 100 / 12));
      estI = Math.min(i, amt); estP = Math.max(0, amt - estI);
      splitNote = `依剩餘本金 ${money(debt.remaining_principal)} × 年利率 ${debt.rate}% ÷ 12 估算（可手動改）。本金部分會從這筆負債扣。`;
    } else if (debt.remaining_principal != null) {
      splitNote = '⚠ 利率未知：預設「全額暫不扣本金、標待拆」；你也可以手動填本金/利息。';
    } else {
      splitNote = 'ℹ 這筆負債本金待補：入帳只會把剩餘期數 −1，不動本金。';
    }
    const cur = debt.remaining_terms;
    const splitBox = el(`<div class="warnbox" style="background:#F4F6F1;border-color:#DEE5D8;color:#3D5244" id="splitBox">
      <b>繳「${escapeHtml(debt.name)}」— 本利拆分</b><br><span style="font-size:12.5px">${splitNote}</span>
      <div class="row" style="margin-top:8px">
        <label class="field" style="margin:0"><span class="lab">本金</span><input id="sp_p" type="number" inputmode="numeric" value="${estP}"></label>
        <label class="field" style="margin:0"><span class="lab">利息/費用</span><input id="sp_i" type="number" inputmode="numeric" value="${estI}"></label>
      </div>
      <label class="inline-check" style="margin-top:8px"><input type="checkbox" id="sp_io" ${rec && rec.interest_only ? 'checked' : ''}> <span>只繳息／不計入期數（例：首期只繳利息）</span></label>
      ${cur != null ? `<div style="font-size:12px;margin-top:6px" id="termsPreview">${rec && rec.interest_only ? `剩餘期數不變（只繳息）：維持 ${cur}` : `入帳後剩餘期數 ${cur} → ${Math.max(0, cur - 1)}`}</div>` : ''}
    </div>`);
    card.appendChild(splitBox);
    // 勾「只繳息」→ 期數不變、本金歸 0；預覽即時更新
    const io = splitBox.querySelector('#sp_io');
    const tp = splitBox.querySelector('#termsPreview');
    if (io) io.addEventListener('change', () => {
      if (tp && cur != null) tp.innerHTML = io.checked ? `剩餘期數不變（只繳息）：維持 ${cur}` : `入帳後剩餘期數 ${cur} → ${Math.max(0, cur - 1)}`;
      const spP = splitBox.querySelector('#sp_p');
      if (io.checked && spP) spP.value = '0'; // 只繳息 → 本金 0
    });
  }

  // ── 轉帳手續費自動辨識（§2.5；只往後新記的負債繳款，舊資料一律不動）──────────
  // 使用者只輸入「實際扣款總額」；程式比對該負債月繳排程，差額自動歸手續費或標待確認。
  delete f.fee; delete f.feeNote; // 每次重畫先清掉舊判定
  if (debt && f.type === 'expense' && f.amount != null && f.amount !== '' && !isEdit) {
    const sched = Number(debt.monthly_amount || 0);
    const actual = Number(f.amount);
    const diff = Math.round(actual - sched);
    if (sched > 0 && diff !== 0) {
      if (diff > 0 && diff <= 50) {
        f.fee = { amount: diff, sched, actual };
        card.appendChild(el(`<div class="warnbox" style="background:#F4F6F1;border-color:#DEE5D8;color:#3D5244">
          💳 偵測到<b>轉帳手續費 ${money(diff)}</b>（實際 ${money(actual)} − 月繳 ${money(sched)}）。<br>
          入帳會拆成「繳款 ${money(sched)}」＋「手續費 ${money(diff)}」兩筆：餘額共扣 ${money(actual)}；
          本金／期數一律按月繳 ${money(sched)} 算，手續費只扣餘額、不還本金；手續費扣款帳戶＝這筆來源帳戶。</div>`));
      } else {
        const more = diff > 0;
        f.feeNote = more
          ? `待確認：實際${actual} − 月繳${sched} = 多${diff}（>$50，手續費／延遲金／其他？）`
          : `待確認：實際${actual} 比月繳${sched} 少${-diff}，請確認原因`;
        card.appendChild(el(`<div class="warnbox" style="background:#FBF3E2;border-color:#E7D6A8;color:#7A5B17">
          ⚠ 實際 ${money(actual)} 與月繳 ${money(sched)} 差 ${money(diff)}${more ? '（超過 $50）' : '（金額偏少）'}：
          ${more ? '是手續費／延遲金／其他？不自動猜。' : '請確認原因。'}入帳會照<b>實際金額 ${money(actual)}</b> 記、並在備註標「待確認」，請事後到明細確認分類。</div>`));
      }
    }
  }

  // 段5-1：預設帶入的帳戶 → 在確認卡顯眼提示「我填了 X，對嗎？」（一眼確認）
  const asmpMsg = (f.type === 'income' || f.type === 'transfer') ? assumptions.to_account_id : assumptions.from_account_id;
  if (asmpMsg) {
    card.appendChild(el(`<div class="warnbox" style="background:#eff6ff;border-color:#bfdbfe;color:#1e40af">🔎 ${asmpMsg}（同名有多個帳戶，我帶了預設值；不對的話按「返回修改」改掉）</div>`));
  }

  if (blocks.length) {
    card.appendChild(el(`<div class="warnbox">${blocks.map((b) => '⛔ ' + b.text).join('<br>')}<br>有「待補」缺漏，不能入帳；可先存成待補草稿，補齊再確認。</div>`));
  }
  if (confirms.length) {
    card.appendChild(el(`<div class="warnbox">${confirms.map((b) => '⚠ ' + b.text).join('<br>')}<br>來源判不準，不亂猜；可先存成「待確認」，之後補。</div>`));
  }

  // Part 2：扣款後該帳戶會變負 → 紅字警告，需勾「確定從這個帳戶扣」才放行（一筆只扣一個帳戶一次）。
  let negWarn = null;
  if (balancesById && f.amount && (f.type === 'expense' || f.type === 'receivable' || f.type === 'transfer')) {
    const fromA = accounts.find((a) => a.id === f.from_account_id);
    if (fromA && fromA.type !== 'payment_tool') { // 信用卡（支付工具）非資產帳戶不在此防呆
      const cur = Number(balancesById[fromA.id] ?? 0);
      const after = cur - Number(f.amount);
      if (after < 0) negWarn = { name: fromA.name, cur, after };
    }
  }

  const btns = el(`<div class="confirm-btns"></div>`);
  if (clean) {
    const ok = el(`<button class="btn">${isEdit ? '確認修正（上鎖）' : '確認入帳'}</button>`);
    if (negWarn) {
      card.appendChild(el(`<div class="warnbox" style="background:#fef2f2;border-color:#fecaca;color:#b91c1c">
        ⚠ 此筆將使「${escapeHtml(negWarn.name)}」從 ${money(negWarn.cur)} 變 <b>${money(negWarn.after)}</b>，確定從這個帳戶扣？<br>
        （如果這筆其實該從別的帳戶付，按「返回修改」改付款來源；別重複從兩個帳戶各記一次。）
        <label class="inline-check" style="margin-top:8px"><input type="checkbox" id="negAck"> <span>我確定就是從「${escapeHtml(negWarn.name)}」扣這一筆</span></label></div>`));
      ok.disabled = true;
      card.querySelector('#negAck').addEventListener('change', (e) => { ok.disabled = !e.target.checked; });
    }
    ok.addEventListener('click', () => {
      if (ok.disabled) return;
      // 讀本利拆分輸入（有 splitBox 才有）；都空＝未拆 → 標待拆（不扣本金）
      const spP = card.querySelector('#sp_p'), spI = card.querySelector('#sp_i'), spIO = card.querySelector('#sp_io');
      if (spP || spI) {
        f.interest_only = !!(spIO && spIO.checked); // 只繳息 → 不計入期數
        f.principal_part = f.interest_only ? 0 : (spP && spP.value !== '' ? Number(spP.value) : null);
        f.interest_part = spI && spI.value !== '' ? Number(spI.value) : null;
        f.split_pending = (!f.interest_only && f.principal_part == null && debt && debt.remaining_principal != null);
      }
      // 轉帳手續費（≤$50）：本筆繳款金額改為「月繳排程」，手續費差額由 saveRecord 另記一筆。
      // 本金/期數按月繳算（principal 上限封在月繳額），餘額仍以實際總額為準（=繳款+手續費）。
      if (f.fee) {
        f.amount = f.fee.sched;
        if (f.principal_part != null) f.principal_part = Math.min(Number(f.principal_part), f.fee.sched);
      } else if (f.feeNote) {
        f.note = (f.note ? f.note + '｜' : '') + f.feeNote; // >$50 或負差 → 照實際金額記、備註標待確認
      }
      saveRecord(f, issues, isEdit, rec, { forceLocked: isEdit });
    });
    btns.appendChild(ok);
  } else {
    // 缺金額／缺來源都不能入帳，只能存草稿；標題依缺什麼而定
    const needAmt = blocks.some((b) => b.text.includes('缺金額'));
    const needSrc = blocks.some((b) => b.kind === 'source');
    let label = '存成草稿（補齊再入帳）';
    if (needAmt && needSrc) label = '存成草稿（待補金額＋待確認來源）';
    else if (needAmt) label = '存成待補草稿';
    else if (needSrc) label = '存成待確認草稿（缺付款來源）';
    const draft = el(`<button class="btn ghost">${label}</button>`);
    draft.addEventListener('click', () => saveRecord(f, issues, isEdit, rec, { forceLocked: false }));
    btns.appendChild(draft);
  }
  const back = el(`<button class="btn ghost">返回修改</button>`);
  back.addEventListener('click', () => { host.innerHTML = ''; });
  btns.appendChild(back);
  card.appendChild(btns);
  host.appendChild(card);
}

async function saveRecord(f, issues, isEdit, rec, opts) {
  const ts = nowISO();
  const record = buildRecord(f, issues, ts, { isNew: !isEdit, forceLocked: opts.forceLocked });
  if (isEdit) {
    record.id = rec.id;
    record.created_at = rec.created_at || ts;
    await db.put('transactions', record);
    await db.logChange({ ts, entity: 'transactions', entity_id: rec.id, action: 'correct', before: rec, after: record, note: '使用者修正（修正即上鎖）' });
  } else {
    const id = await db.add('transactions', record);
    await db.logChange({ ts, entity: 'transactions', entity_id: id, action: 'create', before: null, after: { ...record, id }, note: '新增交易' });

    // §2.5 負債繳款本金遞減：只在「新增且已確認」時套用一次。
    // （期數不在這裡 −1：一律由下方 recomputeDebtTerms 以「起點 − 有效繳款數」推導，避免重複扣／刪不回補。）
    if (record.status === STATUS.CONFIRMED && record.debt_id) {
      const d = await db.get('debts', record.debt_id);
      if (d && d.status === 'active') {
        const before = { ...d };
        if (record.principal_part != null && d.remaining_principal != null) {
          d.remaining_principal = Math.max(0, Number(d.remaining_principal) - Number(record.principal_part));
        }
        d.last_paid_at = ts;
        await db.put('debts', d);
        await db.logChange({ ts, entity: 'debts', entity_id: d.id, action: 'debt_payment', before, after: { ...d }, note: `繳款 ${money(record.amount)}（本金 ${record.principal_part != null ? money(record.principal_part) : '未拆'}${record.split_pending ? '・標待拆' : ''}${record.interest_only ? '・只繳息不計期' : ''}）` });
      }
    }

    // 轉帳手續費：≤$50 的差額另記一筆「手續費」交易（category=轉帳手續費、不關聯負債 →
    // 只影響餘額、不動本金/期數）；扣款帳戶＝繼承這筆繳款的來源帳戶（不可留空）。
    if (record.status === STATUS.CONFIRMED && f.fee && Number(f.fee.amount) > 0 && record.from_account_id) {
      const feeCatId = await db.metaGet('fee_category_id', null);
      const feeRec = {
        date: record.date, type: 'expense', amount: Number(f.fee.amount),
        from_account_id: record.from_account_id, to_account_id: null,
        category_id: feeCatId, debt_id: null, party_tag: '', vehicle_tag: '',
        merchant: '轉帳手續費', note: `轉帳手續費（實際${f.fee.actual} − 月繳${f.fee.sched}）`,
        status: 'confirmed', historical: false, is_fee: true, pending_reason: '',
        invoice_no: null, screenshot_id: null, related_txn_id: id,
        created_at: ts, updated_at: ts, locked_at: null,
      };
      const feeId = await db.add('transactions', feeRec);
      await db.logChange({ ts, entity: 'transactions', entity_id: feeId, action: 'create', before: null, after: { ...feeRec, id: feeId }, note: `自動標轉帳手續費 ${money(feeRec.amount)}（繳款 #${id} 實際−月繳差額）` });
    }

    // 帳單連動：從帳單卡「記一筆」且已確認入帳 → 自動把該帳單標記為「該月已繳」，總覽即時反映。
    // 月份取交易日期所屬月（正常流程＝本月），與總覽 done_month 比對一致。
    if (record.status === STATUS.CONFIRMED && f.source_bill_id) {
      const bill = await db.get('bills', f.source_bill_id);
      const billMonth = String(record.date || '').slice(0, 7);
      if (bill && billMonth && bill.done_month !== billMonth) {
        const before = { ...bill };
        bill.done_month = billMonth;
        await db.put('bills', bill);
        await db.logChange({ ts, entity: 'bills', entity_id: bill.id, action: 'mark_paid', before, after: { ...bill }, note: `記一筆入帳後自動標記已繳（${billMonth}）` });
      }
    }
  }

  // 段5-2：學習「店家 → 分類」。只從使用者確認/鎖定、且有店家+分類的交易學。
  if ((record.status === STATUS.CONFIRMED || record.status === STATUS.LOCKED) && record.merchant && record.category_id != null) {
    const map = await db.metaGet('store_category_map', {});
    if (map[record.merchant] !== record.category_id) {
      const before = map[record.merchant] ?? null;
      map[record.merchant] = record.category_id;
      await db.metaSet('store_category_map', map);
      await db.logChange({ ts, entity: 'store_category_map', entity_id: null, action: before == null ? 'learn' : 'update', before: { store: record.merchant, category_id: before }, after: { store: record.merchant, category_id: record.category_id }, note: '店家分類記憶' });
    }
  }

  // 期數重算（治本）：新增或修正都跑，涵蓋改來源/改負債/重新確認；同一筆不重複扣。
  // 修正可能把繳款移到別的負債，故新舊負債都要重算。
  await recomputeDebtTerms([rec && rec.debt_id, record.debt_id, f.debt_id]);

  clearEditing();
  navigate('list');
}

// ---------------------------------------------------------------- 批次輸入（多行）
function escapeHtml(s) { return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// 寫入一筆新交易（批次/對帳共用）：依資料齊全度自動成 已確認 / 待補 / 待確認，並學店家分類。
async function commitNew(f) {
  const issues = findIssues(f);
  const ts = nowISO();
  const record = buildRecord(f, issues, ts, { isNew: true, forceLocked: false });
  const id = await db.add('transactions', record);
  await db.logChange({ ts, entity: 'transactions', entity_id: id, action: 'create', before: null, after: { ...record, id }, note: '批次新增交易' });
  if ((record.status === STATUS.CONFIRMED || record.status === STATUS.LOCKED) && record.merchant && record.category_id != null) {
    const map = await db.metaGet('store_category_map', {});
    if (map[record.merchant] !== record.category_id) {
      const before = map[record.merchant] ?? null;
      map[record.merchant] = record.category_id;
      await db.metaSet('store_category_map', map);
      await db.logChange({ ts, entity: 'store_category_map', entity_id: null, action: before == null ? 'learn' : 'update', before: { store: record.merchant, category_id: before }, after: { store: record.merchant, category_id: record.category_id }, note: '店家分類記憶（批次）' });
    }
  }
  return { ...record, id };
}

// 歷史匯入寫入（§B）：標 historical=true（不影響餘額）、status=confirmed（進統計）。
// 來源可空（歷史只進統計，不卡「來源必填」）。
async function commitHistorical(d, line) {
  const ts = nowISO();
  const rec = {
    date: d.date, type: d.type || 'expense',
    amount: Number(d.amount),
    from_account_id: d.from_account_id || null, to_account_id: d.to_account_id || null,
    category_id: d.category_id ?? null,
    party_tag: d.party_tag || '', vehicle_tag: d.vehicle_tag || '',
    merchant: (d.merchant || '').trim(), note: (d.note || '').trim(),
    status: 'confirmed', historical: true, pending_reason: '',
    import_line: line || '',   // 保留原始行，日後可重新對應
    invoice_no: null, screenshot_id: null, related_txn_id: null,
    created_at: ts, updated_at: ts, locked_at: null,
  };
  const id = await db.add('transactions', rec);
  await db.logChange({ ts, entity: 'transactions', entity_id: id, action: 'import_historical', before: null, after: { ...rec, id }, note: '歷史批次匯入（不影響餘額）' });
  return id;
}

// 歷史匯入查重（數量感知）：同日期＋同金額＋同類型的既有「歷史」筆 → 視為同一行重貼。
// 既有缺分類且這次有 → 補分類；其他 → 略過不重複新增。
// ⚠ 每筆既有記錄一次只能對掉貼入的一筆（used 集合）：貼入 N 筆相同、庫裡只有 M 筆（M<N）
//   → 前 M 筆對掉既有、其餘 N−M 筆照常新增，不會全部誤判重複（例：同日兩筆 $4,500 收入）。
function matchExistingHist(existing, d, used) {
  return existing.find((x) => !x.deleted && x.historical
    && !(used && used.has(x.id))
    && x.date === d.date && Number(x.amount) === Number(d.amount) && x.type === (d.type || 'expense'));
}

// 歷史匯入預覽（§B）：總筆數/總收入/總支出/應收/各分類小計＋解析不了的行，
// 按「確認全部匯入」才一次寫入。
async function renderHistPreview(out, drafts, skips, accounts, categories) {
  out.innerHTML = '';
  // 歷史匯入必須有日期：沒抓到日期的行移到「待補」清單，不匯入
  const ok = [], dateless = [];
  for (const d of drafts) (d.draft.date ? ok : dateless).push(d);

  if (!ok.length && !dateless.length && !skips.length) { out.appendChild(el('<div class="note">沒有可解析的行。</div>')); return; }

  // 查重 dry-run（數量感知）：每筆既有只能對掉貼入的一筆 → N 貼入、M 既有（M<N）會補新增 N−M 筆
  const existing = (await db.getAll('transactions')).filter((t) => !t.deleted && t.historical);
  const usedDry = new Set();
  let willAdd = 0, willFill = 0, willSkip = 0;
  for (const d of ok) {
    const m = matchExistingHist(existing, d.draft, usedDry);
    if (!m) willAdd++;
    else {
      usedDry.add(m.id);
      if (m.category_id == null && d.draft.category_id != null) willFill++;
      else willSkip++;
    }
  }

  let inc = 0, exp = 0, recv = 0, moves = 0;
  const catSum = new Map();
  for (const d of ok) {
    const t = d.draft, a = Number(t.amount || 0);
    if (t.type === 'income') inc += a;
    else if (t.type === 'receivable') recv += a;
    else if (t.type === 'transfer') moves += a;
    else { exp += a; const k = t.category_id ?? null; catSum.set(k, (catSum.get(k) || 0) + a); }
  }
  const catName = (id) => id == null ? '未分類' : (categories.find((c) => String(c.id) === String(id))?.name || '未分類');
  const acctName = (id) => id == null ? '（未填）' : (accounts.find((a) => a.id === id)?.name || '?');

  const sum = el(`<section class="card" style="border-color:var(--gold)"><h2>歷史匯入預覽（不影響餘額）</h2>
    <div class="kv"><span class="name">總筆數</span><span class="amt">${ok.length} 筆</span></div>
    <div class="kv"><span class="name">將新增 / 補分類 / 略過重複</span><span class="amt">${willAdd} / ${willFill} / ${willSkip}</span></div>
    <div class="kv"><span class="name">總收入</span><span class="amt pos">${money(inc)}</span></div>
    <div class="kv"><span class="name">總支出</span><span class="amt neg">${money(exp)}</span></div>
    ${recv ? `<div class="kv"><span class="name">應收款（進應收清單）</span><span class="amt">${money(recv)}</span></div>` : ''}
    ${moves ? `<div class="kv"><span class="name">內部移動（只記出入）</span><span class="amt">${money(moves)}</span></div>` : ''}
    <div class="group-title">各分類小計</div>
    ${[...catSum.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="kv"><span class="name">${catName(k)}</span><span class="amt">${money(v)}</span></div>`).join('') || '<div class="note">（沒有支出）</div>'}
  </section>`);
  out.appendChild(sum);

  // 分類欄對不上的（會變未分類）→ 列原始分類文字讓使用者看
  const unmatchedCol = ok.filter((d) => d.draft.category_id == null && d.draft.col_text && !d.draft.col_matched);
  if (unmatchedCol.length) {
    const uc = el(`<section class="card" style="border-color:var(--warn)"><h2 style="color:var(--warn)">分類欄對不上（${unmatchedCol.length}）→ 會記為未分類</h2></section>`);
    for (const d of unmatchedCol) uc.appendChild(el(`<div class="kv"><span class="name">${escapeHtml(d.line.slice(0, 30))}</span><span class="sub">分類欄「${escapeHtml(d.draft.col_text)}」</span></div>`));
    out.appendChild(uc);
  }

  // 逐筆清單（核對用）
  const list = el(`<section class="card"><h2>將匯入的明細（${ok.length} 筆）</h2></section>`);
  for (const d of ok) {
    const t = d.draft;
    const tag = t.type === 'income' ? '收入' : t.type === 'receivable' ? '應收' : t.type === 'transfer' ? '移動' : catName(t.category_id);
    list.appendChild(el(`<div class="kv"><span><span class="name">${escapeHtml(t.merchant || d.line.slice(0, 24))}</span><br>
      <span class="sub">${t.date}・${tag}・${t.type === 'income' ? acctName(t.to_account_id) : acctName(t.from_account_id)}</span></span>
      <span class="amt ${t.type === 'income' ? 'pos' : (t.type === 'expense' ? 'neg' : '')}">${money(t.amount)}</span></div>`));
  }
  out.appendChild(list);

  // 解析不了 / 缺日期的行：列出讓使用者補，不丟掉、不匯入
  if (skips.length || dateless.length) {
    const sk = el(`<section class="card" style="border-color:var(--warn)"><h2 style="color:var(--warn)">需要你補的行（${skips.length + dateless.length}）— 不會匯入</h2></section>`);
    for (const s of skips) sk.appendChild(el(`<div class="kv"><span class="name">${escapeHtml(s.line)}</span></div><div class="txn-warn" style="margin-bottom:8px">${s.reason}</div>`));
    for (const d of dateless) sk.appendChild(el(`<div class="kv"><span class="name">${escapeHtml(d.line)}</span></div><div class="txn-warn" style="margin-bottom:8px">沒抓到日期（歷史匯入需要日期，請在行內加上日期再重解析）</div>`));
    out.appendChild(sk);
  }

  if (ok.length) {
    const btn = el(`<button class="btn" style="width:100%;margin-bottom:14px">確認全部匯入（新增 ${willAdd}・補分類 ${willFill}・略過 ${willSkip}）</button>`);
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '匯入中…';
      let added = 0, filled = 0, skipped = 0;
      // 配對池＝匯入前的既有歷史筆；本批新增「不」回流進池（同批 N 筆相同就要進 N 筆）
      const live = (await db.getAll('transactions')).filter((t) => !t.deleted && t.historical);
      const usedIds = new Set();
      for (const d of ok) {
        const m = matchExistingHist(live, d.draft, usedIds);
        if (m) usedIds.add(m.id);
        if (!m) {
          await commitHistorical(d.draft, d.line);
          added++;
        } else if (m.category_id == null && d.draft.category_id != null) {
          const before = { ...m };
          m.category_id = d.draft.category_id;
          if (!m.merchant && d.draft.merchant) m.merchant = d.draft.merchant;
          if (!m.import_line) m.import_line = d.line;
          await db.put('transactions', m);
          await db.logChange({ ts: nowISO(), entity: 'transactions', entity_id: m.id, action: 'hist_fill_category', before, after: { ...m }, note: '歷史重貼補分類（分類欄）' });
          filled++;
        } else skipped++;
      }
      btn.textContent = `✅ 新增 ${added}・補分類 ${filled}・略過重複 ${skipped}`;
      out.appendChild(el('<div class="note">餘額完全沒動；去「報表」切到對應月份看統計與分類歸位。</div>'));
    });
    out.appendChild(btn);
  }
}

export async function renderBatch(view) {
  const accounts = (await db.getAll('accounts')).filter((a) => !a.archived).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const cards = await db.getAll('cards');
  const categories = await db.metaGet('categories', []);
  const partyTags = await db.metaGet('party_tags', []);

  view.innerHTML = '';
  view.appendChild(el(`<div class="row" style="margin-bottom:10px"><button class="btn ghost" id="backEntry">← 回單筆記一筆</button></div>`));
  view.querySelector('#backEntry').addEventListener('click', () => navigate('entry'));
  view.appendChild(el(`<div class="warnbox">批次輸入：一行一筆貼進來，我逐行解析、排成一疊草稿，你<b>逐筆確認才入帳</b>（不會自動存）。多筆／沒金額／沒發生的行會標「跳過」、不亂記。付款來源必填才能入帳。</div>`));

  const box = el(`<section class="card">
    <h2>批次貼多行（一行一筆）</h2>
    <textarea id="bText" rows="6" placeholder="例：
昨天先生拿我的現金 500
7-11買早餐 linepay 200
玉山轉帳 5000 到郵局"></textarea>
    <label class="inline-check" style="margin-top:10px"><input type="checkbox" id="bHist">
      <span><b>歷史匯入（不影響餘額）</b>：只進月報/分類/4群統計與帳戶出入分析，不動帳戶與保管金餘額</span></label>
    <button class="btn" id="bGo" style="margin-top:10px">解析多行</button>
  </section>`);
  view.appendChild(box);
  const out = el(`<div id="bOut"></div>`);
  view.appendChild(out);

  box.querySelector('#bGo').addEventListener('click', async () => {
    const raw = box.querySelector('#bText').value;
    const sourceDefaults = await db.metaGet('source_defaults', {});
    const storeCategoryMap = await db.metaGet('store_category_map', {});
    const keywordRules = await db.metaGet('keyword_category_rules', []);
    const knownStores = Object.keys(storeCategoryMap);
    const ctx = { accounts, cards, sourceDefaults, storeCategoryMap, keywordRules, categories };
    const drafts = [], skips = [];
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const cls = classifyLine(t, knownStores);
      if (cls.skip) {
        // 一行多筆 → 先試自動拆分；拆得出 2 筆以上就排成多張草稿卡（仍逐張確認，不自動存）
        if (cls.multi) {
          const multi = splitMultiExpense(t, ctx, new Date());
          if (multi) {
            multi.items.forEach((it, i) => drafts.push({
              line: `${it.seg}　（拆 ${i + 1}/${multi.items.length}）`,
              draft: it.draft, notes: it.notes,
            }));
            continue;
          }
        }
        skips.push({ line: t, reason: cls.reason });
        continue;
      }
      const { draft, notes } = parseText(t, ctx, new Date());
      // 歷史匯入：含「借/暫借/應收」的支出行 → 應收款（進應收清單、不扣餘額）
      const isHist = !!box.querySelector('#bHist')?.checked;
      if (isHist && draft.type === 'expense' && /(應收|暫借|借出|借給|借(?!記))/.test(t)) {
        draft.type = 'receivable';
        notes.push('歷史匯入：判定為應收款（借出）→ 進應收清單待收款、不扣餘額');
      }
      // 應收款（含分類欄判出來的）：抓「借給誰」當對象顯示
      if (isHist && draft.type === 'receivable' && !draft.merchant) {
        const m = t.match(/借(?:給)?\s*([^\s$＄0-9，,＋+、｜]{1,6})/);
        if (m) draft.merchant = m[1];
      }
      // 收入沒帶分類欄時 → 用整行做多欄位歸類（做客/額外收入/工作收入/營業→i1、先生薪水…→i2）
      if (isHist && draft.type === 'income' && !draft.category_id) {
        const cid = db.classifyIncomeSignal(t);
        if (cid) { draft.category_id = cid; notes.push(`收入歸類（整行比對）→ ${cid}`); }
      }
      drafts.push({ line: t, draft, notes });
    }
    if (box.querySelector('#bHist')?.checked) {
      await renderHistPreview(out, drafts, skips, accounts, categories);
    } else {
      renderBatchResult(out, drafts, skips, accounts, categories, partyTags);
    }
  });
}

function renderBatchResult(out, drafts, skips, accounts, categories, partyTags = []) {
  out.innerHTML = '';
  if (!drafts.length && !skips.length) { out.appendChild(el('<div class="note">沒有可解析的行。</div>')); return; }
  if (drafts.length) {
    out.appendChild(el(`<div class="group-title">待辦草稿（${drafts.length}）— 逐筆看過、確認才入帳</div>`));
    drafts.forEach((d) => out.appendChild(buildBatchCard(d, accounts, categories, partyTags)));
  }
  if (skips.length) {
    const sk = el(`<section class="card" style="border-color:var(--warn)"><h2 style="color:var(--warn)">跳過（${skips.length}）— 沒幫你記</h2></section>`);
    skips.forEach((s) => sk.appendChild(el(`<div class="kv"><span class="name">${escapeHtml(s.line)}</span></div><div class="txn-warn" style="margin-bottom:8px">${s.reason}</div>`)));
    out.appendChild(sk);
  }
}

function buildBatchCard(d, accounts, categories, partyTags = []) {
  const draft = d.draft;
  const acctOpts = (sel) => `<option value="">—請選擇—</option>` + accounts.map((a) => `<option value="${a.id}" ${String(sel) === String(a.id) ? 'selected' : ''}>${a.name}</option>`).join('');
  const catOpts = (sel) => `<option value="">—未分類—</option>` + catsSorted(categories).map((c) => `<option value="${c.id}" ${String(sel) === String(c.id) ? 'selected' : ''}>${c.name}</option>`).join('');
  const partyOpts = (sel) => `<option value="">—無—</option>` + partyTags.map((t) => `<option value="${escapeHtml(t)}" ${sel === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
  const ty0 = draft.type || 'expense';

  const card = el(`<section class="card batch-card">
    <div class="batch-line">📝 ${escapeHtml(d.line)}</div>
    <div class="row">
      <label class="field"><span class="lab">類型</span><select data-f="type">
        <option value="expense" ${ty0 === 'expense' ? 'selected' : ''}>支出</option>
        <option value="income" ${ty0 === 'income' ? 'selected' : ''}>收入</option>
        <option value="transfer" ${ty0 === 'transfer' ? 'selected' : ''}>內部移動</option></select></label>
      <label class="field"><span class="lab">金額</span><input data-f="amount" type="number" inputmode="decimal" value="${draft.amount ?? ''}" /></label>
    </div>
    <label class="field"><span class="lab">日期</span><input data-f="date" type="date" value="${draft.date || todayStr()}" /></label>
    <label class="field" data-wrap="from"><span class="lab" data-lab="from">付款來源</span><select data-f="from">${acctOpts(draft.from_account_id)}</select></label>
    <label class="field" data-wrap="to"><span class="lab" data-lab="to">目標帳戶</span><select data-f="to">${acctOpts(draft.to_account_id)}</select></label>
    <label class="field"><span class="lab">分類（建議，可改）</span><select data-f="cat">${catOpts(draft.category_id)}</select></label>
    <label class="field"><span class="lab">對象標籤（建議，可改）</span><select data-f="party">${partyOpts(draft.party_tag || '')}</select></label>
    <label class="field"><span class="lab">店家（選填）</span><input data-f="merchant" value="${escapeHtml(draft.merchant)}" /></label>
    <div class="note batch-notes">${d.notes.map((n) => '• ' + n).join('<br>')}</div>
    <button class="btn" data-go></button>
    <div class="batch-done" style="display:none"></div>
  </section>`);

  const q = (s) => card.querySelector(s);
  function collect() {
    const ty = q('[data-f="type"]').value;
    return {
      type: ty,
      date: q('[data-f="date"]').value,
      amount: q('[data-f="amount"]').value,
      from_account_id: (ty !== 'income' && q('[data-f="from"]').value) ? Number(q('[data-f="from"]').value) : null,
      to_account_id: (ty !== 'expense' && q('[data-f="to"]').value) ? Number(q('[data-f="to"]').value) : null,
      category_id: q('[data-f="cat"]').value ? Number(q('[data-f="cat"]').value) : null,
      merchant: q('[data-f="merchant"]').value,
      party_tag: q('[data-f="party"]').value || '', vehicle_tag: '', invoice_no: null, screenshot_id: null, related_txn_id: null, locked_at: null,
    };
  }
  function refreshTypeUI() {
    const ty = q('[data-f="type"]').value;
    q('[data-wrap="from"]').style.display = (ty === 'expense' || ty === 'transfer') ? '' : 'none';
    q('[data-wrap="to"]').style.display = (ty === 'income' || ty === 'transfer') ? '' : 'none';
    q('[data-lab="from"]').textContent = ty === 'transfer' ? '從哪個帳戶搬出' : '付款來源';
    q('[data-lab="to"]').textContent = ty === 'transfer' ? '搬進哪個帳戶' : (ty === 'income' ? '錢進哪個帳戶' : '目標帳戶');
  }
  function refreshBtn() {
    const issues = findIssues(collect());
    const btn = q('[data-go]');
    btn.disabled = false;
    const sameAcct = issues.some((i) => i.text.includes('同一個帳戶'));
    const needAmt = issues.some((i) => i.text.includes('缺金額'));
    const needSrc = issues.some((i) => i.kind === 'source');
    if (sameAcct) { btn.textContent = '來源與目標不能相同'; btn.className = 'btn ghost'; btn.disabled = true; }
    else if (needAmt) { btn.textContent = '存待補草稿'; btn.className = 'btn ghost'; }
    else if (needSrc) { btn.textContent = '存待確認草稿（缺來源）'; btn.className = 'btn ghost'; }
    else { btn.textContent = '入帳'; btn.className = 'btn'; }
  }
  card.querySelectorAll('[data-f]').forEach((elm) => elm.addEventListener('change', () => { refreshTypeUI(); refreshBtn(); }));
  q('[data-go]').addEventListener('click', async () => {
    const rec = await commitNew(collect());
    card.querySelectorAll('label, .row, .batch-notes, [data-go]').forEach((e) => { e.style.display = 'none'; });
    const done = q('.batch-done'); done.style.display = '';
    const lbl = rec.status === 'confirmed' ? '已入帳'
      : (rec.pending_reason && rec.pending_reason.includes('金額') ? '已存待補' : '已存待確認');
    done.innerHTML = `<span style="color:var(--ok);font-weight:700">✅ ${lbl}　#${rec.id}</span>`;
  });
  refreshTypeUI();
  refreshBtn();
  return card;
}

// ---------------------------------------------------------------- 對帳（§7）
export async function renderReconcile(view) {
  const settings = await db.metaGet('settings', {});
  const windowDays = settings.dedup_window_days ?? 10;

  view.innerHTML = '';
  view.appendChild(el(`<div class="warnbox">對帳 ≠ 記一筆：這裡貼「發票 / 銀行扣款」的文字，我去<b>比對既有紀錄</b>（事後驗證，不是再記一次）。同金額不同店家不會自動合併；≤${windowDays} 天內一律問你。</div>`));

  const box = el(`<section class="card">
    <h2>貼上發票 / 扣款文字</h2>
    <textarea id="rcText" rows="3" placeholder="把發票或銀行扣款截圖用 iOS 文字辨識複製貼來，例：全聯 $450 6/05 發票 AB-12345678"></textarea>
    <button class="btn" id="rcGo" style="margin-top:8px">開始對帳</button>
  </section>`);
  view.appendChild(box);
  const result = el(`<div id="rcResult"></div>`);
  view.appendChild(result);

  // 對帳輔助：搜尋既有交易（即時過濾，點列看詳情）——幫忙人工核對
  const [rcAccounts, rcAllTxns, rcCats, rcIncCats] = await Promise.all([
    db.getAll('accounts'), db.getAll('transactions'), db.metaGet('categories', []), db.metaGet('income_categories', []),
  ]);
  const rcCatsAll = [...rcCats, ...rcIncCats];
  const rcById = new Map(rcAllTxns.map((t) => [t.id, t]));
  const rcLive = rcAllTxns.filter((t) => !t.deleted).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const searchCard = el(`<section class="card"><h2>搜尋既有交易（核對用）</h2>
    <div class="search-row"><input id="rcSearch" placeholder="🔍 搜尋項目/店家/備註/金額/分類/帳戶" />
      <span class="search-count" id="rcSearchCount"></span></div>
    <div id="rcSearchList"></div></section>`);
  view.appendChild(searchCard);
  const rcListEl = searchCard.querySelector('#rcSearchList');
  const rcRender = (kw) => {
    rcListEl.innerHTML = '';
    const k = normSearch(kw);
    if (!k) { searchCard.querySelector('#rcSearchCount').textContent = '輸入關鍵字搜尋'; return; }
    const hits = rcLive.filter((t) => txnSearchText(t, rcAccounts, rcCatsAll).includes(k)).slice(0, 50);
    searchCard.querySelector('#rcSearchCount').textContent = `符合 ${hits.length} 筆${hits.length >= 50 ? '（只列前 50）' : ''}`;
    for (const t of hits) {
      const row = el(`<div class="txn">${txnSummaryHTML(t, rcAccounts, rcCatsAll, rcById)}<div class="txn-side"><span class="badge b-${t.status}">${STATUS_LABEL[t.status]}</span></div></div>`);
      row.querySelector('.txn-main').addEventListener('click', () => beginEdit(t.id));
      rcListEl.appendChild(row);
    }
  };
  searchCard.querySelector('#rcSearch').addEventListener('input', (e) => rcRender(e.target.value));
  rcRender('');

  box.querySelector('#rcGo').addEventListener('click', async () => {
    const raw = box.querySelector('#rcText').value.trim();
    if (!raw) return;
    const accounts = (await db.getAll('accounts')).filter((a) => !a.archived);
    const cards = await db.getAll('cards');
    const sourceDefaults = await db.metaGet('source_defaults', {});
    const storeCategoryMap = await db.metaGet('store_category_map', {});
    const keywordRules = await db.metaGet('keyword_category_rules', []);
    const rcCategories = await db.metaGet('categories', []);
    const { draft } = parseText(raw, { accounts, cards, sourceDefaults, storeCategoryMap, keywordRules, categories: rcCategories }, new Date());
    const recon = {
      amount: draft.amount,
      date: draft.date || todayStr(),
      merchant: draft.merchant || '',
      invoice_no: scanInvoice(raw),
      from_account_id: draft.from_account_id,
      to_account_id: draft.to_account_id,
      type: draft.type,
      category_id: draft.category_id,
    };
    const txns = (await db.getAll('transactions')).filter((t) => !t.deleted);
    const r = matchReconcile(recon, txns, windowDays);
    renderReconResult(result, recon, r, accounts, windowDays);
  });
}

function reconSummaryHTML(recon) {
  return `<div class="kv"><span class="name">金額</span><span class="amt">${money(recon.amount)}</span></div>
    <div class="kv"><span class="name">日期</span><span>${formatWithWeekday(recon.date)}</span></div>
    <div class="kv"><span class="name">店家</span><span>${recon.merchant || '（對帳資料沒店名）'}</span></div>
    <div class="kv"><span class="name">發票/序號</span><span>${recon.invoice_no || '（無）'}</span></div>`;
}
function txnBriefHTML(t, acctName) {
  const src = t.type === 'income' ? `→ ${acctName(t.to_account_id)}`
    : t.type === 'transfer' ? `${acctName(t.from_account_id)} → ${acctName(t.to_account_id)}`
    : `${acctName(t.from_account_id)}`;
  return `<div class="txn-title">#${t.id} ${t.merchant || TXTYPE_LABEL[t.type]}　<span class="amt">${money(t.amount)}</span></div>
    <div class="txn-sub">${formatWithWeekday(t.date)}・${TXTYPE_LABEL[t.type]}・${src}・${STATUS_LABEL[t.status]}${t.verified ? '・✅已驗證' : ''}</div>`;
}

async function renderReconResult(host, recon, r, accounts, windowDays) {
  const acctName = (id) => accounts.find((a) => a.id === id)?.name || '—';
  host.innerHTML = '';
  host.appendChild(el(`<section class="card"><h2>對帳資料（解析結果）</h2>${reconSummaryHTML(recon)}</section>`));

  if (r.layer === 1) {
    // 第 1 層：序號對得上 → 自動標記已驗證（只加驗證標記，不改它的資料）
    await verifyTxn(r.match.id, recon, '對帳：發票/序號相符，自動驗證');
    const card = el(`<section class="card" style="border-color:var(--ok)">
      <h2 style="color:var(--ok)">✅ 已驗證（發票 / 序號對得上）</h2>
      <div class="note">已自動把這筆標記為「已驗證 / 已扣款」，零風險、不重複入帳：</div>
      <div class="txn" style="border:0">${txnBriefHTML({ ...r.match, verified: true }, acctName)}</div>
      <div class="note">這只是加上驗證標記，沒有更動它原本的金額/分類等資料。</div>
    </section>`);
    host.appendChild(card);
    return;
  }

  if (r.layer === 2) {
    // 第 2 層：疑似重複 → 並排給使用者判斷，絕不自動合併
    const card = el(`<section class="card" style="border-color:var(--warn)">
      <h2 style="color:var(--warn)">⚠ 疑似重複（${r.candidates.length} 筆相符，請判斷）</h2>
      <div class="note">金額相同、且日期差 ≤${windowDays} 天。同金額也可能是兩筆不同消費，所以我不自動合併，由你決定：</div>
    </section>`);
    const remaining = new Set(r.candidates.map((c) => c.txn.id));
    const rowMap = new Map(); // txnId → {row, txn}
    let keeperId = null;

    for (const c of r.candidates) {
      const row = el(`<div class="recon-cand">
        <div class="recon-side"><div class="recon-tag">既有紀錄</div>${txnBriefHTML(c.txn, acctName)}
          <div class="txn-sub">日期相差 ${Math.abs(c.dayDiff)} 天${c.merchantUnknown ? '・⚠ 店家資訊不足，請你判斷' : ''}</div></div>
        <div class="recon-btns">
          <button class="btn sm" data-same>同一筆（保留＋標已驗證）</button>
          <button class="btn sm ghost" data-diff>不同筆</button>
        </div>
      </div>`);
      rowMap.set(c.txn.id, { row, txn: c.txn });

      row.querySelector('[data-same]').addEventListener('click', async () => {
        await verifyTxn(c.txn.id, recon, '對帳：使用者判定同一筆');
        keeperId = c.txn.id;
        row.querySelector('.recon-btns').innerHTML = `<span style="color:var(--ok);font-weight:700">✅ 保留這筆並標已驗證（#${c.txn.id}）</span>`;
        remaining.delete(c.txn.id);
        // 其餘相符的既有紀錄 → 提供「也是重複 → 丟垃圾桶」（你按了才移，不靜默）
        for (const id of [...remaining]) {
          const e = rowMap.get(id);
          if (!e) continue;
          const btns = e.row.querySelector('.recon-btns');
          btns.innerHTML = `<button class="btn sm" data-trash style="background:var(--bad)">這筆也是重複 → 丟垃圾桶</button>
            <button class="btn sm ghost" data-keep>不是，保留</button>`;
          btns.querySelector('[data-trash]').addEventListener('click', async () => {
            await trashAsDup(id, keeperId);
            btns.innerHTML = `<span style="color:var(--muted)">🗑 已移入垃圾桶（可在明細復原）</span>`;
            remaining.delete(id);
          });
          btns.querySelector('[data-keep]').addEventListener('click', () => { btns.innerHTML = '<span class="sub">已保留</span>'; remaining.delete(id); });
        }
      });
      row.querySelector('[data-diff]').addEventListener('click', () => {
        row.remove();
        rowMap.delete(c.txn.id);
        remaining.delete(c.txn.id);
        if (remaining.size === 0 && keeperId == null) host.appendChild(buildLayer3Card(recon, '你判定這些都不是同一筆 → 那這可能是還沒記的一筆：'));
      });
      card.appendChild(row);
    }
    host.appendChild(card);
    return;
  }

  // 第 3 層：對不到 → 可能漏記
  host.appendChild(buildLayer3Card(recon, '對不到任何既有紀錄，這筆可能還沒記：'));
}

function buildLayer3Card(recon, lead) {
  const card = el(`<section class="card"><h2>這筆可能漏記</h2>
    <div class="note">${lead}</div>
    <div class="confirm-btns">
      <button class="btn" data-rec>記一筆（帶入這些資料去確認）</button>
      <button class="btn ghost" data-no>不記</button>
    </div></section>`);
  card.querySelector('[data-rec]').addEventListener('click', () => {
    prefillDraft = {
      type: recon.type || 'expense',
      date: recon.date,
      amount: recon.amount,
      merchant: recon.merchant,
      from_account_id: recon.from_account_id || null,
      to_account_id: recon.to_account_id || null,
      category_id: recon.category_id || null,
      invoice_no: recon.invoice_no || null,
      party_tag: '', vehicle_tag: '',
    };
    clearEditing();
    navigate('entry');
  });
  card.querySelector('[data-no]').addEventListener('click', () => {
    card.innerHTML = '<div class="note">好，這筆不記。</div>';
  });
  return card;
}

// 驗證標記（§7）：只加「已驗證」標記＋補上缺的發票號，不更動金額/分類等核心資料。
// 因此對「已確認/已鎖定」的紀錄也允許（屬標記，非修改其資料）。
async function verifyTxn(id, recon, reason) {
  const t = await db.get('transactions', id);
  if (!t) return;
  const before = { ...t };
  t.verified = true;
  t.verified_at = nowISO();
  t.verified_invoice_no = recon.invoice_no || t.invoice_no || '';
  if (!t.invoice_no && recon.invoice_no) t.invoice_no = recon.invoice_no; // 補上缺的序號（標記）
  await db.put('transactions', t);
  await db.logChange({ ts: nowISO(), entity: 'transactions', entity_id: id, action: 'verify', before, after: { ...t }, note: reason });
}

// ---------------------------------------------------------------- 明細
export async function renderList(view) {
  const [allTxns, accounts, categories, incomeCats] = await Promise.all([
    db.getAll('transactions'), db.getAll('accounts'), db.metaGet('categories', []), db.metaGet('income_categories', []),
  ]);
  const allCats = [...categories, ...incomeCats];
  const acctName = (id) => accounts.find((a) => a.id === id)?.name || '?';
  const catName = (id) => allCats.find((c) => String(c.id) === String(id))?.name || '未分類';
  const sortFn = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.created_at || '').localeCompare(a.created_at || '');

  const txns = allTxns.filter((t) => !t.deleted).sort(sortFn);
  const deleted = allTxns.filter((t) => t.deleted).sort(sortFn);

  view.innerHTML = '';
  view.appendChild(el(`<div class="row" style="margin-bottom:12px">
    <button class="btn" id="goEntry">＋ 記一筆</button></div>`));
  view.querySelector('#goEntry').addEventListener('click', () => { clearEditing(); navigate('entry'); });

  if (!txns.length && !deleted.length) {
    view.appendChild(el(`<div class="note">還沒有任何交易。點「＋ 記一筆」開始。</div>`));
    return;
  }

  // 待辦統計（待補＝缺金額；待確認＝缺付款來源）
  const isPending = (t) => t.status === STATUS.PENDING;
  const needAmt = (t) => t.amount == null || t.amount === '';
  const needSrc = (t) => ((t.type === 'expense' || t.type === 'receivable') && !t.from_account_id)
    || (t.type === 'income' && !t.to_account_id)
    || (t.type === 'transfer' && (!t.from_account_id || !t.to_account_id));
  const pendingTxns = txns.filter(isPending);
  const cntAmt = pendingTxns.filter(needAmt).length;
  const cntSrc = pendingTxns.filter((t) => needSrc(t) && !needAmt(t)).length;

  if (pendingTxns.length) {
    const banner = el(`<div class="todo-banner">
      <span>📌 待補 <b>${cntAmt}</b> 筆、待確認 <b>${cntSrc}</b> 筆</span>
      <button class="btn sm ${listFilter === 'todo' ? '' : 'ghost'}" id="todoToggle">${listFilter === 'todo' ? '顯示全部' : '只看待辦'}</button>
    </div>`);
    banner.querySelector('#todoToggle').addEventListener('click', () => { listFilter = listFilter === 'todo' ? 'all' : 'todo'; navigate('list'); });
    view.appendChild(banner);
  } else if (listFilter === 'todo') {
    listFilter = 'all'; // 沒有待辦了就自動回全部
  }

  const displayed = listFilter === 'todo' ? pendingTxns : txns;
  const selected = new Set();
  const txById = new Map(allTxns.map((t) => [t.id, t]));

  // 一筆交易摘要列（明細與已刪除共用；委派給共用函式，再補 pending_reason）
  function rowSummary(t) {
    const inner = txnSummaryHTML(t, accounts, allCats, txById);
    if (!t.pending_reason) return inner;
    return inner.replace(/<\/div>\s*$/, `<div class="txn-warn">${escapeHtml(t.pending_reason)}</div></div>`);
  }

  // ---- 正常交易 ----
  if (displayed.length) {
    // 搜尋框（即時過濾：項目/店家/備註/金額/分類/帳戶；可清空、寬鬆比對）
    const searchBox = el(`<div class="search-row">
      <input id="listSearch" placeholder="🔍 搜尋項目/店家/備註/金額/分類/帳戶" value="${escapeHtml(listSearchKw)}" />
      <button class="btn sm ghost" id="listSearchClear">清空</button>
      <span class="search-count" id="listSearchCount"></span></div>`);
    view.appendChild(searchBox);

    const toolbar = el(`<div class="list-toolbar">
      <label class="inline-check"><input type="checkbox" id="selAll"> <span>全選</span></label>
      <span style="display:flex;gap:6px">
        <button class="btn sm" id="dupSel" disabled>標為重複（留1筆）</button>
        <button class="btn sm" id="delSel" style="background:var(--bad)" disabled>刪除（0）</button>
      </span>
    </div>`);
    view.appendChild(toolbar);

    const heading = listFilter === 'todo' ? `待辦草稿（${displayed.length} 筆，補齊後才會入帳）` : `交易明細（共 ${displayed.length} 筆）`;
    const sec = el(`<section class="card"><h2>${heading}</h2></section>`);
    const updateToolbar = () => {
      const n = selected.size;
      const del = toolbar.querySelector('#delSel');
      del.textContent = `刪除（${n}）`;
      del.disabled = n === 0;
      const dup = toolbar.querySelector('#dupSel');
      dup.disabled = n < 2;
    };
    for (const t of displayed) {
      const row = el(`<div class="txn" id="txnrow-${t.id}" data-search="${escapeHtml(txnSearchText(t, accounts, allCats))}">
        <input type="checkbox" class="txn-check" data-id="${t.id}">
        ${rowSummary(t)}
        <div class="txn-side">
          <span class="badge b-${t.status}">${STATUS_LABEL[t.status]}</span>
          <button class="btn sm ghost" data-edit="${t.id}">修正</button>
          <button class="btn sm ghost" data-del="${t.id}" style="color:var(--bad)">刪</button>
        </div>
      </div>`);
      row.querySelector('[data-edit]').addEventListener('click', () => beginEdit(t.id));
      row.querySelector('[data-del]').addEventListener('click', () => confirmDelete([t.id]));
      // 點整列（避開勾選框/按鈕）= 看詳情/修正
      row.querySelector('.txn-main').addEventListener('click', () => beginEdit(t.id));
      const cb = row.querySelector('.txn-check');
      cb.addEventListener('change', () => { cb.checked ? selected.add(t.id) : selected.delete(t.id); updateToolbar(); });
      sec.appendChild(row);
    }
    view.appendChild(sec);

    // 即時搜尋：hide/show 現有列（保留焦點、保留卡樣式與點列看詳情）
    const applySearch = () => {
      const kw = normSearch(listSearchKw);
      let shown = 0;
      sec.querySelectorAll('.txn').forEach((r) => {
        const hit = !kw || (r.dataset.search || '').includes(kw);
        r.style.display = hit ? '' : 'none';
        if (hit) shown += 1;
      });
      const cnt = searchBox.querySelector('#listSearchCount');
      cnt.textContent = kw ? `符合 ${shown} 筆` : '';
    };
    const si = searchBox.querySelector('#listSearch');
    si.addEventListener('input', () => { listSearchKw = si.value; applySearch(); });
    searchBox.querySelector('#listSearchClear').addEventListener('click', () => { listSearchKw = ''; si.value = ''; applySearch(); si.focus(); });
    applySearch();

    // 從詳情/修正返回時，捲回剛剛那一筆（保留位置；手機與電腦皆可）。
    // 先還原當時的捲動位置（編輯不改變列數，最準）；再 scrollIntoView 對齊那一筆當保險。
    if (listAnchorId != null) {
      const y = listAnchorScrollY;
      const target = sec.querySelector(`#txnrow-${listAnchorId}`);
      const restore = () => {
        if (y) window.scrollTo(0, y);
        if (target) { const r = target.getBoundingClientRect(); if (r.top < 0 || r.top > window.innerHeight) target.scrollIntoView({ block: 'center' }); }
      };
      setTimeout(restore, 0);
      setTimeout(restore, 80);
    }

    toolbar.querySelector('#selAll').addEventListener('change', (e) => {
      selected.clear();
      sec.querySelectorAll('.txn-check').forEach((cb) => { cb.checked = e.target.checked; if (e.target.checked) selected.add(Number(cb.dataset.id)); });
      updateToolbar();
    });
    toolbar.querySelector('#delSel').addEventListener('click', () => confirmDelete([...selected]));
    toolbar.querySelector('#dupSel').addEventListener('click', () => markDuplicates([...selected]));
  }

  // ---- 已刪除（可複選：全選 / 復原 / 永久刪除）----
  if (deleted.length) {
    const dsec = el(`<section class="card"><h2>🗑 已刪除（${deleted.length}）<button class="btn sm ghost" id="toggleDel" style="float:right">展開</button></h2>
      <div class="note">刪掉的交易移到這裡，不計入餘額、不出現在明細/總覽，可隨時復原；「永久刪除」才會真的消失。</div>
      <div id="delWrap" style="display:none">
        <div class="list-toolbar">
          <label class="inline-check"><input type="checkbox" id="delSelAll"> <span>全選</span></label>
          <span style="display:flex;gap:6px">
            <button class="btn sm" id="restoreSel" disabled>復原（0）</button>
            <button class="btn sm" id="hardSel" style="background:var(--bad)" disabled>永久刪除（0）</button>
          </span>
        </div>
        <div id="delList"></div>
      </div></section>`);
    const delWrap = dsec.querySelector('#delWrap');
    const delList = dsec.querySelector('#delList');
    const delSel = new Set();
    const updateDelBar = () => {
      const n = delSel.size;
      const rs = dsec.querySelector('#restoreSel'); rs.textContent = `復原（${n}）`; rs.disabled = n === 0;
      const hs = dsec.querySelector('#hardSel'); hs.textContent = `永久刪除（${n}）`; hs.disabled = n === 0;
    };
    for (const t of deleted) {
      const row = el(`<div class="txn">
        <input type="checkbox" class="del-check" data-id="${t.id}">
        ${rowSummary(t)}
        <div class="txn-side"><span class="badge b-${t.status}">${STATUS_LABEL[t.status]}</span>
        <button class="btn sm" data-restore="${t.id}">復原</button>
        <button class="btn sm ghost" data-hard="${t.id}" style="color:var(--bad)">永久刪</button></div>
      </div>`);
      row.querySelector('[data-restore]').addEventListener('click', () => restoreTxns([t.id]));
      row.querySelector('[data-hard]').addEventListener('click', () => hardDeleteMany([t.id]));
      const cb = row.querySelector('.del-check');
      cb.addEventListener('change', () => { cb.checked ? delSel.add(t.id) : delSel.delete(t.id); updateDelBar(); });
      delList.appendChild(row);
    }
    dsec.querySelector('#delSelAll').addEventListener('change', (e) => {
      delSel.clear();
      delList.querySelectorAll('.del-check').forEach((cb) => { cb.checked = e.target.checked; if (e.target.checked) delSel.add(Number(cb.dataset.id)); });
      updateDelBar();
    });
    dsec.querySelector('#restoreSel').addEventListener('click', () => restoreTxns([...delSel]));
    dsec.querySelector('#hardSel').addEventListener('click', () => hardDeleteMany([...delSel]));
    dsec.querySelector('#toggleDel').addEventListener('click', (e) => {
      const open = delWrap.style.display === 'none';
      delWrap.style.display = open ? '' : 'none';
      e.target.textContent = open ? '收合' : '展開';
    });
    view.appendChild(dsec);
  }
}

// 軟刪除：二次確認 → 標 deleted，移到已刪除區（不計餘額、可復原），寫變更紀錄。只動交易。
async function confirmDelete(ids) {
  if (!ids.length) return;
  if (!confirm(`確定刪除這 ${ids.length} 筆交易嗎？\n（移到「已刪除」可復原，不會永久消失）`)) return;
  const ts = nowISO();
  const affectedDebts = [];
  for (const id of ids) {
    const t = await db.get('transactions', id);
    if (!t || t.deleted) continue;
    if (t.debt_id != null) affectedDebts.push(t.debt_id);
    const before = { ...t };
    t.deleted = true; t.deleted_at = ts;
    await db.put('transactions', t);
    await db.logChange({ ts, entity: 'transactions', entity_id: id, action: 'soft_delete', before, after: { ...t }, note: '使用者刪除（軟刪除，可復原）' });
  }
  await recomputeDebtTerms(affectedDebts); // 刪繳款 → 期數回補
  navigate('list');
}

async function restoreTxns(ids) {
  const ts = nowISO();
  const affectedDebts = [];
  for (const id of ids) {
    const t = await db.get('transactions', id);
    if (!t || !t.deleted) continue;
    if (t.debt_id != null) affectedDebts.push(t.debt_id);
    const before = { ...t };
    delete t.deleted; delete t.deleted_at;
    await db.put('transactions', t);
    await db.logChange({ ts, entity: 'transactions', entity_id: id, action: 'restore', before, after: { ...t }, note: '使用者復原刪除的交易' });
  }
  await recomputeDebtTerms(affectedDebts); // 復原繳款 → 期數再扣回
  navigate('list');
}

// 標為重複：保留一筆（標已驗證），其餘移入垃圾桶（軟刪除、可復原）。使用者按了才做。
async function markDuplicates(ids) {
  if (ids.length < 2) { alert('請先勾選至少兩筆「重複」的交易。'); return; }
  const recs = (await Promise.all(ids.map((id) => db.get('transactions', id)))).filter((t) => t && !t.deleted);
  if (recs.length < 2) { alert('可標記的交易不足兩筆。'); return; }
  // 保留者：優先「已驗證」→ 再日期最早 → 再 id 最小
  recs.sort((a, b) => (Number(!!b.verified) - Number(!!a.verified)) || (a.date || '').localeCompare(b.date || '') || (a.id - b.id));
  const keeper = recs[0];
  const losers = recs.slice(1);
  if (!confirm(`把這 ${recs.length} 筆當成「同一筆（重複）」：\n保留 #${keeper.id}（標已驗證），其餘 ${losers.length} 筆移到垃圾桶（可復原）。確定？`)) return;
  const ts = nowISO();
  const kBefore = { ...keeper };
  keeper.verified = true; keeper.verified_at = ts;
  await db.put('transactions', keeper);
  await db.logChange({ ts, entity: 'transactions', entity_id: keeper.id, action: 'verify', before: kBefore, after: { ...keeper }, note: '標為重複：保留並驗證此筆' });
  const affectedDebts = [];
  for (const t of losers) {
    if (t.debt_id != null) affectedDebts.push(t.debt_id);
    const before = { ...t };
    t.deleted = true; t.deleted_at = ts; t.dup_of = keeper.id;
    await db.put('transactions', t);
    await db.logChange({ ts, entity: 'transactions', entity_id: t.id, action: 'soft_delete', before, after: { ...t }, note: `標為重複：與 #${keeper.id} 同一筆，移入垃圾桶` });
  }
  if (keeper.debt_id != null) affectedDebts.push(keeper.debt_id);
  await recomputeDebtTerms(affectedDebts); // 去重後 → 期數依保留的有效筆數重算
  navigate('list');
}

// 收回沖銷（§B）：在原應收款上標結清＋收回帳戶，不是新的一筆收入。使用者按了才呼叫。
async function settleReceivable(id, toAccountId) {
  const t = await db.get('transactions', id);
  if (!t || t.type !== 'receivable' || t.settled) return;
  const before = { ...t };
  t.settled = true;
  t.settled_at = nowISO();
  t.settled_date = todayStr();
  t.settled_to_account_id = toAccountId || t.from_account_id;
  await db.put('transactions', t);
  await db.logChange({ ts: nowISO(), entity: 'transactions', entity_id: id, action: 'settle_receivable', before, after: { ...t }, note: '收回沖銷：應收結清、補回帳戶（非收入）' });
  navigate('overview');
}

// 對帳用：把某筆當作 keeper 的重複，移入垃圾桶（軟刪除、可復原）。使用者按了才呼叫。
async function trashAsDup(id, keeperId) {
  const t = await db.get('transactions', id);
  if (!t || t.deleted) return;
  const before = { ...t };
  t.deleted = true; t.deleted_at = nowISO(); t.dup_of = keeperId || null;
  await db.put('transactions', t);
  await db.logChange({ ts: nowISO(), entity: 'transactions', entity_id: id, action: 'soft_delete', before, after: { ...t }, note: `對帳：與 #${keeperId} 同一筆，移入垃圾桶` });
}

// 永久刪除（可一筆或多筆）：真的從資料庫移除（含綁定截圖），二次確認、不可復原。
async function hardDeleteMany(ids) {
  if (!ids.length) return;
  if (!confirm(`永久刪除這 ${ids.length} 筆？\n此動作無法復原（垃圾桶也找不回）。`)) return;
  const ts = nowISO();
  const shots = await db.getAll('screenshots');
  const affectedDebts = [];
  for (const id of ids) {
    const t = await db.get('transactions', id);
    if (!t) continue;
    if (!t.deleted && t.debt_id != null) affectedDebts.push(t.debt_id); // 永久刪一筆「還沒軟刪」的繳款 → 回補
    for (const s of shots.filter((x) => x.txn_id === id)) await db.del('screenshots', s.id);
    await db.del('transactions', id);
    await db.logChange({ ts, entity: 'transactions', entity_id: id, action: 'hard_delete', before: t, after: null, note: '永久刪除（不可復原）' });
  }
  await recomputeDebtTerms(affectedDebts);
  navigate('list');
}

// ---------------------------------------------------------------- 設定
export async function renderSettings(view) {
  const accounts = (await db.getAll('accounts')).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const allTxns = await db.getAll('transactions'); // 帳戶卡顯示「目前餘額」即時計算用
  const cards = await db.getAll('cards');
  const categories = await db.metaGet('categories', []);
  const partyTags = await db.metaGet('party_tags', []);
  const vehicleTags = await db.metaGet('vehicle_tags', []);
  const settings = await db.metaGet('settings', {});

  view.innerHTML = '';
  view.appendChild(el(`<div class="warnbox">設定區：改了即永久生效（§12），每次變更都會寫入「變更紀錄」可回溯。</div>`));

  // 帳戶（§A）：拖 ≡ 排序、放開即存、不整頁重畫不跳頁。內部 id 不變。
  const acctCard = el(`<section class="card"><h2>帳戶（§2）<span class="sub" style="font-weight:400">　拖 ≡ 排序</span></h2>
    <div class="sort-list" data-sort="accts"></div></section>`);
  const acctList = acctCard.querySelector('.sort-list');
  accounts.forEach((a) => {
    const bal = Math.round(accountBalance(a, allTxns));
    const box = el(`<div class="acct-edit" data-key="${a.id}">
      <div class="head"><span style="display:flex;gap:8px;align-items:center"><span class="drag-handle" title="拖曳排序">≡</span><span class="nm">${a.name}</span></span>
        <span class="owner-tag">${OWNER_LABEL[a.owner] || ''}・${TYPE_LABEL[a.type] || a.type}</span></div>
      <div class="sub" style="margin-top:2px">期初 ${money(a.opening_balance || 0)}（6/10 校準）　<span data-adv style="cursor:pointer;color:var(--gold-d);text-decoration:underline">⚙ 進階</span></div>

      <div style="font-family:var(--serif);font-size:22px;font-weight:700;margin:8px 0 0">目前餘額 <span class="amt ${bal < 0 ? 'neg' : ''}">${money(bal)}</span></div>
      <div class="note" style="margin:0 0 8px">程式即時計算（期初 ＋ 6/11 起非歷史淨額）</div>

      <div style="border:1px solid var(--line);border-radius:10px;padding:10px;background:#FBFAF6">
        <span class="lab">校正餘額（對帳 §8）</span>
        <div class="note" style="margin:2px 0 0">程式目前 <b>${money(bal)}</b>。與銀行／現金實際不符時，填實際值按「校正」，差額自動歸呆帳。</div>
        <span style="display:flex;gap:6px;align-items:center;margin-top:8px">
          <input data-f="actual" type="number" inputmode="numeric" placeholder="輸入實際餘額" style="max-width:140px"/>
          <button class="btn sm" data-reconcile>校正</button>
        </span>
      </div>

      <label class="inline-check field" style="margin-top:8px"><input data-f="include_in_total" type="checkbox" ${a.include_in_total ? 'checked' : ''}/> <span>算進總資產</span></label>
      <label class="inline-check field"><input data-f="archived" type="checkbox" ${a.archived ? 'checked' : ''}/> <span>封存（不再使用）</span></label>
      <button class="btn sm" data-save>儲存這個帳戶</button>

      <div data-advbox style="display:none;border-top:1px dashed var(--line);padding-top:10px;margin-top:10px">
        <div class="note">⚠ 期初餘額是帳目地基（已於 6/10 校準）。平常對帳請用上面的「校正餘額」；只有要重設地基才改這裡，會再確認一次以免手滑誤改。</div>
        <label class="field"><span class="lab">帳戶名稱</span><input data-f="name" value="${a.name}" /></label>
        <label class="field"><span class="lab">期初餘額</span><input data-f="opening_balance" type="number" inputmode="numeric" value="${a.opening_balance || 0}" /></label>
        <button class="btn sm ghost" data-saveadv>修改名稱／期初（需確認）</button>
      </div>
    </div>`);
    box.querySelector('[data-adv]').addEventListener('click', () => {
      const ab = box.querySelector('[data-advbox]');
      ab.style.display = ab.style.display === 'none' ? '' : 'none';
    });
    box.querySelector('[data-reconcile]').addEventListener('click', async () => {
      const raw = box.querySelector('[data-f="actual"]').value.trim();
      if (raw === '') { alert('請先輸入這個帳戶的實際餘額。'); return; }
      const actual = Math.round(Number(raw));
      if (!isFinite(actual)) { alert('實際餘額要是數字。'); return; }
      const allTx = await db.getAll('transactions');
      const current = Math.round(accountBalance(a, allTx));
      const diff = actual - current;
      if (diff === 0) { alert(`帳實相符：系統與實際都是 ${money(current)}，無需校正。`); return; }
      const isExpense = diff < 0;
      const ok = confirm(`將校正：「${a.name}」 ${money(current)} → ${money(actual)}\n差 ${money(diff)} 歸「呆帳/餘額校正」。\n\n會新增一筆${isExpense ? '支出' : '收入'}校正交易（當期、會影響餘額），校正後此帳戶餘額 = ${money(actual)}。確定？`);
      if (!ok) return;
      const ts = nowISO();
      const rec = {
        date: todayStr(), type: isExpense ? 'expense' : 'income', amount: Math.abs(diff),
        from_account_id: isExpense ? a.id : null, to_account_id: isExpense ? null : a.id,
        category_id: await badDebtCatId(), party_tag: '', vehicle_tag: '',
        merchant: '餘額校正', note: `對帳：實際${actual} − 系統${current} = 差${diff > 0 ? '+' : ''}${diff}`,
        status: 'confirmed', historical: false, is_reconcile: true, pending_reason: '',
        invoice_no: null, screenshot_id: null, related_txn_id: null,
        created_at: ts, updated_at: ts, locked_at: null,
      };
      const id = await db.add('transactions', rec);
      await db.logChange({ ts, entity: 'transactions', entity_id: id, action: 'reconcile_adjust', before: null, after: { ...rec, id }, note: `餘額校正「${a.name}」：系統 ${current} → 實際 ${actual}，差 ${diff} 歸呆帳` });
      alert(`已校正：「${a.name}」現在餘額 = ${money(actual)}（新增呆帳 ${money(diff)}）。`);
      navigate('settings');
    });
    // 主儲存：只動「算進總資產／封存」（期初與名稱移到進階，避免手滑誤改期初）
    box.querySelector('[data-save]').addEventListener('click', async () => {
      const before = { ...a };
      a.include_in_total = box.querySelector('[data-f="include_in_total"]').checked;
      a.archived = box.querySelector('[data-f="archived"]').checked;
      await db.put('accounts', a);
      await db.logChange({ ts: nowISO(), entity: 'accounts', entity_id: a.id, action: 'update', before, after: { ...a }, note: '設定區修改（算進總資產／封存）' });
      const btn = box.querySelector('[data-save]'); btn.textContent = '已儲存 ✓';
      setTimeout(() => { btn.textContent = '儲存這個帳戶'; }, 1500);
    });
    // 進階儲存：改名稱／期初；期初有變動 → 二次確認才寫入（期初是帳目地基）
    box.querySelector('[data-saveadv]').addEventListener('click', async () => {
      const newName = box.querySelector('[data-f="name"]').value.trim() || a.name;
      const newOpen = Number(box.querySelector('[data-f="opening_balance"]').value || 0);
      const openChanged = newOpen !== Number(a.opening_balance || 0);
      if (openChanged && !confirm(`確定要把「${a.name}」的期初餘額從 ${money(a.opening_balance || 0)} 改成 ${money(newOpen)}？\n\n期初是帳目地基，改了會直接影響上面的「目前餘額」。平常對帳請用「校正餘額」，不要動這裡。確定修改？`)) return;
      const before = { ...a };
      a.name = newName;
      a.opening_balance = newOpen;
      await db.put('accounts', a);
      await db.logChange({ ts: nowISO(), entity: 'accounts', entity_id: a.id, action: 'update', before, after: { ...a }, note: openChanged ? '進階：修改期初餘額（二次確認）' : '進階：修改帳戶名稱' });
      navigate('settings');
    });
    acctList.appendChild(box);
  });
  makeSortable(acctList, '.acct-edit', async (order) => {
    for (let i = 0; i < order.length; i++) {
      const a = accounts.find((x) => String(x.id) === String(order[i]));
      if (a) { a.sort = i + 1; await db.put('accounts', a); }
    }
    await db.logChange({ ts: nowISO(), entity: 'accounts', entity_id: null, action: 'reorder', before: null, after: order, note: '拖曳調整帳戶順序（id 不變）' });
  });
  view.appendChild(acctCard);

  const acctName = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const cardCard = el(`<section class="card"><h2>卡 ↔ 帳戶對應（§2）</h2></section>`);
  for (const c of cards) cardCard.appendChild(el(`<div class="kv"><span class="name">${c.name} <span class="sub">末四碼：${c.last4 || '（未填）'}</span></span><span class="sub">→ ${acctName[c.account_id] || '?'}</span></div>`));
  view.appendChild(cardCard);

  // 主分類（§A）：編號＝固定內部 ID 不顯示、不重編；畫面依「顯示排序」；拖 ≡ 排序、放開即存、不跳頁。
  const g4names = await db.metaGet('group4_names', { A: '生活・日常', B: '玩樂・人情・車', C: '固定・剛性', D: '信用卡' });
  const catCard = el(`<section class="card"><h2>主分類 ${categories.length} 類（§4.1）<span class="sub" style="font-weight:400">　可改名・分群・拖 ≡ 排序</span></h2>
    <div class="note">改名是「就地改」（內部編號不變，舊交易與 4 群對應自動連動）。分群：A ${g4names.A}／B ${g4names.B}／C ${g4names.C}／D ${g4names.D}。</div>
    <div class="sort-list" data-sort="cats"></div></section>`);
  const catList = catCard.querySelector('.sort-list');
  for (const c of catsSorted(categories)) {
    const gOpts = ['', 'A', 'B', 'C', 'D'].map((g) => `<option value="${g}" ${String(c.group4 || '') === g ? 'selected' : ''}>${g ? `${g} ${g4names[g] || ''}` : '—未分群—'}</option>`).join('');
    const row = el(`<div class="cat-edit" data-key="${c.id}">
      <span class="drag-handle" title="拖曳排序">≡</span>
      <input data-f="name" value="${escapeHtml(c.name)}" />
      <select data-f="g4">${gOpts}</select>
      <button class="btn sm" data-save>存</button>
    </div>`);
    row.querySelector('[data-save]').addEventListener('click', async () => {
      const before = { ...c };
      const newName = row.querySelector('[data-f="name"]').value.trim();
      if (newName) c.name = newName;
      c.group4 = row.querySelector('[data-f="g4"]').value || null;
      await db.metaSet('categories', categories);
      await db.logChange({ ts: nowISO(), entity: 'categories', entity_id: c.id, action: 'update', before, after: { ...c }, note: '設定區改分類名稱/分群（id 不變）' });
      const btn = row.querySelector('[data-save]'); btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '存'; }, 1200);
    });
    catList.appendChild(row);
  }
  makeSortable(catList, '.cat-edit', async (order) => {
    order.forEach((key, i) => { const c = categories.find((x) => String(x.id) === String(key)); if (c) c.sort = i + 1; });
    await db.metaSet('categories', categories);
    await db.logChange({ ts: nowISO(), entity: 'categories', entity_id: null, action: 'reorder', before: null, after: order, note: '拖曳調整分類顯示排序（id 不變）' });
  });
  view.appendChild(catCard);
  // 標籤（§A）：同樣拖 ≡ 排序（影響記一筆的標籤下拉順序），放開即存、不跳頁。
  const tagCard = el(`<section class="card"><h2>標籤（§4.3）<span class="sub" style="font-weight:400">　拖 ≡ 排序</span></h2>
    <div class="group-title">對象</div><div class="sort-list" data-sort="party"></div>
    <div class="group-title">車輛</div><div class="sort-list" data-sort="vehicle"></div></section>`);
  const buildTagList = (listEl, arr, metaKey, label) => {
    for (const t of arr) {
      listEl.appendChild(el(`<div class="tag-row" data-key="${escapeHtml(t)}"><span class="drag-handle" title="拖曳排序">≡</span><span>${escapeHtml(t)}</span></div>`));
    }
    makeSortable(listEl, '.tag-row', async (order) => {
      await db.metaSet(metaKey, order);
      await db.logChange({ ts: nowISO(), entity: metaKey, entity_id: null, action: 'reorder', before: arr.slice(), after: order, note: `拖曳調整${label}標籤順序` });
    });
  };
  buildTagList(tagCard.querySelector('[data-sort="party"]'), partyTags, 'party_tags', '對象');
  buildTagList(tagCard.querySelector('[data-sort="vehicle"]'), vehicleTags, 'vehicle_tags', '車輛');
  view.appendChild(tagCard);
  view.appendChild(el(`<section class="card"><h2>其他設定（§12）</h2>
    <div class="kv"><span class="name">帳單提前提醒天數</span><span class="sub">${settings.remind_days_default ?? 3} 天</span></div>
    <div class="kv"><span class="name">對帳查重日期視窗</span><span class="sub">≤ ${settings.dedup_window_days ?? 10} 天</span></div>
    <div class="kv"><span class="name">現金流預警門檻</span><span class="sub">${money(settings.cashflow_threshold ?? 0)}</span></div></section>`));

  // 段5-1：同名帳戶的「預設來源」（可調）
  const sourceDefaults = await db.metaGet('source_defaults', {});
  const sdCard = el(`<section class="card"><h2>同名帳戶的預設來源（§ 段5-1）</h2>
    <div class="note">解析到只寫「玉山／現金」這種同名關鍵字時，預設帶哪個帳戶（確認卡會再問你一次）。打「先生玉山」等明確寫法時不受此影響。</div></section>`);
  const sdKeys = Object.keys(sourceDefaults);
  if (!sdKeys.length) sdCard.appendChild(el(`<div class="note">目前沒有預設項目。</div>`));
  for (const tok of sdKeys) {
    const opts = `<option value="">—不預設（留空待確認）—</option>` +
      accounts.filter((a) => !a.archived).map((a) => `<option value="${a.id}" ${String(sourceDefaults[tok]) === String(a.id) ? 'selected' : ''}>${a.name}</option>`).join('');
    const row = el(`<div class="kv"><span class="name">「${tok}」預設帶</span><select data-tok="${tok}" style="max-width:62%">${opts}</select></div>`);
    row.querySelector('select').addEventListener('change', async (e) => {
      const before = { ...sourceDefaults };
      const v = e.target.value;
      if (v) sourceDefaults[tok] = Number(v); else delete sourceDefaults[tok];
      await db.metaSet('source_defaults', sourceDefaults);
      await db.logChange({ ts: nowISO(), entity: 'source_defaults', entity_id: null, action: 'update', before, after: { ...sourceDefaults }, note: `調整「${tok}」預設來源` });
    });
    sdCard.appendChild(row);
  }
  view.appendChild(sdCard);

  // 段5-2：店家 → 分類 記憶表（可查看/修改/刪除）
  const scMap = await db.metaGet('store_category_map', {});
  const scKeys = Object.keys(scMap);
  const catName2 = (id) => categories.find((c) => String(c.id) === String(id))?.name || '未分類';
  const scCard = el(`<section class="card"><h2>店家 → 分類 記憶表（§ 段5-2）</h2>
    <div class="note">你確認帶「店家＋分類」的交易後，這裡會自動記住，下次同店家自動帶分類（仍可改）。純規則、不接 AI。</div></section>`);
  if (!scKeys.length) scCard.appendChild(el(`<div class="note">還沒記住任何店家分類。</div>`));
  for (const store of scKeys) {
    const opts = catsSorted(categories).map((c) => `<option value="${c.id}" ${String(scMap[store]) === String(c.id) ? 'selected' : ''}>${c.name}</option>`).join('');
    const row = el(`<div class="kv">
      <span class="name">${store}</span>
      <span style="display:flex;gap:6px;align-items:center"><select data-store="${store}">${opts}</select>
      <button class="btn sm ghost" data-del="${store}">刪</button></span></div>`);
    row.querySelector('select').addEventListener('change', async (e) => {
      const before = scMap[store];
      scMap[store] = Number(e.target.value);
      await db.metaSet('store_category_map', scMap);
      await db.logChange({ ts: nowISO(), entity: 'store_category_map', entity_id: null, action: 'update', before: { store, category_id: before }, after: { store, category_id: scMap[store] }, note: '手動改店家分類' });
    });
    row.querySelector('[data-del]').addEventListener('click', async () => {
      if (!confirm(`刪除「${store} → ${catName2(scMap[store])}」這條記憶？`)) return;
      const before = scMap[store];
      delete scMap[store];
      await db.metaSet('store_category_map', scMap);
      await db.logChange({ ts: nowISO(), entity: 'store_category_map', entity_id: null, action: 'delete', before: { store, category_id: before }, after: null, note: '刪除店家分類記憶' });
      navigate('settings');
    });
    scCard.appendChild(row);
  }
  // Feature 2(a)：直接手動新增「店家→分類」對應，不用等記過第一筆
  const scAddOpts = `<option value="">—選分類—</option>` + catsSorted(categories).map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  const scAdd = el(`<div class="add-row">
    <input id="scStore" placeholder="店家名稱（例：全聯）" />
    <select id="scCat">${scAddOpts}</select>
    <button class="btn sm" id="scAddBtn">新增</button></div>`);
  scAdd.querySelector('#scAddBtn').addEventListener('click', async () => {
    const store = scAdd.querySelector('#scStore').value.trim();
    const cid = scAdd.querySelector('#scCat').value;
    if (!store || !cid) { alert('請輸入店家名稱並選分類。'); return; }
    scMap[store] = Number(cid);
    await db.metaSet('store_category_map', scMap);
    await db.logChange({ ts: nowISO(), entity: 'store_category_map', entity_id: null, action: 'add', before: null, after: { store, category_id: Number(cid) }, note: '手動新增店家分類' });
    navigate('settings');
  });
  scCard.appendChild(scAdd);
  view.appendChild(scCard);

  // Feature 2(b)：關鍵字 → 分類 規則表（可編輯）。解析命中關鍵字就建議分類（可改、不擋入帳）。
  const kwRules = await db.metaGet('keyword_category_rules', []);
  const kwCard = el(`<section class="card"><h2>關鍵字 → 分類 規則表</h2>
    <div class="note">解析時文字命中關鍵字 → 自動建議分類（仍可改、不擋入帳）。沒有店家的也能帶分類，例如「中信貸款」命中「貸款」。</div></section>`);
  if (!kwRules.length) kwCard.appendChild(el(`<div class="note">目前沒有規則。</div>`));
  kwRules.forEach((rule, idx) => {
    const opts = catsSorted(categories).map((c) => `<option value="${c.id}" ${String(rule.category_id) === String(c.id) ? 'selected' : ''}>${c.name}</option>`).join('');
    const row = el(`<div class="kv">
      <span class="name">「${rule.keyword}」→</span>
      <span style="display:flex;gap:6px;align-items:center"><select data-i="${idx}">${opts}</select>
      <button class="btn sm ghost" data-del="${idx}">刪</button></span></div>`);
    row.querySelector('select').addEventListener('change', async (e) => {
      const before = { ...rule };
      kwRules[idx].category_id = Number(e.target.value);
      await db.metaSet('keyword_category_rules', kwRules);
      await db.logChange({ ts: nowISO(), entity: 'keyword_category_rules', entity_id: null, action: 'update', before, after: { ...kwRules[idx] }, note: '改關鍵字分類規則' });
    });
    row.querySelector('[data-del]').addEventListener('click', async () => {
      if (!confirm(`刪除規則「${rule.keyword} → ${catName2(rule.category_id)}」？`)) return;
      const before = { ...rule };
      kwRules.splice(idx, 1);
      await db.metaSet('keyword_category_rules', kwRules);
      await db.logChange({ ts: nowISO(), entity: 'keyword_category_rules', entity_id: null, action: 'delete', before, after: null, note: '刪除關鍵字分類規則' });
      navigate('settings');
    });
    kwCard.appendChild(row);
  });
  const kwAddOpts = `<option value="">—選分類—</option>` + catsSorted(categories).map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  const kwAdd = el(`<div class="add-row">
    <input id="kwKey" placeholder="關鍵字（例：加油）" />
    <select id="kwCat">${kwAddOpts}</select>
    <button class="btn sm" id="kwAddBtn">新增</button></div>`);
  kwAdd.querySelector('#kwAddBtn').addEventListener('click', async () => {
    const keyword = kwAdd.querySelector('#kwKey').value.trim();
    const cid = kwAdd.querySelector('#kwCat').value;
    if (!keyword || !cid) { alert('請輸入關鍵字並選分類。'); return; }
    kwRules.push({ keyword, category_id: Number(cid) });
    await db.metaSet('keyword_category_rules', kwRules);
    await db.logChange({ ts: nowISO(), entity: 'keyword_category_rules', entity_id: null, action: 'add', before: null, after: { keyword, category_id: Number(cid) }, note: '新增關鍵字分類規則' });
    navigate('settings');
  });
  kwCard.appendChild(kwAdd);
  view.appendChild(kwCard);

  // 收入分類（固定四類，可改名；i3 保管金只是可選可篩，存入仍不計收入統計）
  {
    const incomeCats = await db.metaGet('income_categories', []);
    const otherList = await db.metaGet('income_migrate_other', []);
    const recat = await db.metaGet('income_recat_v11', null);
    const icCard = el(`<section class="card"><h2>收入分類（4 類）</h2>
      <div class="note">類別固定四個（可改名）。「哥哥保管金」收入只加保管金餘額、不計入收入統計。</div>
      ${recat ? `<div class="note">上次自動重歸結果：Wawa 營業 ${recat.i1} 筆／先生 ${recat.i2} 筆／保管金 ${recat.i3} 筆／留在其他 ${recat.kept_i4} 筆</div>` : ''}</section>`);
    incomeCats.forEach((c, idx) => {
      const row = el(`<div class="cat-edit"><span class="cat-id" style="flex:0 0 30px">${c.id}</span>
        <input data-f="name" value="${escapeHtml(c.name)}" />
        <button class="btn sm" data-save>存</button></div>`);
      row.querySelector('[data-save]').addEventListener('click', async () => {
        const before = { ...c };
        const v = row.querySelector('[data-f="name"]').value.trim();
        if (v) c.name = v;
        await db.metaSet('income_categories', incomeCats);
        await db.logChange({ ts: nowISO(), entity: 'income_categories', entity_id: c.id, action: 'rename', before, after: { ...c }, note: '改收入分類名稱' });
        const btn = row.querySelector('[data-save]'); btn.textContent = '✓'; setTimeout(() => { btn.textContent = '存'; }, 1200);
      });
      icCard.appendChild(row);
    });
    if (otherList.length) {
      icCard.appendChild(el(`<div class="group-title">自動歸到「其他」的既有收入（${otherList.length} 筆，請確認）</div>`));
      for (const o of otherList) icCard.appendChild(el(`<div class="kv"><span class="name">${o.date}　${money(o.amount)}</span><span class="sub">${escapeHtml(o.hint)}</span></div>`));
      icCard.appendChild(el(`<div class="note">不對的話到「明細」按該筆「修正」，收入分類下拉改選正確類別即可。</div>`));
    }
    view.appendChild(icCard);
  }

  // 負債清單（§2.5/§12）：可增改、結清封存（封存保留紀錄不真刪）
  {
    const debts = await db.getAll('debts');
    const accOpts = (sel) => `<option value="">—未指定—</option>` + accounts.filter((a) => !a.archived).map((a) => `<option value="${a.id}" ${String(sel) === String(a.id) ? 'selected' : ''}>${a.name}</option>`).join('');
    const dCard = el(`<section class="card"><h2>負債清單（§2.5）</h2>
      <div class="note">欄位可留空待補；「結清封存」會從活躍清單移除但保留紀錄。本金/期數可隨時手動校正。</div>
      <div class="debt-list"></div>
      <div class="add-row"><input id="dNew" placeholder="新負債名稱"><button class="btn sm" id="dAdd">新增</button></div></section>`);
    const list = dCard.querySelector('.debt-list');
    for (const d of debts) {
      const row = el(`<div class="acct-edit ${d.status !== 'active' ? 'archived-dim' : ''}">
        <div class="head"><span class="nm">${escapeHtml(d.name)}${d.status !== 'active' ? '（已結清封存）' : ''}</span><span class="owner-tag">${d.group ? '群組：' + escapeHtml(d.group) : ''}</span></div>
        <div class="row">
          <label class="field"><span class="lab">剩餘本金（空＝待補）</span><input data-f="p" type="number" inputmode="numeric" value="${d.remaining_principal ?? ''}"></label>
          <label class="field"><span class="lab">年利率%（空＝未知）</span><input data-f="r" type="number" step="0.01" value="${d.rate ?? ''}"></label>
        </div>
        <div class="row">
          <label class="field"><span class="lab">每月還款</span><input data-f="m" type="number" inputmode="numeric" value="${d.monthly_amount ?? ''}"></label>
          <label class="field"><span class="lab">繳款日</span><input data-f="day" type="number" min="1" max="31" value="${d.pay_day ?? ''}"></label>
        </div>
        <div class="row">
          <label class="field"><span class="lab">剩餘期數</span><input data-f="rt" type="number" value="${d.remaining_terms ?? ''}"></label>
          <label class="field"><span class="lab">總期數</span><input data-f="tt" type="number" value="${d.total_terms ?? ''}"></label>
        </div>
        <label class="field"><span class="lab">出錢帳戶</span><select data-f="acc">${accOpts(d.from_account_id)}</select></label>
        <label class="field"><span class="lab">備註</span><input data-f="note" value="${escapeHtml(d.note || '')}"></label>
        <label class="inline-check field"><input data-f="arch" type="checkbox" ${d.status !== 'active' ? 'checked' : ''}> <span>結清封存</span></label>
        <button class="btn sm" data-save>儲存這筆負債</button>
      </div>`);
      row.querySelector('[data-save]').addEventListener('click', async () => {
        const before = { ...d };
        const v = (s) => { const x = row.querySelector(`[data-f="${s}"]`).value; return x === '' ? null : Number(x); };
        d.remaining_principal = v('p'); d.rate = v('r'); d.monthly_amount = v('m') ?? 0;
        d.pay_day = v('day') ?? d.pay_day; d.remaining_terms = v('rt'); d.total_terms = v('tt');
        d.from_account_id = row.querySelector('[data-f="acc"]').value ? Number(row.querySelector('[data-f="acc"]').value) : null;
        d.note = row.querySelector('[data-f="note"]').value.trim();
        d.status = row.querySelector('[data-f="arch"]').checked ? 'settled_archived' : 'active';
        await db.put('debts', d);
        await db.logChange({ ts: nowISO(), entity: 'debts', entity_id: d.id, action: 'update', before, after: { ...d }, note: '設定區手動修改負債' });
        const btn = row.querySelector('[data-save]'); btn.textContent = '✓'; setTimeout(() => { btn.textContent = '儲存這筆負債'; }, 1200);
      });
      list.appendChild(row);
    }
    dCard.querySelector('#dAdd').addEventListener('click', async () => {
      const name = dCard.querySelector('#dNew').value.trim();
      if (!name) { alert('請輸入負債名稱'); return; }
      const nd = { name, group: '', remaining_principal: null, rate: null, monthly_amount: 0, pay_day: 1, remaining_terms: null, total_terms: null, from_account_id: null, note: '', status: 'active' };
      const id = await db.add('debts', nd);
      await db.logChange({ ts: nowISO(), entity: 'debts', entity_id: id, action: 'create', before: null, after: { ...nd, id }, note: '新增負債' });
      navigate('settings');
    });
    view.appendChild(dCard);
  }

  // 每月固定帳單（§11.2/§12）：可增改、封存
  {
    const bills = await db.getAll('bills');
    const debts = (await db.getAll('debts')).filter((d) => d.status === 'active');
    const accOpts = (sel) => `<option value="">—未指定—</option>` + accounts.filter((a) => !a.archived).map((a) => `<option value="${a.id}" ${String(sel) === String(a.id) ? 'selected' : ''}>${a.name}</option>`).join('');
    const catOpts2 = (sel) => `<option value="">—未分類—</option>` + catsSorted(categories).map((c) => `<option value="${c.id}" ${String(sel) === String(c.id) ? 'selected' : ''}>${c.name}</option>`).join('');
    const dOpts = (sel) => `<option value="">—無—</option>` + debts.map((d) => `<option value="${d.id}" ${String(sel) === String(d.id) ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('');
    const bCard = el(`<section class="card"><h2>每月固定帳單（§11.2）</h2>
      <div class="note">總覽會在到期前 7 天提醒；勾「已繳」＝本月完成，下月自動重來。</div>
      <div class="bill-list"></div>
      <div class="add-row"><input id="bNew" placeholder="新帳單名稱"><button class="btn sm" id="bAdd">新增</button></div></section>`);
    const list = bCard.querySelector('.bill-list');
    for (const b of bills) {
      const row = el(`<div class="acct-edit ${b.status !== 'active' ? 'archived-dim' : ''}">
        <div class="head"><span class="nm">${escapeHtml(b.name)}</span></div>
        <div class="row">
          <label class="field"><span class="lab">金額</span><input data-f="amt" type="number" inputmode="numeric" value="${b.amount ?? ''}"></label>
          <label class="field"><span class="lab">每月幾日</span><input data-f="day" type="number" min="1" max="31" value="${b.pay_day ?? ''}"></label>
        </div>
        <label class="field"><span class="lab">付款來源</span><select data-f="acc">${accOpts(b.from_account_id)}</select></label>
        <div class="row">
          <label class="field"><span class="lab">分類</span><select data-f="cat">${catOpts2(b.category_id)}</select></label>
          <label class="field"><span class="lab">關聯負債</span><select data-f="debt">${dOpts(b.debt_id)}</select></label>
        </div>
        <label class="inline-check field"><input data-f="arch" type="checkbox" ${b.status !== 'active' ? 'checked' : ''}> <span>封存（不再提醒）</span></label>
        <button class="btn sm" data-save>儲存這筆帳單</button>
      </div>`);
      row.querySelector('[data-save]').addEventListener('click', async () => {
        const before = { ...b };
        b.amount = Number(row.querySelector('[data-f="amt"]').value || 0);
        b.pay_day = Number(row.querySelector('[data-f="day"]').value || b.pay_day);
        b.from_account_id = row.querySelector('[data-f="acc"]').value ? Number(row.querySelector('[data-f="acc"]').value) : null;
        b.category_id = row.querySelector('[data-f="cat"]').value ? Number(row.querySelector('[data-f="cat"]').value) : null;
        b.debt_id = row.querySelector('[data-f="debt"]').value ? Number(row.querySelector('[data-f="debt"]').value) : null;
        b.status = row.querySelector('[data-f="arch"]').checked ? 'archived' : 'active';
        await db.put('bills', b);
        await db.logChange({ ts: nowISO(), entity: 'bills', entity_id: b.id, action: 'update', before, after: { ...b }, note: '設定區手動修改帳單' });
        const btn = row.querySelector('[data-save]'); btn.textContent = '✓'; setTimeout(() => { btn.textContent = '儲存這筆帳單'; }, 1200);
      });
      list.appendChild(row);
    }
    bCard.querySelector('#bAdd').addEventListener('click', async () => {
      const name = bCard.querySelector('#bNew').value.trim();
      if (!name) { alert('請輸入帳單名稱'); return; }
      const nb = { name, amount: 0, pay_day: 1, from_account_id: null, category_id: null, debt_id: null, status: 'active', done_month: null };
      const id = await db.add('bills', nb);
      await db.logChange({ ts: nowISO(), entity: 'bills', entity_id: id, action: 'create', before: null, after: { ...nb, id }, note: '新增帳單' });
      navigate('settings');
    });
    view.appendChild(bCard);
  }

  // 雲端備份（§10）
  const lastBackup = await db.metaGet('last_backup_at', null);
  const lastTxt = lastBackup ? `上次備份：${new Date(lastBackup).toLocaleString('zh-TW')}` : '尚未備份過';
  const bkCard = el(`<section class="card"><h2>雲端備份（§10）</h2>
    <div class="note">把整個帳本＋截圖打包成「一個檔案」。瀏覽器不能自動寫雲端，所以是「點一下 → 跳分享/下載 → 你自己存到 iCloud 雲碟」。</div>
    <div class="kv"><span class="name">${lastTxt}</span></div>
    <button class="btn" id="doBackup" style="margin-top:8px">💾 立即備份（存到 iCloud）</button>
    <button class="btn ghost" id="doRestore" style="margin-top:8px">↩︎ 從備份檔還原</button>
    <input type="file" id="restoreFile" accept="application/json,.json" style="display:none" />
    <label class="field" style="margin-top:12px"><span class="lab">備份提醒天數（超過幾天沒備份就在總覽提醒）</span>
      <input id="bkDays" type="number" inputmode="numeric" min="1" value="${settings.backup_remind_days ?? 7}" /></label>
    <button class="btn sm" id="saveBkDays">儲存提醒天數</button>
    <div class="note" id="bkMsg"></div></section>`);

  bkCard.querySelector('#doBackup').addEventListener('click', async () => {
    const msg = bkCard.querySelector('#bkMsg');
    msg.textContent = '打包中…';
    try {
      const data = await createBackupObject();
      const res = await saveBackupFile(data, backupFilename(), true);
      if (res === 'cancelled') { msg.textContent = '已取消備份。'; return; }
      const ts = nowISO();
      await db.metaSet('last_backup_at', ts);
      await db.logChange({ ts, entity: 'backup', entity_id: null, action: 'backup', before: null, after: { exportedAt: ts, txns: data.stores.transactions.length }, note: `備份（${res === 'shared' ? '分享' : '下載'}）` });
      msg.innerHTML = `<span style="color:var(--ok)">✅ 已產生備份檔（${res === 'shared' ? '請在分享面板選「儲存到檔案 → iCloud 雲碟」' : '已下載，請移到 iCloud 雲碟'}）。</span>`;
    } catch (e) { msg.innerHTML = `<span style="color:var(--bad)">備份失敗：${e.message || e}</span>`; }
  });

  bkCard.querySelector('#doRestore').addEventListener('click', () => bkCard.querySelector('#restoreFile').click());
  bkCard.querySelector('#restoreFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const msg = bkCard.querySelector('#bkMsg');
    try {
      const data = await readBackupFile(file);
      if (!data || data.app !== 'wawa-ledger') { msg.innerHTML = '<span style="color:var(--bad)">這不是有效的 Wawa 記帳備份檔。</span>'; return; }
      const n = (data.stores?.transactions || []).length;
      if (!confirm(`還原會「取代你目前所有資料」（用備份檔的 ${n} 筆交易等取代）。\n\n為保險，我會先「自動備份你目前的資料」一份（會跳下載）。\n\n確定還原？`)) { e.target.value = ''; return; }
      msg.textContent = '先自動備份目前資料…';
      const current = await createBackupObject();
      await saveBackupFile(current, backupFilename('還原前自動備份'), false); // 下載，較可靠
      msg.textContent = '還原中…';
      await restoreFromObject(data);
      await db.logChange({ ts: nowISO(), entity: 'backup', entity_id: null, action: 'restore', before: null, after: { restoredFrom: data.exportedAt, txns: n }, note: '從備份檔還原（已先自動備份目前資料）' });
      alert('✅ 還原完成，資料已回到備份當時。');
      navigate('overview');
    } catch (err) {
      msg.innerHTML = `<span style="color:var(--bad)">還原失敗：${err.message || err}</span>`;
    } finally { e.target.value = ''; }
  });

  bkCard.querySelector('#saveBkDays').addEventListener('click', async () => {
    const v = Math.max(1, Number(bkCard.querySelector('#bkDays').value || 7));
    const st = await db.metaGet('settings', {});
    const before = { ...st };
    st.backup_remind_days = v;
    await db.metaSet('settings', st);
    await db.logChange({ ts: nowISO(), entity: 'settings', entity_id: null, action: 'update', before, after: { ...st }, note: '調整備份提醒天數' });
    bkCard.querySelector('#bkMsg').innerHTML = `<span style="color:var(--ok)">✅ 已設為 ${v} 天</span>`;
  });
  view.appendChild(bkCard);

  // 清空測試資料：先自動備份目前資料（保險），再刪「全部交易＋綁定截圖」（含保管金/應收測試）。
  // 帳戶、分類、4 群對應、店家記憶、關鍵字規則、所有設定一律保留。
  const txnCount = await db.count('transactions');
  const clearCard = el(`<section class="card"><h2>清空測試資料</h2>
    <div class="note">會先<b>自動備份一份目前的</b>（跳下載，存好以防萬一），再刪掉全部 ${txnCount} 筆交易與綁定截圖（含保管金、應收清單的測試資料）。帳戶、分類、4 群、店家記憶、關鍵字規則、設定都<b>不會</b>動。</div>
    <button class="btn" id="clearTest" style="background:var(--bad)">備份並清空所有交易（${txnCount} 筆）</button>
    <div class="note" id="clearMsg"></div></section>`);
  clearCard.querySelector('#clearTest').addEventListener('click', async () => {
    if (txnCount === 0) { alert('目前沒有交易可清。'); return; }
    if (!confirm(`確定要刪掉全部 ${txnCount} 筆交易與截圖嗎？\n會先自動備份一份目前的（跳下載）。\n此動作只清交易，不影響帳戶/分類/規則/設定。`)) return;
    const msg = clearCard.querySelector('#clearMsg');
    msg.textContent = '先自動備份…';
    try {
      const backup = await createBackupObject();
      await saveBackupFile(backup, backupFilename('清空前自動備份'), false); // 下載，較可靠
    } catch (e) {
      if (!confirm(`自動備份失敗（${e.message || e}）。\n還是要直接清空嗎？（不建議）`)) { msg.textContent = ''; return; }
    }
    msg.textContent = '清空中…';
    await db.clear('transactions');
    await db.clear('screenshots');
    await db.logChange({ ts: nowISO(), entity: 'transactions', entity_id: null, action: 'clear_all', before: { count: txnCount }, after: null, note: '使用者清空測試交易（已先自動備份）' });
    alert(`已清空 ${txnCount} 筆交易，帳本歸零。結構與設定都保留。`);
    navigate('overview');
  });
  view.appendChild(clearCard);

  const stCard = el(`<section class="card"><h2>開發者：自我檢測</h2>
    <div class="note">驗證計算引擎是否正確（不碰真實帳本）。</div>
    <button class="btn ghost" id="goSelftest">執行自我檢測</button></section>`);
  stCard.querySelector('#goSelftest').addEventListener('click', () => navigate('selftest'));
  view.appendChild(stCard);

  makeCollapsibleSections(view); // 純外觀：把每個區塊變成可收合，預設收合
}

// 通用拖曳排序（§A）：抓「≡」把手上下拖、放開即存。
// 用 Pointer Events（iPhone Safari 可用）；只動 DOM 內列的順序，不整頁重畫、不捲動。
function makeSortable(listEl, rowSel, onCommit) {
  listEl.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    const row = handle.closest(rowSel);
    if (!row || row.parentElement !== listEl) return;
    e.preventDefault();
    // ⚠ setPointerCapture 在 WebKit 會丟 NotFoundError（v24 拖曳全掛的元凶）。
    // 改成 best-effort：失敗就算了，move/up 一律掛 document，桌機/手機都穩。
    try { handle.setPointerCapture(e.pointerId); } catch (_) { /* 不依賴 capture */ }
    row.classList.add('dragging');
    const move = (ev) => {
      ev.preventDefault();
      const y = ev.clientY;
      let next = null;
      for (const s of listEl.querySelectorAll(rowSel)) {
        if (s === row) continue;
        const r = s.getBoundingClientRect();
        if (y < r.top + r.height / 2) { next = s; break; }
      }
      if (next) listEl.insertBefore(row, next); else listEl.appendChild(row);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      row.classList.remove('dragging');
      onCommit([...listEl.querySelectorAll(rowSel)].map((r) => r.dataset.key));
    };
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  });
  listEl.querySelectorAll('.drag-handle').forEach((h) => { h.style.touchAction = 'none'; });
}

// 設定頁：把每張 section.card 變成可收合（純呈現，不動內部功能/handler）。
// 記住哪些區塊是展開的，重新整理設定頁時保持狀態（避免操作後又全部收起）。
let openSettingsSections = new Set();
function makeCollapsibleSections(container) {
  container.querySelectorAll(':scope > section.card').forEach((card) => {
    const h2 = card.querySelector(':scope > h2');
    if (!h2 || card.classList.contains('collapsible')) return;
    const key = h2.textContent.trim();

    // 把標題以外的內容收進 body
    const body = document.createElement('div');
    body.className = 'collapse-body';
    let node = h2.nextSibling;
    while (node) { const next = node.nextSibling; body.appendChild(node); node = next; }
    card.appendChild(body);

    // 標題包一層 + 加箭頭（不動原本標題裡的內容/子元素）
    const title = document.createElement('span');
    title.className = 'collapse-title';
    while (h2.firstChild) title.appendChild(h2.firstChild);
    const chev = document.createElement('span');
    chev.className = 'collapse-chev';
    h2.appendChild(title);
    h2.appendChild(chev);
    h2.classList.add('collapse-h');
    card.classList.add('collapsible');

    const setOpen = (open) => {
      card.classList.toggle('open', open);
      body.style.display = open ? '' : 'none';
      chev.textContent = open ? '−' : '+'; // − / +
      if (open) openSettingsSections.add(key); else openSettingsSections.delete(key);
    };
    setOpen(openSettingsSections.has(key)); // 預設全部收合
    h2.addEventListener('click', () => setOpen(body.style.display === 'none'));
  });
}

// ---------------------------------------------------------------- 自我檢測
export function renderSelfTest(view) {
  const r = runSelfTests();
  view.innerHTML = '';
  const back = el(`<button class="btn ghost" style="margin-bottom:12px">← 回設定</button>`);
  back.addEventListener('click', () => navigate('settings'));
  view.appendChild(back);
  view.appendChild(el(`<section class="card">
    <h2>自我檢測（§17.4 驗收）</h2>
    <div class="big-total ${r.allPass ? '' : 'neg'}">${r.passed}/${r.total} ${r.allPass ? '全數通過 ✓' : '有失敗 ✗'}</div>
    <div class="note">用記憶體假資料驗證計算引擎，不碰真實帳本。</div></section>`));
  const list = el(`<section class="card"><h2>明細</h2></section>`);
  for (const t of r.results) {
    list.appendChild(el(`<div class="test-line">
      <span><span class="test-desc">${t.desc}</span><br><span class="test-detail">${t.detail}</span></span>
      <span class="res ${t.pass ? 'pass' : 'fail'}">${t.pass ? 'PASS' : 'FAIL'}</span></div>`));
  }
  view.appendChild(list);
}
