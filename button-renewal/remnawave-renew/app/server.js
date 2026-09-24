// remnawave-renew: кнопка продления для страницы подписки Remnawave.
// Провайдеры оплаты: YooKassa и Platega. Зависимостей нет, нужен Node 18+.
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const env = process.env;
const PROVIDER = (env.PAY_PROVIDER || 'yookassa').toLowerCase();
const PORT = +env.PORT || 3100;
const PANEL = (env.REMNAWAVE_URL || 'http://remnawave:3000').replace(/\/$/, '');
const RW_TOKEN = env.REMNAWAVE_API_TOKEN;
const SUB_URL = (env.SUB_PAGE_URL || '').replace(/\/$/, '');
const RECEIPT_CONTACT = env.RECEIPT_CONTACT || '';
const DATA = env.DATA_DIR || '/data';
const PLANS_FILE = env.PLANS_FILE || DATA + '/plans.json';
const DONE_FILE = DATA + '/processed.json';
const PENDING_FILE = DATA + '/pending.json';
const BUTTON_FILE = env.BUTTON_FILE || '/app/renew-button.js';
const FOREVER = Date.parse('2090-01-01'); // "бессрочные" пользователи: срок не трогаем

const YK_SHOP = env.YK_SHOP_ID;
const YK_KEY = env.YK_SECRET_KEY;
const PL_ID = env.PLATEGA_MERCHANT_ID;
const PL_SECRET = env.PLATEGA_SECRET;
const PL_BASE = (env.PLATEGA_BASE_URL || 'https://app.platega.io').replace(/\/$/, '');
const PL_METHOD = +env.PLATEGA_METHOD || 2; // 2 = СБП

const die = (m) => { console.error(m); process.exit(1); };
if (!RW_TOKEN) die('Не задан REMNAWAVE_API_TOKEN');
if (!SUB_URL) die('Не задан SUB_PAGE_URL');
if (PROVIDER === 'yookassa' && !(YK_SHOP && YK_KEY)) die('Не заданы YK_SHOP_ID / YK_SECRET_KEY');
if (PROVIDER === 'platega' && !(PL_ID && PL_SECRET)) die('Не заданы PLATEGA_MERCHANT_ID / PLATEGA_SECRET');
if (!['yookassa', 'platega'].includes(PROVIDER)) die('PAY_PROVIDER должен быть yookassa или platega');

// ---------- тарифы ----------
// { "vpn": { "name": "...", "desc": "...", "squads": ["uuid"], "prices": { "1": 149, "3": 399 } } }
let PLANS = {};
try { PLANS = JSON.parse(fs.readFileSync(PLANS_FILE, 'utf8')); }
catch (e) { die('Не удалось прочитать ' + PLANS_FILE + ': ' + e.message); }
if (!Object.keys(PLANS).length) die('В plans.json нет тарифов');
const getPlan = (k) => (Object.hasOwn(PLANS, k) ? PLANS[k] : null);
const priceOf = (plan, months) => {
  const v = plan && plan.prices ? plan.prices[String(months)] : undefined;
  return Number.isFinite(+v) && +v > 0 ? +v : null;
};
// клиенту отдаём без squads
const publicPlans = () => Object.fromEntries(Object.entries(PLANS).map(([k, p]) =>
  [k, { name: p.name, desc: p.desc || '', prices: p.prices }]));

// ---------- хранилище ----------
const load = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const done = new Set(load(DONE_FILE, []));
const pending = load(PENDING_FILE, {}); // id платежа Platega -> заказ
const saveDone = () => fs.writeFileSync(DONE_FILE, JSON.stringify([...done]));
const savePending = () => fs.writeFileSync(PENDING_FILE, JSON.stringify(pending));
const inflight = new Set();

// ---------- HTTP-клиенты ----------
async function jfetch(name, url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  if (!r.ok) {
    const e = new Error(`${name} ${opts.method || 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')} -> ${r.status} ${text.slice(0, 300)}`);
    e.status = r.status;
    e.svc = name;
    throw e;
  }
  try { return JSON.parse(text); } catch { return {}; }
}

const rw = (method, path, body) => jfetch('Remnawave', PANEL + path, {
  method,
  headers: {
    Authorization: 'Bearer ' + RW_TOKEN,
    'Content-Type': 'application/json',
    'X-Forwarded-For': '127.0.0.1',
    'X-Forwarded-Proto': 'https',
  },
  body: body ? JSON.stringify(body) : undefined,
});

const YK_AUTH = 'Basic ' + Buffer.from(`${YK_SHOP}:${YK_KEY}`).toString('base64');
const yk = (method, path, body) => jfetch('YooKassa', 'https://api.yookassa.ru/v3' + path, {
  method,
  headers: {
    Authorization: YK_AUTH,
    'Content-Type': 'application/json',
    ...(method === 'POST' ? { 'Idempotence-Key': crypto.randomUUID() } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
});

const pl = (method, path, body) => jfetch('Platega', PL_BASE + path, {
  method,
  headers: { 'X-MerchantId': PL_ID, 'X-Secret': PL_SECRET, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

async function getUser(shortUuid) {
  const j = await rw('GET', '/api/users/by-short-uuid/' + encodeURIComponent(shortUuid));
  return Array.isArray(j.response) ? j.response[0] : j.response;
}

// ---------- продление пользователя (общее для всех провайдеров) ----------
async function applyRenewal(id, shortUuid, planKey, months) {
  const plan = getPlan(planKey);
  if (!plan || !priceOf(plan, months) || !shortUuid) {
    console.error(`payment ${id}: некорректный заказ ${JSON.stringify({ shortUuid, planKey, months })}`);
    return false;
  }
  const user = await getUser(shortUuid);
  if (!user) { console.error(`payment ${id}: пользователь ${shortUuid} не найден`); return false; }
  const cur = user.expireAt ? Date.parse(user.expireAt) : 0;
  const patch = { username: user.username }; // эта версия панели требует username или id
  if (!(cur > FOREVER)) {
    const d = new Date(Math.max(Date.now(), cur)); // активная подписка продлевается от даты окончания
    d.setUTCMonth(d.getUTCMonth() + months);
    patch.expireAt = d.toISOString();
  }
  if (user.status !== 'ACTIVE') patch.status = 'ACTIVE';
  if (Array.isArray(plan.squads) && plan.squads.length) patch.activeInternalSquads = plan.squads;
  await rw('PATCH', '/api/users', patch);
  done.add(id);
  saveDone();
  console.log(`payment ${id}: ${user.username} ${planKey} +${months} мес.` + (patch.expireAt ? ` до ${patch.expireAt}` : ' (бессрочный)'));
  return true;
}

// ---------- создание платежа ----------
function resolveOrder(planKey, months) {
  const plan = getPlan(planKey);
  const price = priceOf(plan, months);
  if (!price) { const e = new Error('bad plan/months'); e.bad = true; throw e; }
  return { plan, price };
}

async function createYooKassa(user, shortUuid, planKey, months, plan, price) {
  const title = `${plan.name}, ${months} мес.`;
  const value = price.toFixed(2);
  const body = {
    amount: { value, currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: `${SUB_URL}/${shortUuid}` },
    description: `${title} (${user.username})`.slice(0, 128),
    metadata: { shortUuid, plan: planKey, months: String(months) },
  };
  if (RECEIPT_CONTACT) {
    body.receipt = {
      customer: RECEIPT_CONTACT.includes('@') ? { email: RECEIPT_CONTACT } : { phone: RECEIPT_CONTACT },
      items: [{
        description: title.slice(0, 128), quantity: '1.00', amount: { value, currency: 'RUB' },
        vat_code: +env.VAT_CODE || 1, payment_subject: 'service', payment_mode: 'full_payment',
      }],
    };
  }
  const p = await yk('POST', '/payments', body);
  return p.confirmation.confirmation_url;
}

async function createPlatega(user, shortUuid, planKey, months, plan, price) {
  const title = `${plan.name}, ${months} мес.`;
  const back = `${SUB_URL}/${shortUuid}`;
  const p = await pl('POST', '/transaction/process', {
    paymentMethod: PL_METHOD,
    paymentDetails: { amount: price, currency: 'RUB' },
    description: `${title} (${user.username})`.slice(0, 128),
    return: back,
    failedUrl: back,
    payload: `${shortUuid}|${planKey}|${months}`,
  });
  const id = p.transactionId || p.id;
  const url = p.redirect || p.url;
  if (!id || !url) throw new Error('Platega: в ответе нет transactionId/redirect: ' + JSON.stringify(p).slice(0, 200));
  pending[id] = { shortUuid, plan: planKey, months, price, created: Date.now() };
  savePending();
  return url;
}

async function handleRenew(res, shortUuid, planKey, months) {
  const { plan, price } = resolveOrder(planKey, months);
  const user = await getUser(shortUuid);
  if (!user) { const e = new Error('user not found'); e.notFound = true; throw e; }
  const url = PROVIDER === 'platega'
    ? await createPlatega(user, shortUuid, planKey, months, plan, price)
    : await createYooKassa(user, shortUuid, planKey, months, plan, price);
  res.writeHead(302, { Location: url });
  res.end();
}

// ---------- YooKassa: вебхук ----------
async function handleYooKassa(payload) {
  if (!payload || payload.event !== 'payment.succeeded') return;
  const id = payload.object && payload.object.id;
  if (!id || done.has(id) || inflight.has(id)) return;
  inflight.add(id);
  try {
    // телу вебхука не верим, перепроверяем платёж через API
    const p = await yk('GET', '/payments/' + encodeURIComponent(id));
    if (p.status !== 'succeeded' || !p.paid) return;
    const md = p.metadata || {};
    const price = priceOf(getPlan(md.plan), +md.months);
    if (!price || Number(p.amount.value) !== price) {
      console.error(`payment ${id}: сумма ${p.amount.value}, ожидалось ${price} (${JSON.stringify(md)})`);
      return;
    }
    await applyRenewal(id, md.shortUuid, md.plan, +md.months);
  } finally { inflight.delete(id); }
}

// ---------- Platega: колбэк ----------
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function fulfillPlatega(id, paidAmount) {
  if (done.has(id) || inflight.has(id)) return;
  const o = pending[id];
  if (!o) { console.error(`platega ${id}: неизвестная транзакция (не создавалась этим сервисом)`); return; }
  if (paidAmount !== undefined && Number(paidAmount) < o.price) {
    console.error(`platega ${id}: сумма ${paidAmount}, ожидалось ${o.price}`);
    return;
  }
  inflight.add(id);
  try {
    if (await applyRenewal(id, o.shortUuid, o.plan, o.months)) { delete pending[id]; savePending(); }
  } finally { inflight.delete(id); }
}

async function handlePlategaCallback(req, payload) {
  // единственная защита колбэка Platega: заголовки X-MerchantId и X-Secret
  if (!safeEq(req.headers['x-merchantid'], PL_ID) || !safeEq(req.headers['x-secret'], PL_SECRET)) {
    const e = new Error('platega callback: неверные X-MerchantId/X-Secret');
    e.status = 403;
    throw e;
  }
  const id = payload && (payload.id || payload.transactionId);
  console.log('platega callback', id, payload && payload.status);
  if (!id || payload.status !== 'CONFIRMED') return;
  const amount = payload.amount !== undefined ? payload.amount : (payload.paymentDetails && payload.paymentDetails.amount);
  await fulfillPlatega(id, amount);
}

// ---------- автопроверка платежей раз в минуту ----------
const tries = new Map();
async function poll() {
  try {
    if (PROVIDER === 'yookassa') {
      const since = new Date(Date.now() - 2 * 86400000).toISOString();
      const j = await yk('GET', '/payments?status=succeeded&limit=100&created_at.gte=' + encodeURIComponent(since));
      for (const p of j.items || []) {
        if (done.has(p.id) || (tries.get(p.id) || 0) >= 5) continue;
        tries.set(p.id, (tries.get(p.id) || 0) + 1);
        try { await handleYooKassa({ event: 'payment.succeeded', object: { id: p.id } }); }
        catch (e) { console.error('poll', p.id, e.message); }
      }
    } else {
      const now = Date.now();
      for (const [id, o] of Object.entries(pending)) {
        if (now - o.created > 7 * 86400000) { delete pending[id]; savePending(); continue; }
        if (now - o.created < 45000 || (tries.get(id) || 0) >= 200) continue;
        tries.set(id, (tries.get(id) || 0) + 1);
        try {
          const s = await pl('GET', '/transaction/' + encodeURIComponent(id));
          if (s.status === 'CONFIRMED') await fulfillPlatega(id);
          else if (s.status === 'CANCELED' || s.status === 'CHARGEBACKED') { delete pending[id]; savePending(); }
        } catch (e) { if ((tries.get(id) || 0) % 20 === 1) console.error('poll', id, e.message); }
      }
    }
  } catch (e) { console.error('poll', e.message); }
}
setInterval(poll, 60000);
setTimeout(poll, 5000);

// ---------- HTTP-сервер ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 100000) { req.destroy(); reject(new Error('too large')); }
    });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

function page(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font-family:system-ui;text-align:center;padding:60px 20px">' + text + '</body>');
}

const CORS = { 'Access-Control-Allow-Origin': '*' };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let m;
    if (req.method === 'GET' && url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
    if (req.method === 'GET' && url.pathname === '/plans.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...CORS });
      return res.end(JSON.stringify(publicPlans()));
    }
    if (req.method === 'GET' && url.pathname === '/renew-button.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS });
      return res.end(fs.readFileSync(BUTTON_FILE));
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/renew\/([A-Za-z0-9_-]{4,64})$/))) {
      return await handleRenew(res, m[1], url.searchParams.get('plan'), +url.searchParams.get('months'));
    }
    if (req.method === 'POST' && PROVIDER === 'yookassa' && url.pathname === '/yookassa/webhook') {
      await handleYooKassa(JSON.parse(await readBody(req)));
      res.writeHead(200); return res.end('ok');
    }
    if (req.method === 'POST' && PROVIDER === 'platega' && url.pathname === '/platega/callback') {
      await handlePlategaCallback(req, JSON.parse(await readBody(req)));
      res.writeHead(200); return res.end('ok');
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    console.error(e.message);
    if (req.url.startsWith('/renew/')) {
      if (e.bad) return page(res, 400, 'Выберите тариф на странице подписки');
      if (e.notFound || (e.svc === 'Remnawave' && e.status === 404)) return page(res, 404, 'Подписка не найдена');
      return page(res, 502, 'Не удалось создать платёж. Попробуйте позже.');
    }
    res.writeHead(e.status === 403 ? 403 : 500); res.end('error'); // провайдер повторит уведомление
  }
}).listen(PORT, '0.0.0.0', () => console.log(`renew-pay (${PROVIDER}) on :${PORT}`));
