const assert = require("node:assert/strict");
const { loadPredictorContext } = require("../lib/load-predictor-context");

function alphaAminePpms(predictEnvironments, parseSmiles, smiles) {
  const predictions = predictEnvironments(parseSmiles(smiles));
  return predictions.proton
    .filter((signal) => signal.label.includes("alpha to") && signal.label.includes("amine N"))
    .map((signal) => signal.ppm);
}

function run() {
  const {
    parseSmiles,
    predictEnvironments,
    gammaSubstituentCorrectionC,
    computeDistanceMatrix,
    computeAromaticRingGeometries,
    ringCurrentCorrection
  } = loadPredictorContext();

  // --- Amine N-substitution differentiation ---
  const [primaryAlphaH] = alphaAminePpms(predictEnvironments, parseSmiles, "CCN");
  const [secondaryAlphaH] = alphaAminePpms(predictEnvironments, parseSmiles, "CCNCC");
  const [tertiaryAlphaH] = alphaAminePpms(predictEnvironments, parseSmiles, "CCN(CC)CC");
  assert.equal(typeof primaryAlphaH, "number", "ethylamine should produce an alpha-to-amine-N proton signal");
  assert.equal(
    primaryAlphaH > secondaryAlphaH && secondaryAlphaH > tertiaryAlphaH,
    true,
    "alpha-to-amine-N proton shift should decrease as N-substitution increases (primary > secondary > tertiary)"
  );

  const primaryCarbon = predictEnvironments(parseSmiles("CCN")).carbon
    .find((signal) => signal.label.includes("amine N"));
  const tertiaryCarbon = predictEnvironments(parseSmiles("CCN(CC)CC")).carbon
    .find((signal) => signal.label.includes("amine N"));
  assert.equal(
    tertiaryCarbon.ppm > primaryCarbon.ppm,
    true,
    "amine alpha-carbon 13C shift should increase as N-substitution increases (opposite trend to 1H)"
  );

  // --- Solvent selector ---
  const aceticAcidCdcl3 = predictEnvironments(parseSmiles("CC(=O)O"), null, "cdcl3");
  const aceticAcidDmso = predictEnvironments(parseSmiles("CC(=O)O"), null, "dmso");
  const aceticAcidD2o = predictEnvironments(parseSmiles("CC(=O)O"), null, "d2o");
  assert.equal(aceticAcidCdcl3.proton.length, 2, "acetic acid in CDCl3 should show CH3 and acid OH");
  assert.equal(aceticAcidD2o.proton.length, 1, "acetic acid in D2O should hide the exchangeable acid OH");
  const cdcl3Oh = aceticAcidCdcl3.proton.find((signal) => signal.label.includes("acid OH"));
  const dmsoOh = aceticAcidDmso.proton.find((signal) => signal.label.includes("acid OH"));
  assert.equal(
    dmsoOh.ppm > cdcl3Oh.ppm,
    true,
    "carboxylic acid OH should appear further downfield in DMSO-d6 than in CDCl3"
  );

  // --- 13C branching / gamma-effect correction ---
  const pentaneCarbon = predictEnvironments(parseSmiles("CCCCC")).carbon;
  assert.equal(pentaneCarbon.length, 3, "n-pentane should produce 3 unique carbon environments by symmetry");

  // Unit-test the gamma correction directly: C1 in pentane (CCCCC, atom ids 0-4)
  // has a carbon three bonds away (C4) and should get a nonzero upfield correction;
  // ethane's two carbons are only one bond apart, so no gamma correction applies.
  const pentaneGraph = parseSmiles("CCCCC");
  const pentaneDistances = computeDistanceMatrix(pentaneGraph);
  const pentaneGamma = gammaSubstituentCorrectionC(pentaneGraph, pentaneGraph.atoms[0], pentaneDistances);
  assert.equal(pentaneGamma < 0, true, "a carbon with a gamma (3-bond) carbon partner should get a negative (upfield) correction");

  const ethaneGraph = parseSmiles("CC");
  const ethaneDistances = computeDistanceMatrix(ethaneGraph);
  const ethaneGamma = gammaSubstituentCorrectionC(ethaneGraph, ethaneGraph.atoms[0], ethaneDistances);
  assert.equal(ethaneGamma, 0, "a carbon with no gamma (3-bond) carbon partner should get no correction");

  // --- Diastereotopic CH2 labeling ---
  const stereocenterAdjacent = predictEnvironments(parseSmiles("CCC(Cl)CO")).proton;
  const diastereotopicSignals = stereocenterAdjacent.filter((signal) => signal.label.includes("diastereotopic"));
  assert.equal(diastereotopicSignals.length >= 1, true, "CH2 groups adjacent to a likely stereocenter should be flagged diastereotopic");
  const terminalMethyl = stereocenterAdjacent.find((signal) => signal.label.includes("alkyl sp3") && !signal.label.includes("diastereotopic"));
  assert.equal(Boolean(terminalMethyl), true, "the remote terminal methyl should not be flagged diastereotopic");

  const ethanolSignals = predictEnvironments(parseSmiles("CCO")).proton;
  assert.equal(
    ethanolSignals.some((signal) => signal.label.includes("diastereotopic")),
    false,
    "ethanol has no stereocenter, so its CH3/CH2 should not be flagged diastereotopic"
  );

  // --- Ring-current correction is opt-in only when real 3D coordinates are supplied ---
  assert.equal(
    predictEnvironments(parseSmiles("c1ccccc1")).proton.every((signal) => !signal.label.includes("ring current")),
    true,
    "ring-current correction should not fire without supplied 3D coordinates"
  );

  // Direct geometry test: a chain carbon folded directly above an aromatic
  // ring face, 4 bonds away topologically, should pick up a shielding
  // (negative ppm) through-space ring-current term.
  const foldedGraph = parseSmiles("c1ccccc1CCCC");
  const foldedDistances = computeDistanceMatrix(foldedGraph);
  const ringAtoms = foldedGraph.atoms.filter((atom) => atom.aromatic);
  const remoteAtom = foldedGraph.atoms[9];
  assert.equal(remoteAtom.element, "C", "atom 9 should be the terminal chain carbon");
  assert.equal(foldedDistances[remoteAtom.id][ringAtoms[0].id] > 3, true, "the chosen remote atom should be more than 3 bonds from the ring");

  const coordinates = foldedGraph.atoms.map(() => ({ x: 0, y: 0, z: 0 }));
  ringAtoms.forEach((atom, index) => {
    const angle = (index / ringAtoms.length) * 2 * Math.PI;
    coordinates[atom.id] = { x: 1.4 * Math.cos(angle), y: 1.4 * Math.sin(angle), z: 0 };
  });
  coordinates[remoteAtom.id] = { x: 0, y: 0, z: 3.2 };

  const aromaticRings = computeAromaticRingGeometries(foldedGraph, coordinates);
  assert.equal(aromaticRings.length, 1, "one aromatic ring geometry should be reconstructed from coordinates");
  const foldedContext = { distances: foldedDistances, aromaticRings, ringCoordinates: coordinates };
  const remoteCorrection = ringCurrentCorrection(foldedGraph, remoteAtom, foldedContext);
  assert.equal(remoteCorrection.ppm < 0, true, "an atom folded directly above a ring face should be shielded (negative ppm)");

  const ringAtomCorrection = ringCurrentCorrection(foldedGraph, ringAtoms[0], foldedContext);
  assert.equal(ringAtomCorrection.ppm, 0, "the ring's own atoms should not apply a ring-current correction to themselves");

  console.log("nmr-predictor heuristics v2 tests passed");
}

run();
