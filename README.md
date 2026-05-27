# NMRpredictor

Static NMR teaching tools for GitHub Pages.

## Included pages

- `index.html`: SMILES-based NMR predictor with approximate 1H, 13C, HSQC, COSY, and NOESY views
- `multiplet.html`: scalar-coupling multiplet modeller and splitting tree visualizer
- `notes.html`: documentation of the heuristic prediction model

## Features

- Browser-only deployment with no backend
- JSME structure editor integration
- RDKit.js structure rendering when available
- Plotly-based interactive 1D and 2D spectra
- 3Dmol.js structure viewer for NOESY distance visualization
- CSV export, PPTX export, and NEF export from the predictor
- Lightweight local HTTP API for CSV spectrum export from SMILES input
- Lightweight local HTTP API for PPTX deck export from SMILES input
- Lightweight Node smoke tests for the predictor heuristics

## Run locally

Open `index.html` directly in a browser, or serve the repository with any static file server.

## API

The repository exposes browser-side and Node-side export routes for both CSV and PPTX generation.

- GitHub Pages query-parameter exports
- local Node HTTP endpoints

### GitHub Pages browser export

GitHub Pages cannot run the Node server in this repo, but it can still trigger prediction and CSV download in the browser.

Pattern:

```text
https://arthuc01.github.io/NMRpredictor/index.html?smiles=<SMILES>&type=<TYPE>&download=csv
```

Example:

```text
https://arthuc01.github.io/NMRpredictor/index.html?smiles=CCO&type=proton&download=csv
```

Supported `type` values:

- `proton`
- `carbon`
- `hsqc`
- `cosy`
- `noesy`

Notes:

- This launches the predictor UI, applies the query parameters client-side, and downloads the active spectrum as CSV.
- It is a browser-side export route, not a raw HTTP CSV endpoint.

PPTX pattern:

```text
https://arthuc01.github.io/NMRpredictor/index.html?smiles=<SMILES>&download=pptx
```

Example:

```text
https://arthuc01.github.io/NMRpredictor/index.html?smiles=CCO&download=pptx
```

The PPTX export produces:

- a first slide with the molecular structure
- one slide per spectrum
- white-background, black-text spectrum graphics suitable for printing
- proton zoom panels for informative non-singlet regions where available

### Node API

The repository also includes a small Node HTTP API that returns CSV output directly from the same predictor logic used by the browser UI.

Start it with:

```bash
npm run api
```

Default address:

```text
http://localhost:3000
```

Endpoint:

```text
GET /api/spectrum?smiles=<SMILES>&type=<TYPE>
```

PPTX endpoint:

```text
GET /api/presentation?smiles=<SMILES>
```

Supported `type` values:

- `proton`
- `carbon`
- `hsqc`
- `cosy`
- `noesy`

Examples:

```bash
curl "http://localhost:3000/api/spectrum?smiles=CCO&type=proton" -o ethanol-1h.csv
curl "http://localhost:3000/api/spectrum?smiles=CCO&type=hsqc" -o ethanol-hsqc.csv
curl "http://localhost:3000/api/presentation?smiles=CCO" -o ethanol-nmr-slides.pptx
```

Health check:

```bash
curl "http://localhost:3000/health"
```

Notes:

- The API returns `text/csv` with a download filename in the `Content-Disposition` header.
- The PPTX endpoint returns `application/vnd.openxmlformats-officedocument.presentationml.presentation`.
- GitHub Pages can host the front-end pages in this repo, but not the Node API itself.
- To expose the API publicly, deploy `api-server.js` on any Node-capable host.

## Tests

```bash
npm test
```

Individual suites:

```bash
node tests/nmr-predictor-smoke.test.js
node tests/nmr-predictor-aromatic-trends.test.js
node tests/nmr-predictor-parser-edgecases.test.js
```
