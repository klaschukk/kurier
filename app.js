'use strict';
(() => {
  // ---------- данные ----------
  const KEY = 'kurier.v1';
  const UI_KEY = 'kurier.ui';
  const DAY = 864e5;

  const DEF = {
    cutPct: 30, savePct: 60,
    homeAddr: 'Сарафово, Бургас', homeKm: 11,
    packWh: 1092, cells: 16, consSingle: 20, consDual: 27, safety: 1.25, cold: false,
    cashLimit: 150, chargerA: 2,
    goalName: 'Свободная жизнь', goalTarget: 3000,
    msName: 'Снять квартиру', msAmount: 1500, msDate: '2027-03-01',
  };

  function normalize(s) {
    s = s && typeof s === 'object' ? s : {};
    const arr = k => (Array.isArray(s[k]) ? s[k] : []);
    return {
      settings: { ...DEF, ...(s.settings || {}) },
      shifts: arr('shifts'), cashDeposits: arr('cashDeposits'), savings: arr('savings'), expenses: arr('expenses'),
      active: s.active || null,
    };
  }
  // 23.10.2026: стереть тестовые данные один раз на каждом устройстве
  try {
    if (!localStorage.getItem('kurier.wiped1')) {
      localStorage.removeItem(KEY); localStorage.removeItem(UI_KEY); localStorage.setItem('kurier.wiped1', '1');
    }
  } catch (e) { /* хранилище недоступно */ }
  const readJSON = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  let S = normalize(readJSON(KEY));
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Не сохранилось: сделай бэкап'); } };

  const u0 = readJSON(UI_KEY) || {};
  const ui = { tab: u0.tab || 'shift', vehicle: u0.vehicle || 'scooter', mode: u0.mode || 'single', period: 'week',
    v: u0.v || 63, target: 100, amps: null, ending: false, last: null, charged: false };
  const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify({ tab: ui.tab, vehicle: ui.vehicle, mode: ui.mode, v: ui.v })); } catch (e) { /* ок */ } };

  // ---------- утилиты ----------
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.').trim()); return Number.isFinite(n) ? n : null; };
  const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const hm = d => { d = new Date(d); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const dm = d => { d = new Date(d); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`; };
  const eur = n => { n = Number(n) || 0; const a = Math.abs(n); return (n < 0 ? '−€' : '€') + (a >= 100 ? Math.round(a) : a.toFixed(2).replace(/\.00$/, '')); };
  const dur = ms => { const t = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(t / 3600)}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`; };
  const hrs = ms => ms / 36e5;
  const rate = (n, h) => (h > 0.05 ? eur(n / h) : '—');
  const pausedNow = a => (a.pausedMs || 0) + (a.paused ? Date.now() - a.paused : 0);
  const workMs = a => Date.now() - a.start - pausedNow(a);
  const workH = s => hrs(s.end - s.start - (s.pausedMs || 0));
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const sum = (a, f) => a.reduce((s, x) => s + (Number(f(x)) || 0), 0);
  const seg = (g, opts, cur) => opts.map(([v, t]) => { const on = String(v) === String(cur); return `<button class="${on ? 'on' : ''}" aria-pressed="${on}" data-act="seg" data-g="${g}" data-v="${v}">${t}</button>`; }).join('');
  const ic = n => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;

  let tt = null, undoFn = null;
  function toast(msg, undo) {
    const t = $('#toast'), b = t.querySelector('button');
    t.querySelector('span').textContent = msg;
    undoFn = undo || null; b.hidden = !undo; b.textContent = 'Вернуть';
    t.hidden = false; clearTimeout(tt); tt = setTimeout(() => { t.hidden = true; undoFn = null; }, undo ? 4500 : 2200);
  }

  // ---------- батарея ----------
  // Банка в покое → % (типичная кривая Li-ion NMC)
  const CURVE = [[3.20, 0], [3.30, 2], [3.40, 6], [3.50, 13], [3.60, 24], [3.70, 38], [3.80, 52], [3.90, 66], [4.00, 79], [4.10, 90], [4.20, 100]];
  function soc(v) {
    const c = v / S.settings.cells;
    if (c <= CURVE[0][0]) return 0;
    for (let i = 1; i < CURVE.length; i++) if (c <= CURVE[i][0]) {
      const [a, pa] = CURVE[i - 1], [b, pb] = CURVE[i]; return pa + (c - a) / (b - a) * (pb - pa);
    }
    return 100;
  }
  function voltAt(p) {
    p = clamp(p, 0, 100);
    for (let i = 1; i < CURVE.length; i++) if (p <= CURVE[i][1]) {
      const [a, pa] = CURVE[i - 1], [b, pb] = CURVE[i]; return (a + (p - pa) / (pb - pa) * (b - a)) * S.settings.cells;
    }
    return 4.2 * S.settings.cells;
  }
  const vMax = () => +(4.2 * S.settings.cells).toFixed(1);
  const vMin = () => +(3.2 * S.settings.cells).toFixed(1);
  // Реальный расход по своим сменам (Wh/км, приведён к теплу)
  function learned(mode) {
    const rows = S.shifts.filter(s => s.vehicle === 'scooter' && s.mode === mode && !s.charged && s.vStart && s.vEnd && s.km >= 5 && s.vStart > s.vEnd).slice(-10);
    if (rows.length < 2) return null;
    const wh = sum(rows, s => (soc(s.vStart) - soc(s.vEnd)) / 100 * S.settings.packWh / (s.cold ? 1.25 : 1));
    return { wh: wh / sum(rows, s => s.km), n: rows.length };
  }
  const cons = mode => (learned(mode)?.wh || (mode === 'dual' ? S.settings.consDual : S.settings.consSingle)) * (S.settings.cold ? 1.25 : 1);
  function batt(v, mode) {
    const st = S.settings, p = soc(v), c = cons(mode);
    const whLeft = p / 100 * st.packWh;
    const homeWh = st.homeKm * cons('single') * st.safety;          // домой всегда на 1 моторе
    const homeV = voltAt(homeWh / st.packWh * 100);
    const km = whLeft / c, work = Math.max(0, (whLeft - homeWh) / c);
    return { p, km, work, homeV, cls: v <= homeV ? 'bad' : work < 8 ? 'soon' : 'ok' };
  }
  function chargeH(from, to, amps) {
    if (to <= from) return 0;
    const W = S.settings.cells * 3.75 * amps * 0.92;
    const cc = Math.max(0, Math.min(to, 80) - from), cv = Math.max(0, to - Math.max(from, 80)) * 2;  // после ~80% ток падает
    return (cc + cv) / 100 * S.settings.packWh / W;
  }

  // ---------- деньги ----------
  const cutOf = s => s.cut ?? S.settings.cutPct;
  const net = s => (s.gross || 0) * (1 - cutOf(s) / 100) + (s.tips || 0);
  function stats(list) {
    const h = sum(list, workH), n = sum(list, net);
    return { n: list.length, h, net: n, deliv: sum(list, s => s.deliveries), perH: h > 0.05 ? n / h : 0 };
  }
  const inPeriod = (t, p) => p === 'day' ? ymd(t) === ymd(Date.now()) : p === 'week' ? Date.now() - t < 7 * DAY : p === 'month' ? Date.now() - t < 30 * DAY : true;
  const WIN = [['Утро', h => h < 11], ['Обед', h => h >= 11 && h < 15], ['День', h => h >= 15 && h < 18], ['Вечер', h => h >= 18]];
  const cashBal = () => sum(S.shifts, s => s.cash) + (S.active?.cash || 0) - sum(S.cashDeposits, d => d.amount);
  const saved = () => sum(S.savings, x => x.amount);
  function perDay() {
    if (!S.savings.length) return null;
    const span = (Date.now() - Math.min(...S.savings.map(x => x.date))) / DAY;
    if (span < 14) return null;                                      // рано судить о темпе
    return span >= 30 ? sum(S.savings.filter(x => Date.now() - x.date < 30 * DAY), x => x.amount) / 30 : saved() / span;
  }
  function shiftsLeft(left) {
    const recent = S.shifts.slice(-10);
    if (recent.length < 2 || left <= 0) return null;
    const per = sum(recent, net) / recent.length * S.settings.savePct / 100;
    return per > 0 ? Math.ceil(left / per) : null;
  }
  function lastBackupDays() {
    const t = +(readJSON('kurier.backup') || 0);
    return t ? Math.floor((Date.now() - t) / DAY) : null;
  }
  const mapsHome = () => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(S.settings.homeAddr)}&travelmode=bicycling`;

  // ---------- кусочки ----------
  const C = 2 * Math.PI * 52;
  const ring = (pct, cls, big, sub) => `<div class="ringwrap">
    <svg class="ring ${cls}" viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="52"/>
    <circle class="val" cx="60" cy="60" r="52" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - clamp(pct, 0, 100) / 100)).toFixed(1)}" transform="rotate(-90 60 60)"/></svg>
    <div class="ringtxt"><b>${big}</b><small>${sub}</small></div></div>`;
  const vLbl = v => `<b>${(+v).toFixed(1)} V</b> · ${Math.round(soc(v))}%`;
  const slider = (id, v) => `<div class="vlabel"><span>Вольтаж</span><span id="${id}L">${vLbl(v)}</span></div>
    <input type="range" id="${id}" aria-label="Вольтаж батареи" min="${vMin()}" max="${vMax()}" step="0.1" value="${v}">`;

  // ---------- экраны ----------
  function vShift() {
    const a = S.active;
    if (a && ui.ending) return vEnd();
    if (a) {
      const b = a.vehicle === 'scooter' ? batt(ui.v, a.mode) : null;
      return `
      <section class="card hero${a.paused ? ' paused' : ''}">
        <small>${a.paused ? 'Пауза · ' : ''}${a.vehicle === 'bike' ? 'Велик' : 'Самокат · ' + (a.mode === 'dual' ? '2 мотора' : '1 мотор')} · с ${hm(a.start)}</small>
        <div class="timer" id="timer">${dur(workMs(a))}</div>
        <div class="grid2">
          <div class="kpi"><b>${a.deliveries}</b><small>доставок</small></div>
          <div class="kpi"><b>${eur(a.cash)}</b><small>наличка</small></div>
        </div>
        ${cashBal() > S.settings.cashLimit ? `<p class="bad"><b>Налички Wolt ${eur(cashBal())}: пора сдать</b></p>` : ''}
        <button class="pausebtn" data-act="pause">${a.paused ? ic('play') + 'Продолжить' : ic('pause') + 'Пауза'}</button>
      </section>
      <button class="tap" data-act="plus">${ic('plus')}Доставка</button>
      <div class="row"><span></span>${a.deliveries ? `<button class="link" data-act="minus">${ic('minus')}1 доставка</button>` : ''}</div>
      <section class="card">
        <h2>Наличка</h2>
        <div class="chips">${[5, 10, 15, 20, 30].map(n => `<button data-act="cash" data-n="${n}">+${n}</button>`).join('')}</div>
        <div class="inline"><input id="cashAmt" inputmode="decimal" placeholder="другая сумма" aria-label="Сумма налички, €"><button data-act="cashIn" aria-label="Добавить наличку">${ic('plus')}</button></div>
      </section>
      ${b ? `<section class="card"><h2>Батарея</h2>${slider('vNow', ui.v)}<div id="qb">${qb(b)}</div></section>` : ''}
      <div class="grid2">
        <a class="btn" href="${mapsHome()}" target="_blank" rel="noopener">${ic('home')}Домой</a>
        <button class="end" data-act="end">${ic('flag')}Финиш</button>
      </div>`;
    }
    const t = stats(S.shifts.filter(s => inPeriod(s.start, 'day')));
    const wk = stats(S.shifts.filter(s => inPeriod(s.start, 'week')));
    const sl = shiftsLeft(S.settings.goalTarget - saved());
    const bk = lastBackupDays();
    const g = S.settings.goalTarget > 0 ? clamp(saved() / S.settings.goalTarget * 100, 0, 100) : 0;
    return `
      ${ui.last ? lastCard() : ''}
      <section class="card hero">
        <div class="row">
          <div><small>Сегодня</small><span class="xl">${eur(t.net)}</span><small>${t.n ? `${t.h.toFixed(1)} ч · ${t.deliv} дост.${t.h > 0.05 ? ' · ' + eur(t.perH) + '/ч' : ''}` : 'смен ещё не было'}</small></div>
          <div class="r"><small>Неделя</small><span class="lg">${eur(wk.net)}</span></div>
        </div>
        <div class="row" style="margin-top:14px"><small>${esc(S.settings.goalName)}</small><small>${Math.round(g)}%${sl ? ` · ≈${sl} смен` : ''}</small></div>
        <div class="progress" style="margin-top:6px"><i style="width:${g.toFixed(1)}%"></i></div>
      </section>
      <div class="seg">${seg('ride', [['single', '1 мотор'], ['dual', '2 мотора'], ['bike', 'Велик']], ui.vehicle === 'bike' ? 'bike' : ui.mode)}</div>
      ${ui.vehicle === 'scooter' ? `<section class="card">${slider('vStart', ui.v)}</section>` : ''}
      <button class="go" data-act="start">Поехали</button>
      ${S.shifts.length >= 5 && (bk == null || bk >= 7) ? `<button class="link" data-tab="settings" style="width:100%">Бэкап ${bk == null ? 'ещё не делался' : `был ${bk} дн. назад`}</button>` : ''}`;
  }
  const qb = b => `<div class="grid3" style="margin-top:6px">
      <div class="kpi"><b class="${b.cls}">${Math.round(b.p)}%</b><small>заряд</small></div>
      <div class="kpi"><b>${Math.round(b.work)} км</b><small>на заказы</small></div>
      <div class="kpi"><b class="${b.cls}">${b.homeV.toFixed(1)}</b><small>V — домой</small></div>
    </div>${b.cls === 'bad' ? '<p class="bad"><b>Пора домой.</b></p>' : ''}`;

  function vEnd() {
    const a = S.active;
    return `
      <section class="card">
        <h2>Финиш <span>${dur(workMs(a))} · ${a.deliveries} дост.</span></h2>
        <label>Заработал в Wolt, €</label>
        <input id="eGross" class="money-in" inputmode="decimal" placeholder="0" aria-label="Заработал в Wolt, €">
        <div class="grid2">
          <label>Чаевые нал., €<input id="eTips" inputmode="decimal" placeholder="0"></label>
          <label>Км<input id="eKm" inputmode="decimal" placeholder="0"></label>
        </div>
        ${a.vehicle === 'scooter' ? `<div style="margin-top:14px">${slider('eV', ui.v)}</div>
          <div class="chips"><button class="${ui.charged ? 'on' : ''}" aria-pressed="${!!ui.charged}" data-act="charged">${ic('zap')}Подзаряжался</button></div>` : ''}
      </section>
      <button class="go" data-act="saveEnd">Сохранить</button>
      <button class="link" data-act="cancelEnd" style="width:100%">Ещё не закончил</button>`;
  }
  function lastCard() {
    const s = S.shifts.find(x => x.id === ui.last);
    if (!s) return '';
    const n = net(s), h = workH(s), sug = Math.round(n * S.settings.savePct / 100);
    return `<section class="card">
      <div class="row"><h2 style="margin:0">Смена</h2><button class="x" data-act="hideLast" aria-label="Скрыть">${ic('x')}</button></div>
      <div class="grid2" style="margin-top:8px">
        <div class="kpi"><b>${eur(n)}</b><small>тебе</small></div>
        <div class="kpi"><b>${h > 0.05 ? eur(n / h) : '—'}</b><small>в час</small></div>
      </div>
      ${sug > 0 ? `<button class="go" data-act="saveSug" data-n="${sug}">Отложить ${eur(sug)} на цель</button>` : ''}
    </section>`;
  }

  function vBattery() {
    const amps = ui.amps || S.settings.chargerA;
    const l = learned(ui.mode);
    return `
      <section class="card">
        <div id="bOut">${bOut()}</div>
        ${slider('bV', ui.v)}
        <div class="seg">${seg('mode', [['single', '1 мотор'], ['dual', '2 мотора']], ui.mode)}</div>
        <div class="chips"><button class="${S.settings.cold ? 'on' : ''}" aria-pressed="${S.settings.cold}" data-act="cold">${ic('snow')}Холодно</button></div>
        ${l ? `<small>Твой расход: ${l.wh.toFixed(1)} Wh/км по ${l.n} сменам</small>` : ''}
      </section>
      <section class="card">
        <h2>Зарядка</h2>
        <div class="seg">${seg('target', [[80, 'до 80%'], [90, 'до 90%'], [100, 'до 100%']], ui.target)}</div>
        <div class="chips">${[2, 3, 4, 5].map(x => `<button class="${x === amps ? 'on' : ''}" aria-pressed="${x === amps}" data-act="seg" data-g="amps" data-v="${x}">${x}A</button>`).join('')}</div>
        <div id="cOut">${cOut()}</div>
      </section>`;
  }
  function bOut() {
    const b = batt(ui.v, ui.mode);
    return `${ring(b.p, b.cls, Math.round(b.p) + '%', `~${Math.round(b.km)} км`)}
      <div class="grid2">
        <div class="kpi"><b>${Math.round(b.work)} км</b><small>на заказы</small></div>
        <div class="kpi"><b class="${b.cls}">${b.homeV.toFixed(1)} V</b><small>порог «домой»</small></div>
      </div>`;
  }
  function cOut() {
    const h = chargeH(soc(ui.v), ui.target, ui.amps || S.settings.chargerA);
    if (h <= 0) return '<span class="lg ok">Заряжено</span>';
    const m = Math.round(h * 60);
    return `<div class="row"><span class="lg">${Math.floor(m / 60)} ч ${pad(m % 60)} м</span><span class="dim">готово в ${hm(Date.now() + m * 6e4)}</span></div>`;
  }

  function vMoney() {
    const list = S.shifts.filter(s => inPeriod(s.start, ui.period));
    const t = stats(list), cash = cashBal();
    const w = WIN.map(([name, f]) => [name, stats(list.filter(s => f(new Date(s.start).getHours())))]);
    const top = Math.max(1, ...w.map(([, x]) => x.perH));
    const cashCls = cash > S.settings.cashLimit ? 'bad' : cash > S.settings.cashLimit * 0.7 ? 'soon' : '';
    return `
      ${ui.edit ? editCard() : ''}
      <div class="seg">${seg('period', [['day', 'День'], ['week', 'Неделя'], ['month', 'Месяц'], ['all', 'Всё']], ui.period)}</div>
      <section class="card hero">
        <small>Тебе чистыми</small><span class="xl">${eur(t.net)}</span>
        <div class="grid3" style="margin-top:12px">
          <div class="kpi"><b>${rate(t.net, t.h)}</b><small>в час</small></div>
          <div class="kpi"><b>${t.h.toFixed(1)}</b><small>часов</small></div>
          <div class="kpi"><b>${t.deliv}</b><small>доставок</small></div>
        </div>
      </section>
      ${list.length ? `<section class="card"><h2>€/ч по времени</h2><div class="bars">${w.map(([name, x]) => `
        <div class="barrow"><span>${name}</span><div class="btrack"><i style="width:${x.n ? (x.perH / top * 100).toFixed(0) : 0}%"></i></div><b class="r">${rate(x.net, x.h)}</b></div>`).join('')}
      </div></section>` : ''}
      <section class="card">
        <h2>Наличка Wolt <span class="${cashCls}">${eur(cash)}</span></h2>
        <div class="inline"><input id="depAmt" inputmode="decimal" placeholder="сколько сдал" aria-label="Сколько сдал, €"><button data-act="dep">Сдал</button>${cash > 0 ? '<button data-act="depAll">Всё</button>' : ''}</div>
      </section>
      ${list.length ? `<section class="card"><h2>Смены</h2><ul class="list">${list.slice().reverse().slice(0, 40).map(s => `
        <li><button class="rowbtn" data-act="editShift" data-id="${s.id}"><b>${dm(s.start)}</b> <span class="meta">${hm(s.start)}–${hm(s.end)} · ${s.deliveries} дост. · ${rate(net(s), workH(s))}/ч</span></button>
        <div class="row"><b>${eur(net(s))}</b><button class="x" data-act="delShift" data-id="${s.id}" aria-label="Удалить смену">${ic('x')}</button></div></li>`).join('')}</ul></section>` : ''}`;
  }

  function editCard() {
    const s = S.shifts.find(x => x.id === ui.edit);
    if (!s) return '';
    const inp = (id, label, v, mode = 'decimal') => `<label>${label}<input id="${id}" inputmode="${mode}" value="${v || 0}"></label>`;
    return `<section class="card">
      <div class="row"><h2 style="margin:0">Смена ${dm(s.start)} · ${hm(s.start)}</h2><button class="x" data-act="editClose" aria-label="Закрыть">${ic('x')}</button></div>
      ${inp('xGross', 'Заработал в Wolt, €', s.gross)}
      <div class="grid3">${inp('xTips', 'Чаевые, €', s.tips)}${inp('xDel', 'Доставок', s.deliveries, 'numeric')}${inp('xKm', 'Км', s.km)}</div>
      ${inp('xCash', 'Наличка, €', s.cash)}
      <button class="go" data-act="editSave">Сохранить</button>
    </section>`;
  }

  function vGoal() {
    const st = S.settings, have = saved(), left = Math.max(0, st.goalTarget - have);
    const pct = st.goalTarget > 0 ? have / st.goalTarget * 100 : 0;
    const r = perDay(), eta = r > 0 ? new Date(Date.now() + left / r * DAY) : null;
    const msLeft = Math.max(0, st.msAmount - have), weeks = (new Date(st.msDate + 'T00:00:00') - Date.now()) / (7 * DAY);
    return `
      <section class="card hero">
        ${ring(pct, 'accent', eur(have), 'из ' + eur(st.goalTarget))}
        <div class="row"><b>${esc(st.goalName)}</b><span class="dim">осталось ${eur(left)}</span></div>
        ${shiftsLeft(left) ? `<div class="row" style="margin-top:8px"><span class="dim">≈ смен до цели</span><span class="lg">${shiftsLeft(left)}</span></div>` : ''}
        ${eta ? `<small>Темп ~${eur(r * 30)}/мес → ${eta.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}</small>` : ''}
      </section>
      <section class="card">
        <div class="chips">${[10, 20, 50, 100].map(n => `<button data-act="add" data-n="${n}">+${n}</button>`).join('')}</div>
        <div class="inline"><input id="savAmt" inputmode="decimal" placeholder="сумма" aria-label="Сумма, €"><button data-act="addIn" aria-label="Отложить">${ic('plus')}</button><button data-act="take" aria-label="Взять">${ic('minus')}</button></div>
      </section>
      ${msLeft > 0 && weeks > 0 ? `<section class="card"><h2>${esc(st.msName)} <span>до ${dm(st.msDate + 'T00:00:00')}</span></h2>
        <span class="lg">${eur(msLeft / weeks)}<small> / неделю</small></span></section>` : ''}
      ${S.savings.length ? `<section class="card"><ul class="list">${S.savings.slice().reverse().slice(0, 12).map(x => `
        <li><span class="meta">${dm(x.date)}${x.note ? ' · ' + esc(x.note) : ''}</span><div class="row"><b class="${x.amount < 0 ? 'bad' : 'ok'}">${x.amount > 0 ? '+' : ''}${eur(x.amount)}</b><button class="x" data-act="delSav" data-id="${x.id}" aria-label="Удалить запись">${ic('x')}</button></div></li>`).join('')}</ul></section>` : ''}`;
  }

  const F = (k, label, type) => `<label>${label}<input data-set="${k}" ${type === 'text' ? 'type="text"' : type === 'date' ? 'type="date"' : 'inputmode="decimal"'} value="${esc(S.settings[k])}"></label>`;
  function vSettings() {
    return `
      <section class="card">
        <h2>Главное</h2>
        <div class="grid2">${F('cutPct', 'Доля за профиль, %')}${F('savePct', 'Откладывать, %')}</div>
        ${F('homeAddr', 'Адрес дома', 'text')}
        <div class="grid2">${F('homeKm', 'Км до дома')}${F('cashLimit', 'Лимит налички, €')}</div>
      </section>
      <section class="card">
        <h2>Цель</h2>
        ${F('goalName', 'Название', 'text')}
        ${F('goalTarget', 'Сумма, €')}
        ${F('msName', 'Промежуточная', 'text')}
        <div class="grid2">${F('msAmount', 'Сумма, €')}${F('msDate', 'К дате', 'date')}</div>
      </section>
      <section class="card">
        <details><summary>Батарея (если не Mantis 10+ 60V 18.2Ah)</summary>
          <div class="grid2">${F('packWh', 'Ёмкость, Wh')}${F('cells', 'Банок (60V=16)')}${F('consSingle', 'Wh/км 1 мотор')}${F('consDual', 'Wh/км 2 мотора')}${F('safety', 'Запас домой, ×')}${F('chargerA', 'Зарядник, A')}</div>
        </details>
      </section>
      <section class="card">
        <h2>Данные на телефоне <span>${lastBackupDays() == null ? 'бэкапа нет' : lastBackupDays() === 0 ? 'бэкап сегодня' : `бэкап ${lastBackupDays()} дн. назад`}</span></h2>
        <div class="grid2"><button data-act="export">Бэкап</button><button data-act="import">Загрузить</button></div>
        <button class="link" data-act="reset" style="width:100%;margin-top:6px">Стереть всё</button>
      </section>`;
  }

  // Старый адрес на сервере: подсказать переезд на GitHub Pages
  const NEW_URL = 'https://klaschukk.github.io/kurier/';
  const moveBanner = () => `<section class="card hero">
      <h2>Приложение переехало</h2>
      <div class="grid2"><button data-act="export">1. Бэкап</button><a class="btn" href="${NEW_URL}">2. Новый адрес</a></div>
      <small>На новом: ⚙ → «Загрузить» → выбери файл бэкапа.</small>
    </section>`;

  const VIEWS = { shift: vShift, battery: vBattery, money: vMoney, goal: vGoal, settings: vSettings };
  function render() {
    $('#view').innerHTML = (location.port === '8092' ? moveBanner() : '') + (VIEWS[ui.tab] || vShift)();
    document.querySelectorAll('[data-tab]').forEach(b => { const on = b.dataset.tab === ui.tab; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    $('#live').hidden = !S.active;
  }

  // ---------- действия ----------
  const addSav = (n, note) => { S.savings.push({ id: uid(), date: Date.now(), amount: n, note: note || '' }); save(); };
  function removeWithUndo(key, id, label) {
    const i = S[key].findIndex(x => x.id === id);
    if (i < 0) return;
    const [item] = S[key].splice(i, 1); save(); render();
    toast(label, () => { S[key].splice(i, 0, item); save(); render(); });
  }
  const A = {
    seg(el) {
      const g = el.dataset.g, v = el.dataset.v;
      if (g === 'ride') { if (v === 'bike') ui.vehicle = 'bike'; else { ui.vehicle = 'scooter'; ui.mode = v; } saveUi(); }
      else if (g === 'mode') { ui.mode = v; saveUi(); }
      else if (g === 'target' || g === 'amps') ui[g] = +v;
      else if (g === 'period') ui.period = v;
      render();
    },
    start() {
      S.active = { start: Date.now(), vehicle: ui.vehicle, mode: ui.vehicle === 'scooter' ? ui.mode : null,
        vStart: ui.vehicle === 'scooter' ? +ui.v : null, deliveries: 0, cash: 0, cold: S.settings.cold };
      ui.last = null; ui.charged = false; save(); render();
    },
    pause() {
      const a = S.active;
      if (a.paused) { a.pausedMs = (a.pausedMs || 0) + Date.now() - a.paused; a.paused = null; }
      else a.paused = Date.now();
      save(); render();
    },
    plus() { S.active.deliveries++; save(); render(); if (navigator.vibrate) navigator.vibrate(15); },
    minus() { if (S.active.deliveries) { S.active.deliveries--; save(); render(); } },
    cash(el) { S.active.cash += +el.dataset.n; save(); render(); toast(`+€${el.dataset.n} наличкой`); },
    cashIn() { const n = num(val('cashAmt')); if (n > 0) { S.active.cash += n; save(); render(); toast(`+${eur(n)} наличкой`); } },
    end() { ui.ending = true; render(); scrollTo(0, 0); const g = $('#eGross'); if (g) g.focus(); },
    cancelEnd() { ui.ending = false; render(); },
    charged() { ui.charged = !ui.charged; render(); },
    saveEnd() {
      const a = S.active, s = {
        id: uid(), start: a.start, end: Date.now(), vehicle: a.vehicle, mode: a.mode, deliveries: a.deliveries, cash: a.cash,
        gross: num(val('eGross')) || 0, tips: num(val('eTips')) || 0, km: num(val('eKm')) || 0,
        pausedMs: pausedNow(a), vStart: a.vStart, vEnd: a.vehicle === 'scooter' ? +ui.v : null, charged: !!ui.charged, cold: a.cold, cut: S.settings.cutPct,
      };
      S.shifts.push(s); S.active = null; ui.ending = false; ui.last = s.id; save(); saveUi(); render(); scrollTo(0, 0);
    },
    saveSug(el) { addSav(+el.dataset.n, 'со смены'); ui.last = null; render(); toast(`Отложено ${eur(+el.dataset.n)}`); },
    hideLast() { ui.last = null; render(); },
    cold() { S.settings.cold = !S.settings.cold; save(); render(); },
    dep() { const n = num(val('depAmt')); if (n > 0) { S.cashDeposits.push({ id: uid(), date: Date.now(), amount: n }); save(); render(); toast(`Сдал ${eur(n)}`); } },
    depAll() { const n = cashBal(); S.cashDeposits.push({ id: uid(), date: Date.now(), amount: n }); save(); render(); toast(`Сдал ${eur(n)}`); },
    editShift(el) { ui.edit = el.dataset.id; render(); scrollTo(0, 0); },
    editClose() { ui.edit = null; render(); },
    editSave() {
      const s = S.shifts.find(x => x.id === ui.edit);
      if (s) {
        s.gross = num(val('xGross')) || 0; s.tips = num(val('xTips')) || 0; s.km = num(val('xKm')) || 0;
        s.cash = num(val('xCash')) || 0; s.deliveries = Math.max(0, Math.round(num(val('xDel')) || 0));
        save(); toast('Смена исправлена');
      }
      ui.edit = null; render();
    },
    delShift(el) { removeWithUndo('shifts', el.dataset.id, 'Смена удалена'); },
    delSav(el) { removeWithUndo('savings', el.dataset.id, 'Запись удалена'); },
    add(el) { addSav(+el.dataset.n); render(); toast(`+€${el.dataset.n} на цель`); },
    addIn() { const n = num(val('savAmt')); if (n > 0) { addSav(n); render(); toast(`+${eur(n)} на цель`); } },
    take() { const n = num(val('savAmt')); if (n > 0) { addSav(-n, 'взял'); render(); } },
    export() {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' }));
      a.download = `kurier-${ymd(Date.now())}.json`;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      try { localStorage.setItem('kurier.backup', String(Date.now())); } catch (e) { /* ок */ }
      render();
    },
    import() { $('#importFile').click(); },
    reset() { if (confirm('Стереть все данные? Без бэкапа не вернуть.')) { S = normalize(null); save(); render(); } },
  };

  const SLIDERS = ['vStart', 'vNow', 'eV', 'bV'];
  document.addEventListener('click', e => {
    if (e.target.closest('#toast button')) { const f = undoFn; $('#toast').hidden = true; undoFn = null; if (f) f(); return; }
    const tab = e.target.closest('[data-tab]');
    if (tab) { ui.tab = tab.dataset.tab; ui.ending = false; ui.edit = null; saveUi(); render(); scrollTo(0, 0); return; }
    const el = e.target.closest('[data-act]');
    if (el && A[el.dataset.act]) A[el.dataset.act](el);
  });
  document.addEventListener('input', e => {
    const id = e.target.id;
    if (!SLIDERS.includes(id)) return;
    ui.v = +e.target.value;
    const l = document.getElementById(id + 'L'); if (l) l.innerHTML = vLbl(ui.v);
    if (id === 'vNow') $('#qb').innerHTML = qb(batt(ui.v, S.active.mode));
    if (id === 'bV') { $('#bOut').innerHTML = bOut(); $('#cOut').innerHTML = cOut(); }
  });
  document.addEventListener('change', e => {
    if (SLIDERS.includes(e.target.id)) return saveUi();
    const k = e.target.dataset && e.target.dataset.set;
    if (!k) return;
    const v = e.target.value.trim();
    if (typeof DEF[k] === 'number') {
      const n = num(v);
      if (n == null || n < 0) return render();
      S.settings[k] = k === 'cells' ? Math.round(n) || 16 : n;
    } else if (v) S.settings[k] = v;
    save(); toast('Сохранено');
  });
  $('#importFile').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    f.text().then(t => {
      const o = JSON.parse(t);
      if (!o || !o.settings || !Array.isArray(o.shifts)) throw new Error('bad');
      S = normalize(o); save(); render(); toast(`Загружено: ${o.shifts.length} смен`);
    }).catch(() => toast('Это не файл бэкапа')).finally(() => { e.target.value = ''; });
  });

  setInterval(() => { const t = document.getElementById('timer'); if (t && S.active && !S.active.paused) t.textContent = dur(workMs(S.active)); }, 1000);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
})();
