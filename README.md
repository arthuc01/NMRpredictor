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
- CSV export and NEF export from the predictor
- Lightweight local HTTP API for CSV spectrum export from SMILES input
- Lightweight Node smoke tests for the predictor heuristics

## Run locally

Open `index.html` directly in a browser, or serve the repository with any static file server.

## API

The repository includes a small Node HTTP API that returns CSV output directly from the same predictor logic used by the browser UI.

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
```

Health check:

```bash
curl "http://localhost:3000/health"
```

Notes:

- The API returns `text/csv` with a download filename in the `Content-Disposition` header.
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
