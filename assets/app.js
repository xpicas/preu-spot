/* Preu SPOT de la llum — mercat diari OMIE (zona ES)
 * Fonts de dades, per ordre:
 *   1. data/AAAA-MM-DD.json  -> generat per GitHub Actions des d'OMIE (scripts/fetch_omie.py)
 *   2. API pública de REE (apidatos.ree.es), sèrie 600 "Precio mercado spot" -> admet CORS
 * Totes les hores es mostren en hora peninsular (Europe/Madrid), sigui on sigui el navegador.
 */
(() => {
  'use strict';

  const TZ = 'Europe/Madrid';
  const SLOTS = 96; // quarts d'hora en un dia "normal"
  const REE_URL = (d) =>
    `https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real?start_date=${d}T00:00&end_date=${d}T23:59&time_trunc=hour`;
  const POLL_TOMORROW_MS = 5 * 60 * 1000;
  const TICK_MS = 20 * 1000;

  // ---------- temps (sempre en hora de Madrid) ----------
  const partsFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  function mParts(date) {
    const o = {};
    for (const p of partsFmt.formatToParts(date)) o[p.type] = p.value;
    return { date: `${o.year}-${o.month}-${o.day}`, h: +o.hour, m: +o.minute };
  }
  const todayStr = () => mParts(new Date()).date;
  function addDays(ds, n) {
    const [y, m, d] = ds.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  const dayFmt = new Intl.DateTimeFormat('ca-ES', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  const shortDayFmt = new Intl.DateTimeFormat('ca-ES', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  const dsToUTC = (ds) => new Date(ds + 'T12:00:00Z');
  const pad = (n) => String(n).padStart(2, '0');
  const slotLabel = (i, res = 15) => {
    const a = i * res;
    return `${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  };
  const slotRange = (i, res = 15) => {
    const a = i * res, b = (i + 1) * res;
    return `${pad(Math.floor(a / 60))}:${pad(a % 60)}–${pad(Math.floor(b / 60) % 24)}:${pad(b % 60)}`;
  };
  function dayName(ds) {
    const t = todayStr();
    if (ds === t) return 'Avui';
    if (ds === addDays(t, 1)) return 'Demà';
    if (ds === addDays(t, -1)) return 'Ahir';
    const s = shortDayFmt.format(dsToUTC(ds));
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ---------- format de preus ----------
  const state = {
    unit: load('unit', 'kwh'),
    res: +load('res', '15'),
    compare: load('compare', '1') === '1',
    base: todayStr(),
    days: new Map(), // ds -> {slots:[96], source, updated} | null
    chart: null,
  };
  function load(k, def) { try { return localStorage.getItem('spot.' + k) ?? def; } catch { return def; } }
  function save(k, v) { try { localStorage.setItem('spot.' + k, v); } catch { /* sense emmagatzematge */ } }

  const nf = (min, max) => new Intl.NumberFormat('ca-ES', { minimumFractionDigits: min, maximumFractionDigits: max });
  const fMWh = nf(2, 2), fKWh = nf(4, 4), fPct = nf(0, 0);
  const conv = (p) => (state.unit === 'kwh' ? p / 1000 : p);
  const unitLabel = () => (state.unit === 'kwh' ? '€/kWh' : '€/MWh');
  const fmt = (p) => (p == null || Number.isNaN(p) ? '—' : (state.unit === 'kwh' ? fKWh : fMWh).format(conv(p)));
  const fmtU = (p) => (p == null ? '—' : `${fmt(p)} ${unitLabel()}`);

  // ---------- dades ----------
  // Normalitza a 96 quarts per hora local. Dies de canvi d'hora: 92 (falten) o 100 (es fa la mitjana dels duplicats).
  function toSlots(points) {
    const sum = new Array(SLOTS).fill(0), cnt = new Array(SLOTS).fill(0);
    let res = 15;
    if (points.length && points.length <= 25) res = 60; // dies anteriors a l'1/10/2025 (resolució horària)
    for (const { t, p } of points) {
      const { h, m } = mParts(t);
      const i0 = Math.floor((h * 60 + m) / 15);
      for (let k = 0; k < res / 15; k++) {
        const i = i0 + k;
        if (i < SLOTS) { sum[i] += p; cnt[i]++; }
      }
    }
    return sum.map((s, i) => (cnt[i] ? s / cnt[i] : null));
  }

  async function fromLocal(ds) {
    const r = await fetch(`data/${ds}.json`, { cache: 'no-cache' });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !Array.isArray(j.prices) || j.prices.length < 23) return null;
    return {
      points: j.prices.map((x) => ({ t: new Date(x.t), p: +x.p })),
      source: `OMIE${j.source && j.source !== 'OMIE' ? ' (' + j.source + ')' : ''}`,
      updated: j.updated || null,
    };
  }

  async function fromREE(ds) {
    const r = await fetch(REE_URL(ds));
    if (!r.ok) return null;
    const j = await r.json();
    const s = (j.included || []).find((x) => x.id === '600' || /spot/i.test(x.attributes?.title || ''));
    if (!s) return null;
    const pts = s.attributes.values
      .map((v) => ({ t: new Date(v.datetime), p: +v.value }))
      .filter((x) => mParts(x.t).date === ds);
    if (pts.length < 23) return null;
    return { points: pts, source: 'REE (apidatos)', updated: s.attributes['last-update'] || j.data?.attributes?.['last-update'] || null };
  }

  const misses = new Map(); // ds -> instant de l'últim intent fallit
  async function getDay(ds, { force = false } = {}) {
    if (state.days.get(ds)) return state.days.get(ds);
    if (!force && misses.has(ds) && Date.now() - misses.get(ds) < POLL_TOMORROW_MS) return null;
    let d = null;
    for (const src of [fromLocal, fromREE]) {
      try { d = await src(ds); } catch (e) { d = null; }
      if (d) break;
    }
    const out = d ? { slots: toSlots(d.points), n: d.points.length, source: d.source, updated: d.updated } : null;
    if (out) { state.days.set(ds, out); misses.delete(ds); } else misses.set(ds, Date.now());
    return out;
  }

  // ---------- càlculs ----------
  const valid = (a) => a.filter((v) => v != null);
  const mean = (a) => { const v = valid(a); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
  function hourly(slots) {
    const out = [];
    for (let h = 0; h < 24; h++) out.push(mean(slots.slice(h * 4, h * 4 + 4)));
    return out;
  }
  function extremes(arr) {
    let mi = null, ma = null;
    arr.forEach((v, i) => {
      if (v == null) return;
      if (mi == null || v < arr[mi]) mi = i;
      if (ma == null || v > arr[ma]) ma = i;
    });
    return { mi, ma };
  }
  function cheapestWindow(slots, hours, fromSlot = 0) {
    const w = hours * 4;
    let best = null;
    for (let s = fromSlot; s + w <= SLOTS; s++) {
      const part = slots.slice(s, s + w);
      if (part.some((v) => v == null)) continue;
      const avg = mean(part);
      if (best == null || avg < best.avg) best = { start: s, end: s + w, avg };
    }
    return best;
  }
  function tertiles(slots) {
    const v = valid(slots).sort((a, b) => a - b);
    return [v[Math.floor(v.length / 3)], v[Math.floor((2 * v.length) / 3)]];
  }
  const currentSlot = () => { const { h, m } = mParts(new Date()); return Math.floor((h * 60 + m) / 15); };

  // ---------- render ----------
  const $ = (id) => document.getElementById(id);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function renderHero(today) {
    const idx = currentSlot();
    const t = todayStr();
    $('now-unit').textContent = unitLabel();
    if (!today) {
      $('now-price').textContent = '—';
      $('now-label').textContent = 'Ara · sense dades';
      ['next-price', 'hour-price'].forEach((id) => ($(id).textContent = '—'));
      $('now-level').hidden = true; $('now-vs').textContent = '';
      return;
    }
    const p = today.slots[idx];
    $('now-label').textContent = `Ara · ${slotRange(idx)} (${dayFmt.format(dsToUTC(t))})`;
    $('now-price').textContent = fmt(p);
    const next = idx + 1 < SLOTS ? today.slots[idx + 1] : state.days.get(addDays(t, 1))?.slots[0];
    $('next-label').textContent = `Següent quart (${slotRange((idx + 1) % SLOTS)})`;
    $('next-price').textContent = fmtU(next);
    const h = Math.floor(idx / 4);
    $('hour-label').textContent = `Mitjana ${pad(h)}:00–${pad((h + 1) % 24)}:00`;
    $('hour-price').textContent = fmtU(mean(today.slots.slice(h * 4, h * 4 + 4)));

    const avg = mean(today.slots);
    const [t1, t2] = tertiles(today.slots);
    const lvl = p == null ? null : p <= t1 ? 'low' : p >= t2 ? 'high' : 'mid';
    const el = $('now-level');
    el.hidden = !lvl;
    if (lvl) { el.dataset.l = lvl; el.textContent = { low: 'Barat', mid: 'Normal', high: 'Car' }[lvl] + ' per avui'; }
    if (p != null && avg) {
      const d = ((p - avg) / Math.abs(avg)) * 100;
      $('now-vs').textContent = `${d >= 0 ? '+' : '−'}${fPct.format(Math.abs(d))} % vs mitjana del dia (${fmtU(avg)})`;
    } else $('now-vs').textContent = '';
  }

  const fmtSmall = (p) => (p == null ? '—' : `${fmt(p)} <small>${unitLabel()}</small>`);
  function statBlock(k, v, s, wide = false) {
    return `<div class="stat${wide ? ' wide' : ''}"><span class="stat-k">${k}</span><span class="stat-v">${v}</span>${s ? `<span class="stat-s">${s}</span>` : ''}</div>`;
  }

  function renderStats(base, next, baseDs, nextDs) {
    const parts = [];
    const add = (d, ds, other) => {
      const name = dayName(ds);
      if (!d) { parts.push(statBlock(`${name} · mitjana`, '—', ds === addDays(todayStr(), 1) ? 'Encara no publicat (≈13:00)' : 'Sense dades', true)); return; }
      const { mi, ma } = extremes(d.slots);
      const avg = mean(d.slots);
      let cmp = '';
      if (other) {
        const oa = mean(other.slots);
        const diff = ((avg - oa) / Math.abs(oa)) * 100;
        cmp = `${diff >= 0 ? '+' : '−'}${fPct.format(Math.abs(diff))} % vs ${dayName(baseDs).toLowerCase()}`;
      }
      parts.push(statBlock(`${name} · mitjana`, fmtSmall(avg), cmp || `${d.n} preus`));
      parts.push(statBlock(`${name} · mínim`, fmtSmall(d.slots[mi]), `<span class="t">${slotRange(mi)}</span>`));
      parts.push(statBlock(`${name} · màxim`, fmtSmall(d.slots[ma]), `<span class="t">${slotRange(ma)}</span>`));
    };
    add(base, baseDs, null);
    if (state.compare) add(next, nextDs, base);
    $('stats').innerHTML = parts.join('');
  }

  function renderWindows(base, next, baseDs, nextDs) {
    const hours = +$('win-hours').value;
    const isToday = baseDs === todayStr();
    const cards = [];
    const card = (d, ds, from) => {
      const name = dayName(ds);
      if (!d) return `<div class="win"><div class="win-k">${name}</div><div class="win-v">—</div><div class="win-s">Sense dades</div></div>`;
      const w = cheapestWindow(d.slots, hours, from);
      if (!w) return `<div class="win"><div class="win-k">${name}</div><div class="win-v">—</div><div class="win-s">No queda prou dia</div></div>`;
      const a = slotLabel(w.start), b = w.end >= SLOTS ? '24:00' : slotLabel(w.end);
      return `<div class="win"><div class="win-k">${name}${from ? ' (des d\'ara)' : ''}</div><div class="win-v">${a}–${b}</div><div class="win-s">Mitjana ${fmtU(w.avg)}</div></div>`;
    };
    cards.push(card(base, baseDs, isToday ? currentSlot() : 0));
    if (state.compare) cards.push(card(next, nextDs, 0));
    $('windows').innerHTML = cards.join('');
  }

  function renderTable(base, next, baseDs, nextDs) {
    const showNext = state.compare && next;
    const hb = base ? hourly(base.slots) : new Array(24).fill(null);
    const hn = showNext ? hourly(next.slots) : null;
    const nowH = baseDs === todayStr() ? Math.floor(currentSlot() / 4) : -1;
    let html = `<thead><tr><th>Hora</th><th>${dayName(baseDs)} (${unitLabel()})</th>${hn ? `<th>${dayName(nextDs)}</th><th>Dif.</th>` : ''}</tr></thead><tbody>`;
    for (let h = 0; h < 24; h++) {
      const d = hn && hb[h] != null && hn[h] != null ? hn[h] - hb[h] : null;
      html += `<tr${h === nowH ? ' class="is-now"' : ''}><td>${pad(h)}:00–${pad((h + 1) % 24)}:00</td><td>${fmt(hb[h])}</td>`;
      if (hn) html += `<td>${fmt(hn[h])}</td><td class="${d == null ? '' : d > 0 ? 'up' : 'down'}">${d == null ? '—' : (d > 0 ? '+' : d < 0 ? '−' : '') + fmt(Math.abs(d))}</td>`;
      html += '</tr>';
    }
    $('table').innerHTML = html + '</tbody>';
  }

  // línia vertical "ara"
  const nowLine = {
    id: 'nowLine',
    afterDatasetsDraw(chart, _a, opts) {
      if (opts.index == null) return;
      const x = chart.scales.x.getPixelForValue(opts.index);
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = opts.color; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = opts.color; ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.fillText('ara', x, top - 4);
      ctx.restore();
    },
  };

  function renderChart(base, next, baseDs, nextDs) {
    const res = state.res;
    const n = res === 15 ? SLOTS : 24;
    const series = (d) => (d ? (res === 15 ? d.slots : hourly(d.slots)).map((v) => (v == null ? null : conv(v))) : null);
    const a = series(base);
    const b = state.compare ? series(next) : null;
    const labels = Array.from({ length: n }, (_, i) => slotLabel(i, res));
    const isToday = baseDs === todayStr();
    const curIdx = isToday ? (res === 15 ? currentSlot() : Math.floor(currentSlot() / 4)) : null;

    const cToday = css('--today'), cPast = css('--today-past'), cNow = css('--today-now'), cTom = css('--tomorrow');
    const cGrid = css('--grid'), cText = css('--text-secondary'), cMuted = css('--text-muted'), cSurf = css('--surface');

    const datasets = [];
    if (a) datasets.push({
      type: 'bar', label: dayName(baseDs), data: a, order: 2,
      backgroundColor: a.map((_, i) => (curIdx == null ? cToday : i < curIdx ? cPast : i === curIdx ? cNow : cToday)),
      borderRadius: { topLeft: res === 15 ? 2 : 4, topRight: res === 15 ? 2 : 4 }, borderSkipped: 'start',
      categoryPercentage: 1, barPercentage: res === 15 ? 0.82 : 0.86,
    });
    if (b) datasets.push({
      type: 'line', label: dayName(nextDs), data: b, order: 1,
      borderColor: cTom, backgroundColor: cTom, borderWidth: 2, stepped: 'middle',
      pointRadius: 0, pointHoverRadius: 4, pointHoverBorderColor: cSurf, pointHoverBorderWidth: 2, spanGaps: false,
    });

    // llegenda HTML (només si hi ha 2 sèries)
    const lg = $('legend');
    lg.innerHTML = datasets.length > 1
      ? `<span><i class="sw" style="background:${cToday}"></i>${dayName(baseDs)} · barres</span><span><i class="sw line" style="background:${cTom}"></i>${dayName(nextDs)} · línia</span>`
      : '';

    const unit = unitLabel();
    const dec = state.unit === 'kwh' ? 4 : 2;
    const cfg = {
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 16 } },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          nowLine: { index: curIdx, color: cText },
          tooltip: {
            callbacks: {
              title: (items) => slotRange(items[0].dataIndex, res),
              label: (it) => ` ${it.dataset.label}: ${it.raw == null ? '—' : nf(dec, dec).format(it.raw)} ${unit}`,
              afterBody: (items) => {
                if (items.length < 2 || items[0].raw == null || items[1].raw == null) return '';
                const d = items[1].raw - items[0].raw;
                return ` Diferència: ${d > 0 ? '+' : d < 0 ? '−' : ''}${nf(dec, dec).format(Math.abs(d))} ${unit}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false }, border: { color: cGrid },
            ticks: {
              color: cMuted, maxRotation: 0, autoSkip: false, font: { size: 11 },
              callback(v, i) {
                const every = (this.chart.width < 520 ? 6 : 3) * (res === 15 ? 4 : 1); // cada 6 h al mòbil, 3 h a l'escriptori
                return i % every === 0 ? labels[i] : '';
              },
            },
          },
          y: {
            beginAtZero: true, grid: { color: cGrid }, border: { display: false },
            ticks: { color: cMuted, font: { size: 11 }, callback: (v) => nf(0, state.unit === 'kwh' ? 3 : 0).format(v) },
            title: { display: true, text: unit, color: cMuted, font: { size: 11 } },
          },
        },
      },
      plugins: [nowLine],
    };
    if (state.chart) state.chart.destroy();
    state.chart = new Chart($('chart'), cfg);
    $('chart').setAttribute('aria-label', `Preu SPOT ${dayName(baseDs)}${b ? ' i ' + dayName(nextDs) : ''}, cada ${res} minuts`);
  }

  function renderNav(baseDs, next, nextDs) {
    const t = todayStr();
    const name = dayName(baseDs);
    const full = dayFmt.format(dsToUTC(baseDs));
    $('chart-title').textContent = ['Avui', 'Demà', 'Ahir'].includes(name) ? `${name} · ${full}` : full.charAt(0).toUpperCase() + full.slice(1);
    $('date-pick').value = baseDs;
    $('date-pick').max = addDays(t, 1);
    $('go-today').hidden = baseDs === t;
    $('next-day').disabled = baseDs >= addDays(t, 1);
    $('compare-label').textContent = `Compara amb ${dayName(nextDs).toLowerCase()}`;
    const note = $('compare-note');
    if (state.compare && !next) {
      note.hidden = false;
      note.textContent = nextDs === addDays(t, 1)
        ? 'Els preus de demà encara no s\'han publicat. OMIE els publica cap a les 13:00; la pàgina ho torna a mirar cada 5 minuts.'
        : `No hi ha dades per a ${dayName(nextDs).toLowerCase()}.`;
    } else note.hidden = true;
  }

  function renderFooter() {
    const t = todayStr();
    const used = [state.days.get(state.base), state.days.get(addDays(state.base, 1)), state.days.get(t)].filter(Boolean);
    const srcs = [...new Set(used.map((d) => d.source))];
    const now = new Date();
    $('source-line').textContent = srcs.length
      ? `Font: ${srcs.join(' + ')} · darrera comprovació ${pad(mParts(now).h)}:${pad(mParts(now).m)} (hora peninsular)`
      : 'No s\'han pogut obtenir dades d\'OMIE ni de REE. Torna-ho a provar d\'aquí a una estona.';
    $('source-line').classList.toggle('err', !srcs.length);
  }

  async function render() {
    const baseDs = state.base, nextDs = addDays(baseDs, 1);
    const t = todayStr();
    const [base, next, today] = await Promise.all([getDay(baseDs), getDay(nextDs), getDay(t)]);
    renderHero(today);
    renderNav(baseDs, next, nextDs);
    renderStats(base, next, baseDs, nextDs);
    renderChart(base, next, baseDs, nextDs);
    renderWindows(base, next, baseDs, nextDs);
    renderTable(base, next, baseDs, nextDs);
    renderFooter();
  }

  // ---------- refresc ----------
  let lastDay = todayStr(), lastSlot = currentSlot(), lastPoll = 0;
  async function tick() {
    const t = todayStr();
    if (t !== lastDay) { // canvi de dia
      if (state.base === lastDay) state.base = t;
      lastDay = t;
      await render();
      return;
    }
    const tom = addDays(t, 1);
    const { h } = mParts(new Date());
    if (!state.days.get(tom) && h >= 12 && Date.now() - lastPoll > POLL_TOMORROW_MS) {
      lastPoll = Date.now();
      const d = await getDay(tom, { force: true });
      if (d) { await render(); return; }
    }
    const s = currentSlot();
    if (s !== lastSlot) { lastSlot = s; await render(); }
  }

  // ---------- controls ----------
  function setPressed(sel, attr, val) {
    document.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === String(val))));
  }
  document.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => {
    state.unit = b.dataset.unit; save('unit', state.unit); setPressed('[data-unit]', 'unit', state.unit); render();
  }));
  document.querySelectorAll('[data-res]').forEach((b) => b.addEventListener('click', () => {
    state.res = +b.dataset.res; save('res', state.res); setPressed('[data-res]', 'res', state.res); render();
  }));
  $('compare').addEventListener('change', (e) => { state.compare = e.target.checked; save('compare', state.compare ? '1' : '0'); render(); });
  $('win-hours').addEventListener('change', () => render());
  $('prev-day').addEventListener('click', () => { state.base = addDays(state.base, -1); render(); });
  $('next-day').addEventListener('click', () => { state.base = addDays(state.base, 1); render(); });
  $('go-today').addEventListener('click', () => { state.base = todayStr(); render(); });
  $('date-pick').addEventListener('change', (e) => { if (e.target.value) { state.base = e.target.value; render(); } });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => render());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  setPressed('[data-unit]', 'unit', state.unit);
  setPressed('[data-res]', 'res', state.res);
  $('compare').checked = state.compare;

  render();
  setInterval(tick, TICK_MS);
})();
