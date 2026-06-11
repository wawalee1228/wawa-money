// ============================================================================
// backup.js — 一鍵備份 / 還原（§10）
// 把整個帳本（8 張表 + 所有設定 meta + 綁定截圖）打包成「一個 JSON 檔」。
// 瀏覽器不能自動寫雲端 → 用「分享/下載」讓使用者自己存到 iCloud 雲碟。
// 還原會「取代目前資料」，呼叫端負責先警告 + 自動先備份一份。
// ============================================================================
import * as db from './db.js';

const STORES = ['accounts', 'cards', 'transactions', 'bills', 'planned_expenses', 'debts', 'screenshots', 'change_log'];
const BACKUP_APP = 'wawa-ledger';

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
function dataURLToBlob(dataURL) {
  const [meta, b64] = String(dataURL).split(',');
  const mime = (meta.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// 打包成可序列化物件
export async function createBackupObject() {
  const data = { app: BACKUP_APP, version: 1, exportedAt: new Date().toISOString(), stores: {}, meta: [] };
  for (const s of STORES) {
    const rows = await db.getAll(s);
    if (s === 'screenshots') {
      data.stores[s] = await Promise.all(rows.map(async (r) => ({ ...r, blob: r.blob ? await blobToDataURL(r.blob) : null })));
    } else {
      data.stores[s] = rows;
    }
  }
  data.meta = await db.getAll('meta'); // 全部 key-value 設定
  return data;
}

// 還原：清空後依備份重建（保留原本的 id）。呼叫端須先確認 + 先自動備份。
export async function restoreFromObject(data) {
  if (!data || data.app !== BACKUP_APP || !data.stores) {
    throw new Error('這不是有效的 Wawa 記帳備份檔');
  }
  for (const s of STORES) await db.clear(s);
  await db.clear('meta');
  for (const s of STORES) {
    const rows = data.stores[s] || [];
    for (const row of rows) {
      const r = { ...row };
      if (s === 'screenshots' && r.blob) r.blob = dataURLToBlob(r.blob);
      await db.put(s, r);
    }
  }
  for (const row of (data.meta || [])) await db.put('meta', row);
}

// 產生檔名：wawa記帳備份_YYYY-MM-DD_HHMM[_後綴].json
export function backupFilename(suffix = '') {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  return `wawa記帳備份_${stamp}${suffix ? '_' + suffix : ''}.json`;
}

// 存檔：優先用分享面板（iOS 可選「儲存到檔案 → iCloud 雲碟」）；不支援則退回下載。
// 回傳 'shared' | 'downloaded' | 'cancelled'
export async function saveBackupFile(data, filename, preferShare = true) {
  const json = JSON.stringify(data);
  const blob = new Blob([json], { type: 'application/json' });

  if (preferShare && navigator.canShare) {
    try {
      const file = new File([blob], filename, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return 'shared';
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // 其他錯誤 → 退回下載
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return 'downloaded';
}

// 讀使用者選的備份檔 → 解析成物件
export function readBackupFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { try { resolve(JSON.parse(r.result)); } catch (e) { reject(new Error('備份檔格式錯誤（不是有效 JSON）')); } };
    r.onerror = () => reject(new Error('讀取檔案失敗'));
    r.readAsText(file);
  });
}
