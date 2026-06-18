const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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

// Builds a fresh VM sandbox on every call rather than caching one. nmr-predictor.js
// declares a module-level mutable `state` object; in a long-running process (the
// Node API server handles one request after another in the same process) a cached,
// shared sandbox would let state from one request leak into the next if any future
// code path the API exercises starts touching `state`. Re-running the ~4000-line
// script costs only a few ms, which is negligible next to a CSV/PPTX request.
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
  return sandbox;
}

module.exports = {
  loadPredictorContext
};
