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
  const { parseSmiles } = loadPredictorContext();

  // Dot-disconnected species should parse instead of throwing.
  const saltLike = parseSmiles("CC(=O)O.[Na+]");
  assert.equal(saltLike.atoms.length >= 5, true, "dot-disconnected species should parse");

  // Bracket isotope and charge metadata should be retained.
  const isotopic = parseSmiles("[13CH4]");
  assert.equal(isotopic.atoms.length, 1, "single bracket isotope atom expected");
  assert.equal(isotopic.atoms[0].isotope, 13, "isotope should be parsed");
  assert.equal(isotopic.atoms[0].formalCharge, 0, "neutral isotope atom should have charge 0");

  const ammonium = parseSmiles("[NH4+]");
  assert.equal(ammonium.atoms.length, 1, "single ammonium atom expected");
  assert.equal(ammonium.atoms[0].formalCharge, 1, "ammonium charge should be +1");
  assert.equal(ammonium.atoms[0].hydrogens, 4, "explicit ammonium hydrogens should be retained");

  const oxide = parseSmiles("[O-]");
  assert.equal(oxide.atoms.length, 1, "single oxide atom expected");
  assert.equal(oxide.atoms[0].formalCharge, -1, "oxide charge should be -1");

  // Selenium/tellurium tokens should parse in plain and bracket forms.
  const selane = parseSmiles("C[Se]C");
  assert.equal(selane.atoms.some((atom) => atom.element === "Se"), true, "selenium token should parse");
  const tellane = parseSmiles("C[Te]C");
  assert.equal(tellane.atoms.some((atom) => atom.element === "Te"), true, "tellurium token should parse");

  // Two-digit ring closure labels should parse and close correctly.
  const macro = parseSmiles("C%10CCCCCCCCCC%10");
  assert.equal(macro.atoms.length, 11, "macrocycle should contain expected atom count");
  assert.equal(macro.bonds.length, 11, "macrocycle should close with final %10 bond");

  console.log("nmr-predictor parser edge-case tests passed");
}

run();
