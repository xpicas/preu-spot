# Preu SPOT de la llum

Web estàtica per consultar el **preu majorista SPOT** (preu marginal del mercat diari d'OMIE, zona Espanya), cada 15 minuts:

- Preu del quart d'hora actual, el següent i la mitjana de l'hora.
- Gràfica del dia (15 min o mitjana horària) amb el dia següent superposat quan ja s'ha publicat (≈13:00).
- Mitjana, mínim i màxim de cada dia, franja contínua més barata (1–8 h) i taula hora a hora.
- Navegació per dies anteriors, unitats €/MWh o €/kWh, mode fosc automàtic.

No és el PVPC: no inclou peatges, càrrecs, ajust ni impostos.

## Com obté les dades

1. **`data/AAAA-MM-DD.json`** – els genera un workflow de GitHub Actions (`scripts/fetch_omie.py`) baixant el fitxer oficial `marginalpdbc` d'OMIE. S'executa cada 10 min entre les 10:00 i les 13:59 UTC (quan OMIE publica el dia següent) i un cop més a la nit. Si OMIE falla, prova l'API de REE.
2. **API pública de REE** (`apidatos.ree.es`, sèrie 600 «Precio mercado spot»), consultada directament pel navegador si el fitxer local no existeix. Admet CORS i no necessita token.

La web funciona encara que el workflow no s'executi: llavors tira només de REE.

## Posada en marxa (GitHub Pages)

1. Crea un repositori **públic** a GitHub (p. ex. `preu-spot`). Pages gratuït requereix repositori públic.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.** Fes-ho abans del primer push.
3. Puja el contingut d'aquesta carpeta (inclosa la carpeta oculta `.github/`):
   ```bash
   cd preu-spot
   git init -b main
   git add .
   git commit -m "Web preu SPOT"
   git remote add origin https://github.com/<usuari>/preu-spot.git
   git push -u origin main
   ```
   Si ho puges arrossegant fitxers a la web de GitHub, comprova que `.github/workflows/update.yml` hi és (el Finder amaga les carpetes que comencen per punt).
4. A **Actions** veuràs «Actualitza preus i publica». El push ja el llança; si falla perquè Pages encara no estava activat, torna'l a executar amb *Run workflow*.
5. La web queda a `https://<usuari>.github.io/preu-spot/`. Al mòbil: *Afegeix a la pantalla d'inici*.

## Manteniment

- GitHub desactiva els workflows programats d'un repositori públic després de 60 dies sense activitat. Els commits diaris de dades haurien de mantenir-lo actiu; si mai es desactiva, reactiva'l a **Actions**.
- Les hores de cron de GitHub no són exactes (poden anar uns minuts tard). Mentrestant la web consulta REE directament.
- Provar el script en local: `python3 scripts/fetch_omie.py 2026-11-08`.

## Fitxers

```
index.html                 pàgina
assets/app.js              lògica (dades, càlculs, gràfica)
assets/style.css           estils (clar/fosc)
assets/chart.umd.min.js    Chart.js 4.6.1 (inclòs, sense CDN)
scripts/fetch_omie.py      descàrrega OMIE -> data/*.json (sense dependències)
.github/workflows/update.yml  programació + desplegament a Pages
data/                      històric de preus en JSON
```
