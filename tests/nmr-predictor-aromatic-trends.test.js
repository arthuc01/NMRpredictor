const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeElement() {
  return {
    textContent: "",
    style: {},
    innerHTML: "",
    value: "",
    classList: { toggle: () => {} },
    addEventListener: () => {},
    querySelectorAll: () => [],
    insertAdjacentHTML: () => {},
    getBoundingClientRect: () => ({ left: 0, width: 1, top: 0, height: 1 }),
    removeAllListeners: () => {},
    on: () => {}
  };
}

function loadPredictorContext() {
  const elementCache = new Map();
  const documentStub = {
    getElementById(id) {
      if (!elementCache.has(id)) {
        elementCache.set(id, makeElement());
      }
      return elementCache.get(id);
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return {
        href: "",
        download: "",
        click: () => {},
        parentNode: null
      };
    },
    body: {
      appendChild: () => {},
      removeChild: () => {}
    }
  };

  const sandbox = {
    console,
    document: documentStub,
    window: {
      addEventListener: () => {},
      setTimeout: () => {}
    },
    URL: {
      createObjectURL: () => "blob:test",
      revokeObjectURL: () => {}
    },
    Blob: function Blob() {}
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const predictorPath = path.resolve(__dirname, "..", "nmr-predictor.js");
  const source = fs.readFileSync(predictorPath, "utf8");
  vm.runInContext(source, sandbox, { filename: predictorPath });
  return sandbox;
}

function aromaticProtonPpms(predictEnvironments, parseSmiles, smiles) {
  const predictions = predictEnvironments(parseSmiles(smiles));
  return predictions.proton
    .filter((signal) => signal.label.includes("aromatic C-H"))
    .map((signal) => signal.ppm)
    .sort((a, b) => a - b);
}

function run() {
  const { parseSmiles, predictEnvironments } = loadPredictorContext();

  const benzene = aromaticProtonPpms(predictEnvironments, parseSmiles, "c1ccccc1");
  const chlorobenzene = aromaticProtonPpms(predictEnvironments, parseSmiles, "c1ccccc1Cl");
  const anisole = aromaticProtonPpms(predictEnvironments, parseSmiles, "COc1ccccc1");
  const nitrobenzene = aromaticProtonPpms(predictEnvironments, parseSmiles, "O=[N+]([O-])c1ccccc1");

  assert.equal(benzene.length > 0, true, "benzene aromatic proton signals expected");
  assert.equal(chlorobenzene.length > 0, true, "chlorobenzene aromatic proton signals expected");
  assert.equal(anisole.length > 0, true, "anisole aromatic proton signals expected");
  assert.equal(nitrobenzene.length > 0, true, "nitrobenzene aromatic proton signals expected");

  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanBenzene = mean(benzene);
  const meanChloro = mean(chlorobenzene);
  const meanAnisole = mean(anisole);
  const meanNitro = mean(nitrobenzene);

  // Directionality checks for substituent trends.
  assert.equal(meanNitro > meanBenzene + 0.25, true, "nitrobenzene should be notably downfield vs benzene");
  assert.equal(meanChloro > meanBenzene + 0.05, true, "chlorobenzene should be slightly downfield vs benzene");
  assert.equal(meanAnisole < meanBenzene - 0.10, true, "anisole should be upfield vs benzene");

  // Nitro should create at least one strongly downfield aromatic signal.
  assert.equal(Math.max(...nitrobenzene) > 8.0, true, "nitrobenzene should have aromatic proton(s) above 8 ppm");

  console.log("nmr-predictor aromatic trend tests passed");
}

run();
