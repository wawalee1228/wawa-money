// ============================================================================
// app.js — 啟動與分頁切換
// ============================================================================
import { ensureSeeded, ensureDefaults } from './db.js';
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
    const didSeed = await ensureSeeded();
    if (didSeed) console.log('[Wawa] 已種子化結構資料（帳戶/卡/分類/標籤），餘額皆 0。');
    await ensureDefaults(); // 已種子化的舊資料庫補上新設定（預設來源、店家分類記憶表）
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
