const http = require("http");
const fs = require("fs");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3100);
const RW_URL = (process.env.REMN​​AWAVE_URL || process.env.REMNAWAVE_URL || "").replace(/\/$/, "");
const RW_TOKEN = process.env.REMNAWAVE_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

const providers = (process.env.PAYMENT_PROVIDERS || "yookassa")
  .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);

const prices = {
  1: Number(process.env.PRICE_1M || 149),
  3: Number(process.env.PRICE_3M || 399),
  6: Number(process.env.PRICE_6M || 699),
  12: Number(process.env.PRICE_12M || 1199)
};

const DATA_DIR = "/data";
const DONE_FILE = `${DATA_DIR}/processed.json`;
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDone() {
  try { return new Set(JSON.parse(fs.readFileSync(DONE_FILE, "utf8"))); }
  catch { return new Set(); }
}
const done = loadDone();

function saveDone() {
  fs.writeFileSync(DONE_FILE, JSON.stringify([...done], null, 2));
}

async function requestJson(url, options = {}) {
  const r = await fetch(url, options);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`${options.method || "GET"} ${url} -> ${r.status} ${text}`);
  return body;
}

async function rw(path, method = "GET", body) {
  const headers = { "Authorization": `Bearer ${RW_TOKEN}`, "Content-Type": "application/json" };
  return requestJson(`${RW_URL}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function yookassa(path, method = "GET", body) {
  const auth = Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString("base64");
  return requestJson(`https://api.yookassa.ru/v3${path}`, {
    method,
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json",
      ...(method === "POST" ? { "Idempotence-Key": crypto.randomUUID() } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function platega(path, method = "GET", body) {
  return requestJson(`https://app.platega.io${path}`, {
    method,
    headers: {
      "X-MerchantId": process.env.PLATEGA_MERCHANT_ID || "",
      "X-Secret": process.env.PLATEGA_SECRET || "",
      "Content-Type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function monthDate(months, current) {
  const d = new Date(current);
  d.setMonth(d.getMonth() + months);
  return d;
}

function getUserIdFromPayment(p) {
  const m = p.metadata || {};
  return m.userId || m.user_id || m.username || m.login || p.userId || p.username || null;
}

async function findUser(identifier) {
  if (!identifier) throw new Error("Payment metadata does not contain userId/username");
  if (String(identifier).includes("-") && String(identifier).length > 20) {
    try { return await rw(`/api/users/${encodeURIComponent(identifier)}`); } catch {}
  }
  const data = await rw(`/api/users?search=${encodeURIComponent(identifier)}`);
  const list = data?.response?.users || data?.users || data?.items || data?.response || [];
  if (Array.isArray(list)) {
    const exact = list.find(u => u.username === identifier || u.uuid === identifier || u.id === identifier);
    if (exact) return exact;
  }
  throw new Error(`Remnawave user not found: ${identifier}`);
}

async function renew(identifier, months, paymentId) {
  if (done.has(paymentId)) {
    console.log(`skip ${paymentId}: already processed`);
    return;
  }

  const user = await findUser(identifier);
  const cur = Date.parse(user.expireAt || user.expire_at || "");
  const now = Date.now();

  // Бессрочные аккаунты не получают искусственную дату окончания.
  if (Number.isFinite(cur) && cur > Date.parse("2090-01-01")) {
    done.add(paymentId);
    saveDone();
    console.log(`payment ${paymentId}: ${user.username || identifier} unlimited account, expireAt unchanged`);
    return;
  }

  const base = Number.isFinite(cur) && cur > now ? cur : now;
  const expireAt = monthDate(months, base).toISOString();

  const patch = {
    ...(user.username ? { username: user.username } : { id: user.uuid || user.id }),
    expireAt
  };

  if (user.status !== "ACTIVE") patch.status = "ACTIVE";

  await rw("/api/users", "PATCH", patch);

  done.add(paymentId);
  saveDone();

  console.log(`payment ${paymentId}: ${user.username || identifier} +${months} мес. до ${expireAt}`);
}

function parseMonths(metadata = {}) {
  const n = Number(metadata.months || metadata.period || 1);
  return [1, 3, 6, 12].includes(n) ? n : 1;
}

async function handlePayment(payment) {
  const id = payment.id || payment.transactionId || payment.uuid;
  if (!id) throw new Error("Payment ID missing");

  const metadata = payment.metadata || {};
  const identifier = getUserIdFromPayment(payment);
  const months = parseMonths(metadata);

  await renew(identifier, months, id);
}

async function handleYookassa(body) {
  const event = body?.event;
  if (event !== "payment.succeeded") return;
  const p = body.object;
  await handlePayment({
    id: p.id,
    metadata: p.metadata || {},
    status: p.status
  });
}

async function handlePlatega(body) {
  const status = String(body?.status || body?.paymentStatus || "").toUpperCase();
  if (!["CONFIRMED", "SUCCESS", "SUCCEEDED", "COMPLETED"].includes(status)) return;

  const metadata = body.metadata || body.data?.metadata || {};
  await handlePayment({
    id: body.transactionId || body.id || body.data?.id,
    metadata
  });
}

async function createYookassaPayment({ identifier, months }) {
  const amount = prices[months];
  const returnUrl = PUBLIC_URL || "https://example.com";

  const p = await yookassa("/payments", "POST", {
    amount: { value: amount.toFixed(2), currency: "RUB" },
    capture: true,
    confirmation: { type: "redirect", return_url: returnUrl },
    description: `Продление Remnawave на ${months} мес.`,
    metadata: { userId: identifier, months: String(months) }
  });

  return p.confirmation?.confirmation_url;
}

async function createPlategaPayment({ identifier, months }) {
  const amount = prices[months];

  const p = await platega("/transaction/process", "POST", {
    amount,
    currency: "RUB",
    description: `Продление Remnawave на ${months} мес.`,
    metadata: { userId: identifier, months: String(months) },
    return: PUBLIC_URL || undefined
  });

  return p.redirect || p.url || p.paymentUrl || p.data?.url || null;
}

async function pollYookassa() {
  if (!providers.includes("yookassa")) return;

  const since = new Date(Date.now() - 2 * 86400000).toISOString();
  const q = `/payments?status=succeeded&limit=100&created_at.gte=${encodeURIComponent(since)}`;
  const j = await yookassa(q);

  for (const p of j.items || []) {
    if (done.has(p.id)) continue;
    try {
      await handlePayment({ id: p.id, metadata: p.metadata || {} });
    } catch (e) {
      console.error("poll", p.id, e.message);
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        ok: true,
        providers,
        prices,
        processed: done.size
      }));
    }

    if (req.method === "POST" && (req.url === "/webhook/yookassa" || req.url === "/webhook/platega")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");

      console.log(`webhook ${req.url}`, body.event || body.status || body.paymentStatus || "");

      if (req.url === "/webhook/yookassa") await handleYookassa(body);
      else await handlePlatega(body);

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (req.method === "POST" && req.url === "/create-payment") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");

      const identifier = body.userId || body.username;
      const months = Number(body.months || 1);
      if (!identifier || !prices[months]) throw new Error("userId/username and valid months required");

      const method = String(body.provider || providers[0]).toLowerCase();
      let url;

      if (method === "yookassa") url = await createYookassaPayment({ identifier, months });
      else if (method === "platega") url = await createPlategaPayment({ identifier, months });
      else throw new Error("Unknown provider");

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, url, provider: method, months, amount: prices[months] }));
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (e) {
    console.error(e.stack || e.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});

server.listen(PORT, () => console.log(`renew-pay on :${PORT}`));

setTimeout(() => {
  if (providers.includes("yookassa")) {
    pollYookassa().catch(e => console.error("initial poll", e.message));
    setInterval(() => pollYookassa().catch(e => console.error("poll", e.message)), 60000);
  }
}, 5000);
