# Preu SPOT de la llum

Web estàtica per consultar el **preu majorista SPOT** de l'electricitat a Espanya (preu marginal del mercat diari d'OMIE), cada 15 minuts, en €/kWh. No és el PVPC.

## Què mostra

- **Preu actual** del quart d'hora en curs, pintat amb el mateix color que la seva barra, i la diferència respecte a la mitjana del dia.
- **Gràfica del dia** (cada 15 min o mitjana horària) amb barres en degradat **absolut** verd → groc → vermell. El dia següent apareix superposat com una línia blava quan OMIE el publica (cap a les 13:00). En passar per sobre d'una barra només surten el preu d'aquell dia i el de demà.
- **Navegació per dies** (fletxes o selector de data) i mode fosc automàtic.
- **Dos modes de preu**, amb el selector de dalt:
  - **SPOT**: preu de mercat pur.
  - **Amb peatges i impostos**: `(SPOT × (1 + pèrdues) + altres costos + peatges i càrrecs del període) × (1 + IEE) × (1 + IVA)`.

### Escala de color de les barres (€/kWh)

Fixa per a tots els dies; es canvia a `COLOR_SCALE` (`assets/app.js`).

| Mode | Verd | Groc | Vermell |
|---|---|---|---|
| SPOT | ≤ 0,00 | 0,10 | ≥ 0,20 |
| Amb peatges i impostos | ≤ 0,05 | 0,20 | ≥ 0,35 |

### Paràmetres del mode «Amb peatges i impostos»

Valors per defecte (tarifa **2.0TD**, ≤ 15 kW, península), editables al panell «Paràmetres» de la pàgina. El navegador recorda els canvis; el botó «Restaura els valors 2026» els torna als de `DEFAULTS` (`assets/app.js`).

| Concepte | Valor 2026 | Font |
|---|---|---|
| Peatges + càrrecs P1 (punta) | 0,097553 €/kWh (0,033261 + 0,064292) | Resolució CNMC 18/12/2025 + Ordre TED/1524/2025 |
| Peatges + càrrecs P2 (pla) | 0,029267 €/kWh (0,016409 + 0,012858) | ídem |
| Peatges + càrrecs P3 (vall) | 0,003292 €/kWh (0,000077 + 0,003215) | ídem |
| Impost especial sobre l'electricitat | 5,11269632 % | |
| IVA | 21 % | |
| Pèrdues / altres costos | 0 (sense calibrar) | vegeu «Comparació amb la factura» |

**Períodes 2.0TD:** P1 de 10 a 14 h i de 18 a 22 h; P2 de 8 a 10 h, de 14 a 18 h i de 22 a 24 h; P3 de 0 a 8 h. Caps de setmana i festius nacionals de data fixa (1/1, 6/1, 1/5, 15/8, 12/10, 1/11, 6/12, 8/12, 25/12) són P3 tot el dia. Els festius autonòmics i locals (11/9, 24/6, 26/12…) no compten.

No s'hi inclouen el terme de potència ni les quotes fixes (quota de la comercialitzadora, bo social, lloguer del comptador), perquè no depenen de l'hora.

## Comparació amb la factura (Chippio, 9/9–12/10/2026)

- **Coincideixen:** peatges d'energia (2,41 €), càrrecs d'energia (3,80 €), terme de potència (es cobra a cost), base i tipus de l'IEE (5,112696 % sobre potència + energia + bo social) i IVA (21 % sobre tot).
- **No coincideix el cost de l'energia.** Descomptant peatges i càrrecs, la factura cobra (sense impostos) 0,2388 €/kWh en P1, 0,1511 en P2 i 0,1844 en P3 (mitjana 0,1859). Això és SPOT + pèrdues de xarxa + costos del sistema (ajust, capacitat, operadors…), que a la web estan a 0. Per això la web dona un preu una mica inferior al real.
- **Atenció:** els preus per kWh de la factura són **sense impostos**; els del mode «Amb peatges i impostos» els inclouen (×1,2719).
- **Pendent:** calibrar `loss` i `adj` amb el consum horari del període (CSV d'e-distribución) i els preus SPOT d'aquelles dates.

## D'on surten les dades

1. **`data/AAAA-MM-DD.json`**: el workflow de GitHub Actions (`scripts/fetch_omie.py`) baixa el fitxer oficial `marginalpdbc` d'OMIE cada 10 min entre les 10:00 i les 13:59 UTC (quan OMIE publica el dia següent) i un cop més a les 21:17 UTC. Si OMIE falla, prova REE. Només desa dies complets (92/96/100 quarts d'hora) i només fa commit si hi ha canvis.
2. **API pública de REE** (`apidatos.ree.es`, sèrie 600 «Precio mercado spot»): la consulta el navegador directament si no hi ha el fitxer local. Admet CORS i no necessita token.

La web funciona encara que el workflow no s'executi: llavors tira només de REE. La pàgina oberta busca els preus de demà cada 5 minuts a partir de les 12:00 i canvia de dia sola a mitjanit. Totes les hores són hora peninsular, sigui on sigui el navegador.

## Posada en marxa (GitHub Pages)

1. Crea un repositori **públic** a GitHub (p. ex. `preu-spot`). Pages gratuït requereix repositori públic.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.** Fes-ho abans de pujar res.
3. Puja els fitxers:
   - **Amb git** (inclou les carpetes ocultes):
     ```bash
     cd preu-spot
     git init -b main
     git add .
     git commit -m "Web preu SPOT"
     git remote add origin https://github.com/<usuari>/preu-spot.git
     git push -u origin main
     ```
   - **Arrossegant a la web de GitHub** (*Add file → Upload files*): selecciona el **contingut** de la carpeta (`assets`, `scripts`, `index.html`, `manifest.webmanifest`, `README.md`), no la carpeta en si. GitHub no accepta fitxers ocults per aquesta via: `data/.gitkeep`, `.nojekyll` i `.gitignore` es poden deixar fora (la carpeta `data/` la crea el workflow). El fitxer `.github/workflows/update.yml` sí que cal: crea'l amb *Add file → Create new file*, escrivint `.github/workflows/update.yml` com a nom i enganxant-hi el contingut.
4. A **Actions** veuràs «Actualitza preus i publica». Si la primera execució falla perquè Pages encara no estava activat, torna-la a llançar (*Re-run all jobs* o *Run workflow*).
5. La web queda a `https://<usuari>.github.io/preu-spot/`. Al mòbil: *Afegeix a la pantalla d'inici*.

**Actualitzar la web:** substitueix els fitxers modificats (normalment `index.html`, `assets/app.js` i `assets/style.css`). El workflow publica sol després de cada canvi.

## Allotjament: alternatives

- **GitHub Pages** (recomanat): gratuït, sempre encès i amb la tasca automàtica d'OMIE. Límits molt per sobre de l'ús: 1 GB de web, 100 GB/mes de trànsit. Les dades creixen ~1,5 MB/any.
- **Cloudflare Pages o Netlify**: també gratuïts i permeten arrossegar la carpeta, però no executen la tasca programada; la web dependria només de REE.
- **Servidor propi** (VPS, Raspberry Pi, NAS): servir la carpeta amb qualsevol servidor web (p. ex. Caddy) i programar `scripts/fetch_omie.py` amb cron cada 10 min de 12 a 15 h (hora peninsular) + un cop a la nit. Requereix Python ≥ 3.9, sense dependències.
- **Proves en local (Windows)**: a la carpeta, `python -m http.server 8000` i obrir `http://localhost:8000`. Només funciona mentre l'ordinador està encès.

## Manteniment

- **Cada gener:** revisar peatges (CNMC) i càrrecs (Ministeri) i actualitzar `DEFAULTS` a `assets/app.js`. També si canvien l'IVA o l'IEE (el 2026 l'IVA va ser del 10 % del 22/3 al 31/5).
- **Inactivitat:** en repositoris públics, GitHub desactiva les tasques programades després de 60 dies sense activitat. Els commits diaris de dades haurien d'evitar-ho; si passa, reactiva-la a **Actions** (la web continua funcionant amb REE mentrestant).
- **Versions de les accions:** quan GitHub retiri versions antigues (`actions/checkout`, `configure-pages`, `upload-pages-artifact`, `deploy-pages`), avisa als registres d'execució; cal pujar el número de versió a `update.yml`.
- **Fonts externes:** si REE o OMIE canvien el format o l'adreça, cal adaptar `fromREE` (`assets/app.js`) o `fetch_omie.py`. OMIE va passar de preus horaris a 15 minuts l'1/10/2025; el codi accepta tots dos.
- **Provar el script en local:** `python scripts/fetch_omie.py 2026-11-08`.

## Fitxers

```
index.html                    pàgina
manifest.webmanifest          per afegir-la a la pantalla d'inici
assets/app.js                 lògica: dades, preu final, colors, gràfica
assets/style.css              estils (clar/fosc)
assets/chart.umd.min.js       Chart.js 4.6.1 (inclòs, sense CDN)
assets/icon.svg               icona
scripts/fetch_omie.py         OMIE -> data/*.json (sense dependències)
.github/workflows/update.yml  programació + desplegament a Pages
data/                         històric de preus en JSON (el crea el workflow)
```
