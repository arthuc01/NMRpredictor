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

function run() {
  const ctx = loadPredictorContext();
  const {
    parseSmiles,
    predictEnvironments,
    predictHsqc,
    predictCosy,
    predictNoesy
  } = ctx;

  assert.equal(typeof parseSmiles, "function", "parseSmiles should be defined");
  assert.equal(typeof predictEnvironments, "function", "predictEnvironments should be defined");

  const benzene = parseSmiles("C1=CC=CC=C1");
  assert.equal(benzene.atoms.filter((atom) => atom.aromatic).length, 6, "benzene should be fully aromatic");

  const pyridine = parseSmiles("C1=CC=NC=C1");
  assert.equal(pyridine.atoms.filter((atom) => atom.aromatic).length, 6, "pyridine ring should be aromatic");
  assert.equal(
    pyridine.atoms.some((atom) => atom.element === "N" && atom.aromatic),
    true,
    "pyridine should include aromatic nitrogen"
  );

  const furan = parseSmiles("C1=COC=C1");
  assert.equal(furan.atoms.filter((atom) => atom.aromatic).length, 5, "furan ring should be aromatic");
  assert.equal(
    furan.atoms.some((atom) => atom.element === "O" && atom.aromatic),
    true,
    "furan should include aromatic oxygen"
  );

  const disconnected = parseSmiles("CCO.O");
  assert.equal(disconnected.atoms.length >= 4, true, "dot-disconnected SMILES should parse");

  const ethanolPred = predictEnvironments(parseSmiles("CCO"));
  assert.equal(ethanolPred.proton.length, 3, "ethanol should produce 3 proton environments (CH3, CH2, OH)");
  assert.equal(ethanolPred.carbon.length, 2, "ethanol should produce 2 carbon environments");
  const ethanolGraph = parseSmiles("CCO");
  const ethanolHsqc = predictHsqc(ethanolGraph, ethanolPred.proton, ethanolPred.carbon);
  const ethanolCosy = predictCosy(ethanolGraph, ethanolPred.proton);
  const ethanolNoesy = predictNoesy(ethanolGraph, ethanolPred.proton, "CCO");
  assert.equal(ethanolHsqc.length, 2, "ethanol HSQC should include CH3 and CH2 only (no OH)");
  assert.equal(
    ethanolHsqc.some((peak) => peak.protonAtomIds.some((atomId) => {
      const atom = ethanolGraph.atoms[atomId - 1];
      return atom?.element === "O";
    })),
    false,
    "ethanol HSQC should exclude exchangeable OH carriers"
  );
  assert.equal(
    ethanolCosy.some((peak) => !peak.diagonal),
    true,
    "ethanol COSY should include at least one off-diagonal coupling (CH3->CH2)"
  );
  assert.equal(
    ethanolNoesy.some((peak) => !peak.diagonal),
    true,
    "ethanol NOESY should include at least one off-diagonal coupling"
  );
  assert.equal(
    ethanolNoesy.some((peak) => peak.atomIdsA.some((atomId) => ethanolGraph.atoms[atomId - 1]?.element === "O")),
    false,
    "ethanol NOESY should exclude exchangeable OH carrier peaks"
  );

  const chloroformPred = predictEnvironments(parseSmiles("C(Cl)(Cl)Cl"));
  assert.equal(chloroformPred.proton.length, 1, "chloroform should produce 1 proton environment");
  const chcl3ppm = chloroformPred.proton[0].ppm;
  assert.equal(chcl3ppm > 3 && chcl3ppm < 8, true, "chloroform CH should be downfield");

  console.log("nmr-predictor smoke tests passed");
}

run();
