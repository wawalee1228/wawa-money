// ============================================================================
// db.js — 本機資料庫（IndexedDB）
// 最高原則：帳本存資料庫、不存記憶；餘額一律即時算，這裡「絕不存餘額欄位」。
// §15 的 8 張正式表全部建立；§15 未給表的設定（主分類、標籤、提醒天數、
// 對帳視窗…）放在 meta 設定區，可改、改了永久生效（§12）。
// ============================================================================

const DB_NAME = 'wawa-ledger';
const DB_VERSION = 1;

// §15 建議的 8 張表（keyPath=id，自動編號）
const STORES = [
  'accounts',          // 帳戶
  'cards',             // 卡 ↔ 帳戶對應
  'transactions',      // 交易（主表）
  'bills',             // 固定帳單
  'planned_expenses',  // 預留 / 計劃性支出
  'debts',             // 負債
  'screenshots',       // 原始截圖（綁定交易）
  'change_log',        // 規則 / 資料變更版本紀錄
];

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const s = db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
          if (name === 'transactions') {
            s.createIndex('byDate', 'date');
            s.createIndex('byStatus', 'status');
            s.createIndex('byFrom', 'from_account_id');
            s.createIndex('byTo', 'to_account_id');
          }
          if (name === 'cards') s.createIndex('byAccount', 'account_id');
          if (name === 'screenshots') s.createIndex('byTxn', 'txn_id');
        }
      }
      // meta：key-value 設定區（種子旗標、設定、主分類、標籤…）
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = 'readonly') {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- 一般 CRUD ----
export async function getAll(store) { return reqP((await tx(store)).getAll()); }
export async function get(store, id) { return reqP((await tx(store, 'readonly')).get(id)); }
export async function add(store, obj) { return reqP((await tx(store, 'readwrite')).add(obj)); }
export async function put(store, obj) { return reqP((await tx(store, 'readwrite')).put(obj)); }
export async function del(store, id) { return reqP((await tx(store, 'readwrite')).delete(id)); }
export async function clear(store) { return reqP((await tx(store, 'readwrite')).clear()); }
export async function count(store) { return reqP((await tx(store)).count()); }

// ---- meta 設定區 ----
export async function metaGet(key, fallback = null) {
  const row = await reqP((await tx('meta')).get(key));
  return row ? row.value : fallback;
}
export async function metaSet(key, value) {
  return reqP((await tx('meta', 'readwrite')).put({ key, value }));
}

// ---- 變更紀錄（§12：改規則/改資料須有歷史版本，可回溯）----
// 注意：日期字串由呼叫端（app 層）傳入，db 層不取系統時間，保持單純。
export async function logChange(entry) {
  // entry: { ts, entity, entity_id, action, before, after, note }
  return add('change_log', entry);
}

// ============================================================================
// 種子資料：只放「結構」（來自規格 §2／§4），不放使用者的初始帳目。
// 餘額一律 0、卡號末四碼留空、負債/帳單/交易全空，等使用者之後提供。
// ============================================================================
export async function ensureSeeded() {
  const seeded = await metaGet('seeded', false);
  if (seeded) return false;

  // --- §2 帳戶 ---
  // type: bank=銀行帳戶, cash=現金, wallet=數位錢包, payment_tool=支付工具(非資產)
  // include_in_total：是否算進總資產。custody=true 代表「另列」（哥哥保管金）。
  const accounts = [
    // §2.1 Wawa 端（皆算進總資產）
    { name: 'Wawa 中國信託', type: 'bank',   owner: 'wawa',    include_in_total: true,  custody: false, opening_balance: 0, note: '主帳戶；綁 VISA 簽帳卡、LINE Pay、LINE Pay Money 儲值來源', archived: false, sort: 1 },
    { name: 'Wawa 玉山',     type: 'bank',   owner: 'wawa',    include_in_total: true,  custody: false, opening_balance: 0, note: '緩衝帳戶；綁 VISA 簽帳卡', archived: false, sort: 2 },
    { name: 'Wawa 郵局',     type: 'bank',   owner: 'wawa',    include_in_total: true,  custody: false, opening_balance: 0, note: '備用帳戶；綁 VISA 簽帳卡；原則上少動', archived: false, sort: 3 },
    { name: 'Wawa 身上現金', type: 'cash',   owner: 'wawa',    include_in_total: true,  custody: false, opening_balance: 0, note: '早餐、零用、現金收入、現金繳款', archived: false, sort: 4 },
    { name: 'LINE Pay Money 錢包', type: 'wallet', owner: 'wawa', include_in_total: true, custody: false, opening_balance: 0, note: '需儲值；儲值＝調度，付款才算支出', archived: false, sort: 5 },
    { name: '一卡通 / iPASS MONEY', type: 'wallet', owner: 'wawa', include_in_total: true, custody: false, opening_balance: 0, note: '需儲值；儲值＝調度，付款才算支出', archived: false, sort: 6 },
    // §2.2 先生端
    // ⚠ 先生帳戶「是否算進總資產」規格未明說，先預設 true（§2.2 提到薪資入帳/繳家庭貸款），設定區可改。
    { name: '先生 玉山',     type: 'bank', owner: 'husband', include_in_total: true,  custody: false, opening_balance: 0, note: '薪資入帳、繳部分固定貸款', archived: false, sort: 7 },
    { name: '先生 中信貸款帳戶', type: 'bank', owner: 'husband', include_in_total: true, custody: false, opening_balance: 0, note: '信貸資金剩餘、卡費、調度', archived: false, sort: 8 },
    { name: '先生 身上現金 / 工作預備金', type: 'cash', owner: 'husband', include_in_total: true, custody: false, opening_balance: 0, note: '從貸款帳戶提領；標「工作預備金」者不可直接算已花掉', archived: false, sort: 9 },
    { name: '先生 信用卡',   type: 'payment_tool', owner: 'husband', include_in_total: false, custody: false, opening_balance: 0, note: '支付工具（非資產）；B 模式：繳卡費記支出，程式不自動算餘額', archived: false, sort: 10 },
    // §2.3 孩子端（另列，不算家庭可用錢）
    { name: '哥哥保管金',    type: 'cash', owner: 'child', include_in_total: false, custody: true, opening_balance: 0, note: '紅包＋獎學金，Wawa 代管，另列', archived: false, sort: 11 },
  ];
  const acctIdByName = {};
  for (const a of accounts) acctIdByName[a.name] = await add('accounts', a);

  // --- §2 三張 VISA 簽帳卡（卡↔帳戶對應；末四碼留空待填）---
  const cards = [
    { name: '中信 VISA 簽帳卡', account_id: acctIdByName['Wawa 中國信託'], brand: 'VISA debit', last4: '' },
    { name: '玉山 VISA 簽帳卡', account_id: acctIdByName['Wawa 玉山'],     brand: 'VISA debit', last4: '' },
    { name: '郵局 VISA 簽帳卡', account_id: acctIdByName['Wawa 郵局'],     brand: 'VISA debit', last4: '' },
  ];
  for (const c of cards) await add('cards', c);

  // --- §4.1 主分類（group4：§4.2 的 4 群收合；種子含原始全部分類，「孩子生活」由 backfill v6 退役）---
  const categories = [
    { id: 1,  name: '固定支出',     group4: 'C' },
    { id: 2,  name: '債務 / 貸款',  group4: 'C' },
    { id: 3,  name: '信用卡 / 卡費', group4: 'D' },
    { id: 4,  name: '工作室支出',   group4: null },
    { id: 5,  name: 'AI / 工具支出', group4: null },
    { id: 6,  name: '生活支出',     group4: 'A' },
    { id: 7,  name: '娛樂 / 非必要', group4: 'B' },
    { id: 8,  name: '孩子教育',     group4: 'C' },
    { id: 9,  name: '孩子生活',     group4: null },
    { id: 10, name: '醫療',         group4: null },
    { id: 11, name: '人情 / 喪葬',  group4: 'B' },
    { id: 12, name: '車輛支出',     group4: null },
  ];

  // --- §4.3 標籤（兩維度）---
  const partyTags = ['家庭', '工作室', '先生', '孩子', 'Wawa 個人', '哥哥保管金'];
  const vehicleTags = ['大 Volvo', '小 Volvo', '小黑'];

  // --- §12 可改設定（預設值）---
  const settings = {
    remind_days_default: 3,   // §11.2 帳單提前提醒天數
    dedup_window_days: 10,    // §7 對帳日期視窗 ≤10 天
    cashflow_threshold: 0,    // §11.2 現金流預警門檻
  };

  await metaSet('categories', categories);
  await metaSet('party_tags', partyTags);
  await metaSet('vehicle_tags', vehicleTags);
  await metaSet('settings', settings);
  await metaSet('seeded', true);
  await ensureDefaults();
  return true; // 表示本次有種子
}

// ----------------------------------------------------------------------------
// backfill：每次開機補上「後來新增的設定」，已存在則不動（不影響既有資料）。
// 用於已種子化的舊資料庫升級。
// ----------------------------------------------------------------------------
export async function ensureDefaults() {
  const accounts = await getAll('accounts');
  const byName = (n) => accounts.find((a) => a.name.includes(n));

  // 同名帳戶的「預設來源」（§ 段5-1：可調預設）。token → accountId。
  // 逐鍵 backfill：只補「目前沒有的鍵」，已存在（含使用者改過的）一律不動。
  {
    const md = (await metaGet('source_defaults', null)) || {};
    const wanted = [['玉山', 'Wawa 玉山'], ['中信', 'Wawa 中國信託'], ['郵局', 'Wawa 郵局'], ['現金', 'Wawa 身上現金']];
    let changed = false;
    for (const [tok, accName] of wanted) {
      if (!(tok in md)) { const a = byName(accName); if (a) { md[tok] = a.id; changed = true; } }
    }
    if (changed) await metaSet('source_defaults', md);
  }

  // 店家 → 分類 記憶表（§ 段5-2：純規則、不接 AI）。merchant → categoryId。
  if ((await metaGet('store_category_map', null)) == null) {
    await metaSet('store_category_map', {});
  }

  // 備份提醒天數（§10）：補進既有 settings，不覆寫使用者設定。
  {
    const st = (await metaGet('settings', null)) || {};
    if (st.backup_remind_days == null) { st.backup_remind_days = 7; await metaSet('settings', st); }
  }

  // 關鍵字 → 分類 規則表（可編輯；解析時命中關鍵字就「建議」分類，仍可改、不擋入帳）。
  if ((await metaGet('keyword_category_rules', null)) == null) {
    await metaSet('keyword_category_rules', [
      { keyword: '貸款', category_id: 2 },
      { keyword: '還款', category_id: 2 },
      { keyword: '房貸', category_id: 2 },
      { keyword: '加油', category_id: 12 },
      { keyword: '學費', category_id: 8 },
    ]);
  }
  await backfillV2();
  await backfillV3();
  await backfillV4();
  await backfillV5();
  await backfillV6();
  await backfillV7();
  await backfillV8();
}

// ----------------------------------------------------------------------------
// 一次性 backfill v8：初始化各帳戶期初餘額＝2026-06-11 實際可用餘額（使用者提供）。
// 歷史匯入（五月、六月1-10）不影響餘額；今天之後的新交易才從這裡加減。
// 只在該帳戶期初仍為 0 時寫入（不覆寫使用者手動設定）；設定區隨時可改。
// ----------------------------------------------------------------------------
export async function backfillV8() {
  if (await metaGet('backfill_init_balance_v8', false)) return;
  const initMap = [
    ['Wawa 中國信託', 25653], ['Wawa 玉山', 39994], ['Wawa 郵局', 17749], ['Wawa 身上現金', 3957],
    ['LINE Pay Money', 13], ['一卡通', 33],
    ['先生 中信', 48087], ['先生 玉山', 20409], ['先生 身上現金', 0],
    ['哥哥保管金', 4100], // 另列，不計入總資產（帳戶本身 include_in_total=false）
  ];
  const accs = await getAll('accounts');
  for (const [kw, val] of initMap) {
    const a = accs.find((x) => x.name.includes(kw));
    if (a && Number(a.opening_balance || 0) === 0 && val !== 0) {
      const before = { ...a };
      a.opening_balance = val;
      await put('accounts', a);
      await logChange({ ts: new Date().toISOString(), entity: 'accounts', entity_id: a.id, action: 'init_balance', before, after: { ...a }, note: '初始化期初餘額（2026-06-11 實際可用）' });
    }
  }
  await metaSet('backfill_init_balance_v8', true);
}

// ----------------------------------------------------------------------------
// 一次性 backfill v7：日常現金分配的「情境關鍵字」→ 生活支出（分類 6）。
// 出現在行名目/冒號前綴時，套用到該行沒有自己名目的段落（預設帶、確認卡可改）。
// ----------------------------------------------------------------------------
export async function backfillV7() {
  if (await metaGet('backfill_seed_v7', false)) return;
  const adds = [['每天固定支出', 6], ['平日開銷', 6], ['日常開銷', 6]];
  const kw = (await metaGet('keyword_category_rules', null)) || [];
  const seen = new Set(kw.map((r) => r.keyword));
  for (const [k, v] of adds) if (!seen.has(k)) { kw.push({ keyword: k, category_id: v }); seen.add(k); }
  await metaSet('keyword_category_rules', kw);
  await metaSet('backfill_seed_v7', true);
}

// ----------------------------------------------------------------------------
// 一次性 backfill v6（§A 孩子生活退役）：
// ① 既有 category_id=9（孩子生活）的交易全部遷成 6（生活支出），逐筆寫變更紀錄。
// ② 分類清單移除 id 9；id 9 永不重用、其餘 id 不變（4 群 A 自然只剩 6 生活＋10 醫療）。
// ③ 關鍵字規則/店家記憶指向 9 的改指 6；補習/註冊→孩子教育(8) 補上（已有的不動）。
// ----------------------------------------------------------------------------
export async function backfillV6() {
  if (await metaGet('backfill_seed_v6', false)) return;

  // ① 交易遷移 9 → 6（安全：先遷交易、後動分類清單，不會出現孤兒）
  const txns = await getAll('transactions');
  let migrated = 0;
  for (const t of txns) {
    if (t.category_id === 9) {
      const before = { ...t };
      t.category_id = 6;
      await put('transactions', t);
      migrated += 1;
      await logChange({ ts: new Date().toISOString(), entity: 'transactions', entity_id: t.id, action: 'migrate_category', before, after: { ...t }, note: '孩子生活(9)退役 → 遷至生活支出(6)' });
    }
  }
  await metaSet('migrate_v6_count', migrated);

  // ② 分類清單移除 9（id 不重用）
  const cats = await metaGet('categories', []);
  const without = cats.filter((c) => c.id !== 9);
  if (without.length !== cats.length) {
    await metaSet('categories', without);
    await logChange({ ts: new Date().toISOString(), entity: 'categories', entity_id: 9, action: 'retire', before: cats.find((c) => c.id === 9), after: null, note: '孩子生活退役（id 9 不重用）；交易已遷生活支出' });
  }

  // ③ 規則遷移：關鍵字 9→6、店家記憶 9→6；補習/註冊→8 補上
  const kw = (await metaGet('keyword_category_rules', null)) || [];
  for (const r of kw) if (r.category_id === 9) r.category_id = 6;
  const seen = new Set(kw.map((r) => r.keyword));
  for (const k of ['補習', '註冊']) if (!seen.has(k)) kw.push({ keyword: k, category_id: 8 });
  await metaSet('keyword_category_rules', kw);
  const sm = (await metaGet('store_category_map', null)) || {};
  let smChanged = false;
  for (const k of Object.keys(sm)) if (sm[k] === 9) { sm[k] = 6; smChanged = true; }
  if (smChanged) await metaSet('store_category_map', sm);

  await metaSet('backfill_seed_v6', true);
}

// ----------------------------------------------------------------------------
// 一次性 backfill v5：常見繳費關鍵字 → 固定支出（分類 1）。
// 預設帶、仍走確認卡可改；合併不覆寫，已有同關鍵字者跳過。
// ----------------------------------------------------------------------------
export async function backfillV5() {
  if (await metaGet('backfill_seed_v5', false)) return;
  const adds = [
    ['電話費', 1], ['電信費', 1], ['手機費', 1], ['網路費', 1], ['瓦斯費', 1],
    ['水費', 1], ['電費', 1], ['管理費', 1], ['保險費', 1],
  ];
  const kw = (await metaGet('keyword_category_rules', null)) || [];
  const seen = new Set(kw.map((r) => r.keyword));
  for (const [k, v] of adds) if (!seen.has(k)) { kw.push({ keyword: k, category_id: v }); seen.add(k); }
  await metaSet('keyword_category_rules', kw);
  await metaSet('backfill_seed_v5', true);
}

// ----------------------------------------------------------------------------
// 一次性 backfill v4：
// ① 分類加「顯示排序 sort」欄位（依目前順序編號）。內部 id 永不重編，
//    資料連動與 4 群對應都靠 id；sort 只管畫面順序。
// ② 既有 #33（借表弟錢 $3015）改套「應收款」：現金扣款保留（type 改
//    receivable 後 calc 仍從原帳戶扣）、從支出統計移除、列入應收清單。
//    保險起見：只在金額 3015 或內容含「表弟」時才轉，避免轉錯筆。
// ----------------------------------------------------------------------------
export async function backfillV4() {
  if (await metaGet('backfill_seed_v4', false)) return;

  const cats = await metaGet('categories', []);
  let i = 0;
  for (const c of cats) { i += 1; if (c.sort == null) c.sort = i; }
  await metaSet('categories', cats);

  const t = await get('transactions', 33);
  if (t && t.type === 'expense'
      && (Number(t.amount) === 3015 || /表弟/.test(t.merchant || '') || /表弟/.test(t.note || ''))) {
    const before = { ...t };
    t.type = 'receivable';
    await put('transactions', t);
    await logChange({ ts: new Date().toISOString(), entity: 'transactions', entity_id: 33, action: 'convert_receivable', before, after: { ...t }, note: '#33 借表弟錢改套應收款（使用者指示）：移出支出統計、現金扣款保留、列入應收清單' });
  }

  await metaSet('backfill_seed_v4', true);
}

// ----------------------------------------------------------------------------
// 一次性 backfill v3：①主分類 11 就地改名「人情／婚喪／送禮」（id 不變，
// 既有交易存的是 category_id，自動連動，不開第 13 類）。
// ②全部主分類 → 4 群完整對應（消除未分群）。③群組顯示名稱。
// 跑過一次就不再動，之後一律以設定區使用者改的為準。
// ----------------------------------------------------------------------------
export async function backfillV3() {
  if (await metaGet('backfill_seed_v3', false)) return;

  const cats = await metaGet('categories', []);
  // ① 改名（只在仍是舊名時改，不蓋使用者自己改過的）
  const c11 = cats.find((c) => c.id === 11);
  if (c11 && c11.name.includes('人情') && c11.name.includes('喪') && !c11.name.includes('婚喪')) {
    c11.name = '人情 / 婚喪 / 送禮';
  }
  // ② 4 群對應：A 生活日常 / B 玩樂人情車 / C 固定剛性 / D 信用卡
  const G = { 6: 'A', 9: 'A', 10: 'A', 7: 'B', 11: 'B', 12: 'B', 1: 'C', 2: 'C', 4: 'C', 5: 'C', 8: 'C', 3: 'D' };
  for (const c of cats) if (G[c.id]) c.group4 = G[c.id];
  await metaSet('categories', cats);

  // ③ 群組顯示名稱（報表 4 群檢視用）
  if ((await metaGet('group4_names', null)) == null) {
    await metaSet('group4_names', { A: '生活・日常', B: '玩樂・人情・車', C: '固定・剛性', D: '信用卡' });
  }
  await metaSet('backfill_seed_v3', true);
}

// ----------------------------------------------------------------------------
// 一次性 backfill v2：分類改名、店家/關鍵字大量補建（合併、不覆寫使用者既有項）。
// 用 meta 旗標確保只跑一次；之後使用者刪掉的不會被它復活。
// 分類編號（§4.1）：1固定 2債務貸款 3信用卡卡費 4工作室 5工具 6生活 7娛樂
//                   8孩子教育 9孩子生活 10醫療 11人情喪葬 12車輛
// ----------------------------------------------------------------------------
export async function backfillV2() {
  if (await metaGet('backfill_seed_v2', false)) return;

  // (1) 分類改名：AI / 工具支出 → 工具（只在仍是舊名時改，不蓋過使用者改名）
  const cats = await metaGet('categories', []);
  const c5 = cats.find((c) => c.id === 5);
  if (c5 && /AI/.test(c5.name)) { c5.name = '工具'; await metaSet('categories', cats); }

  // (2) 店家 → 分類（合併，不覆寫既有；全聯為使用者測試需要、額外補上並標明）
  const storeSeed = {
    '三峽停車場': 12, '中油': 12, '連加': 12, '車容坊': 12,
    '統一超商': 6, '7-11': 6, '全家': 6, '八方雲集': 6, 'Subway': 6, '爭鮮': 6, '麥當勞': 6,
    '寶雅': 6, '蝦皮': 6, 'Coupang': 6, 'Mary Kay': 6, '優步': 6, 'Uber': 6, '全聯': 6,
    '好樂迪': 7, 'Spotify': 7, '秀泰影城': 7,
    '台灣大哥大': 1,
    'CapCut': 5, '美圖': 5, 'Skool': 5, 'Microsoft 365': 5,
  };
  const sm = await metaGet('store_category_map', {});
  for (const [k, v] of Object.entries(storeSeed)) if (!(k in sm)) sm[k] = v;
  await metaSet('store_category_map', sm);

  // (3) 關鍵字 → 分類（合併，新關鍵字才加；較具體的排前面，因 find 取第一個命中）
  const kwSeed = [
    ['看醫生', 10], ['看中醫', 10], ['看診', 10], ['拿藥', 10], ['掛號', 10],
    ['信用卡費', 3], ['卡費', 3],
    ['學習系統', 8], ['學費', 8], ['月費', 8],
    ['人壽險', 1], ['委代扣', 1], ['保險', 1], ['管理費', 1], ['大哥大', 1], ['電信', 1],
    ['房貸', 2], ['車貸', 2], ['信貸', 2], ['貸款', 2], ['還款', 2], ['利息', 2],
    ['加油', 12],
    ['紅包', 11], ['白包', 11], ['滿月', 11], ['奠儀', 11], ['喪', 11],
    ['鹹酥雞', 6], ['炸物', 6], ['早餐', 6], ['午餐', 6], ['晚餐', 6], ['便當', 6],
    ['零食', 6], ['飲料', 6], ['麵', 6], ['超商', 6], ['衛生紙', 6], ['衛生棉', 6], ['日用品', 6],
    ['工作室', 4], ['耗材', 4], ['房租', 4],
  ];
  const kw = await metaGet('keyword_category_rules', []);
  const seen = new Set(kw.map((r) => r.keyword));
  for (const [k, v] of kwSeed) if (!seen.has(k)) { kw.push({ keyword: k, category_id: v }); seen.add(k); }
  await metaSet('keyword_category_rules', kw);

  await metaSet('backfill_seed_v2', true);
}
