// Кнопка «Продлить» для страницы подписки Remnawave.
// Тарифы берутся с сервиса оплаты (/plans.json), поэтому цены правятся в одном месте.
(function () {
  var script = document.currentScript || document.querySelector('script[src*="renew-button.js"]');
  // база сервиса оплаты = адрес скрипта без /renew-button.js (сохраняем путь /renew-pay и порт)
  var PAY = script ? new URL(script.src, location.href).href.replace(/\/renew-button\.js.*$/, '') : '';
  var shortUuid = location.pathname.split('/').filter(Boolean).pop();
  if (!PAY || !shortUuid) return;

  var PLANS = null;
  var fmt = function (n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0') + '\u00a0₽';
  };

  var css = document.createElement('style');
  css.textContent =
    '.rn-btn{padding:8px 16px;border-radius:8px;background:rgba(34,211,238,.14);color:#5fdcea;' +
    'border:1px solid rgba(34,211,238,.28);font:600 14px system-ui,sans-serif;font-family:inherit;' +
    'cursor:pointer;margin-right:8px;white-space:nowrap}' +
    '.rn-btn:hover{background:rgba(34,211,238,.24)}' +
    '.rn-fixed{position:fixed;top:12px;right:12px;z-index:9999;margin:0;box-shadow:0 2px 8px rgba(0,0,0,.3)}' +
    '.rn-ov{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.6);display:flex;' +
    'align-items:center;justify-content:center;padding:16px}' +
    '.rn-box{width:100%;max-width:340px;background:#171e27;color:#e6edf3;' +
    'border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:16px;' +
    'font-family:inherit;box-shadow:0 8px 32px rgba(0,0,0,.5)}' +
    '.rn-box h3{margin:0 0 4px;font-size:16px}' +
    '.rn-box p{margin:0 0 12px;font-size:13px;opacity:.7}' +
    '.rn-opt{display:block;width:100%;margin-top:8px;padding:12px;border-radius:10px;' +
    'background:rgba(255,255,255,.04);color:#e6edf3;border:1px solid rgba(255,255,255,.08);' +
    'font:600 14px system-ui,sans-serif;font-family:inherit;cursor:pointer;text-align:center}' +
    '.rn-opt:hover{background:rgba(34,211,238,.12);border-color:rgba(34,211,238,.3)}' +
    '.rn-opt small{display:block;font-weight:400;opacity:.65;margin-top:2px}';
  document.head.appendChild(css);

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function loadPlans(cb) {
    if (PLANS) return cb(PLANS);
    fetch(PAY + '/plans.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { PLANS = j; cb(j); })
      .catch(function () { cb(null); });
  }

  function openModal() {
    var ov = el('div', 'rn-ov'), box = el('div', 'rn-box');
    ov.appendChild(box);
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });

    function closeBtn() {
      var c = el('button', 'rn-opt', 'Закрыть');
      c.onclick = function () { ov.remove(); };
      return c;
    }

    function stepPlans(plans) {
      box.innerHTML = '';
      box.appendChild(el('h3', '', 'Выберите тариф'));
      box.appendChild(el('p', '', 'Продление подписки'));
      if (!plans) {
        box.appendChild(el('p', '', 'Не удалось загрузить тарифы. Попробуйте позже.'));
      } else {
        Object.keys(plans).forEach(function (k) {
          var b = el('button', 'rn-opt', plans[k].name);
          if (plans[k].desc) b.appendChild(el('small', '', plans[k].desc));
          b.onclick = function () { stepPeriods(plans, k); };
          box.appendChild(b);
        });
      }
      box.appendChild(closeBtn());
    }

    function stepPeriods(plans, k) {
      var p = plans[k];
      box.innerHTML = '';
      box.appendChild(el('h3', '', p.name));
      if (p.desc) box.appendChild(el('p', '', p.desc));
      Object.keys(p.prices).sort(function (a, b) { return a - b; }).forEach(function (m) {
        var b = el('button', 'rn-opt', m + '\u00a0мес. · ' + fmt(p.prices[m]));
        b.onclick = function () {
          location.href = PAY + '/renew/' + encodeURIComponent(shortUuid) +
            '?plan=' + encodeURIComponent(k) + '&months=' + encodeURIComponent(m);
        };
        box.appendChild(b);
      });
      var back = el('button', 'rn-opt', '‹ Назад');
      back.onclick = function () { stepPlans(plans); };
      box.appendChild(back);
    }

    box.appendChild(el('p', '', 'Загрузка…'));
    document.body.appendChild(ov);
    loadPlans(stepPlans);
  }

  var btn = el('button', 'rn-btn', 'Продлить');
  btn.type = 'button';
  btn.onclick = openModal;

  // Ставим кнопку в шапку слева от иконки Telegram; если не нашли, фиксируем в углу экрана.
  function place() {
    var tg = document.querySelector('a[href*="t.me"], a[href*="telegram"]');
    if (!tg) return false;
    var item = tg;
    while (item.parentElement && item.parentElement.children.length < 2) item = item.parentElement;
    var box = item.parentElement;
    if (!box) return false;
    box.insertBefore(btn, box.firstElementChild);
    btn.className = 'rn-btn';
    btn.style.height = '42px';
    return true;
  }

  var tries = 0;
  setInterval(function () {
    if (document.body.contains(btn) && btn.className.indexOf('rn-fixed') < 0) return;
    if (place()) return;
    if (++tries > 20 && !document.body.contains(btn)) {
      btn.className = 'rn-btn rn-fixed';
      btn.style.height = '';
      document.body.appendChild(btn);
    }
  }, 300);
})();
