const assert = require("node:assert/strict");
const { generateSpectrumCsv, generateSpectrumPresentation } = require("../api/predictor-service");

async function run() {
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

  assert.throws(
    () => generateSpectrumCsv({ smiles: "C".repeat(500), type: "proton" }),
    /too long/,
    "overly long smiles should be rejected"
  );

  const pptx = await generateSpectrumPresentation({ smiles: "CCO" });
  assert.equal(pptx.filename, "CCO-nmr-slides.pptx");
  assert.equal(typeof pptx.slideCount, "number");
  assert.equal(pptx.slideCount >= 6, true, "presentation should include structure and spectra slides");
  assert.equal(Buffer.isBuffer(pptx.data), true, "presentation should be returned as a Node buffer");
  assert.equal(pptx.data.length > 5000, true, "presentation buffer should not be empty");

  console.log("nmr-predictor API tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
