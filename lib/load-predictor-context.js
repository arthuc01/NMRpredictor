const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let cachedContext = null;

function makeElement() {
  return {
    textContent: "",
    style: {},
    innerHTML: "",
    value: "",
    dataset: {},
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
  if (cachedContext) return cachedContext;

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
    addEventListener: () => {},
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
      setTimeout: () => {},
      requestAnimationFrame: (fn) => fn?.()
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
  cachedContext = sandbox;
  return sandbox;
}

module.exports = {
  loadPredictorContext
};
