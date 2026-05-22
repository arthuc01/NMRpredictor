const assert = require("node:assert/strict");
const { generateSpectrumCsv } = require("../api/predictor-service");

function run() {
  const proton = generateSpectrumCsv({ smiles: "CCO", type: "proton" });
  assert.equal(proton.filename, "CCO-1H-spectrum.csv");
  assert.equal(proton.csv.includes("section,nucleus,signal_id"), true, "proton export should include 1D header");
  assert.equal(proton.csv.includes("stick,1H"), true, "proton export should include 1H stick rows");

  const hsqc = generateSpectrumCsv({ smiles: "CCO", type: "hsqc" });
  assert.equal(hsqc.filename, "CCO-HSQC.csv");
  assert.equal(hsqc.csv.startsWith("experiment,peak_id,proton_ppm,carbon_ppm"), true, "HSQC export should include 2D header");

  assert.throws(
    () => generateSpectrumCsv({ smiles: "", type: "proton" }),
    /Missing required 'smiles'/,
    "missing smiles should be rejected"
  );

  assert.throws(
    () => generateSpectrumCsv({ smiles: "CCO", type: "badtype" }),
    /Unsupported spectrum type/,
    "unsupported type should be rejected"
  );

  console.log("nmr-predictor API tests passed");
}

run();
