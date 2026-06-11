// ============================================================================
// parse.js — 規則辨識層（§1.2、§5、§9）
// 把「貼上的一段文字」或「截圖用 iOS 文字辨識複製出來的文字」用「規則」拆成
// 確認卡草稿：認 金額 / 日期(含相對日期) / 店家 / 付款來源關鍵字。
//
// 鐵律：
//  - 程式內不接任何 AI；純規則。
//  - 認不準的欄位一律「留空」，交給確認卡讓使用者補；絕不腦補（§5）。
//  - 付款來源「不可只看品牌字」：一律看資金來源信號（餘額/儲值 → 錢包；
//    簽帳/中信/末四碼 → 中信帳戶）；只寫「LINE Pay」又無信號 → 留空標待確認（§5）。
//  - 解析後一律走確認卡核對才入帳（呼叫端負責）。
// ============================================================================
import { parseRelativeDate } from './date.js';

function half(s) { return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); }

// ---- 日期：在整段文字裡找日期（明確日期優先，再找相對日期）；找不到回 null ----
export function scanDate(text, base = new Date()) {
  const s = half(text);
  // 明確：YYYY-MM-DD / YYYY/M/D
  let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return { date: pad(y, mo, d), matched: m[0], how: '明確日期' };
  }
  // 明確：M月D日
  m = s.match(/(\d{1,2})月(\d{1,2})日?/);
  if (m) {
    const mo = +m[1], d = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return { date: pad(base.getFullYear(), mo, d), matched: m[0], how: '明確日期（補今年）' };
  }
  // 相對日期：先把可能的相對片語掃出來，再交給 date.js 換算
  const relRe = /(大前天|前天|昨天|今天|本日|今日|大後天|後天|明天|明日|(?:上|這|本|下)(?:週|周|禮拜|星期)[一二三四五六日天末]|(?:\d+|[零一二兩三四五六七八九十]+)(?:天|日)前|前(?:\d+|[零一二兩三四五六七八九十]+)(?:天|日)|(?:\d+|[零一二兩三四五六七八九十]+)(?:天|日)後|後(?:\d+|[零一二兩三四五六七八九十]+)(?:天|日))/;
  m = s.match(relRe);
  if (m) {
    const r = parseRelativeDate(m[1], base);
    if (r) return { date: r.date, matched: m[1], how: '相對日期回推' };
  }
  return null;
}
function pad(y, mo, d) { const p = (x) => String(x).padStart(2, '0'); return `${y}-${p(mo)}-${p(d)}`; }

// ---- 金額：抓帶幣別記號者優先；多個或零個 → 留空（不猜）----
export function scanAmount(text) {
  let s = half(text);
  // 先移除會被誤當金額的數字：日期、發票號、末四碼、卡號、時間、店名數字(7-11)
  s = s.replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g, ' ')   // YYYY-MM-DD
       .replace(/[A-Za-z]{2}-?\d{8}/g, ' ')               // 發票號 AB12345678
       .replace(/\d{1,2}月\d{1,2}日?/g, ' ')               // M月D日
       .replace(/\d{1,2}\s*\/\s*\d{1,2}/g, ' ')           // M/D
       .replace(/\d{1,2}:\d{2}/g, ' ')                    // 時間
       .replace(/末\s*四\s*碼?\s*\d{3,4}/g, ' ')
       .replace(/(卡號|帳號|序號|發票)\D{0,3}[\dxX*]{3,}/g, ' ')
       .replace(/\d+\s*-\s*\d+/g, ' ');                   // 7-11 / 6-10 這種數字-數字（店名/日期）

  // 帶記號的金額：$ NT NT$ 元 塊
  const marked = [];
  let m; const re1 = /(?:nt\$?|\$)\s*([\d,]+(?:\.\d+)?)/gi;
  while ((m = re1.exec(s))) marked.push(num(m[1]));
  const re2 = /([\d,]+(?:\.\d+)?)\s*(?:元|塊)/g;
  while ((m = re2.exec(s))) marked.push(num(m[1]));

  let candidates = marked;
  if (candidates.length === 0) {
    // 沒有記號 → 退而求其次抓「獨立數字」（避免抓到夾在文字裡的小編號）
    const bare = [];
    const re3 = /(?<![\d.])([\d,]{1,9}(?:\.\d+)?)(?![\d.])/g;
    while ((m = re3.exec(s))) { const v = num(m[1]); if (v >= 1) bare.push(v); }
    candidates = bare;
  }
  const uniq = [...new Set(candidates.filter((x) => x != null && x > 0))];
  if (uniq.length === 1) return { amount: uniq[0], multiple: false };
  if (uniq.length > 1) return { amount: null, multiple: true, found: uniq };
  return { amount: null, multiple: false };
}
function num(s) { const v = Number(String(s).replace(/,/g, '')); return isNaN(v) ? null : v; }

// ---- 發票號碼 / 交易序號（查重 §7 用；抓不到回空字串）----
export function scanInvoice(text) {
  const s = half(text);
  // 台灣電子發票：2 個大寫英文 + 8 碼數字（可帶連字號），如 AB-12345678。
  // 用「前面是開頭或非英數字」避免吃到別的英數串，且不依賴 lookbehind（相容舊版 iOS）。
  let m = s.match(/(?:^|[^A-Za-z0-9])([A-Z]{2})-?(\d{8})(?![0-9])/);
  if (m) return (m[1] + m[2]);
  // 交易序號 / 授權碼 等：關鍵字後接 6 碼以上英數
  m = s.match(/(?:序號|交易序號|交易編號|授權碼|交易號)\D{0,4}([A-Za-z0-9]{6,})/);
  if (m) return m[1];
  return '';
}

// ---- 店家（§6 選填）----
// 順序：1) 先比對「已知店名」（記憶表裡的店名，出現在句中任何位置就認，最可靠）
//       2) 結構「在X」  3) 結構「X買/X花/X付…」（去掉開頭的日期/人稱雜字）
// 全部認不到 → 留空，不腦補。
export function scanMerchant(text, knownStores = []) {
  const s = half(text);

  // 1) 已知店名：長名優先比，避免短名先吃掉
  const hit = (knownStores || [])
    .filter((n) => n && s.includes(n))
    .sort((a, b) => b.length - a.length)[0];
  if (hit) return hit;

  // 2) 在X
  let m = s.match(/在\s*([^\s，,。、0-9$]{1,12}?)(?=刷|花|買|付|消費|用|吃|喝|，|,|。|、|\d|\$|$)/);
  if (m && m[1].trim()) return m[1].trim();

  // 3) X買 / X花 / X付 / X刷 / X吃 / X喝 / X繳…（取緊鄰動詞前的詞）
  m = s.match(/([^\s，,。、0-9$]{2,10})(?:買|花|付|刷|吃|喝|消費|繳費|繳)/);
  if (m) {
    let cand = m[1].replace(
      /^(大前天|前天|昨天|今天|明天|後天|大後天|(?:上|這|本|下)(?:週|周|禮拜|星期)[一二三四五六日天]|先生|老公|哥哥|妹妹|我|他|她|你|用|拿|剛|又|有|去|今早|早上|中午|晚上)+/,
      '');
    cand = cand.trim();
    if (cand.length >= 2) return cand;
  }
  return '';
}

// ---- 分類欄比對（結構化行「日期｜項目｜金額｜來源｜分類」的最後一欄）----
// 回 { kind:'cat', id } / { kind:'income' } / { kind:'receivable' } / null（對不上）。
// 先比「含分類名」（動態讀分類表，含使用者改過的名），再比別名；手續費等對不上 → null（未分類）。
export function matchCategoryColumn(colText, categories) {
  const t = (colText || '').trim();
  if (!t) return null;
  if (/收入/.test(t)) return { kind: 'income' };
  if (/(應收|暫借)/.test(t)) return { kind: 'receivable' };
  for (const c of (categories || [])) {
    if (c && c.name && t.includes(c.name)) return { kind: 'cat', id: c.id };
  }
  const alias = [
    [/餐費|生活/, 6], [/婚喪|送禮|人情|紅白包/, 11], [/貸款|債務|利息/, 2], [/車輛|加油|停車/, 12],
    [/工作室|材料|耗材/, 4], [/工具/, 5], [/教育|學費|補習/, 8], [/保險|固定/, 1],
    [/信用卡|卡費/, 3], [/娛樂|訂閱/, 7], [/醫療|看診/, 10],
  ];
  for (const [re, id] of alias) if (re.test(t)) return { kind: 'cat', id };
  return null;
}

// ---- 類型：收入/內部移動/支出（預設支出）----
export function scanType(text) {
  const s = text;
  if (/(儲值|提款|領錢|提領|轉帳|轉到|轉入|匯到|互轉|搬到|存入)/.test(s)) return 'transfer';
  if (/(薪資|薪水|運費|收入|入帳|匯入|收到|客人|營業)/.test(s)) return 'income';
  return 'expense';
}

// ---- 內部移動：抓「來源 + 目標」兩個帳戶（§3 提領/轉帳/儲值）----
// 依方向詞判定：從/由/提領/X轉 → 來源；到/至/轉到/存入/進/儲值錢包 → 目標。
// 抓不到的留 null，交給確認卡讓使用者補（轉帳兩個帳戶都必填）。
export function scanTransferAccounts(text, accounts, cards, defaults = {}) {
  const s = half(text);
  const TOK = '中國信託|中信|玉山|郵局|現金|一卡通|ipass|line\\s*pay\\s*money|錢包';
  const resolve = (tok) => (tok ? scanSource(tok, accounts, cards, defaults).id : null);
  let from = null, to = null, m;

  m = s.match(new RegExp('(?:到|至|轉到|轉入|存入|進)\\s*(' + TOK + ')', 'i'));
  if (m) to = resolve(m[1]);
  m = s.match(new RegExp('(?:從|由)\\s*(' + TOK + ')', 'i'));
  if (m) from = resolve(m[1]);

  if (/(提領|提款|領錢|領)/.test(s)) {
    if (from == null) { const b = s.match(/(中國信託|中信|玉山|郵局)/); if (b) from = resolve(b[1]); }
    if (to == null && /現金/.test(s)) to = resolve('現金');
  }
  if (/儲值/.test(s)) {
    if (to == null) { const w = s.match(new RegExp('(一卡通|ipass|line\\s*pay\\s*money|錢包)', 'i')); if (w) to = resolve(w[1]); }
    if (from == null) { const b = s.match(/(中國信託|中信|玉山|郵局|現金)/); if (b) from = resolve(b[1]); }
  }
  if (from == null) { m = s.match(new RegExp('(' + TOK + ')\\s*轉')); if (m) from = resolve(m[1]); }
  return { from, to };
}

// ---- 一行多筆拆分（批次輸入用）----
// 觸發：一行裡有多個「名目＋金額」段，用 ＋/+/、/，分隔 → 拆成多筆「支出」草稿。
// 規則：日期＝該行日期；對象標籤 我→Wawa 個人、兒子/哥哥/妹妹→孩子、先生→先生；
//       分類：關鍵字規則優先（早餐→生活…），孩子相關 fallback 孩子生活，判不準留空；
//       付款來源：該段「有寫來源（如 現金）」才填，沒寫一律留空→待確認，不亂猜不扣餘額。
// 拆出的草稿一律進確認卡逐張確認，不自動入帳（呼叫端負責）。
export function splitMultiExpense(text, ctx, base = new Date()) {
  const accounts = ctx.accounts || [];
  const cards = ctx.cards || [];
  const defaults = ctx.sourceDefaults || {};
  const kwRules = ctx.keywordRules || [];
  const s = half(text);

  const dateR = scanDate(s, base);
  const date = dateR ? dateR.date : null; // null → 呼叫端用今天

  // 取「｜」分段的最後一段當內容（前面通常是日期/名目），再用 ＋/+/、/，切成小段。
  // 若最後一欄是「分類欄」（沒金額、對得上分類）→ 內容改取倒數第二段，分類套用到每筆（欄位優先）。
  const parts = s.split(/[｜|]/).map((x) => x.trim()).filter(Boolean);
  let colCat = null, colCatText = '';
  let contentIdx = parts.length - 1;
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    const la = scanAmount(last);
    if (la.amount == null && !la.multiple) {
      const m = matchCategoryColumn(last, ctx.categories || []);
      if (m && m.kind === 'cat') { colCat = m; colCatText = last; contentIdx = parts.length - 2; }
    }
  }
  let content = parts.length ? parts[contentIdx] : s;

  // —— 冒號前綴＝套用到後面整串 ——
  // 「前綴：內容」（全形：或半形: 皆可）：前綴的付款來源 → 冒號後每一筆的共同來源。
  // 前綴本身不是一筆；某段自己寫了來源則以自己的為準；判不準照舊留空待確認。
  let prefixSrc = null, prefixNote = '';
  // 行情境文字：｜分段的「名目」部分（最後一段以外）＋冒號前綴。
  // 用來做第二優先的分類預設（如 每天固定支出/平日開銷 → 生活支出）。
  let contextText = parts.slice(0, -1).join(' ');
  const cm = content.match(/^([^：:]{1,20})[：:](.+)$/);
  // 排除「12:30」這種時間被誤當前綴
  const looksLikeTime = cm && /\d$/.test(cm[1].trim()) && /^\d{2}(\D|$)/.test(cm[2].trim());
  if (cm && !looksLikeTime) {
    const pre = cm[1].trim();
    contextText += ' ' + pre;
    const psrc = scanSource(pre, accounts, cards, defaults);
    content = cm[2].trim();
    if (psrc.id) {
      prefixSrc = psrc;
      prefixNote = `前綴「${pre}」→ 後面每筆的共同付款來源：${psrc.reason}${psrc.assumed ? '（預設帶，請核對）' : ''}`;
    } else if (psrc.reason) {
      prefixNote = `前綴「${pre}」：${psrc.reason}（前綴判不準 → 不套用，各筆來源照舊）`;
    } else {
      prefixNote = `前綴「${pre}」：沒有來源線索，僅當名目（不入帳，各筆來源各自判斷）`;
    }
  }

  const segs = content.split(/[＋+、，,]/).map((x) => x.trim()).filter(Boolean);

  const items = [];
  for (const seg of segs) {
    const a = scanAmount(seg);
    if (a.amount == null || a.multiple) continue; // 沒金額（或仍多金額）的段不成筆，不腦補
    // 對象標籤（孩子 → 先生 → 我 的順序判）
    const party = /(兒子|哥哥|妹妹|女兒|孩子)/.test(seg) ? '孩子'
      : /(先生|老公)/.test(seg) ? '先生'
      : /(我|自己)/.test(seg) ? 'Wawa 個人' : '';
    // 付款來源：該段自己寫了 → 以自己的為準（含「判不準→留空」也照舊，不吃前綴）；
    //           沒寫 → 繼承前綴共同來源；連前綴都沒有 → 留空待確認。
    const src = scanSource(seg, accounts, cards, defaults);
    // 分類預設（仍走確認卡可改），優先序高→低：
    //   0) 行尾分類欄（欄位優先）  1) 段落自己的名目關鍵字
    //   2) 行情境字（每天固定支出/平日開銷…→生活）  3) 純人稱＋金額 → 生活支出
    //   4) 孩子相關 → 生活支出  5) 判不準留空
    let category_id = null, catWhy = '';
    if (colCat) { category_id = colCat.id; catWhy = `分類欄「${colCatText}」→ 套用到每筆（欄位優先）`; }
    const hit = (category_id != null) ? null
      : kwRules.find((r) => r.keyword && seg.includes(r.keyword) && r.category_id != null);
    const ctxHit = (category_id == null && !hit && contextText)
      ? kwRules.find((r) => r.keyword && contextText.includes(r.keyword) && r.category_id != null)
      : null;
    // 純人稱：拿掉金額/幣別後只剩人稱字（我/兒子/哥哥/妹妹/女兒/孩子/先生/老公、的/和/跟）
    const cleanSeg = seg
      .replace(/(?:nt\$?|\$)\s*[\d,]+(?:\.\d+)?/gi, '')
      .replace(/[\d,]+(?:\.\d+)?\s*(?:元|塊)?/g, '')
      .replace(/[\s$.]/g, '');
    const purePerson = !!cleanSeg && /^(我|自己|兒子|哥哥|妹妹|女兒|孩子|先生|老公|的|和|跟)+$/.test(cleanSeg);
    if (category_id == null) {
      if (hit) { category_id = hit.category_id; catWhy = `命中關鍵字「${hit.keyword}」`; }
      else if (ctxHit) { category_id = ctxHit.category_id; catWhy = `行情境「${ctxHit.keyword}」→ 套用到這串`; }
      else if (purePerson) { category_id = 6; catWhy = '純人稱＋金額 → 預設生活支出'; }
      else if (party === '孩子') { category_id = 6; catWhy = '孩子相關 → 生活支出'; }
    }

    // 來源三段式：自己有 → 用自己的；自己判不準 → 留空（不吃前綴、不亂猜）；
    //             自己沒寫 → 繼承前綴；連前綴都沒有 → 留空待確認。
    let from_account_id = null, srcNote;
    if (src.id) {
      from_account_id = src.id;
      srcNote = `付款來源：${src.reason}${src.assumed ? '（預設帶，請核對）' : ''}${prefixSrc ? '（此段自己有寫，覆蓋前綴）' : ''}`;
    } else if (src.reason) {
      srcNote = `付款來源：${src.reason}（此段自己寫了但判不準 → 留空待確認，不套前綴）`;
    } else if (prefixSrc) {
      from_account_id = prefixSrc.id;
      srcNote = `付款來源：繼承前綴 → ${prefixSrc.reason}`;
    } else {
      srcNote = '付款來源：這段沒寫來源 → 留空、存起來會是「待確認」（不亂猜、不扣餘額）';
    }

    const notes = [
      ...(prefixNote ? [prefixNote] : []),
      `對象標籤：${party || '（判不出，留空）'}`,
      srcNote,
      category_id != null ? `分類：${catWhy}（建議，可改）` : '分類：判不準 → 留空待選',
    ];
    items.push({
      seg,
      draft: {
        type: 'expense', date, amount: a.amount, merchant: '',
        from_account_id, to_account_id: null,
        category_id, party_tag: party, vehicle_tag: '',
      },
      notes,
    });
  }
  return items.length >= 2 ? { date, items } : null; // 拆不出兩筆以上就不算多筆
}

// ---- 整行分類：批次輸入用。判斷一行是「交易候選」還是「跳過」（絕不腦補生交易）----
export function classifyLine(text, knownStores = []) {
  const t = (text || '').trim();
  if (!t) return { skip: true, reason: '空行' };
  // 先把已知店名（可能含數字，如 7-11、85度C）拿掉，避免店名數字被誤當金額
  let forAmt = t;
  for (const n of (knownStores || []).filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (forAmt.includes(n)) forAmt = forAmt.split(n).join(' ');
  }
  const amt = scanAmount(forAmt);
  if (amt.multiple) return { skip: true, multi: true, reason: `這行有多個金額（${amt.found.join('、')}），可能是多筆 → 請分行（之後用每日一鍵）` };
  if (amt.amount == null) return { skip: true, reason: '沒抓到金額 → 可能不是交易，已跳過（沒幫你記）' };
  if (/(沒|未|別|沒有|沒能|不用|取消)\s*(拿|領|花|買|付|繳|刷|給|收|消費|儲值|轉)/.test(t)) {
    return { skip: true, reason: '看起來在說「沒發生」→ 跳過，沒幫你記（不對請手動記）' };
  }
  return { skip: false };
}

// ---- 付款來源（§5 核心）：看資金來源信號，分不清就回 null + 原因（待確認）----
// defaults：同名帳戶的可調預設（token → accountId）。命中預設時回 assumed:true，
//           讓確認卡顯示「我填了 X，對嗎？」給使用者一眼確認（不是默默存）。
export function scanSource(text, accounts, cards, defaults = {}) {
  const s = half(text);
  const low = s.toLowerCase();
  const hasBalance = /(餘額|儲值|錢包餘額|錢包)/.test(s);
  const cardSig = /(簽帳|刷卡|刷|末\s*四|末四碼|信用卡|帳戶扣款)/.test(s);
  const findAcct = (pred) => accounts.filter((a) => !a.archived).filter(pred);
  const byName = (kw) => findAcct((a) => a.name.includes(kw));

  // 1) 一卡通 / iPASS（名稱即錢包，不會誤判）
  if (/(一卡通|ipass)/i.test(low)) {
    const w = findAcct((a) => /一卡通|ipass/i.test(a.name));
    if (w.length === 1) return { id: w[0].id, reason: '一卡通錢包' };
  }

  // 2) LINE Pay 家族（最容易記錯，照 §5 信號判）
  const lpMoney = /(line\s*pay\s*money|line\s*pay\s*錢包|錢包餘額)/i.test(low);
  const lpPlain = /line\s*pay/i.test(low);
  if (lpMoney) {
    const w = byName('LINE Pay Money');
    if (w.length === 1) return { id: w[0].id, reason: 'LINE Pay Money 錢包（有餘額/錢包信號）' };
  } else if (lpPlain) {
    if (cardSig || /(中信|中國信託)/.test(s)) {
      const c = resolveBank(s, accounts);
      if (c.id) return { id: c.id, reason: 'LINE Pay 刷中信簽帳卡（有中信/簽帳信號）' };
    }
    if (hasBalance) {
      const w = byName('LINE Pay Money');
      if (w.length === 1) return { id: w[0].id, reason: 'LINE Pay + 餘額/儲值信號 → 錢包' };
    }
    // 只寫 LINE Pay、無餘額也無中信/簽帳信號 → 分不出，照 §5 留空待確認
    return { id: null, reason: '只寫「LINE Pay」，沒有餘額/錢包或中信/簽帳信號，分不出扣中信還是錢包餘額 → 待你確認' };
  }

  // 3) 卡別（刷卡）→ 用 cards 對應的帳戶（§5 依卡別判定）
  if (cardSig) {
    // 文字出現的 token → 對應卡片名稱關鍵字
    const tokToCardKw = [['中國信託', '中信'], ['中信', '中信'], ['玉山', '玉山'], ['郵局', '郵局']];
    for (const [tok, cardKw] of tokToCardKw) {
      if (s.includes(tok)) {
        const card = cards.find((c) => c.name.includes(cardKw));
        if (card) {
          const acc = accounts.find((a) => a.id === card.account_id && !a.archived);
          if (acc) return { id: acc.id, reason: `刷${tok}卡 → ${acc.name}` };
        }
      }
    }
  }

  // 4) 銀行 / 現金（看名稱 + 限定詞；同名多個 → 用可調預設帶入並標 assumed，無預設則待確認）
  // token：文字關鍵字；match：哪些帳戶算這個 token；defKey：對應 source_defaults 的鍵。
  const tokenDefs = [
    { token: '中信', keys: ['中信', '中國信託'], match: (a) => a.name.includes('中信') || a.name.includes('中國信託'), defKey: '中信' },
    { token: '玉山', keys: ['玉山'], match: (a) => a.name.includes('玉山'), defKey: '玉山' },
    { token: '郵局', keys: ['郵局'], match: (a) => a.name.includes('郵局'), defKey: '郵局' },
    { token: '現金', keys: ['現金'], match: (a) => a.name.includes('現金') && a.type === 'cash', defKey: '現金' },
  ];
  const hasHusband = /(先生|老公|他)/.test(s);
  const hasWawa = /(我|wawa|自己)/i.test(s);
  const conflictLoan = /(貸款|還款|房貸)/.test(s); // 衝突信號：可能是「還某人的貸款」也可能是「用某帳戶去繳」
  for (const def of tokenDefs) {
    if (!def.keys.some((k) => s.includes(k))) continue;
    let cands = findAcct(def.match);
    // 人稱最大：明確寫「我／先生」一律以人稱為準（不管有沒有貸款字）
    if (hasWawa) cands = cands.filter((a) => a.owner === 'wawa');
    else if (hasHusband) cands = cands.filter((a) => a.owner === 'husband');
    // 沒人稱、但銀行帳戶（中信/玉山/郵局）又出現「貸款/還款/房貸」衝突信號 →
    // 可能是「還某人的貸款（沒說從哪出錢）」或「用某帳戶去繳」，兩義不能猜 → 待確認。
    // ⚠ 不可因為文字剛好對到帳戶名「中信貸款帳戶」就自動選它。
    else if (def.token !== '現金' && conflictLoan) {
      return { id: null, reason: `「${def.token}」又出現「貸款/還款/房貸」、且沒寫人稱，可能是還貸款也可能是用帳戶去繳，分不出 → 待你確認` };
    }
    if (cands.length === 1) return { id: cands[0].id, reason: `${def.token} → ${cands[0].name}` };
    if (cands.length > 1) {
      const defId = defaults[def.defKey];
      const defAcc = defId && accounts.find((a) => a.id === defId && !a.archived);
      if (defAcc) return { id: defAcc.id, assumed: true, reason: `「${def.token}」同名有多個帳戶，預設帶「${defAcc.name}」（請在確認卡核對）` };
      return { id: null, reason: `「${def.token}」對應到多個帳戶（${cands.map((a) => a.name).join('、')}），分不出哪一個 → 待你確認` };
    }
  }

  return { id: null, reason: '' }; // 沒有任何來源線索 → 留空，由表單層標待確認
}

// 給 LINE Pay 分支用：找 Wawa 中信主帳（有中信/簽帳信號時）
function resolveBank(s, accounts) {
  const live = accounts.filter((a) => !a.archived);
  if (/貸款/.test(s)) {
    const loan = live.filter((a) => a.name.includes('貸款') && a.name.includes('中信'));
    if (loan.length === 1) return { id: loan[0].id };
  }
  const main = live.filter((a) => a.name.includes('中國信託') && !a.name.includes('貸款'));
  if (main.length === 1) return { id: main[0].id };
  return { id: null };
}

// ============================================================================
// 總入口：把文字解析成草稿 + 註記（哪些填好、哪些留空待你補）
// ============================================================================
export function parseText(text, ctx, base = new Date()) {
  const accounts = ctx.accounts || [];
  const cards = ctx.cards || [];
  const sourceDefaults = ctx.sourceDefaults || {};
  const storeCategoryMap = ctx.storeCategoryMap || {};
  const keywordRules = ctx.keywordRules || [];
  const categories = ctx.categories || [];
  const notes = [];
  const assumptions = {};   // 哪些欄位是「預設帶入、需你確認」

  // 結構化行「日期｜項目｜金額｜來源｜分類」：最後一欄若是「分類文字」（沒有金額）
  // → 欄位優先，高於關鍵字猜測（§欄位優先）。對不上任何分類才留未分類。
  const colsAll = half(text).split(/[｜|]/).map((x) => x.trim()).filter(Boolean);
  let colSpec = null, colText = '';
  if (colsAll.length >= 3) {
    const last = colsAll[colsAll.length - 1];
    const la = scanAmount(last);
    if (la.amount == null && !la.multiple) {
      colText = last;
      colSpec = matchCategoryColumn(last, categories);
    }
  }

  let type = scanType(text);
  if (colSpec && colSpec.kind === 'income') { type = 'income'; notes.push(`分類欄「${colText}」→ 收入`); }
  else if (colSpec && colSpec.kind === 'receivable') { type = 'receivable'; notes.push(`分類欄「${colText}」→ 應收款/暫借款（進應收清單）`); }

  const dateR = scanDate(text, base);
  const date = dateR ? dateR.date : null;   // null → 呼叫端用今天當預設
  if (dateR) notes.push(`日期：${dateR.matched}（${dateR.how}）`);
  else notes.push('日期：文字裡沒提到 → 預設今天（記帳日＝回報當天）');

  const amtR = scanAmount(text);
  if (amtR.multiple) notes.push(`金額：偵測到多個數字（${amtR.found.join('、')}），分不出哪個是金額 → 留空待你補（或這可能是多筆，請分開貼）`);
  else if (amtR.amount == null) notes.push('金額：沒抓到 → 留空（待補）');

  let merchant = scanMerchant(text, Object.keys(storeCategoryMap));
  if (text.includes('大大寬頻')) merchant = '大大寬頻'; // 特例店家（依金額分類，見下）
  // 結構化行：店家抓不到時，用第 2 欄「項目」當顯示名（明細才看得出買什麼）
  if (!merchant && colSpec && colsAll.length >= 4) {
    const item = colsAll[1];
    const ia = scanAmount(item);
    if (item && ia.amount == null && !ia.multiple && !/^\d{4}[-/.]/.test(item)) merchant = item;
  }
  if (!merchant) notes.push('店家：沒抓到 → 留空（選填，可不填）');

  const src = scanSource(text, accounts, cards, sourceDefaults);
  const acctName = (id) => accounts.find((a) => a.id === id)?.name || '';
  let from_account_id = null, to_account_id = null;
  if (type === 'income') {
    if (src.id) { to_account_id = src.id; notes.push(`收款帳戶：${src.reason}`); if (src.assumed) assumptions.to_account_id = `我填了「${acctName(src.id)}」，對嗎？`; }
    else notes.push(`收款帳戶：${src.reason || '沒抓到'} → 留空待你選`);
  } else if (type === 'transfer') {
    const tr = scanTransferAccounts(text, accounts, cards, sourceDefaults);
    from_account_id = tr.from;
    to_account_id = tr.to;
    const fName = tr.from ? acctName(tr.from) : '（待補）';
    const tName = tr.to ? acctName(tr.to) : '（待補）';
    notes.push(`內部移動：來源 ${fName} → 目標 ${tName}${(!tr.from || !tr.to) ? '（沒抓到的請你補）' : ''}`);
  } else {
    if (src.id) { from_account_id = src.id; notes.push(`付款來源：${src.reason}`); if (src.assumed) assumptions.from_account_id = `我填了「${acctName(src.id)}」，對嗎？`; }
    else notes.push(`付款來源：${src.reason || '沒抓到付款來源線索'} → 留空標待確認（不亂猜）`);
  }

  // 分類建議（一律「建議、可改」，不擋入帳）。優先序：
  //   0) 分類欄（結構化行，欄位優先）  0.5) 大大寬頻特例  1) 店家記憶  2) 關鍵字規則  3) 留空
  let category_id = null;
  if (colSpec && colSpec.kind === 'cat') {
    category_id = colSpec.id;
    notes.push(`分類：分類欄「${colText}」→ 直接對應（欄位優先，可改）`);
  } else if (colText && !colSpec) {
    notes.push(`分類欄「${colText}」對不上任何分類 → 照其他規則判（判不出就未分類）`);
  }
  if (category_id == null)
  if (merchant === '大大寬頻') {
    if (amtR.amount === 1500) { category_id = 1; notes.push('大大寬頻 $1500 → 固定支出（特例）'); }
    else if (amtR.amount === 1200) { category_id = 4; notes.push('大大寬頻 $1200 → 工作室（特例）'); }
    else notes.push('大大寬頻：金額不是 1500/1200 → 分類留空待你選');
  } else if (merchant && storeCategoryMap[merchant] != null) {
    category_id = storeCategoryMap[merchant];
    notes.push(`分類：記得「${merchant}」上次是這個分類 → 自動帶上（可改）`);
  } else {
    const hitRule = keywordRules.find((r) => r.keyword && text.includes(r.keyword) && r.category_id != null);
    if (hitRule) {
      category_id = hitRule.category_id;
      notes.push(`分類：文字命中關鍵字「${hitRule.keyword}」→ 建議分類（可改）`);
    } else {
      notes.push('分類：留空給你選（沒有腦補；你確認後我會記住這家店的分類）');
    }
  }

  return {
    draft: {
      type,
      date,
      amount: amtR.amount,
      merchant,
      from_account_id,
      to_account_id,
      category_id,
      party_tag: '',
      vehicle_tag: '',
      col_text: colText || '',        // 結構化行的分類欄原文（歷史預覽用）
      col_matched: !!colSpec,
    },
    notes,
    assumptions,
  };
}
