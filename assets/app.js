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
    mode: load('mode', 'spot'), // 'spot' | 'final'
    cfg: null, // es carrega després de definir DEFAULTS
    res: +load('res', '15'),
    compare: load('compare', '1') === '1',
    base: todayStr(),
    days: new Map(), // ds -> {slots:[96], source, updated} | null
    chart: null,
  };
  function load(k, def) { try { return localStorage.getItem('spot.' + k) ?? def; } catch { return def; } }
  function save(k, v) { try { localStorage.setItem('spot.' + k, v); } catch { /* sense emmagatzematge */ } }

  // Tots els valors que es mostren són en €/kWh.
  const nf = (min, max) => new Intl.NumberFormat('ca-ES', { minimumFractionDigits: min, maximumFractionDigits: max });
  const fKWh = nf(4, 4), fPct = nf(0, 0);
  const unitLabel = () => '€/kWh';
  const fmt = (p) => (p == null || Number.isNaN(p) ? '—' : fKWh.format(p));
  const fmtU = (p) => (p == null ? '—' : `${fmt(p)} €/kWh`);

  // ---------- preu final: peatges, càrrecs i impostos (tarifa 2.0TD, península) ----------
  // Peatges: Resolució CNMC 18/12/2025. Càrrecs: Orden TED/1524/2025. Vigents des de l'1/1/2026.
  const DEFAULTS = {
    p1: 0.097553, // 0,033261 peatge + 0,064292 càrrec (punta)
    p2: 0.029267, // 0,016409 + 0,012858 (pla)
    p3: 0.003292, // 0,000077 + 0,003215 (vall)
    loss: 0,      // % de pèrdues aplicat a l'energia (opcional)
    adj: 0,       // €/kWh d'altres costos: serveis d'ajust, capacitat, OS/OM, marge... (opcional)
    iee: 5.11269632, // % Impost especial sobre l'electricitat
    iva: 21,         // % IVA
  };
  function loadCfg() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('spot.cfg') || '{}') }; } catch { return { ...DEFAULTS }; }
  }
  state.cfg = loadCfg();
  const saveCfg = () => save('cfg', JSON.stringify(state.cfg));
  // Festius nacionals de data fixa i no substituïbles (+ 6 de gener): tot el dia és vall (P3).
  // Els festius autonòmics i locals (11/9, 24/6, 26/12...) NO compten.
  const HOLIDAYS = ['01-01', '01-06', '05-01', '08-15', '10-12', '11-01', '12-06', '12-08', '12-25'];
  function period(ds, hour) {
    const wd = dsToUTC(ds).getUTCDay();
    if (wd === 0 || wd === 6 || HOLIDAYS.includes(ds.slice(5))) return 3;
    if (hour < 8) return 3;
    if ((hour >= 10 && hour < 14) || (hour >= 18 && hour < 22)) return 1;
    return 2;
  }
  const PNAME = { 1: 'punta', 2: 'pla', 3: 'vall' };

  // Escala de color ABSOLUTA de les barres (€/kWh): verd fins a `green`, groc a `mid`, vermell a partir de `red`.
  // És la mateixa per a tots els dies; només canvia segons el mode, perquè el preu final és més alt que el SPOT.
  const COLOR_SCALE = {
    spot:  { green: 0.00, mid: 0.10, red: 0.20 },
    final: { green: 0.05, mid: 0.20, red: 0.35 },
  };
  const RAMP = ['#0ca30c', '#f2b705', '#d03b3b']; // verd, groc, vermell

  // Converteix un dia en brut (€/MWh) a valors en €/kWh segons el mode.
  function derive(raw, ds) {
    if (!raw) return null;
    const c = state.cfg;
    const spot = raw.slots.map((v) => (v == null ? null : v / 1000));
    const per = spot.map((_, i) => period(ds, Math.floor(i / 4)));
    if (state.mode !== 'final') return { ...raw, slots: spot, spot, per, energy: spot, toll: spot.map(() => 0), tax: spot.map(() => 0) };
    const energy = spot.map((v) => (v == null ? null : v * (1 + c.loss / 100) + c.adj));
    const toll = per.map((p) => c['p' + p]);
    const total = energy.map((e, i) => (e == null ? null : (e + toll[i]) * (1 + c.iee / 100) * (1 + c.iva / 100)));
    const tax = total.map((t, i) => (t == null ? null : t - energy[i] - toll[i]));
    return { ...raw, slots: total, spot, per, energy, toll, tax };
  }

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
      $('now-vs').textContent = '';
      return;
    }
    const p = today.slots[idx];
    const per = today.per[idx];
    $('now-label').textContent = `Ara · ${slotRange(idx)} (${dayFmt.format(dsToUTC(t))})${state.mode === 'final' ? ` · P${per} ${PNAME[per]}` : ''}`;
    $('now-price').textContent = fmt(p);
    const next = idx + 1 < SLOTS ? today.slots[idx + 1] : derive(state.days.get(addDays(t, 1)), addDays(t, 1))?.slots[0];
    $('next-label').textContent = `Següent quart (${slotRange((idx + 1) % SLOTS)})`;
    $('next-price').textContent = fmtU(next);
    const h = Math.floor(idx / 4);
    $('hour-label').textContent = `Mitjana ${pad(h)}:00–${pad((h + 1) % 24)}:00`;
    $('hour-price').textContent = fmtU(mean(today.slots.slice(h * 4, h * 4 + 4)));

    const avg = mean(today.slots);
    if (p != null && avg) {
      const d = ((p - avg) / Math.abs(avg)) * 100;
      $('now-vs').textContent = Math.abs(d) < 0.5
        ? `igual que la mitjana del dia (${fmtU(avg)})`
        : `${d >= 0 ? '+' : '−'}${fPct.format(Math.abs(d))} % vs mitjana del dia (${fmtU(avg)})`;
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
    const pick = (arr) => (res === 15 ? arr : hourly(arr));
    const series = (d) => (d ? pick(d.slots) : null);
    const comps = (d) => (d ? { energy: pick(d.energy), toll: pick(d.toll), tax: pick(d.tax), per: res === 15 ? d.per : d.per.filter((_, i) => i % 4 === 0) } : null);
    const a = series(base);
    const b = state.compare ? series(next) : null;
    const labels = Array.from({ length: n }, (_, i) => slotLabel(i, res));
    const isToday = baseDs === todayStr();
    const curIdx = isToday ? (res === 15 ? currentSlot() : Math.floor(currentSlot() / 4)) : null;

    const cTom = css('--tomorrow'), cNowRing = css('--text-primary');
    const sc = COLOR_SCALE[state.mode === 'final' ? 'final' : 'spot'];
    // Degradat vertical lligat als valors de l'eix Y (no al dia): es recalcula si canvia l'escala o la mida.
    const gradCache = {};
    const ramp = (alpha) => (c) => {
      const { chart } = c;
      const y = chart.scales.y, area = chart.chartArea;
      if (!y || !area) return RAMP[0];
      const key = `${alpha}|${y.min}|${y.max}|${area.top}|${area.bottom}`;
      if (gradCache[key]) return gradCache[key];
      const y0 = y.getPixelForValue(sc.green), y1 = y.getPixelForValue(sc.red);
      const g = chart.ctx.createLinearGradient(0, y0, 0, y1 === y0 ? y0 - 1 : y1);
      const a = (hex) => hex + Math.round(alpha * 255).toString(16).padStart(2, '0');
      g.addColorStop(0, a(RAMP[0]));
      g.addColorStop((sc.mid - sc.green) / (sc.red - sc.green), a(RAMP[1]));
      g.addColorStop(1, a(RAMP[2]));
      return (gradCache[key] = g);
    };
    const full = ramp(1), past = ramp(0.35);
    const f2 = (v) => nf(2, 2).format(v);
    $('scale-note').innerHTML = `<span class="scale-bar" aria-hidden="true"></span> Color segons el preu (escala fixa): verd ≤ ${f2(sc.green)} · groc ${f2(sc.mid)} · vermell ≥ ${f2(sc.red)} €/kWh`;
    const cGrid = css('--grid'), cText = css('--text-secondary'), cMuted = css('--text-muted'), cSurf = css('--surface');

    const datasets = [];
    if (a) datasets.push({
      type: 'bar', label: dayName(baseDs), data: a, order: 2,
      backgroundColor: (c) => (curIdx != null && c.dataIndex < curIdx ? past(c) : full(c)),
      borderColor: cNowRing, borderWidth: a.map((_, i) => (i === curIdx ? 2 : 0)),
      borderRadius: { topLeft: res === 15 ? 2 : 4, topRight: res === 15 ? 2 : 4 }, borderSkipped: 'start',
      categoryPercentage: 1, barPercentage: res === 15 ? 0.82 : 0.86, _c: comps(base),
    });
    if (b) datasets.push({
      type: 'line', label: dayName(nextDs), data: b, order: 1,
      borderColor: cTom, backgroundColor: cTom, borderWidth: 2, stepped: 'middle',
      pointRadius: 0, pointHoverRadius: 4, pointHoverBorderColor: cSurf, pointHoverBorderWidth: 2, spanGaps: false, _c: comps(next),
    });

    // llegenda HTML (només si hi ha 2 sèries)
    const lg = $('legend');
    lg.innerHTML = datasets.length > 1
      ? `<span><i class="sw" style="background:linear-gradient(0deg,${RAMP.join(',')})"></i>${dayName(baseDs)} · barres</span><span><i class="sw line" style="background:${cTom}"></i>${dayName(nextDs)} · línia</span>`
      : '';

    const unit = unitLabel();
    const dec = 4;
    const f4 = (v) => (v == null ? '—' : nf(4, 4).format(v));
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
              afterLabel: (it) => {
                const c = it.dataset._c;
                if (state.mode !== 'final' || !c || it.raw == null) return '';
                const i = it.dataIndex, p = c.per[i];
                return [`    Energia ${f4(c.energy[i])}`, `    Peatges i càrrecs P${p} (${PNAME[p]}) ${f4(c.toll[i])}`, `    Impostos (IEE + IVA) ${f4(c.tax[i])}`];
              },
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
            ticks: { color: cMuted, font: { size: 11 }, callback: (v) => nf(0, 3).format(v) },
            title: { display: true, text: unit, color: cMuted, font: { size: 11 } },
          },
        },
      },
      plugins: [nowLine],
    };
    if (state.chart) state.chart.destroy();
    state.chart = new Chart($('chart'), cfg);
    $('chart').setAttribute('aria-label', `Preu ${state.mode === 'final' ? 'final' : 'SPOT'} ${dayName(baseDs)}${b ? ' i ' + dayName(nextDs) : ''}, cada ${res} minuts`);
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
    const [rb, rn, rt] = await Promise.all([getDay(baseDs), getDay(nextDs), getDay(t)]);
    const base = derive(rb, baseDs), next = derive(rn, nextDs), today = derive(rt, t);
    const fin = state.mode === 'final';
    $('sub').textContent = fin
      ? `SPOT + peatges i càrrecs 2.0TD + IEE ${nf(0, 2).format(state.cfg.iee)} % + IVA ${nf(0, 2).format(state.cfg.iva)} %`
      : 'Mercat diari d\'OMIE · zona Espanya · sense peatges ni impostos';
    $('title').textContent = fin ? 'Preu final de la llum' : 'Preu SPOT de la llum';
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
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    state.mode = b.dataset.mode; save('mode', state.mode); setPressed('[data-mode]', 'mode', state.mode); render();
  }));
  // paràmetres del preu final
  const CFG_KEYS = ['p1', 'p2', 'p3', 'loss', 'adj', 'iee', 'iva'];
  const numFmt = (v) => String(v).replace('.', ',');
  function fillCfg() { CFG_KEYS.forEach((k) => { $('cfg-' + k).value = numFmt(state.cfg[k]); }); }
  CFG_KEYS.forEach((k) => $('cfg-' + k).addEventListener('change', (e) => {
    const v = parseFloat(String(e.target.value).replace(',', '.'));
    if (Number.isFinite(v) && v >= 0) { state.cfg[k] = v; saveCfg(); render(); }
    fillCfg();
  }));
  $('cfg-reset').addEventListener('click', () => { state.cfg = { ...DEFAULTS }; saveCfg(); fillCfg(); render(); });
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

  setPressed('[data-mode]', 'mode', state.mode);
  fillCfg();
  setPressed('[data-res]', 'res', state.res);
  $('compare').checked = state.compare;

  render();
  setInterval(tick, TICK_MS);
})();
