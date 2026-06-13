// ============================================================================
// app.js — 啟動與分頁切換
// ============================================================================
import { ensureSeeded, ensureDefaults, metaGet, getAll } from './db.js';

const APP_VERSION = 'v42-loan';
import {
  renderOverview, renderReport, renderEntry, renderBatch, renderReconcile, renderList, renderSettings, renderSelfTest,
  setNavigate, clearEditing,
} from './ui.js';

const view = document.getElementById('view');
const tabs = [...document.querySelectorAll('.tab')];
const TAB_NAMES = new Set(['overview', 'entry', 'reconcile', 'list', 'settings']);

async function show(name) {
  // 分頁高亮（selftest 不在分頁列，維持設定高亮）
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.view === name
    || (name === 'selftest' && t.dataset.view === 'settings')
    || (name === 'batch' && t.dataset.view === 'entry')
    || (name === 'report' && t.dataset.view === 'overview')));
  window.scrollTo(0, 0);
  if (name === 'overview') await renderOverview(view);
  else if (name === 'report') await renderReport(view);
  else if (name === 'entry') await renderEntry(view);
  else if (name === 'batch') await renderBatch(view);
  else if (name === 'reconcile') await renderReconcile(view);
  else if (name === 'list') await renderList(view);
  else if (name === 'settings') await renderSettings(view);
  else if (name === 'selftest') renderSelfTest(view);
}

setNavigate(show);

tabs.forEach((t) => t.addEventListener('click', () => {
  // 從分頁列點「記一筆」一律是新增（清掉修正狀態）
  if (t.dataset.view === 'entry') clearEditing();
  show(t.dataset.view);
}));

(async function boot() {
  try {
    console.log(`[Wawa] App ${APP_VERSION} 啟動中…（若這行沒出現＝你載入的是舊版，請重整 1-2 次）`);
    const didSeed = await ensureSeeded();
    if (didSeed) console.log('[Wawa] 已種子化結構資料（帳戶/卡/分類/標籤），餘額皆 0。');
    await ensureDefaults(); // 已種子化的舊資料庫補上新設定＋所有 backfill（含 v12 收入修正）
    // 診斷：收入修正狀況
    const fix12 = await metaGet('income_fix_v12', null);
    const incTx = (await getAll('transactions')).filter((t) => !t.deleted && t.type === 'income');
    const i4cnt = incTx.filter((t) => t.category_id === 'i4').length;
    const nonecnt = incTx.filter((t) => t.category_id == null).length;
    console.log('[Wawa] 收入診斷：', { v12: fix12, 收入總筆數: incTx.length, 仍在其他i4: i4cnt, 仍未分類None: nonecnt });
    console.log('[Wawa] 撥款 v13：', await metaGet('loan_v13_result', null));
    await show('overview');
  } catch (e) {
    view.innerHTML = `<section class="card"><h2>啟動失敗</h2><div class="note">${e && e.message ? e.message : e}</div></section>`;
    console.error(e);
  }
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('[Wawa] SW 未註冊：', e.message));
  });
}
