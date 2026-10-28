'use strict';
/* مدير محل السجائر v1 — vanilla JS. All money = integer piastres (1 EGP = 100).
   SECURITY: browser-only login. It is NOT real security (see README). Replace DB + auth with a backend later. */
const APP = 'cigarette-shop-manager', VER = 1, TZ = 'Africa/Cairo';
let S = null, cur = null, view = 'dash', cart = [], busy = false, fails = 0, lockUntil = 0, lastCsv = null;
const R = { from: '', to: '', group: 'day' };
const H = {};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = p => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const now = () => new Date().toISOString();
const money = n => (n / 100).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ج.م';
const toP = v => { const n = Math.round(parseFloat(String(v).replace(',', '.')) * 100); return isFinite(n) ? n : NaN; };
const cairoDay = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const fmtDT = iso => new Date(iso).toLocaleString('ar-EG', { timeZone: TZ });
const today = () => cairoDay(now());
const inR = (iso, f, t) => { const d = cairoDay(iso); return d >= f && d <= t; };
const adm = () => { if (!cur || cur.role !== 'admin') throw new Error('غير مصرح لك بهذا الإجراء'); };
const TYPES = { opening: 'رصيد افتتاحي', receive: 'استلام', adjust: 'تسوية', sale: 'بيع', return: 'مرتجع/إلغاء' };

/* ---------- Storage (IndexedDB, localStorage fallback). Replace this object to plug in a cloud DB. ---------- */
const DB = {
  db: null,
  open() { return new Promise((res, rej) => { if (!window.indexedDB) return rej(); const r = indexedDB.open('cigshop', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { this.db = r.result; res(); }; r.onerror = () => rej(r.error); }); },
  get() { if (!this.db) return Promise.resolve(JSON.parse(localStorage.getItem('cigshop') || 'null')); return new Promise((res, rej) => { const q = this.db.transaction('kv').objectStore('kv').get('main'); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }); },
  put(s) { if (!this.db) { localStorage.setItem('cigshop', JSON.stringify(s)); return Promise.resolve(); } return new Promise((res, rej) => { const t = this.db.transaction('kv', 'readwrite'); t.objectStore('kv').put(s, 'main'); t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }
};
/* Atomic-as-possible: mutate a copy-protected state, write once, roll back in memory if the write fails. */
async function tx(fn) {
  const snap = structuredClone(S);
  try { fn(); await DB.put(S); } catch (e) { S = snap; throw e; } finally { if (cur) cur = S.users.find(u => u.id === cur.id) || cur; }
}
function log(a, d) { S.audit.push({ id: uid('a'), at: now(), by: cur ? cur.id : null, action: a, detail: d || '' }); if (S.audit.length > 3000) S.audit.splice(0, S.audit.length - 3000); }
async function hash(pw, salt) { const b = new TextEncoder().encode(salt + ':' + pw); if (window.crypto && crypto.subtle) { const d = await crypto.subtle.digest('SHA-256', b); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join(''); } return 'plain:' + salt + pw; }
async function fresh() {
  const salt = uid('s');
  return { app: APP, version: VER, created: now(), users: [{ id: uid('u'), username: 'admin', name: 'المدير', role: 'admin', active: true, salt, hash: await hash('admin123', salt), mustChange: true, created: now() }], products: [], sales: [], moves: [], expenses: [], audit: [], backups: [], settings: { shop: 'محل السجائر', methods: ['كاش', 'فودافون كاش', 'إنستاباي'], allowNegative: false, receiptNo: 0 } };
}
const okState = o => o && Array.isArray(o.users) && Array.isArray(o.products) && Array.isArray(o.sales) && Array.isArray(o.moves) && Array.isArray(o.expenses) && Array.isArray(o.audit) && o.settings && Array.isArray(o.settings.methods);

/* ---------- UI helpers ---------- */
function toast(m, e) { const d = document.createElement('div'); d.className = 'toast' + (e ? ' e' : ''); d.setAttribute('role', 'status'); d.textContent = m; document.body.appendChild(d); setTimeout(() => d.remove(), 3500); }
function dlg(html) { const d = document.createElement('dialog'); d.innerHTML = html; document.body.appendChild(d); d.addEventListener('close', () => d.remove()); d.showModal(); return d; }
function form(title, fields, ok = 'حفظ', validate) {
  return new Promise(res => {
    const inp = f => f.t === 'select' ? `<select name="${f.k}">${f.o.map(o => `<option value="${esc(o[0])}"${String(o[0]) === String(f.v) ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`
      : f.t === 'textarea' ? `<textarea name="${f.k}">${esc(f.v)}</textarea>`
      : `<input name="${f.k}" type="${f.t || 'text'}" value="${esc(f.v ?? '')}"${f.step ? ` step="${f.step}"` : ''}${f.min != null ? ` min="${f.min}"` : ''}${f.r ? ' required' : ''}${f.ro ? ' readonly' : ''} autocomplete="off">`;
    const d = dlg(`<form method="dialog"><h3>${esc(title)}</h3>${fields.map(f => `<label>${esc(f.l)}${inp(f)}</label>`).join('')}<div class="err"></div><div class="row"><button class="btn" value="ok">${esc(ok)}</button><button class="btn ghost" value="x" formnovalidate>إلغاء</button></div></form>`);
    const f = d.querySelector('form');
    f.onsubmit = e => { if (!e.submitter || e.submitter.value !== 'ok') return; const err = validate && validate(Object.fromEntries(new FormData(f))); if (err) { e.preventDefault(); d.querySelector('.err').textContent = err; } };
    d.addEventListener('close', () => res(d.returnValue === 'ok' ? Object.fromEntries(new FormData(f)) : null));
  });
}
const sure = m => form(m, [], 'تأكيد');
function tbl(head, rows, raw) { if (!rows.length) return '<p class="empty">لا توجد بيانات</p>'; return `<div class="tw"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${raw ? c : esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`; }
function dl(name, text, mime) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
const cell = v => { let s = String(v ?? ''); if (/^[=+@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = rows => '\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n');
function csvParse(t) { const rows = []; let r = [], c = '', q = false; t = t.replace(/^\uFEFF/, ''); for (let i = 0; i < t.length; i++) { const ch = t[i]; if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; } else if (ch === '"') q = true; else if (ch === ',') { r.push(c); c = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; r.push(c); c = ''; if (r.some(x => x !== '')) rows.push(r); r = []; } else c += ch; } r.push(c); if (r.some(x => x !== '')) rows.push(r); return rows; }
const rangeBar = () => `<div class="row noprint"><label>من<input type="date" id="rf" value="${R.from}" data-on="range"></label><label>إلى<input type="date" id="rt" value="${R.to}" data-on="range"></label></div>`;
H.range = () => { const f = $('#rf').value, t = $('#rt').value; if (f && t && f <= t) { R.from = f; R.to = t; render(); } else toast('التاريخ غير صحيح', 1); };

/* ---------- Business logic ---------- */
function mv(p, type, q, reason, saleId) { p.stock += q; S.moves.push({ id: uid('m'), at: now(), pid: p.id, name: p.name, type, qty: q, after: p.stock, reason, saleId: saleId || null, by: cur.id }); }
function saleFin(s) { let rev = 0, cogs = 0, costRev = 0, noCost = 0; s.items.forEach(i => { rev += i.net; if (i.cost != null) { cogs += i.cost * i.qty; costRev += i.net; } else noCost++; }); return { rev, cogs, costRev, noCost }; }
/* revenue = Σ line net (after discount); COGS = Σ cost×qty (lines with recorded cost only);
   gross profit = Σ net of costed lines − COGS; net estimate = gross profit − expenses. */
function summary(from, to) {
  const ss = S.sales.filter(s => s.status === 'completed' && inR(s.at, from, to));
  const t = { ss, rev: 0, cogs: 0, costRev: 0, noCost: 0, count: ss.length };
  ss.forEach(s => { const f = saleFin(s); t.rev += f.rev; t.cogs += f.cogs; t.costRev += f.costRev; t.noCost += f.noCost; });
  t.exp = S.expenses.filter(x => x.date >= from && x.date <= to).reduce((a, x) => a + x.amount, 0);
  t.gross = t.costRev - t.cogs; t.net = t.gross - t.exp; return t;
}
const lowStock = () => S.products.filter(p => p.active && p.stock <= p.threshold);

/* ---------- Auth ---------- */
function loginView() {
  const hint = S.users.some(u => u.username === 'admin' && u.mustChange);
  $('#app').innerHTML = `<div class="login"><h1>🚬 ${esc(S.settings.shop)}</h1><form id="lf"><label>اسم المستخدم<input name="u" autocomplete="username" required></label><label>كلمة المرور<input name="p" type="password" autocomplete="current-password" required></label><div class="err" id="le"></div><button class="btn big">دخول</button></form>${hint ? '<p class="note">أول استخدام: المستخدم admin وكلمة المرور admin123 — هيطلب منك تغييرها.</p>' : ''}<p class="note">البيانات محفوظة على هذا الجهاز/المتصفح فقط.</p></div>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target), le = $('#le');
    if (Date.now() < lockUntil) { le.textContent = 'محاولات كتير. استنى ' + Math.ceil((lockUntil - Date.now()) / 1000) + ' ثانية.'; return; }
    const u = S.users.find(x => x.username === String(f.get('u')).trim().toLowerCase());
    if (u && u.active && await hash(f.get('p'), u.salt) === u.hash) {
      fails = 0; cur = u; sessionStorage.setItem('sid', u.id); log('login'); await DB.put(S).catch(() => { });
      view = u.role === 'admin' ? 'dash' : 'pos'; R.from = R.to = today(); render(); if (u.mustChange) await changePw(true);
    } else { if (++fails >= 5) { lockUntil = Date.now() + 30000; fails = 0; } le.textContent = 'بيانات الدخول غير صحيحة'; }
  };
}
async function changePw(force) {
  for (;;) {
    const v = await form(force ? 'لازم تغيّر كلمة المرور' : 'تغيير كلمة المرور', [{ k: 'o', l: 'كلمة المرور الحالية', t: 'password', r: 1 }, { k: 'n', l: 'الجديدة (6 حروف أو أرقام على الأقل)', t: 'password', r: 1 }, { k: 'c', l: 'تأكيد الجديدة', t: 'password', r: 1 }], 'حفظ',
      v => v.n.length < 6 ? 'كلمة المرور قصيرة' : v.n !== v.c ? 'التأكيد غير مطابق' : v.n === 'admin123' ? 'اختار كلمة مرور مختلفة' : '');
    if (!v) { if (force) continue; return; }
    if (await hash(v.o, cur.salt) !== cur.hash) { toast('كلمة المرور الحالية غلط', 1); continue; }
    const salt = uid('s'), h = await hash(v.n, salt);
    await tx(() => { const u = S.users.find(x => x.id === cur.id); u.salt = salt; u.hash = h; u.mustChange = false; log('password_change'); });
    toast('تم تغيير كلمة المرور'); return;
  }
}
H.logout = () => { log('logout'); DB.put(S).catch(() => { }); cur = null; cart = []; sessionStorage.removeItem('sid'); render(); };
H.pw = () => changePw(false);

/* ---------- Shell / routing ---------- */
const NAV = { admin: [['dash', '📊', 'الرئيسية'], ['pos', '🛒', 'البيع'], ['products', '🚬', 'المنتجات'], ['inventory', '📦', 'المخزون'], ['sales', '🧾', 'المبيعات'], ['expenses', '💸', 'المصروفات'], ['reports', '📈', 'التقارير'], ['users', '👥', 'المستخدمين'], ['settings', '⚙️', 'الإعدادات']], cashier: [['pos', '🛒', 'البيع'], ['sales', '🧾', 'مبيعاتي']] };
const V = {};
function render() {
  if (!cur) return loginView();
  const nav = NAV[cur.role] || NAV.cashier; if (!nav.some(n => n[0] === view)) view = nav[0][0];
  if (!R.from) R.from = R.to = today();
  $('#app').innerHTML = `<header class="noprint"><b>${esc(S.settings.shop)}</b><span>${esc(cur.name)}</span><button class="btn sm ghost" data-act="pw" aria-label="تغيير كلمة المرور">🔑</button><button class="btn sm ghost" data-act="logout">خروج</button></header><nav class="noprint">${nav.map(n => `<a href="#" data-act="go" data-v="${n[0]}" class="${view === n[0] ? 'on' : ''}"><i>${n[1]}</i>${n[2]}</a>`).join('')}</nav><main id="main"></main>`;
  try { V[view](); } catch (e) { $('#main').innerHTML = `<p class="err">حصل خطأ: ${esc(e.message)}</p>`; }
}
H.go = d => { view = d.v; render(); };
document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && H[b.dataset.act]) { e.preventDefault(); Promise.resolve().then(() => H[b.dataset.act](b.dataset, b)).catch(err => toast(err.message || String(err), 1)); } });
document.addEventListener('input', e => { const t = e.target; if (t.dataset && t.dataset.on && H[t.dataset.on]) try { H[t.dataset.on](t); } catch (err) { toast(err.message, 1); } });

/* ---------- Dashboard ---------- */
V.dash = () => {
  adm(); const s = summary(R.from, R.to), top = {};
  s.ss.forEach(x => x.items.forEach(i => { top[i.name] = (top[i.name] || 0) + i.qty; }));
  const best = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5), low = lowStock();
  const gp = s.costRev ? money(s.gross) : '—';
  $('#main').innerHTML = `<h2>لوحة التحكم</h2>${rangeBar()}
  <div class="grid"><div class="stat"><small>إجمالي المبيعات (إيراد)</small><b>${money(s.rev)}</b></div><div class="stat"><small>عدد الفواتير</small><b>${s.count}</b></div><div class="stat"><small>إجمالي الربح (مبدئي)</small><b>${gp}</b></div><div class="stat"><small>المصروفات</small><b>${money(s.exp)}</b></div><div class="stat"><small>صافي الربح التقديري</small><b class="${s.net < 0 ? 'bad' : 'ok'}">${s.costRev || s.exp ? money(s.net) : '—'}</b></div></div>
  <p class="note">الإيراد = مجموع المبيعات بعد الخصم وليس ربحًا. إجمالي الربح = مبيعات الأصناف المسجّل لها تكلفة − تكلفتها. صافي الربح التقديري = إجمالي الربح − المصروفات.${s.noCost ? ` <b>تنبيه: ${s.noCost} بند بدون تكلفة مسجلة لم تدخل في الربح.</b>` : ''}</p>
  <div class="card"><h3>⚠️ مخزون منخفض (${low.length})</h3>${tbl(['المنتج', 'المتاح', 'الحد'], low.map(p => [p.name, p.stock, p.threshold]))}</div>
  <div class="card"><h3>الأكثر مبيعًا</h3>${tbl(['المنتج', 'الكمية'], best)}</div>
  <div class="card"><h3>آخر الفواتير</h3>${tbl(['رقم', 'الوقت', 'الكاشير', 'الإجمالي'], S.sales.filter(x => x.status === 'completed').slice(-8).reverse().map(x => [x.no, fmtDT(x.at), x.cashier, money(x.total)]))}</div>`;
};

/* ---------- POS ---------- */
V.pos = () => {
  $('#main').innerHTML = `<div class="pos"><section class="card"><input id="q" data-on="posq" placeholder="ابحث بالاسم أو الكود أو الباركود (Enter للباركود)" autocomplete="off"><div id="plist"></div></section>
  <aside class="card"><h3>السلة</h3><div id="lines"></div><div id="tot" class="tot"></div>
  <label>خصم (ج.م)<input id="disc" type="number" min="0" step="0.01" data-on="paycalc"></label>
  <label>طريقة الدفع (الأولى = نقدي)<select id="pm" data-on="paycalc">${S.settings.methods.map(m => `<option>${esc(m)}</option>`).join('')}</select></label>
  <label id="rcvl">المبلغ المستلم (ج.م)<input id="rcv" type="number" min="0" step="0.01" data-on="paycalc"></label><div id="chg" class="note"></div>
  <button class="btn big" data-act="checkout">إتمام البيع</button></aside></div>`;
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') { const q = e.target.value.trim().toLowerCase(), p = S.products.find(x => x.active && q && (String(x.barcode).toLowerCase() === q || x.sku.toLowerCase() === q)); if (p) { H.add({ id: p.id }); e.target.value = ''; H.posq(e.target); } } });
  H.posq($('#q')); drawCart();
};
H.posq = el => {
  const q = el.value.trim().toLowerCase(), L = S.products.filter(p => p.active && (!q || [p.name, p.brand, p.sku, p.barcode].some(x => String(x || '').toLowerCase().includes(q)))).slice(0, 40);
  $('#plist').innerHTML = L.length ? L.map(p => `<button data-act="add" data-id="${p.id}">${esc(p.name)}<small>${money(p.price)} • متاح ${p.stock}</small></button>`).join('') : '<p class="empty">لا يوجد منتج</p>';
};
H.add = d => { const p = S.products.find(x => x.id === d.id); if (!p) return; const c = cart.find(x => x.id === d.id); if (c) c.q++; else cart.push({ id: d.id, q: 1 }); drawCart(); };
H.dec = d => { const c = cart.find(x => x.id === d.id); if (c && --c.q < 1) cart = cart.filter(x => x !== c); drawCart(); };
H.del = d => { cart = cart.filter(x => x.id !== d.id); drawCart(); };
H.qty = el => { const c = cart.find(x => x.id === el.dataset.id), q = parseInt(el.value, 10); if (c && q >= 1) { c.q = q; drawTotals(); const p = S.products.find(x => x.id === c.id), lt = document.getElementById('lt_' + c.id); if (lt && p) lt.textContent = money(p.price * q); } };
function cartSub() { return cart.reduce((a, c) => { const p = S.products.find(x => x.id === c.id); return a + (p ? p.price * c.q : 0); }, 0); }
function drawCart() {
  $('#lines').innerHTML = cart.length ? cart.map(c => { const p = S.products.find(x => x.id === c.id); return `<div class="line"><div>${esc(p.name)}<br><small class="note">${money(p.price)} × <span id="lt_${c.id}">${money(p.price * c.q)}</span></small></div><input type="number" min="1" step="1" value="${c.q}" data-on="qty" data-id="${c.id}" aria-label="الكمية"><div><button class="btn sm ghost" data-act="dec" data-id="${c.id}">−</button> <button class="btn sm red" data-act="del" data-id="${c.id}">✕</button></div></div>`; }).join('') : '<p class="empty">السلة فاضية</p>';
  drawTotals();
}
function drawTotals() {
  const sub = cartSub(), dv = $('#disc').value.trim(), disc = dv ? toP(dv) : 0, total = sub - (disc > 0 && disc <= sub ? disc : 0), cash = $('#pm').selectedIndex === 0;
  $('#tot').textContent = 'الإجمالي: ' + money(total); $('#rcvl').style.display = cash ? '' : 'none';
  const rv = $('#rcv').value.trim(), rec = rv ? toP(rv) : NaN; $('#chg').textContent = cash && rec >= total ? 'الباقي للعميل: ' + money(rec - total) : cash && rv ? 'المبلغ أقل من الإجمالي' : '';
}
H.paycalc = drawTotals;
H.checkout = async () => {
  if (busy) return; busy = true; const btn = $('[data-act=checkout]'); if (btn) btn.disabled = true;
  try {
    if (!cart.length) throw new Error('السلة فاضية');
    const lines = cart.map(c => { const p = S.products.find(x => x.id === c.id); if (!p || !p.active) throw new Error('منتج غير متاح'); if (!Number.isInteger(c.q) || c.q < 1) throw new Error('كمية غير صحيحة'); return { p, q: c.q }; });
    const low = lines.filter(l => l.p.stock < l.q);
    if (low.length) { if (!(cur.role === 'admin' && S.settings.allowNegative)) throw new Error('المخزون لا يكفي: ' + low.map(l => l.p.name + ' (المتاح ' + l.p.stock + ')').join('، ')); if (!await sure('المخزون لا يكفي لبعض المنتجات. تسمح بالبيع وتخلي المخزون بالسالب؟')) return; }
    const sub = lines.reduce((a, l) => a + l.p.price * l.q, 0), dv = $('#disc').value.trim(), disc = dv ? toP(dv) : 0;
    if (!(disc >= 0) || disc > sub) throw new Error('الخصم غير صحيح');
    const total = sub - disc, pm = $('#pm').value, cash = $('#pm').selectedIndex === 0; let rec = total, chg = 0;
    if (cash) { const rv = $('#rcv').value.trim(); rec = rv ? toP(rv) : total; if (!(rec >= total)) throw new Error('المبلغ المستلم أقل من الإجمالي'); chg = rec - total; }
    let s;
    await tx(() => {
      const no = 'R-' + String(++S.settings.receiptNo).padStart(6, '0'); let left = disc;
      const items = lines.map((l, i) => { const lt = l.p.price * l.q; let d = i === lines.length - 1 ? left : (sub ? Math.round(disc * lt / sub) : 0); if (d > left) d = left; left -= d; return { pid: l.p.id, name: l.p.name, qty: l.q, price: l.p.price, cost: l.p.cost, net: lt - d }; });
      s = { id: uid('s'), no, at: now(), cashierId: cur.id, cashier: cur.name, items, subtotal: sub, discount: disc, total, method: pm, received: rec, change: chg, status: 'completed' };
      S.sales.push(s); lines.forEach(l => mv(l.p, 'sale', -l.q, 'بيع ' + no, s.id)); log('sale', no);
    });
    cart = []; render(); showReceipt(s);
  } catch (e) { toast(e.message, 1); } finally { busy = false; const b = $('[data-act=checkout]'); if (b) b.disabled = false; }
};
function showReceipt(s) {
  const d = dlg(`<div class="rc"><h3 style="text-align:center">${esc(S.settings.shop)}</h3><div>فاتورة: ${esc(s.no)}${s.status === 'cancelled' ? ' (ملغاة)' : ''}<br>${fmtDT(s.at)}<br>الكاشير: ${esc(s.cashier)}</div><table><tr><th>الصنف</th><th>كمية</th><th>سعر</th><th>إجمالي</th></tr>${s.items.map(i => `<tr><td>${esc(i.name)}</td><td>${i.qty}</td><td>${money(i.price)}</td><td>${money(i.price * i.qty)}</td></tr>`).join('')}</table><hr>المجموع: ${money(s.subtotal)}<br>الخصم: ${money(s.discount)}<br><b>الإجمالي: ${money(s.total)}</b><br>الدفع: ${esc(s.method)}${s.change ? `<br>المستلم: ${money(s.received)} — الباقي: ${money(s.change)}` : ''}<p style="text-align:center">شكرًا لزيارتكم</p></div><div class="row noprint"><button class="btn" onclick="window.print()">🖨️ طباعة</button><button class="btn ghost" onclick="this.closest('dialog').close()">إغلاق</button></div>`);
  return d;
}

/* ---------- Products ---------- */
const PCOLS = ['name', 'brand', 'sku', 'barcode', 'category', 'cost', 'price', 'stock', 'threshold', 'supplier'];
V.products = () => {
  adm(); const cats = [...new Set(S.products.map(p => p.category).filter(Boolean))];
  $('#main').innerHTML = `<h2>المنتجات</h2><div class="row noprint"><input id="pq" placeholder="بحث" data-on="prows"><select id="pc" data-on="prows"><option value="">كل الأقسام</option>${cats.map(c => `<option>${esc(c)}</option>`).join('')}</select><select id="ps" data-on="prows"><option value="">الكل</option><option value="a">نشط</option><option value="i">غير نشط</option></select></div>
  <div class="row noprint"><button class="btn" data-act="pedit">+ منتج جديد</button><button class="btn ghost" data-act="pexport">تصدير CSV</button><button class="btn ghost" data-act="pimport">استيراد CSV</button><input type="file" id="pf" accept=".csv,text/csv" hidden></div><div id="plist2"></div>`;
  $('#pf').onchange = async e => { try { await importCsv(await e.target.files[0].text()); } catch (er) { toast(er.message, 1); } e.target.value = ''; };
  H.prows();
};
H.prows = () => {
  const q = ($('#pq').value || '').trim().toLowerCase(), cat = $('#pc').value, st = $('#ps').value;
  const L = S.products.filter(p => (!q || [p.name, p.brand, p.sku, p.barcode].some(x => String(x || '').toLowerCase().includes(q))) && (!cat || p.category === cat) && (!st || (st === 'a') === p.active));
  $('#plist2').innerHTML = tbl(['المنتج', 'الكود', 'القسم', 'التكلفة', 'السعر', 'المخزون', 'الحالة', ''], L.map(p => [esc(p.name) + (p.brand ? ' <small>' + esc(p.brand) + '</small>' : ''), esc(p.sku), esc(p.category), p.cost == null ? '—' : money(p.cost), money(p.price), `<span class="${p.stock <= p.threshold ? 'low' : ''}">${p.stock}</span>`, p.active ? 'نشط' : 'متوقف', `<button class="btn sm ghost" data-act="pedit" data-id="${p.id}">تعديل</button> <button class="btn sm ghost" data-act="ptog" data-id="${p.id}">${p.active ? 'إيقاف' : 'تفعيل'}</button>`]), true);
};
function pvalidate(v, id) {
  if (!v.name.trim()) return 'اسم المنتج مطلوب'; if (!v.sku.trim()) return 'الكود مطلوب';
  if (S.products.some(p => p.id !== id && p.sku.toLowerCase() === v.sku.trim().toLowerCase())) return 'الكود مستخدم لمنتج آخر';
  if (v.barcode.trim() && S.products.some(p => p.id !== id && p.barcode && p.barcode === v.barcode.trim())) return 'الباركود مستخدم لمنتج آخر';
  if (!(toP(v.price) >= 0)) return 'سعر البيع غير صحيح'; if (v.cost !== '' && !(toP(v.cost) >= 0)) return 'سعر الشراء غير صحيح';
  if (!Number.isInteger(+v.threshold) || +v.threshold < 0) return 'حد التنبيه غير صحيح';
  if (v.stock != null && (v.stock === '' || !Number.isInteger(+v.stock) || +v.stock < 0)) return 'الكمية لازم عدد صحيح 0 أو أكثر'; return '';
}
H.pedit = async d => {
  adm(); const p = d.id ? S.products.find(x => x.id === d.id) : null;
  const F = [{ k: 'name', l: 'اسم المنتج', v: p?.name, r: 1 }, { k: 'brand', l: 'الماركة', v: p?.brand }, { k: 'sku', l: 'الكود (SKU)', v: p?.sku, r: 1 }, { k: 'barcode', l: 'الباركود', v: p?.barcode }, { k: 'category', l: 'القسم', v: p?.category }, { k: 'cost', l: 'سعر الشراء (اختياري)', t: 'number', step: '0.01', min: 0, v: p && p.cost != null ? p.cost / 100 : '' }, { k: 'price', l: 'سعر البيع', t: 'number', step: '0.01', min: 0, v: p ? p.price / 100 : '', r: 1 }];
  if (!p) F.push({ k: 'stock', l: 'الرصيد الافتتاحي', t: 'number', step: 1, min: 0, v: 0 }); F.push({ k: 'threshold', l: 'حد التنبيه', t: 'number', step: 1, min: 0, v: p ? p.threshold : 5 }, { k: 'supplier', l: 'المورد', v: p?.supplier });
  const v = await form(p ? 'تعديل منتج' : 'منتج جديد', F, 'حفظ', v => pvalidate(v, p?.id)); if (!v) return;
  await tx(() => {
    const o = p || { id: uid('p'), stock: 0, active: true, created: now() };
    Object.assign(o, { name: v.name.trim(), brand: v.brand.trim(), sku: v.sku.trim(), barcode: v.barcode.trim(), category: v.category.trim(), cost: v.cost === '' ? null : toP(v.cost), price: toP(v.price), threshold: +v.threshold, supplier: v.supplier.trim() });
    if (!p) { S.products.push(o); if (+v.stock > 0) mv(o, 'opening', +v.stock, 'رصيد افتتاحي'); } log(p ? 'product_edit' : 'product_add', o.name);
  }); toast('تم الحفظ'); render();
};
H.ptog = async d => { adm(); const p = S.products.find(x => x.id === d.id); if (p.active && !await sure('إيقاف ' + p.name + '؟ (لن يظهر في البيع، وتبقى بياناته)')) return; await tx(() => { p.active = !p.active; log('product_toggle', p.name); }); render(); };
H.pexport = () => { adm(); dl('products.csv', csv([PCOLS, ...S.products.map(p => PCOLS.map(c => c === 'cost' ? (p.cost == null ? '' : p.cost / 100) : c === 'price' ? p.price / 100 : p[c]))]), 'text/csv'); };
H.pimport = () => $('#pf').click();
async function importCsv(t) {
  adm(); const rows = csvParse(t); if (rows.length < 2) throw new Error('الملف فاضي'); const h = rows[0].map(x => x.trim().toLowerCase()); if (!h.includes('name') || !h.includes('sku') || !h.includes('price')) throw new Error('الملف لازم يحتوي أعمدة name, sku, price');
  let added = 0; const skipped = [];
  await tx(() => rows.slice(1).forEach((r, i) => {
    const v = Object.fromEntries(PCOLS.map(c => [c, (r[h.indexOf(c)] ?? '').trim()])); v.stock = v.stock || '0'; v.threshold = v.threshold || '5';
    const e = pvalidate(v, null); if (e) return skipped.push('سطر ' + (i + 2) + ': ' + e);
    const o = { id: uid('p'), stock: 0, active: true, created: now(), name: v.name, brand: v.brand, sku: v.sku, barcode: v.barcode, category: v.category, cost: v.cost === '' ? null : toP(v.cost), price: toP(v.price), threshold: +v.threshold, supplier: v.supplier };
    S.products.push(o); if (+v.stock > 0) mv(o, 'opening', +v.stock, 'استيراد CSV'); added++;
  }));
  toast(`تم استيراد ${added} منتج` + (skipped.length ? ` — تخطي ${skipped.length}: ${skipped[0]}` : ''), skipped.length > 0 && !added); render();
}

/* ---------- Inventory ---------- */
V.inventory = () => {
  adm(); let val = 0, unk = 0; S.products.forEach(p => { if (p.cost == null) { if (p.stock > 0) unk++; } else val += p.cost * p.stock; });
  $('#main').innerHTML = `<h2>المخزون</h2><div class="grid"><div class="stat"><small>قيمة المخزون (بسعر الشراء المسجّل)</small><b>${money(val)}</b></div></div>${unk ? `<p class="note">${unk} منتج بدون سعر شراء غير محسوب في القيمة.</p>` : ''}
  <div class="card">${tbl(['المنتج', 'المتاح', 'الحد', 'القيمة', ''], S.products.map(p => [esc(p.name), `<span class="${p.stock <= p.threshold ? 'low' : ''}">${p.stock}</span>`, p.threshold, p.cost == null ? '—' : money(p.cost * p.stock), `<button class="btn sm" data-act="recv" data-id="${p.id}">استلام</button> <button class="btn sm ghost" data-act="adj" data-id="${p.id}">تسوية</button>`]), true)}</div>
  <div class="card"><h3>حركة المخزون (آخر 100)</h3>${tbl(['الوقت', 'المنتج', 'النوع', 'الكمية', 'الرصيد', 'السبب'], S.moves.slice(-100).reverse().map(m => [fmtDT(m.at), m.name, TYPES[m.type] || m.type, m.qty, m.after, m.reason]))}</div>`;
};
H.recv = async d => {
  adm(); const p = S.products.find(x => x.id === d.id);
  const v = await form('استلام بضاعة: ' + p.name, [{ k: 'q', l: 'الكمية المستلمة', t: 'number', step: 1, min: 1, r: 1 }, { k: 'c', l: 'سعر الشراء الجديد (اختياري)', t: 'number', step: '0.01', min: 0 }, { k: 's', l: 'المورد', v: p.supplier }], 'حفظ', v => (!Number.isInteger(+v.q) || +v.q <= 0) ? 'الكمية لازم عدد صحيح أكبر من صفر' : v.c !== '' && !(toP(v.c) >= 0) ? 'سعر غير صحيح' : '');
  if (!v) return; await tx(() => { if (v.c !== '') p.cost = toP(v.c); if (v.s) p.supplier = v.s; mv(p, 'receive', +v.q, 'استلام من ' + (v.s || 'مورد')); log('stock_receive', p.name + ' +' + v.q); }); render();
};
H.adj = async d => {
  adm(); const p = S.products.find(x => x.id === d.id);
  const v = await form('تسوية مخزون: ' + p.name + ' (الحالي ' + p.stock + ')', [{ k: 'q', l: 'التغيير (+ زيادة / − نقص)', t: 'number', step: 1, r: 1 }, { k: 'r', l: 'السبب (مطلوب)', r: 1 }], 'حفظ', v => (!Number.isInteger(+v.q) || +v.q === 0) ? 'أدخل عددًا صحيحًا غير صفر' : !v.r.trim() ? 'السبب مطلوب' : p.stock + +v.q < 0 ? 'الرصيد لا يمكن أن يكون سالبًا' : '');
  if (!v) return; await tx(() => { mv(p, 'adjust', +v.q, v.r.trim()); log('stock_adjust', p.name + ' ' + v.q + ' ' + v.r); }); render();
};

/* ---------- Sales ---------- */
V.sales = () => {
  const mine = cur.role !== 'admin'; const L = S.sales.filter(s => inR(s.at, R.from, R.to) && (!mine || s.cashierId === cur.id)).reverse();
  $('#main').innerHTML = `<h2>${mine ? 'مبيعاتي' : 'سجل المبيعات'}</h2>${rangeBar()}${tbl(['رقم', 'الوقت', 'الكاشير', 'الدفع', 'الإجمالي', 'الحالة', ''], L.map(s => [esc(s.no), fmtDT(s.at), esc(s.cashier), esc(s.method), money(s.total), s.status === 'completed' ? 'مكتملة' : '<span class="bad">ملغاة</span>', `<button class="btn sm ghost" data-act="rcpt" data-id="${s.id}">عرض</button>${!mine && s.status === 'completed' ? ` <button class="btn sm red" data-act="cancel" data-id="${s.id}">إلغاء</button>` : ''}`]), true)}`;
};
H.rcpt = d => { const s = S.sales.find(x => x.id === d.id); if (s && (cur.role === 'admin' || s.cashierId === cur.id)) showReceipt(s); };
H.cancel = async d => {
  adm(); const s = S.sales.find(x => x.id === d.id); if (!s || s.status !== 'completed') return;
  if (!await sure('إلغاء الفاتورة ' + s.no + ' وإرجاع الكميات للمخزون؟')) return;
  await tx(() => { s.items.forEach(i => { const p = S.products.find(x => x.id === i.pid); if (p) mv(p, 'return', i.qty, 'إلغاء ' + s.no, s.id); }); s.status = 'cancelled'; s.cancelledAt = now(); s.cancelledBy = cur.id; log('sale_cancel', s.no); }); toast('تم الإلغاء'); render();
};

/* ---------- Expenses ---------- */
const ECATS = ['إيجار', 'كهرباء ومياه', 'رواتب', 'نقل', 'صيانة', 'أخرى'];
V.expenses = () => {
  adm(); const L = S.expenses.filter(x => x.date >= R.from && x.date <= R.to).sort((a, b) => b.date.localeCompare(a.date)), tot = L.reduce((a, x) => a + x.amount, 0);
  $('#main').innerHTML = `<h2>المصروفات</h2>${rangeBar()}<div class="row noprint"><button class="btn" data-act="eadd">+ مصروف جديد</button></div><p><b>الإجمالي: ${money(tot)}</b></p>${tbl(['التاريخ', 'البيان', 'القسم', 'المبلغ', 'ملاحظات', 'سجّله', ''], L.map(x => [x.date, esc(x.desc), esc(x.category), money(x.amount), esc(x.notes), esc(x.byName), `<button class="btn sm red" data-act="edel" data-id="${x.id}">حذف</button>`]), true)}`;
};
H.eadd = async () => {
  adm(); const v = await form('مصروف جديد', [{ k: 'd', l: 'البيان', r: 1 }, { k: 'a', l: 'المبلغ (ج.م)', t: 'number', step: '0.01', min: 0, r: 1 }, { k: 'c', l: 'القسم', t: 'select', o: ECATS.map(c => [c, c]) }, { k: 'dt', l: 'التاريخ', t: 'date', v: today(), r: 1 }, { k: 'n', l: 'ملاحظات', t: 'textarea' }], 'حفظ', v => !v.d.trim() ? 'البيان مطلوب' : !(toP(v.a) > 0) ? 'المبلغ لازم أكبر من صفر' : !v.dt ? 'التاريخ مطلوب' : '');
  if (!v) return; await tx(() => { S.expenses.push({ id: uid('e'), desc: v.d.trim(), amount: toP(v.a), category: v.c, date: v.dt, notes: v.n.trim(), by: cur.id, byName: cur.name, at: now() }); log('expense_add', v.d + ' ' + v.a); }); toast('تم الحفظ'); render();
};
H.edel = async d => { adm(); const x = S.expenses.find(e => e.id === d.id); if (!await sure('حذف المصروف: ' + x.desc + '؟')) return; await tx(() => { S.expenses = S.expenses.filter(e => e !== x); log('expense_delete', x.desc + ' ' + x.amount); }); render(); };

/* ---------- Reports ---------- */
const wk = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - (t.getUTCDay() + 1) % 7); return t.toISOString().slice(0, 10); };
V.reports = () => {
  adm(); const s = summary(R.from, R.to), key = d => R.group === 'month' ? d.slice(0, 7) : R.group === 'week' ? wk(d) : d, P = {}, Pr = {}, C = {}, M = {}, E = {};
  s.ss.forEach(x => { const f = saleFin(x), g = P[key(cairoDay(x.at))] ||= { n: 0, rev: 0, cogs: 0, cr: 0 }; g.n++; g.rev += f.rev; g.cogs += f.cogs; g.cr += f.costRev; const c = C[x.cashier] ||= { n: 0, rev: 0 }; c.n++; c.rev += x.total; const m = M[x.method] ||= { n: 0, rev: 0 }; m.n++; m.rev += x.total; x.items.forEach(i => { const p = Pr[i.name] ||= { q: 0, rev: 0 }; p.q += i.qty; p.rev += i.net; }); });
  S.expenses.filter(x => x.date >= R.from && x.date <= R.to).forEach(x => { E[x.category] = (E[x.category] || 0) + x.amount; });
  const T = {
    per: [['الفترة', 'فواتير', 'المبيعات', 'التكلفة', 'إجمالي الربح'], ...Object.entries(P).sort().map(([k, g]) => [k, g.n, money(g.rev), money(g.cogs), g.cr ? money(g.cr - g.cogs) : '—'])],
    prod: [['المنتج', 'الكمية', 'المبيعات'], ...Object.entries(Pr).sort((a, b) => b[1].q - a[1].q).map(([k, p]) => [k, p.q, money(p.rev)])],
    cash: [['الكاشير', 'فواتير', 'المبيعات'], ...Object.entries(C).map(([k, c]) => [k, c.n, money(c.rev)])],
    pay: [['طريقة الدفع', 'فواتير', 'المبلغ'], ...Object.entries(M).map(([k, c]) => [k, c.n, money(c.rev)])],
    exp: [['القسم', 'المبلغ'], ...Object.entries(E).map(([k, v]) => [k, money(v)])],
    low: [['المنتج', 'المتاح', 'الحد'], ...lowStock().map(p => [p.name, p.stock, p.threshold])],
    inv: [['المنتج', 'المتاح', 'سعر الشراء', 'القيمة'], ...S.products.map(p => [p.name, p.stock, p.cost == null ? '—' : money(p.cost), p.cost == null ? '—' : money(p.cost * p.stock)])]
  };
  const names = { per: 'المبيعات حسب الفترة', prod: 'المبيعات حسب المنتج', cash: 'حسب الكاشير', pay: 'حسب طريقة الدفع', exp: 'المصروفات', low: 'نقص المخزون', inv: 'تقييم المخزون' };
  lastCsv = [['تقرير', R.from, R.to], ['إجمالي المبيعات', s.rev / 100], ['تكلفة البضاعة المباعة', s.cogs / 100], ['إجمالي الربح', s.costRev ? s.gross / 100 : 'غير متاح'], ['المصروفات', s.exp / 100], ['صافي الربح التقديري', s.net / 100]];
  Object.keys(T).forEach(k => { lastCsv.push([], [names[k]], ...T[k]); });
  $('#main').innerHTML = `<h2>التقارير</h2>${rangeBar()}<div class="row noprint"><select id="gp" data-on="grp"><option value="day">يومي</option><option value="week">أسبوعي</option><option value="month">شهري</option></select><button class="btn" data-act="rcsv">تصدير CSV</button><button class="btn ghost" onclick="window.print()">🖨️ طباعة</button></div>
  <div class="grid"><div class="stat"><small>المبيعات (إيراد)</small><b>${money(s.rev)}</b></div><div class="stat"><small>تكلفة البضاعة المباعة</small><b>${money(s.cogs)}</b></div><div class="stat"><small>إجمالي الربح</small><b>${s.costRev ? money(s.gross) : '—'}</b></div><div class="stat"><small>المصروفات</small><b>${money(s.exp)}</b></div><div class="stat"><small>صافي الربح التقديري</small><b>${money(s.net)}</b></div></div>
  <p class="note">المعادلات: الإيراد = Σ(سعر البيع × الكمية − الخصم الموزع). التكلفة = Σ(سعر الشراء وقت البيع × الكمية) للبنود المسجّل لها تكلفة فقط. إجمالي الربح = إيراد البنود ذات التكلفة − تكلفتها. صافي الربح التقديري = إجمالي الربح − المصروفات. التدفق النقدي ≠ الربح المحاسبي.${s.noCost ? ` <b>${s.noCost} بند بدون تكلفة لم يدخل في الربح.</b>` : ''}</p>
  ${Object.keys(T).map(k => `<div class="card"><h3>${names[k]}</h3>${tbl(T[k][0], T[k].slice(1))}</div>`).join('')}`;
  $('#gp').value = R.group;
};
H.grp = el => { R.group = el.value; render(); };
H.rcsv = () => { adm(); dl(`report-${R.from}_${R.to}.csv`, csv(lastCsv), 'text/csv'); };

/* ---------- Users ---------- */
V.users = () => {
  adm(); $('#main').innerHTML = `<h2>المستخدمين</h2><div class="row noprint"><button class="btn" data-act="uadd">+ كاشير جديد</button></div>${tbl(['الاسم', 'المستخدم', 'الدور', 'الحالة', ''], S.users.map(u => [esc(u.name), esc(u.username), u.role === 'admin' ? 'مدير' : 'كاشير', u.active ? 'نشط' : 'متوقف', `<button class="btn sm ghost" data-act="uedit" data-id="${u.id}">تعديل</button>`]), true)}`;
};
H.uadd = async () => {
  adm(); const v = await form('كاشير جديد', [{ k: 'n', l: 'الاسم', r: 1 }, { k: 'u', l: 'اسم المستخدم (إنجليزي بدون مسافات)', r: 1 }, { k: 'p', l: 'كلمة المرور (6 على الأقل)', t: 'password', r: 1 }], 'إنشاء', v => !v.n.trim() ? 'الاسم مطلوب' : !/^[a-z0-9_.]{3,}$/i.test(v.u.trim()) ? 'اسم المستخدم 3 أحرف/أرقام على الأقل' : S.users.some(x => x.username === v.u.trim().toLowerCase()) ? 'اسم المستخدم موجود' : v.p.length < 6 ? 'كلمة المرور قصيرة' : '');
  if (!v) return; const salt = uid('s'), h = await hash(v.p, salt);
  await tx(() => { S.users.push({ id: uid('u'), username: v.u.trim().toLowerCase(), name: v.n.trim(), role: 'cashier', active: true, salt, hash: h, mustChange: false, created: now() }); log('user_add', v.u); }); render();
};
H.uedit = async d => {
  adm(); const u = S.users.find(x => x.id === d.id), self = u.id === cur.id;
  const v = await form('تعديل: ' + u.username, [{ k: 'n', l: 'الاسم', v: u.name, r: 1 }, { k: 'p', l: 'كلمة مرور جديدة (اتركها فاضية لو مش عايز تغيّرها)', t: 'password' }, { k: 'a', l: 'الحالة', t: 'select', v: u.active ? '1' : '0', o: [['1', 'نشط'], ['0', 'متوقف']] }], 'حفظ', v => !v.n.trim() ? 'الاسم مطلوب' : v.p && v.p.length < 6 ? 'كلمة المرور قصيرة' : self && v.a === '0' ? 'لا يمكنك إيقاف حسابك' : '');
  if (!v) return; const salt = uid('s'), h = v.p ? await hash(v.p, salt) : null;
  await tx(() => { u.name = v.n.trim(); u.active = v.a === '1'; if (h) { u.salt = salt; u.hash = h; u.mustChange = false; } log('user_edit', u.username); }); render();
};

/* ---------- Settings / backup ---------- */
V.settings = () => {
  adm(); const last = (S.backups || []).slice(-1)[0];
  $('#main').innerHTML = `<h2>الإعدادات</h2>
  <div class="card"><h3>المحل</h3><label>اسم المحل<input id="sn" value="${esc(S.settings.shop)}"></label><label>طرق الدفع (مفصولة بفاصلة — الأولى = نقدي)<input id="sm" value="${esc(S.settings.methods.join('، '))}"></label><label><input type="checkbox" id="sa" ${S.settings.allowNegative ? 'checked' : ''} style="width:auto;min-height:0"> السماح للمدير فقط بالبيع بمخزون غير كافٍ (بعد تأكيد)</label><button class="btn" data-act="ssave">حفظ</button></div>
  <div class="card"><h3>النسخ الاحتياطي</h3><p class="note">⚠️ البيانات على هذا الجهاز/المتصفح فقط ولا تتزامن مع أجهزة أخرى. لو مسحت بيانات المتصفح أو حذفت التطبيق هتضيع. خد نسخة احتياطية باستمرار.${last ? ' آخر نسخة: ' + fmtDT(last.at) : ' لم يتم أخذ نسخة بعد.'}</p><div class="row"><button class="btn" data-act="bexp">تصدير نسخة JSON</button><button class="btn ghost" data-act="bimp">استعادة من ملف</button><input type="file" id="bf" accept=".json,application/json" hidden></div></div>
  <div class="card"><h3>بيانات تجريبية</h3><p class="note">تضيف منتجات تجريبية فقط (لا تحذف شيئًا).</p><button class="btn ghost" data-act="demo">إضافة بيانات تجريبية</button></div>
  <div class="card"><h3>تنبيه أمني</h3><p class="note">تسجيل الدخول هنا داخل المتصفح فقط وليس حماية حقيقية: أي شخص يستخدم نفس الجهاز بخبرة تقنية يمكنه الوصول للبيانات. لا تعتمد عليه لحماية بيانات حساسة. راجع README.</p></div>`;
  $('#bf').onchange = async e => { try { await restore(await e.target.files[0].text()); } catch (er) { toast(er.message, 1); } e.target.value = ''; };
};
H.ssave = async () => {
  adm(); const shop = $('#sn').value.trim(), m = $('#sm').value.split(/[,،]/).map(x => x.trim()).filter(Boolean); if (!shop || !m.length) return toast('الاسم وطريقة دفع واحدة على الأقل مطلوبين', 1);
  await tx(() => { S.settings.shop = shop; S.settings.methods = m; S.settings.allowNegative = $('#sa').checked; log('settings'); }); toast('تم الحفظ'); render();
};
const backupObj = () => ({ app: APP, version: VER, exportedAt: now(), data: S });
async function exportBackup(kind) { const name = `cigarette-backup-${kind}-${today()}.json`; dl(name, JSON.stringify(backupObj(), null, 1), 'application/json'); await tx(() => { (S.backups ||= []).push({ at: now(), kind, file: name }); }); }
H.bexp = async () => { adm(); await exportBackup('manual'); toast('تم تنزيل النسخة'); render(); };
H.bimp = () => $('#bf').click();
function validateBackup(o) {
  if (!o || o.app !== APP) return 'الملف ليس نسخة من هذا التطبيق'; if (!Number.isInteger(o.version)) return 'رقم الإصدار مفقود';
  if (o.version !== VER) return `إصدار النسخة (${o.version}) غير متوافق مع إصدار التطبيق (${VER})`;
  const d = o.data; if (!okState(d)) return 'بنية البيانات غير صحيحة';
  if (!d.users.some(u => u.role === 'admin' && u.active && u.hash && u.salt)) return 'لا يوجد مدير نشط في النسخة';
  if (d.products.some(p => !p.id || typeof p.name !== 'string' || !Number.isInteger(p.price) || p.price < 0 || !Number.isInteger(p.stock))) return 'بيانات منتجات غير صحيحة';
  if (d.sales.some(s => !s.id || !Array.isArray(s.items) || !Number.isInteger(s.total))) return 'بيانات مبيعات غير صحيحة';
  if (d.expenses.some(x => !x.id || !Number.isInteger(x.amount) || !x.date)) return 'بيانات مصروفات غير صحيحة'; return '';
}
async function restore(text) {
  adm(); let o; try { o = JSON.parse(text); } catch { throw new Error('الملف تالف أو ليس JSON'); }
  const err = validateBackup(o); if (err) throw new Error(err);
  if (!await sure(`استعادة النسخة؟ (تاريخ النسخة: ${fmtDT(o.exportedAt || now())}) هيتم استبدال كل البيانات الحالية، وهتتنزل نسخة أمان تلقائيًا الأول.`)) return;
  dl(`cigarette-backup-safety-${today()}-${Date.now()}.json`, JSON.stringify(backupObj(), null, 1), 'application/json');
  const snap = structuredClone(S); try { S = o.data; (S.backups ||= []).push({ at: now(), kind: 'restore', file: '' }); await DB.put(S); } catch (e) { S = snap; throw new Error('فشلت الاستعادة، لم يتغير شيء'); }
  cur = null; cart = []; sessionStorage.removeItem('sid'); toast('تمت الاستعادة. سجّل الدخول من جديد.'); render();
}
H.demo = async () => {
  adm(); if (!await sure('إضافة 4 منتجات تجريبية؟ (لن يتم حذف أي بيانات)')) return;
  const D = [['سجائر محلي علبة', 'DEMO-1', 8500, 9500, 50], ['سجائر مستورد علبة', 'DEMO-2', 14000, 16000, 30], ['ولاعة', 'DEMO-3', 800, 1500, 40], ['معسل 50 جم', 'DEMO-4', 1200, 2000, 20]];
  await tx(() => D.forEach(d => { if (S.products.some(p => p.sku === d[1])) return; const o = { id: uid('p'), name: d[0] + ' (تجريبي)', brand: '', sku: d[1], barcode: '', category: 'تجريبي', cost: d[2], price: d[3], stock: 0, threshold: 5, supplier: '', active: true, created: now() }; S.products.push(o); mv(o, 'opening', d[4], 'بيانات تجريبية'); })); toast('تمت الإضافة'); render();
};

/* ---------- Boot ---------- */
(async () => {
  try { try { await DB.open(); } catch { DB.db = null; }
    S = await DB.get(); if (!S) { S = await fresh(); await DB.put(S); }
    if (!okState(S)) { $('#app').innerHTML = '<p class="err" style="padding:20px">بيانات التطبيق المحفوظة تالفة. لم يتم تعديل أي شيء. استعد من نسخة احتياطية أو تواصل مع الدعم.</p>'; return; }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    cur = S.users.find(u => u.id === sessionStorage.getItem('sid') && u.active) || null; view = cur && cur.role === 'admin' ? 'dash' : 'pos'; render();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  } catch (e) { $('#app').innerHTML = '<p class="err" style="padding:20px">تعذّر تشغيل التطبيق: ' + esc(e.message || e) + '</p>'; }
})();
