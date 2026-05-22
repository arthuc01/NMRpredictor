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
- Lightweight Node smoke tests for the predictor heuristics

## Run locally

Open `index.html` directly in a browser, or serve the repository with any static file server.

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
