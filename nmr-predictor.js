const NMRP = {
  smiles: document.getElementById("nmrp-smiles-input"),
  predict: document.getElementById("nmrp-predict-button"),
  draw: document.getElementById("nmrp-draw-button"),
  status: document.getElementById("nmrp-status"),
  rdkitSummary: document.getElementById("nmrp-rdkit-summary"),
  protonSummary: document.getElementById("nmrp-proton-summary"),
  carbonSummary: document.getElementById("nmrp-carbon-summary"),
  hsqcSummary: document.getElementById("nmrp-hsqc-summary"),
  cosySummary: document.getElementById("nmrp-cosy-summary"),
  noesySummary: document.getElementById("nmrp-noesy-summary"),
  structure: document.getElementById("nmrp-structure"),
  structure3d: document.getElementById("nmrp-structure-3d"),
  spectrum: document.getElementById("nmrp-spectrum"),
  table: document.getElementById("nmrp-table-body"),
  protonTab: document.getElementById("nmrp-proton-tab"),
  carbonTab: document.getElementById("nmrp-carbon-tab"),
  hsqcTab: document.getElementById("nmrp-hsqc-tab"),
  cosyTab: document.getElementById("nmrp-cosy-tab"),
  noesyTab: document.getElementById("nmrp-noesy-tab"),
  caption: document.getElementById("nmrp-spectrum-caption"),
  fullscreen: document.getElementById("nmrp-fullscreen"),
  downloadCsv: document.getElementById("nmrp-download-csv"),
  downloadNef: document.getElementById("nmrp-download-nef"),
  zoomIn: document.getElementById("nmrp-zoom-in"),
  zoomOut: document.getElementById("nmrp-zoom-out"),
  resetZoom: document.getElementById("nmrp-reset-zoom")
};

const ATOM_RE = /Cl|Br|Se|Te|se|te|[BCNOFPSIbcnops]/;
const HALOGENS = new Set(["F", "Cl", "Br", "I"]);
const DISPLAY_COLORS = {
  proton: "#0d6c74",
  carbon: "#d9730d"
};

const HALIDE_SHIFT_RULES = {
  F: { alphaH: 4.25, alphaC: 82, effectH: 0.30, effectC: 7 },
  Cl: { alphaH: 3.45, alphaC: 47, effectH: 0.22, effectC: 5 },
  Br: { alphaH: 3.30, alphaC: 33, effectH: 0.18, effectC: 4 },
  I: { alphaH: 3.15, alphaC: 15, effectH: 0.12, effectC: 3 }
};

const state = {
  rdkit: null,
  viewer3d: null,
  jsme: null,
  activeSpectrum: "proton",
  selectedSignalId: null,
  selectedSignalIds: [],
  graph: null,
  lastSmiles: "",
  predictionRunId: 0,
  cactus3d: null,
  cactusCache: new Map(),
  predictions: { proton: [], carbon: [], hsqc: [], cosy: [], noesy: [] },
  defaultDomains: {
    proton: { min: 0, max: 12 },
    carbon: { min: 0, max: 220 }
  },
  viewDomains: {
    proton: { min: 0, max: 12 },
    carbon: { min: 0, max: 220 }
  },
  viewDomains2D: {
    hsqc: { x: { min: 0, max: 12 }, y: { min: 0, max: 220 } },
    cosy: { x: { min: 0, max: 12 }, y: { min: 0, max: 12 } },
    noesy: { x: { min: 0, max: 12 }, y: { min: 0, max: 12 } }
  }
};

function setPredictorStatus(message, isError = false) {
  NMRP.status.textContent = message;
  NMRP.status.style.color = isError ? "#a11d37" : "";
}

function sanitizeFilename(value) {
  return String(value || "")
    .replace(/[^a-z0-9-_]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    || "nmr-predictor";
}

function downloadTextCsv(rows, filename) {
  const blob = new Blob([rows], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, filename);
}

function downloadTextFile(text, filename, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mimeType });
  downloadBlob(blob, filename);
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = filename;
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    if (link.parentNode) {
      document.body.removeChild(link);
    }
    URL.revokeObjectURL(objectUrl);
  }
}

function autoDomainForSignals(signals, fallback) {
  const ppmValues = (signals || [])
    .map((signal) => Number(signal.ppm))
    .filter(Number.isFinite);
  if (!ppmValues.length) {
    return { ...fallback };
  }
  const minPpm = Math.min(...ppmValues);
  const maxPpm = Math.max(...ppmValues);
  return {
    min: minPpm < 0 ? Math.floor(minPpm) - 1 : 0,
    max: Math.ceil(maxPpm) + 1
  };
}

function autoDefaultDomains(predictions) {
  return {
    proton: autoDomainForSignals(predictions.proton, state.defaultDomains.proton),
    carbon: autoDomainForSignals(predictions.carbon, state.defaultDomains.carbon)
  };
}

function normalizeElement(token) {
  if (token.length === 1 && token === token.toLowerCase()) {
    return token.toUpperCase();
  }
  if (token === "cl") return "Cl";
  if (token === "br") return "Br";
  if (token === "se") return "Se";
  if (token === "te") return "Te";
  return token;
}

function dedupeSortedNumeric(array) {
  return [...new Set(array)].filter(Number.isFinite).sort((a, b) => a - b);
}

function isAromaticToken(token) {
  return token.length === 1 && token === token.toLowerCase();
}

function parseBracketAtom(content) {
  const isotopeMatch = content.match(/^\d+/);
  const elementMatch = content.match(/Cl|Br|Se|Te|se|te|[BCNOFPSIbcno]/);
  if (!elementMatch) {
    throw new Error(`Unsupported bracket atom [${content}].`);
  }
  const hMatch = content.match(/H(\d*)/);
  const chargeMatch = content.match(/([+-])(\d*)/);
  const charge = chargeMatch
    ? (chargeMatch[1] === "-" ? -1 : 1) * Number(chargeMatch[2] || 1)
    : 0;
  return {
    element: normalizeElement(elementMatch[0]),
    aromatic: isAromaticToken(elementMatch[0]),
    bracketHydrogens: hMatch ? Number(hMatch[1] || 1) : null,
    isotope: isotopeMatch ? Number(isotopeMatch[0]) : null,
    formalCharge: charge
  };
}

function defaultBondOrder(previousAtom, nextAtom, explicitOrder) {
  if (explicitOrder) {
    return explicitOrder;
  }
  if (previousAtom?.aromatic && nextAtom?.aromatic) {
    return 1.5;
  }
  return 1;
}

function parseSmiles(smiles) {
  const atoms = [];
  const bonds = [];
  const branches = [];
  const rings = new Map();
  let current = null;
  let pendingBond = null;
  let pendingStereo = null;

  const addAtom = (atom) => {
    atom.id = atoms.length;
    atom.bonds = [];
    atoms.push(atom);
    if (current !== null) {
      const previous = atoms[current];
      const order = defaultBondOrder(previous, atom, pendingBond);
      const bond = { from: current, to: atom.id, order, stereo: pendingStereo };
      bonds.push(bond);
      previous.bonds.push(bond);
      atom.bonds.push(bond);
    }
    current = atom.id;
    pendingBond = null;
    pendingStereo = null;
  };

  for (let i = 0; i < smiles.length; i += 1) {
    const char = smiles[i];
    if (char === "(") {
      branches.push(current);
      continue;
    }
    if (char === ")") {
      current = branches.pop();
      continue;
    }
    if (char === ".") {
      current = null;
      pendingBond = null;
      pendingStereo = null;
      continue;
    }
    if (char === "=") {
      pendingBond = 2;
      continue;
    }
    if (char === "#") {
      pendingBond = 3;
      continue;
    }
    if (char === "-" || char === "/" || char === "\\") {
      pendingBond = 1;
      pendingStereo = char === "-" ? null : char;
      continue;
    }
    if (char === "%") {
      const ringDigits = smiles.slice(i + 1, i + 3);
      if (!/^\d{2}$/.test(ringDigits)) {
        throw new Error("Invalid two-digit ring closure label.");
      }
      if (current === null) {
        throw new Error("Ring closure appeared before an atom.");
      }
      const ringKey = `%${ringDigits}`;
      if (rings.has(ringKey)) {
        const ring = rings.get(ringKey);
        const atom = atoms[current];
        const previous = atoms[ring.atomId];
        const order = defaultBondOrder(previous, atom, pendingBond || ring.bondOrder);
        const bond = { from: ring.atomId, to: current, order, stereo: pendingStereo || ring.stereo };
        bonds.push(bond);
        previous.bonds.push(bond);
        atom.bonds.push(bond);
        rings.delete(ringKey);
      } else {
        rings.set(ringKey, { atomId: current, bondOrder: pendingBond, stereo: pendingStereo });
      }
      pendingBond = null;
      pendingStereo = null;
      i += 2;
      continue;
    }
    if (/[0-9]/.test(char)) {
      if (current === null) {
        throw new Error("Ring closure appeared before an atom.");
      }
      const ringKey = char;
      if (rings.has(ringKey)) {
        const ring = rings.get(ringKey);
        const atom = atoms[current];
        const previous = atoms[ring.atomId];
        const order = defaultBondOrder(previous, atom, pendingBond || ring.bondOrder);
        const bond = { from: ring.atomId, to: current, order, stereo: pendingStereo || ring.stereo };
        bonds.push(bond);
        previous.bonds.push(bond);
        atom.bonds.push(bond);
        rings.delete(ringKey);
      } else {
        rings.set(ringKey, { atomId: current, bondOrder: pendingBond, stereo: pendingStereo });
      }
      pendingBond = null;
      pendingStereo = null;
      continue;
    }
    if (char === "[") {
      const end = smiles.indexOf("]", i);
      if (end === -1) {
        throw new Error("Unclosed bracket atom.");
      }
      addAtom(parseBracketAtom(smiles.slice(i + 1, end)));
      i = end;
      continue;
    }
    const pair = smiles.slice(i, i + 2);
    const token = ATOM_RE.test(pair) && ["Cl", "Br", "Se", "Te", "se", "te"].includes(pair) ? pair : char;
    if (ATOM_RE.test(token)) {
      addAtom({
        element: normalizeElement(token),
        aromatic: isAromaticToken(token),
        bracketHydrogens: null
      });
      if (token.length === 2) {
        i += 1;
      }
      continue;
    }
    throw new Error(`Unsupported SMILES token "${char}" (element or construct not yet supported).`);
  }

  if (rings.size) {
    throw new Error("Unclosed ring in SMILES.");
  }

  perceiveKekuleAromaticRings(atoms, bonds);
  assignImplicitHydrogens(atoms);
  return { atoms, bonds };
}

function perceiveKekuleAromaticRings(atoms, bonds) {
  const aromaticEligibleElements = new Set(["C", "N", "O", "S", "P"]);
  const ringAtomIds = atoms
    .filter((atom) => aromaticEligibleElements.has(atom.element))
    .map((atom) => atom.id);
  const adjacency = new Map(ringAtomIds.map((id) => [id, []]));
  bonds
    .filter((bond) => {
      if (![1, 1.5, 2].includes(bond.order)) return false;
      return aromaticEligibleElements.has(atoms[bond.from].element)
        && aromaticEligibleElements.has(atoms[bond.to].element);
    })
    .forEach((bond) => {
      adjacency.get(bond.from)?.push(bond.to);
      adjacency.get(bond.to)?.push(bond.from);
    });
  const seen = new Set();
  const canonicalCycle = (cycle) => {
    const rotations = cycle.map((_, index) => cycle.slice(index).concat(cycle.slice(0, index)).join("-"));
    const reversed = [...cycle].reverse();
    rotations.push(...reversed.map((_, index) => reversed.slice(index).concat(reversed.slice(0, index)).join("-")));
    return rotations.sort()[0];
  };

  const findCyclesOfLength = (length) => {
    const cycles = [];
    const visit = (start, current, path) => {
      if (path.length === length) {
        if (adjacency.get(current)?.includes(start)) {
          const key = canonicalCycle(path);
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push([...path]);
          }
        }
        return;
      }
      adjacency.get(current)?.forEach((next) => {
        if (next < start || path.includes(next)) return;
        visit(start, next, [...path, next]);
      });
    };
    ringAtomIds.forEach((start) => visit(start, start, [start]));
    return cycles;
  };

  const aromaticCandidates = [
    ...findCyclesOfLength(5),
    ...findCyclesOfLength(6)
  ];

  aromaticCandidates.forEach((cycle) => {
    const cycleBonds = cycle.map((from, index) => {
      const to = cycle[(index + 1) % cycle.length];
      return bonds.find((bond) => (bond.from === from && bond.to === to) || (bond.from === to && bond.to === from));
    });
    const doubleBondCount = cycleBonds.filter((bond) => bond?.order === 2).length;
    const aromaticBondCount = cycleBonds.filter((bond) => bond?.order === 1.5).length;
    const alternating = cycleBonds.every((bond, index) => bond.order !== cycleBonds[(index + 1) % cycleBonds.length].order);
    const hasHetero = cycle.some((atomId) => atoms[atomId].element !== "C");
    const sixMemberAromatic = cycle.length === 6 && (doubleBondCount === 3 || (aromaticBondCount > 0 && doubleBondCount >= 2)) && alternating;
    const fiveMemberHeteroAromatic = cycle.length === 5 && hasHetero && (doubleBondCount === 2 || aromaticBondCount >= 2);
    if (!sixMemberAromatic && !fiveMemberHeteroAromatic) return;
    cycle.forEach((atomId) => {
      atoms[atomId].aromatic = true;
    });
    cycleBonds.forEach((bond) => {
      bond.order = 1.5;
    });
  });
}

function bondOrderSum(atom) {
  return atom.bonds.reduce((sum, bond) => sum + bond.order, 0);
}

function typicalValence(atom) {
  if (atom.aromatic && atom.element === "C") return 4;
  if (atom.element === "C") return 4;
  if (atom.element === "N") return atom.aromatic ? 2 : 3;
  if (atom.element === "O") return 2;
  if (atom.element === "S") return 2;
  if (atom.element === "Se") return 2;
  if (atom.element === "Te") return 2;
  if (atom.element === "P") return 3;
  if (HALOGENS.has(atom.element)) return 1;
  return 0;
}

function assignImplicitHydrogens(atoms) {
  atoms.forEach((atom) => {
    if (atom.bracketHydrogens !== null) {
      atom.hydrogens = atom.bracketHydrogens;
      return;
    }
    const raw = typicalValence(atom) - bondOrderSum(atom);
    atom.hydrogens = Math.max(0, Math.round(raw));
  });
}

function otherAtom(graph, bond, atomId) {
  return graph.atoms[bond.from === atomId ? bond.to : bond.from];
}

function neighbors(graph, atom) {
  return atom.bonds.map((bond) => ({ atom: otherAtom(graph, bond, atom.id), bond }));
}

function bondedHalogens(graph, atom) {
  return neighbors(graph, atom)
    .map(({ atom: n }) => n.element)
    .filter((element) => HALOGENS.has(element));
}

function dominantHalideRule(graph, atom) {
  const halogens = bondedHalogens(graph, atom);
  if (!halogens.length) return null;
  const ppmSorted = halogens
    .map((element) => ({ element, rule: HALIDE_SHIFT_RULES[element] }))
    .filter((entry) => entry.rule)
    .sort((a, b) => b.rule.alphaH - a.rule.alphaH);
  return ppmSorted[0] || null;
}

function hasBondTo(graph, atom, element, order = null) {
  return neighbors(graph, atom).some(({ atom: n, bond }) => n.element === element && (order === null || bond.order === order));
}

function isCarbonylCarbon(graph, atom) {
  return atom.element === "C" && hasBondTo(graph, atom, "O", 2);
}

function isCarboxylCarbon(graph, atom) {
  if (!isCarbonylCarbon(graph, atom)) return false;
  return neighbors(graph, atom).some(({ atom: n, bond }) => bond.order === 1 && n.element === "O");
}

function isAmideCarbonylCarbon(graph, atom) {
  return isCarbonylCarbon(graph, atom) && neighbors(graph, atom).some(({ atom: n, bond }) => bond.order === 1 && n.element === "N");
}

function isAttachedToCarbonyl(graph, atom) {
  return neighbors(graph, atom).some(({ atom: n }) => isCarbonylCarbon(graph, n));
}

function isAlkeneCarbon(graph, atom) {
  return atom.element === "C" && atom.bonds.some((bond) => bond.order === 2 && otherAtom(graph, bond, atom.id).element === "C");
}

function isAlkyneCarbon(graph, atom) {
  return atom.element === "C" && atom.bonds.some((bond) => bond.order === 3 && otherAtom(graph, bond, atom.id).element === "C");
}

function isNitrileCarbon(graph, atom) {
  return atom.element === "C" && hasBondTo(graph, atom, "N", 3);
}

function isAcyloxyOxygen(graph, atom) {
  return atom.element === "O" && neighbors(graph, atom).some(({ atom: n }) => isCarbonylCarbon(graph, n));
}

function isEsterOAlkylCarbon(graph, atom) {
  return atom.element === "C" && !atom.aromatic && neighbors(graph, atom).some(({ atom: n }) => isAcyloxyOxygen(graph, n));
}

function isAcylMethylCarbon(graph, atom) {
  return atom.element === "C" && atom.hydrogens === 3 && neighbors(graph, atom).some(({ atom: n }) => isCarbonylCarbon(graph, n));
}

function isBetaToEsterOAlkylCarbon(graph, atom) {
  return atom.element === "C" && atom.hydrogens === 3 && !isAcylMethylCarbon(graph, atom)
    && neighbors(graph, atom).some(({ atom: n }) => isEsterOAlkylCarbon(graph, n));
}

function isAlcoholOxygen(graph, atom) {
  return atom.element === "O" && atom.hydrogens > 0
    && neighbors(graph, atom).some(({ atom: n, bond }) => bond.order === 1 && n.element === "C" && !isCarbonylCarbon(graph, n));
}

function alcoholBearingCarbon(graph, atom) {
  return atom.element === "C" && !atom.aromatic && !isCarbonylCarbon(graph, atom)
    && neighbors(graph, atom).some(({ atom: n, bond }) => bond.order === 1 && isAlcoholOxygen(graph, n));
}

function attachedAlcoholCarbon(graph, atom) {
  if (!isAlcoholOxygen(graph, atom)) return null;
  return neighbors(graph, atom).find(({ atom: n, bond }) => bond.order === 1 && n.element === "C")?.atom || null;
}

function aldehydeCarbonyls(graph) {
  return graph.atoms.filter((atom) => isCarbonylCarbon(graph, atom) && atom.hydrogens > 0);
}

function nearestAldehydeDistance(graph, atom) {
  const aldehydes = aldehydeCarbonyls(graph);
  if (!aldehydes.length) return Infinity;
  const distances = shortestPathDistances(graph, atom.id);
  return Math.min(...aldehydes.map((aldehyde) => distances[aldehyde.id]));
}

function isPolyhydroxyContext(graph, atom) {
  const target = atom.element === "O" ? attachedAlcoholCarbon(graph, atom) : atom;
  if (!target || !alcoholBearingCarbon(graph, target)) return false;
  const distances = shortestPathDistances(graph, target.id);
  const localAlcoholCarbons = graph.atoms.filter((entry) => alcoholBearingCarbon(graph, entry) && distances[entry.id] <= 4).length;
  return localAlcoholCarbons >= 2 || nearestAldehydeDistance(graph, target) <= 4;
}

function polyhydroxyAlcoholOxygenShift(graph, atom) {
  if (!isAlcoholOxygen(graph, atom) || !isPolyhydroxyContext(graph, atom)) return null;
  const carbon = attachedAlcoholCarbon(graph, atom);
  const distanceToAldehyde = nearestAldehydeDistance(graph, carbon);
  if (carbon?.hydrogens >= 2) {
    return { ppm: 3.95, label: "polyhydroxy primary alcohol OH; exchangeable and broad", broad: true };
  }
  if (distanceToAldehyde === 1) return { ppm: 5.15, label: "polyhydroxy OH alpha to aldehyde; exchangeable and broad", broad: true };
  if (distanceToAldehyde === 2) return { ppm: 4.40, label: "polyhydroxy secondary alcohol OH; exchangeable and broad", broad: true };
  if (distanceToAldehyde === 3) return { ppm: 4.50, label: "polyhydroxy secondary alcohol OH; exchangeable and broad", broad: true };
  if (distanceToAldehyde === 4) return { ppm: 4.40, label: "polyhydroxy secondary alcohol OH; exchangeable and broad", broad: true };
  return { ppm: 4.50, label: "polyhydroxy alcohol OH; exchangeable and broad", broad: true };
}

function polyhydroxyCarbonProtonShift(graph, atom) {
  if (!atom || atom.element !== "C" || atom.hydrogens <= 0 || !isPolyhydroxyContext(graph, atom)) return null;
  const distanceToAldehyde = nearestAldehydeDistance(graph, atom);
  if (atom.hydrogens >= 2) return { ppm: 3.56, label: "polyhydroxy CH2OH C-H" };
  if (distanceToAldehyde === 1) return { ppm: 4.36, label: "polyhydroxy C-H alpha to aldehyde and O" };
  if (distanceToAldehyde === 2) return { ppm: 3.72, label: "polyhydroxy C-H beta to aldehyde" };
  if (distanceToAldehyde === 3) return { ppm: 3.40, label: "polyhydroxy C-H in oxygenated chain" };
  if (distanceToAldehyde === 4) return { ppm: 3.50, label: "polyhydroxy C-H in oxygenated chain" };
  return { ppm: 3.55, label: "polyhydroxy C-H on C-O carbon" };
}

function polyhydroxyCarbonShift(graph, atom) {
  if (!atom || atom.element !== "C" || !isPolyhydroxyContext(graph, atom)) return null;
  const distanceToAldehyde = nearestAldehydeDistance(graph, atom);
  if (atom.hydrogens >= 2) return { ppm: 62, label: "polyhydroxy CH2OH carbon base range 50-75" };
  if (distanceToAldehyde === 1) return { ppm: 72, label: "polyhydroxy C-O carbon alpha to aldehyde" };
  if (distanceToAldehyde === 2) return { ppm: 73, label: "polyhydroxy C-O carbon" };
  if (distanceToAldehyde === 3) return { ppm: 72, label: "polyhydroxy C-O carbon" };
  if (distanceToAldehyde === 4) return { ppm: 71, label: "polyhydroxy C-O carbon" };
  return { ppm: 70, label: "polyhydroxy C-O carbon base range 50-80" };
}

function isAlphaToCarbonylCarbon(graph, atom) {
  return atom.element === "C" && !atom.aromatic && !isCarbonylCarbon(graph, atom)
    && neighbors(graph, atom).some(({ atom: n }) => isCarbonylCarbon(graph, n));
}

function isBetaToCarbonylCarbon(graph, atom) {
  return atom.element === "C" && !atom.aromatic && !isCarbonylCarbon(graph, atom)
    && neighbors(graph, atom).some(({ atom: n }) => isAlphaToCarbonylCarbon(graph, n));
}

function isAllylicCarbon(graph, atom) {
  return atom.element === "C" && !atom.aromatic && !isAlkeneCarbon(graph, atom)
    && neighbors(graph, atom).some(({ atom: n, bond }) => bond.order === 1 && isAlkeneCarbon(graph, n));
}

function isAcetalLikeCarbon(graph, atom) {
  return atom.element === "C" && !atom.aromatic && !isCarbonylCarbon(graph, atom)
    && neighbors(graph, atom).filter(({ atom: n }) => ["O", "N", "S"].includes(n.element)).length >= 2;
}

function isAmideNitrogen(graph, atom) {
  return atom.element === "N" && neighbors(graph, atom).some(({ atom: n, bond }) => bond.order === 1 && isCarbonylCarbon(graph, n));
}

function sulfurOxoCount(graph, atom) {
  if (atom.element !== "S") return 0;
  return neighbors(graph, atom).filter(({ atom: n, bond }) => n.element === "O" && bond.order === 2).length;
}

function isSulfoxideSulfur(graph, atom) {
  return atom.element === "S" && sulfurOxoCount(graph, atom) === 1;
}

function isSulfoneSulfur(graph, atom) {
  return atom.element === "S" && sulfurOxoCount(graph, atom) >= 2;
}

function isThiolSulfur(graph, atom) {
  return atom.element === "S" && atom.hydrogens > 0 && neighbors(graph, atom).some(({ atom: n }) => n.element === "C");
}

function carbonAlphaHeteroShiftH(graph, atom) {
  if (atom.element !== "C") return null;
  const heteroNeighbours = neighbors(graph, atom).filter(({ atom: n }) => ["O", "N", "S", "Se", "Te"].includes(n.element));
  if (!heteroNeighbours.length) return null;
  const entries = heteroNeighbours.map(({ atom: n }) => {
    if (n.element === "O") return { ppm: 3.60, label: "alpha to O" };
    if (n.element === "N") return { ppm: isAmideNitrogen(graph, n) ? 3.35 : 2.70, label: isAmideNitrogen(graph, n) ? "alpha to amide N" : "alpha to amine N" };
    if (n.element === "S") {
      if (isSulfoneSulfur(graph, n)) return { ppm: 3.05, label: "alpha to sulfone S" };
      if (isSulfoxideSulfur(graph, n)) return { ppm: 2.85, label: "alpha to sulfoxide S" };
      if (isThiolSulfur(graph, n)) return { ppm: 2.55, label: "alpha to thiol S" };
      return { ppm: 2.45, label: "alpha to thioether S" };
    }
    if (n.element === "Se") return { ppm: 2.60, label: "alpha to selenoether Se" };
    if (n.element === "Te") return { ppm: 2.75, label: "alpha to telluroether Te" };
    return { ppm: 2.60, label: "alpha to heteroatom" };
  });
  const strongest = entries.sort((a, b) => b.ppm - a.ppm)[0];
  const extra = Math.max(0, heteroNeighbours.length - 1) * 0.20;
  return { ppm: strongest.ppm + extra, label: `${strongest.label}${heteroNeighbours.length > 1 ? " (multiple heteroatom neighbours)" : ""}` };
}

function carbonAlphaHeteroShiftC(graph, atom) {
  if (atom.element !== "C") return null;
  const heteroNeighbours = neighbors(graph, atom).filter(({ atom: n }) => ["O", "N", "S", "Se", "Te"].includes(n.element));
  if (!heteroNeighbours.length) return null;
  const entries = heteroNeighbours.map(({ atom: n }) => {
    if (n.element === "O") return { ppm: 60, label: "C attached to O" };
    if (n.element === "N") return { ppm: isAmideNitrogen(graph, n) ? 52 : 45, label: isAmideNitrogen(graph, n) ? "C attached to amide N" : "C attached to amine N" };
    if (n.element === "S") {
      if (isSulfoneSulfur(graph, n)) return { ppm: 56, label: "C attached to sulfone S" };
      if (isSulfoxideSulfur(graph, n)) return { ppm: 49, label: "C attached to sulfoxide S" };
      if (isThiolSulfur(graph, n)) return { ppm: 34, label: "C attached to thiol S" };
      return { ppm: 32, label: "C attached to thioether S" };
    }
    if (n.element === "Se") return { ppm: 36, label: "C attached to selenoether Se" };
    if (n.element === "Te") return { ppm: 40, label: "C attached to telluroether Te" };
    return { ppm: 40, label: "C attached to heteroatom" };
  });
  const strongest = entries.sort((a, b) => b.ppm - a.ppm)[0];
  const extra = Math.max(0, heteroNeighbours.length - 1) * 6;
  return { ppm: strongest.ppm + extra, label: `${strongest.label}${heteroNeighbours.length > 1 ? " (multiple heteroatom neighbours)" : ""}` };
}

function isBenzylicCarbon(graph, atom) {
  return atom.element === "C" && !atom.aromatic && neighbors(graph, atom).some(({ atom: n }) => n.aromatic);
}

function isBetaToAromaticCarbon(graph, atom) {
  return atom.element === "C" && !atom.aromatic && neighbors(graph, atom).some(({ atom: n }) => isBenzylicCarbon(graph, n));
}

function isCyclopentadieneMethylene(graph, atom) {
  if (atom.element !== "C" || atom.aromatic || atom.hydrogens !== 2) return false;
  const carbonNeighbours = neighbors(graph, atom).filter(({ atom: n }) => n.element === "C");
  return carbonNeighbours.length === 2 && carbonNeighbours.every(({ atom: n, bond }) => bond.order === 1 && isAlkeneCarbon(graph, n));
}

function isCyclopentadieneVinylic(graph, atom) {
  if (atom.element !== "C" || atom.aromatic || atom.hydrogens !== 1 || !isAlkeneCarbon(graph, atom)) return null;
  const nextToMethylene = neighbors(graph, atom).some(({ atom: n }) => isCyclopentadieneMethylene(graph, n));
  return nextToMethylene ? "outer" : "inner";
}

function carbonDegree(graph, atom) {
  return neighbors(graph, atom).filter(({ atom: n }) => n.element === "C").length;
}

function adjacentHydrogens(graph, atom) {
  if (atom.element !== "C") {
    return 0;
  }
  return neighbors(graph, atom)
    .filter(({ atom: n, bond }) => n.element === "C" && bond.order === 1)
    .reduce((sum, { atom: n }) => sum + n.hydrogens, 0);
}

function adjacentHydrogenEnvironments(graph, atom) {
  if (atom.element !== "C") {
    return [];
  }
  if (atom.aromatic) {
    return aromaticHydrogenEnvironments(graph, atom);
  }
  const groups = new Map();
  neighbors(graph, atom)
    .filter(({ atom: n, bond }) => n.element === "C" && n.hydrogens > 0 && (bond.order === 1 || (bond.order === 2 && isAlkeneCarbon(graph, atom) && isAlkeneCarbon(graph, n))))
    .forEach(({ atom: n, bond }) => {
      const key = atomFeatureKey(graph, n);
      const current = groups.get(key) || { count: 0, atomIds: [], hydrogenCounts: [], jHz: estimateJHz(graph, atom, n, bond) };
      current.count += n.hydrogens;
      current.atomIds.push(n.id + 1);
      current.hydrogenCounts.push({ atomId: n.id + 1, count: n.hydrogens });
      groups.set(key, current);
    });
  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count || a.atomIds[0] - b.atomIds[0])
    .slice(0, 3);
}

function aromaticHydrogenEnvironments(graph, atom) {
  // Teaching approximation: split only by H atoms on directly adjacent
  // aromatic carbons, but keep non-equivalent adjacent environments separate.
  const groups = new Map();
  neighbors(graph, atom)
    .filter(({ atom: n }) => n.element === "C" && n.aromatic && n.hydrogens > 0)
    .forEach(({ atom: n }) => {
      const key = radiusEnvironmentKey(graph, n, 3);
      const current = groups.get(key) || { count: 0, atomIds: [], hydrogenCounts: [], jHz: 8.0, label: "adjacent aromatic" };
      current.count += n.hydrogens;
      current.atomIds.push(n.id + 1);
      current.hydrogenCounts.push({ atomId: n.id + 1, count: n.hydrogens });
      groups.set(key, current);
    });
  const environments = Array.from(groups.values())
    .sort((a, b) => b.count - a.count || a.atomIds[0] - b.atomIds[0])
    .slice(0, 3);
  return environments.map((environment, index) => ({
    ...environment,
    jHz: environments.length > 1 ? 8.0 - index * 0.8 : 8.0
  }));
}

function estimateJHz(graph, atom, neighbour, bond) {
  if (bond.order === 2 && isAlkeneCarbon(graph, atom) && isAlkeneCarbon(graph, neighbour)) {
    return alkeneCouplingJHz(graph, bond);
  }
  if (bond.order !== 1) return 0;
  if (isCarbonylCarbon(graph, atom) || isCarbonylCarbon(graph, neighbour)) return 6.2;
  if (atom.aromatic || neighbour.aromatic) return 7.5;
  if (isAlkeneCarbon(graph, atom) || isAlkeneCarbon(graph, neighbour)) return 7.0;
  return 7.0;
}

function alkeneCouplingJHz(graph, doubleBond) {
  const stereoClass = alkeneStereoClass(graph, doubleBond);
  if (stereoClass === "trans") return 16.0;
  if (stereoClass === "cis") return 10.0;
  return 12.0;
}

function alkeneStereoClass(graph, doubleBond) {
  const leftStereo = alkeneStereoMarkerAt(graph, doubleBond.from, doubleBond);
  const rightStereo = alkeneStereoMarkerAt(graph, doubleBond.to, doubleBond);
  if (!leftStereo || !rightStereo) return "unspecified";
  return leftStereo === rightStereo ? "trans" : "cis";
}

function alkeneStereoMarkerAt(graph, atomId, doubleBond) {
  const atom = graph.atoms[atomId];
  const stereoBond = atom.bonds.find((bond) => bond !== doubleBond && bond.order === 1 && bond.stereo);
  return stereoBond?.stereo || null;
}

function multiplicityFromEnvironments(environments) {
  if (!environments.length) return "s";
  return environments.map((environment) => multiplicityLabel(environment.count)).join("");
}

function shortestPathDistances(graph, sourceId) {
  const distances = Array(graph.atoms.length).fill(Infinity);
  const queue = [sourceId];
  distances[sourceId] = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const atomId = queue[index];
    for (const { atom } of neighbors(graph, graph.atoms[atomId])) {
      if (distances[atom.id] === Infinity) {
        distances[atom.id] = distances[atomId] + 1;
        queue.push(atom.id);
      }
    }
  }
  return distances;
}

function computeDistanceMatrix(graph) {
  // RDKit's GetDistanceMatrix is mirrored here as a small topological BFS matrix,
  // because this static GitHub Pages app cannot run a Python RDKit backend.
  // Complexity is O(n^2) in atom count, which is acceptable for small molecules.
  return graph.atoms.map((atom) => shortestPathDistances(graph, atom.id));
}

function distanceWeight(distance) {
  if (distance === 1) return 1.0;
  if (distance === 2) return 0.45;
  if (distance === 3) return 0.20;
  if (distance >= 4 && distance < Infinity) return 0.05;
  return 0;
}

function classifyFunctionalGroups(graph) {
  const groups = [];
  graph.atoms.forEach((atom) => {
    if (isCarbonylCarbon(graph, atom)) {
      groups.push({ type: "carbonyl", atomId: atom.id, effectH: 0.65, effectC: 10 });
    }
    if (atom.element === "O") {
      if (isAcyloxyOxygen(graph, atom)) {
        groups.push({ type: "ester/acid O", atomId: atom.id, effectH: 0.60, effectC: 20 });
      } else {
        groups.push({ type: "alcohol/ether O", atomId: atom.id, effectH: 0.55, effectC: 18 });
      }
    }
    if (atom.element === "N") {
      if (isAmideNitrogen(graph, atom)) {
        groups.push({ type: "amide N", atomId: atom.id, effectH: 0.55, effectC: 12 });
      } else {
        groups.push({ type: "amine N", atomId: atom.id, effectH: 0.42, effectC: 10 });
      }
    }
    if (atom.element === "S") {
      if (isSulfoneSulfur(graph, atom)) {
        groups.push({ type: "sulfone S", atomId: atom.id, effectH: 0.65, effectC: 14 });
      } else if (isSulfoxideSulfur(graph, atom)) {
        groups.push({ type: "sulfoxide S", atomId: atom.id, effectH: 0.55, effectC: 12 });
      } else if (isThiolSulfur(graph, atom)) {
        groups.push({ type: "thiol S", atomId: atom.id, effectH: 0.32, effectC: 8 });
      } else {
        groups.push({ type: "thioether S", atomId: atom.id, effectH: 0.38, effectC: 9 });
      }
    }
    if (atom.element === "Se") {
      groups.push({ type: "selenoether Se", atomId: atom.id, effectH: 0.42, effectC: 10 });
    }
    if (atom.element === "Te") {
      groups.push({ type: "telluroether Te", atomId: atom.id, effectH: 0.46, effectC: 11 });
    }
    if (HALOGENS.has(atom.element)) {
      const rule = HALIDE_SHIFT_RULES[atom.element] || { effectH: 0.16, effectC: 4 };
      groups.push({ type: `${atom.element} substituent`, atomId: atom.id, effectH: rule.effectH, effectC: rule.effectC });
    }
    if (atom.element === "C" && hasBondTo(graph, atom, "N", 3)) {
      groups.push({ type: "nitrile", atomId: atom.id, effectH: 0.38, effectC: 8 });
    }
    if (atom.aromatic) {
      groups.push({ type: "aromatic ring", atomId: atom.id, effectH: 0.08, effectC: 3 });
    }
    if (isAlkeneCarbon(graph, atom)) {
      groups.push({ type: "alkene", atomId: atom.id, effectH: 0.25, effectC: 6 });
    }
  });
  return groups;
}

function estimatePartialCharges(graph) {
  // A compact Gasteiger-like teaching approximation: electronegative atoms pull
  // charge from neighbours, and carbonyl/pi bonds add small polarization terms.
  const electronegativity = {
    C: 2.55, H: 2.20, N: 3.04, O: 3.44,
    F: 3.98, Cl: 3.16, Br: 2.96, I: 2.66,
    S: 2.58, Se: 2.55, Te: 2.10, P: 2.19
  };
  const charges = Array(graph.atoms.length).fill(0);
  graph.atoms.forEach((atom) => {
    neighbors(graph, atom).forEach(({ atom: n, bond }) => {
      if (atom.id > n.id) return;
      const delta = ((electronegativity[n.element] || 2.5) - (electronegativity[atom.element] || 2.5)) * 0.035 * bond.order;
      charges[atom.id] += delta;
      charges[n.id] -= delta;
    });
  });
  graph.atoms.forEach((atom) => {
    if (isCarbonylCarbon(graph, atom)) {
      charges[atom.id] += 0.08;
      neighbors(graph, atom)
        .filter(({ atom: n, bond }) => n.element === "O" && bond.order === 2)
        .forEach(({ atom: oxygen }) => {
          charges[oxygen.id] -= 0.08;
        });
    }
  });
  return charges;
}

function stableHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function atomFeatureKey(graph, atom) {
  return [
    atom.element,
    atom.aromatic ? "aromatic" : "aliphatic",
    `H${atom.hydrogens}`,
    `bo${bondOrderSum(atom).toFixed(1)}`,
    `deg${carbonDegree(graph, atom)}`,
    isCarbonylCarbon(graph, atom) ? "carbonyl" : "",
    isAlkeneCarbon(graph, atom) ? "alkene" : "",
    isAlkyneCarbon(graph, atom) ? "alkyne" : "",
  ].join("|");
}

function radiusEnvironmentKey(graph, atom, radius = 3) {
  // Morgan-like teaching signature: repeatedly fold sorted neighbour signatures
  // into each atom key. This separates ortho/meta/para-type environments before
  // any ppm calculation, instead of relying on shift similarity.
  let signatures = graph.atoms.map((entry) => atomFeatureKey(graph, entry));
  for (let level = 1; level <= radius; level += 1) {
    signatures = graph.atoms.map((entry) => {
      const neighbourSignatures = neighbors(graph, entry)
        .map(({ atom: n, bond }) => `${bond.order}:${signatures[n.id]}`)
        .sort()
        .join(",");
      return `r${level}(${signatures[entry.id]}->[${neighbourSignatures}])`;
    });
  }
  return signatures[atom.id];
}

function baseProtonShift(graph, atom) {
  const solventCaveat = "position solvent-dependent; may not appear";
  if (atom.element === "O") {
    const polyhydroxyOh = polyhydroxyAlcoholOxygenShift(graph, atom);
    if (polyhydroxyOh) return { ...polyhydroxyOh, label: `${polyhydroxyOh.label}; ${solventCaveat}` };
    if (neighbors(graph, atom).some(({ atom: n }) => isCarboxylCarbon(graph, n))) {
      return { ppm: 11.0, label: `acid OH base range 10-13; ${solventCaveat}`, broad: true };
    }
    if (neighbors(graph, atom).some(({ atom: n }) => n.aromatic)) {
      return { ppm: 8.7, label: `exchangeable phenol OH, often broad/variable near 9 ppm; ${solventCaveat}`, broad: true };
    }
    return { ppm: 4.8, label: `exchangeable alcohol OH, often broad/variable; ${solventCaveat}`, broad: true };
  }
  if (atom.element === "N") {
    if (isAmideNitrogen(graph, atom)) return { ppm: 7.2, label: `exchangeable amide NH, often broad; ${solventCaveat}`, broad: true };
    if (neighbors(graph, atom).some(({ atom: n }) => n.aromatic)) return { ppm: 4.3, label: `exchangeable aniline-like NH, often broad; ${solventCaveat}`, broad: true };
    return { ppm: 2.2, label: `exchangeable amine NH, often broad/variable; ${solventCaveat}`, broad: true };
  }
  if (atom.element === "S") {
    if (isThiolSulfur(graph, atom)) return { ppm: 1.8, label: `exchangeable thiol SH, often broad/variable; ${solventCaveat}`, broad: true };
    return { ppm: 2.0, label: `exchangeable sulfur-bound H, often broad/variable; ${solventCaveat}`, broad: true };
  }
  if (isCyclopentadieneMethylene(graph, atom)) return { ppm: 2.90, label: "cyclopentadiene CH2" };
  const cyclopentadienePosition = isCyclopentadieneVinylic(graph, atom);
  if (cyclopentadienePosition) {
    return { ppm: cyclopentadienePosition === "inner" ? 6.50 : 6.40, label: "cyclopentadiene vinylic CH" };
  }
  if (isCarbonylCarbon(graph, atom) && atom.hydrogens > 0) {
    const oxygenatedNeighbour = neighbors(graph, atom).some(({ atom: n }) => alcoholBearingCarbon(graph, n));
    return { ppm: oxygenatedNeighbour ? 9.72 : 9.6, label: "aldehyde C-H base range 9.0-10.2" };
  }
  if (atom.aromatic) return { ppm: 7.25, label: "aromatic C-H base range 6.5-8.0" };
  if (isAlkeneCarbon(graph, atom)) return { ppm: 5.45, label: "vinylic C-H base range 4.5-6.5" };
  if (isAlkyneCarbon(graph, atom)) return { ppm: 2.35, label: "alkynyl C-H" };
  if (isBenzylicCarbon(graph, atom)) {
    const ppm = atom.hydrogens >= 3 ? 2.30 : atom.hydrogens === 2 ? 2.65 : 2.80;
    return { ppm, label: "benzylic C-H base range 1.8-3.0" };
  }
  if (isEsterOAlkylCarbon(graph, atom)) {
    const ppm = atom.hydrogens >= 3 ? 3.89 : 4.12;
    return { ppm, label: "alkoxy ester C-H base range" };
  }
  if (isAcylMethylCarbon(graph, atom)) {
    return { ppm: 2.04, label: "acetyl methyl C-H base range" };
  }
  if (isBetaToEsterOAlkylCarbon(graph, atom)) {
    return { ppm: 1.26, label: "ethyl ester terminal methyl C-H base range" };
  }
  const polyhydroxyCh = polyhydroxyCarbonProtonShift(graph, atom);
  if (polyhydroxyCh) return polyhydroxyCh;
  if (neighbors(graph, atom).some(({ bond }) => bond.order === 2)) return { ppm: 2.05, label: "allylic C-H base range 1.8-3.0" };
  const halide = dominantHalideRule(graph, atom);
  if (halide) {
    const halogenCount = bondedHalogens(graph, atom).length;
    const extra = Math.max(0, halogenCount - 1) * 0.35;
    return {
      ppm: halide.rule.alphaH + extra,
      label: `C-H on carbon bonded to ${halide.element}${halogenCount > 1 ? " (multiple halides)" : ""} base range 3.0-4.5`
    };
  }
  const heteroShift = carbonAlphaHeteroShiftH(graph, atom);
  if (heteroShift) {
    return { ppm: heteroShift.ppm, label: `${heteroShift.label} base range` };
  }
  const degree = carbonDegree(graph, atom);
  return { ppm: degree <= 1 ? 0.95 : degree === 2 ? 1.30 : 1.55, label: "alkyl sp3 C-H base range 0.9-1.7" };
}

function baseCarbonShift(graph, atom) {
  if (isCarbonylCarbon(graph, atom)) {
    if (isAmideCarbonylCarbon(graph, atom)) return { ppm: 170, label: "amide carbonyl base range 165-180" };
    if (isCarboxylCarbon(graph, atom)) {
      const aryl = neighbors(graph, atom).some(({ atom: n }) => n.aromatic);
      const ester = neighbors(graph, atom).some(({ atom: n }) => n.element === "O" && neighbors(graph, n).some(({ atom: m }) => m.element === "C" && !isCarbonylCarbon(graph, m)));
      return { ppm: aryl ? 166 : ester ? 170 : 174, label: ester ? "ester carbonyl base range 165-175" : aryl ? "aryl carboxylic acid carbonyl calibrated near 166" : "carboxylic acid carbonyl base range 170-180" };
    }
    if (atom.hydrogens > 0) return { ppm: 198, label: "aldehyde carbonyl base range 190-205" };
    const conjugated = neighbors(graph, atom).some(({ atom: n }) => n.aromatic || isAlkeneCarbon(graph, n));
    return { ppm: conjugated ? 195 : 210, label: conjugated ? "conjugated ketone carbonyl base range 185-205" : "ketone carbonyl base range 205-220" };
  }
  if (atom.aromatic) return { ppm: 128, label: "aromatic sp2 base range 120-145" };
  if (isNitrileCarbon(graph, atom)) return { ppm: 118, label: "nitrile carbon base range 110-125" };
  if (isAlkeneCarbon(graph, atom)) {
    const conjugated = neighbors(graph, atom).some(({ atom: n }) => n.aromatic || isCarbonylCarbon(graph, n));
    const attachedToO = neighbors(graph, atom).some(({ atom: n }) => n.element === "O");
    if (attachedToO) return { ppm: 150, label: "C=C attached to O base range 140-165" };
    if (atom.hydrogens >= 2) return { ppm: conjugated ? 118 : 112, label: "terminal alkene CH2 carbon base range 110-118" };
    if (atom.hydrogens === 1) return { ppm: conjugated ? 136 : 126, label: "internal alkene CH carbon base range 120-138" };
    return { ppm: conjugated ? 140 : 132, label: "substituted alkene quaternary carbon base range 125-145" };
  }
  if (isAlkyneCarbon(graph, atom)) return { ppm: atom.hydrogens > 0 ? 70 : 80, label: atom.hydrogens > 0 ? "terminal alkyne C-H carbon base range 65-75" : "internal alkyne carbon base range 70-90" };
  const halide = dominantHalideRule(graph, atom);
  if (halide) {
    const halogenCount = bondedHalogens(graph, atom).length;
    const extra = Math.max(0, halogenCount - 1) * 8;
    return {
      ppm: halide.rule.alphaC + extra,
      label: `C attached to ${halide.element}${halogenCount > 1 ? " (multiple halides)" : ""} base range typical for alkyl halides`
    };
  }
  if (isEsterOAlkylCarbon(graph, atom)) {
    return { ppm: atom.hydrogens >= 3 ? 51.5 : 61.0, label: "alkoxy ester carbon base range" };
  }
  if (isAcylMethylCarbon(graph, atom)) {
    return { ppm: 20.7, label: "acetyl methyl carbon base range" };
  }
  if (isBetaToEsterOAlkylCarbon(graph, atom)) {
    return { ppm: 14.1, label: "ethyl ester terminal methyl carbon base range" };
  }
  const polyhydroxyCarbon = polyhydroxyCarbonShift(graph, atom);
  if (polyhydroxyCarbon) return polyhydroxyCarbon;
  if (isAcetalLikeCarbon(graph, atom)) {
    return { ppm: 100, label: "acetal/anomeric-type carbon base range 90-110" };
  }
  const heteroShift = carbonAlphaHeteroShiftC(graph, atom);
  if (heteroShift) {
    return { ppm: heteroShift.ppm, label: `${heteroShift.label} base range` };
  }
  if (isBenzylicCarbon(graph, atom)) {
    return { ppm: atom.hydrogens >= 3 ? 21 : atom.hydrogens === 2 ? 35 : 42, label: "benzylic sp3 carbon base range 20-50" };
  }
  if (isAllylicCarbon(graph, atom)) {
    return { ppm: atom.hydrogens >= 3 ? 18 : atom.hydrogens === 2 ? 30 : 38, label: "allylic carbon base range 15-40" };
  }
  if (isAlphaToCarbonylCarbon(graph, atom)) {
    return { ppm: atom.hydrogens >= 3 ? 28 : atom.hydrogens === 2 ? 38 : 45, label: "alpha to carbonyl carbon base range 20-50" };
  }
  if (isBetaToCarbonylCarbon(graph, atom)) {
    return { ppm: atom.hydrogens >= 3 ? 22 : atom.hydrogens === 2 ? 30 : 36, label: "beta to carbonyl carbon base range 20-40" };
  }
  const degree = carbonDegree(graph, atom);
  return { ppm: degree <= 1 ? 14 : degree === 2 ? 25 : degree === 3 ? 35 : 40, label: "alkyl sp3 base range 10-40" };
}

function correctionForAtom(graph, atom, nucleus, context) {
  if (nucleus === "1H" && (isCyclopentadieneMethylene(graph, atom) || isCyclopentadieneVinylic(graph, atom))) {
    return { ppm: 0, labels: [] };
  }
  if (nucleus === "1H" && (
    polyhydroxyAlcoholOxygenShift(graph, atom)
    || polyhydroxyCarbonProtonShift(graph, atom)
    || (isCarbonylCarbon(graph, atom) && atom.hydrogens > 0 && neighbors(graph, atom).some(({ atom: n }) => alcoholBearingCarbon(graph, n)))
  )) {
    return { ppm: 0, labels: [] };
  }
  if (nucleus === "1H" && (isEsterOAlkylCarbon(graph, atom) || isAcylMethylCarbon(graph, atom) || isBetaToEsterOAlkylCarbon(graph, atom))) {
    return { ppm: 0, labels: [] };
  }
  if (nucleus === "13C" && (
    isCarboxylCarbon(graph, atom)
    || isEsterOAlkylCarbon(graph, atom)
    || isAcylMethylCarbon(graph, atom)
    || isBetaToEsterOAlkylCarbon(graph, atom)
    || isNitrileCarbon(graph, atom)
    || isAcetalLikeCarbon(graph, atom)
  )) {
    return { ppm: 0, labels: [] };
  }
  if (nucleus === "13C" && polyhydroxyCarbonShift(graph, atom)) {
    return { ppm: 0, labels: [] };
  }
  if (nucleus === "13C" && atom.aromatic) {
    return aromaticCarbonSubstituentCorrection(graph, atom);
  }
  const { groups, distances, charges } = context;
  let ppm = 0;
  const labels = [];
  if (nucleus === "1H" && atom.aromatic) {
    const aromaticCorrection = aromaticSubstituentCorrection(graph, atom, distances);
    ppm += aromaticCorrection.ppm;
    labels.push(...aromaticCorrection.labels);
  } else {
    groups.forEach((group) => {
      const distance = distances[atom.id][group.atomId];
      if (distance === 0) return;
      if (nucleus === "1H" && isBenzylicCarbon(graph, atom) && ["aromatic ring", "alkene"].includes(group.type)) {
        return;
      }
      if (nucleus === "1H" && isBetaToAromaticCarbon(graph, atom) && ["aromatic ring", "alkene"].includes(group.type)) {
        return;
      }
      const effect = nucleus === "1H" ? group.effectH : group.effectC;
      const contribution = distanceWeight(distance) * effect;
      if (Math.abs(contribution) >= 0.01) {
        ppm += contribution;
        if (distance <= 3) labels.push(`${group.type} d${distance}`);
      }
    });
  }

  const ownCharge = charges[atom.id] || 0;
  const neighbourCharge = neighbors(graph, atom).reduce((sum, { atom: n }) => sum + (charges[n.id] || 0), 0) / Math.max(neighbors(graph, atom).length, 1);
  ppm += nucleus === "1H" ? (ownCharge * 0.28 + neighbourCharge * 0.16) : (ownCharge * 5.5 + neighbourCharge * 2.0);
  if (nucleus === "1H" && isBetaToAromaticCarbon(graph, atom)) ppm += 0.16;

  if (atom.aromatic) ppm += nucleus === "1H" ? 0.18 : 3.0;
  if (neighbors(graph, atom).some(({ atom: n }) => n.aromatic || isAlkeneCarbon(graph, n))) {
    ppm += nucleus === "1H" ? 0.10 : 1.5;
  }
  return { ppm, labels };
}

function canonicalCycleKey(cycle) {
  const rotations = cycle.map((_, index) => cycle.slice(index).concat(cycle.slice(0, index)).join("-"));
  const reversed = [...cycle].reverse();
  rotations.push(...reversed.map((_, index) => reversed.slice(index).concat(reversed.slice(0, index)).join("-")));
  return rotations.sort()[0];
}

function aromaticRingAdjacency(graph) {
  const aromaticIds = graph.atoms.filter((entry) => entry.aromatic).map((entry) => entry.id);
  const adjacency = new Map(aromaticIds.map((id) => [id, []]));
  graph.bonds
    .filter((bond) => {
      const from = graph.atoms[bond.from];
      const to = graph.atoms[bond.to];
      return from.aromatic && to.aromatic && [1, 1.5, 2].includes(bond.order);
    })
    .forEach((bond) => {
      adjacency.get(bond.from)?.push(bond.to);
      adjacency.get(bond.to)?.push(bond.from);
    });
  return adjacency;
}

function findAromaticSixRings(graph) {
  const adjacency = aromaticRingAdjacency(graph);
  const aromaticIds = [...adjacency.keys()].sort((a, b) => a - b);
  const seen = new Set();
  const rings = [];
  const visit = (start, current, path) => {
    if (path.length === 6) {
      if (adjacency.get(current)?.includes(start)) {
        const key = canonicalCycleKey(path);
        if (!seen.has(key)) {
          seen.add(key);
          rings.push({ atoms: [...path], key });
        }
      }
      return;
    }
    adjacency.get(current)?.forEach((next) => {
      if (next < start || path.includes(next)) return;
      visit(start, next, [...path, next]);
    });
  };
  aromaticIds.forEach((start) => visit(start, start, [start]));
  return rings;
}

function classifyArylSubstituent(graph, substituent) {
  if (HALOGENS.has(substituent.element)) {
    return { key: `halogen_${substituent.element}`, label: `${substituent.element}` };
  }
  if (substituent.element === "N") {
    const nitroLike = neighbors(graph, substituent)
      .some(({ atom: n, bond }) => n.element === "O" && (bond.order === 1 || bond.order === 2));
    if (nitroLike) return { key: "nitro", label: "NO2" };
    if (isAmideNitrogen(graph, substituent)) return { key: "amide_n", label: "amide N" };
    return { key: "amino", label: "amino" };
  }
  if (substituent.element === "O") {
    return isAcyloxyOxygen(graph, substituent)
      ? { key: "acyloxy", label: "OAc/acyloxy" }
      : { key: "alkoxy", label: "alkoxy/OH" };
  }
  if (substituent.element === "S") {
    if (isSulfoneSulfur(graph, substituent)) return { key: "sulfone", label: "sulfone" };
    if (isSulfoxideSulfur(graph, substituent)) return { key: "sulfoxide", label: "sulfoxide" };
    return { key: "thioether", label: "thioether/thiol" };
  }
  if (substituent.element === "C") {
    if (isCarbonylCarbon(graph, substituent)) {
      return isCarboxylCarbon(graph, substituent)
        ? { key: "carboxyl", label: "CO2R/CO2H" }
        : { key: "acyl", label: "acyl/CHO/COR" };
    }
    if (hasBondTo(graph, substituent, "N", 3)) return { key: "nitrile", label: "CN" };
    return { key: "alkyl", label: "alkyl" };
  }
  return { key: "generic_ewg", label: substituent.element };
}

function aromaticPositionName(step) {
  if (step === 1) return "ortho";
  if (step === 2) return "meta";
  if (step === 3) return "para";
  return "";
}

function aromaticPositionStep(ringAtoms, fromAtomId, toAtomId) {
  const i = ringAtoms.indexOf(fromAtomId);
  const j = ringAtoms.indexOf(toAtomId);
  if (i < 0 || j < 0) return null;
  const delta = Math.abs(i - j);
  return Math.min(delta, ringAtoms.length - delta);
}

function aromaticPositionEffects(substituentKey) {
  const table = {
    nitro: { 1: 1.00, 2: 0.55, 3: 0.90 },
    acyl: { 1: 0.65, 2: 0.25, 3: 0.45 },
    carboxyl: { 1: 0.60, 2: 0.20, 3: 0.40 },
    nitrile: { 1: 0.45, 2: 0.20, 3: 0.30 },
    halogen_F: { 1: 0.28, 2: 0.05, 3: 0.10 },
    halogen_Cl: { 1: 0.24, 2: 0.04, 3: 0.10 },
    halogen_Br: { 1: 0.22, 2: 0.04, 3: 0.09 },
    halogen_I: { 1: 0.20, 2: 0.03, 3: 0.08 },
    alkoxy: { 1: -0.58, 2: -0.18, 3: -0.46 },
    acyloxy: { 1: -0.18, 2: 0.02, 3: -0.08 },
    amino: { 1: -0.55, 2: -0.20, 3: -0.48 },
    amide_n: { 1: -0.20, 2: -0.06, 3: -0.16 },
    alkyl: { 1: -0.30, 2: -0.12, 3: -0.24 },
    thioether: { 1: -0.22, 2: -0.08, 3: -0.16 },
    sulfoxide: { 1: 0.25, 2: 0.08, 3: 0.16 },
    sulfone: { 1: 0.35, 2: 0.12, 3: 0.22 },
    generic_ewg: { 1: 0.20, 2: 0.08, 3: 0.14 }
  };
  return table[substituentKey] || table.generic_ewg;
}

function aromaticSubstituentCorrectionFallback(graph, atom, distances) {
  let ppm = 0;
  const labels = [];
  graph.atoms
    .filter((ringAtom) => ringAtom.aromatic)
    .forEach((ringAtom) => {
      const ringDistance = distances[atom.id][ringAtom.id];
      if (!Number.isFinite(ringDistance) || ringDistance < 1 || ringDistance > 3) return;
      neighbors(graph, ringAtom)
        .filter(({ atom: substituent }) => !substituent.aromatic)
        .forEach(({ atom: substituent }) => {
          const classification = classifyArylSubstituent(graph, substituent);
          const effects = aromaticPositionEffects(classification.key);
          const effect = effects[ringDistance] || 0;
          if (Math.abs(effect) >= 0.01) {
            ppm += effect;
            labels.push(`${classification.label} ring d${ringDistance}`);
          }
        });
    });
  return { ppm, labels };
}

function aromaticSubstituentCorrection(graph, atom, distances) {
  const aromaticRings = findAromaticSixRings(graph).filter((ring) => ring.atoms.includes(atom.id));
  if (!aromaticRings.length) {
    return aromaticSubstituentCorrectionFallback(graph, atom, distances);
  }
  let ppm = 0;
  const labels = [];
  const counted = new Set();
  aromaticRings.forEach((ring) => {
    ring.atoms.forEach((ringAtomId) => {
      if (ringAtomId === atom.id) return;
      const ringAtom = graph.atoms[ringAtomId];
      neighbors(graph, ringAtom)
        .filter(({ atom: substituent }) => !substituent.aromatic)
        .forEach(({ atom: substituent }) => {
          const uniqueKey = `${ring.key}:${ringAtomId}:${substituent.id}`;
          if (counted.has(uniqueKey)) return;
          counted.add(uniqueKey);
          const step = aromaticPositionStep(ring.atoms, atom.id, ringAtomId);
          if (![1, 2, 3].includes(step)) return;
          const position = aromaticPositionName(step);
          const classification = classifyArylSubstituent(graph, substituent);
          const effects = aromaticPositionEffects(classification.key);
          const effect = effects[step] || 0;
          if (Math.abs(effect) < 0.01) return;
          ppm += effect;
          labels.push(`${position} ${classification.label}`);
        });
    });
  });
  return { ppm, labels };
}

function aromaticCarbonPositionEffects(substituentKey) {
  const table = {
    carboxyl: { 0: 2.1, 1: 1.9, 2: 0.6, 3: 5.0 },
    acyl: { 0: 3.0, 1: 2.0, 2: 0.7, 3: 4.0 },
    alkoxy: { 0: 25.0, 1: -14.0, 2: 1.5, 3: -8.0 },
    acyloxy: { 0: 22.0, 1: -7.0, 2: 1.0, 3: -4.0 },
    alkyl: { 0: 9.0, 1: -1.0, 2: 0.5, 3: -2.0 },
    halogen_F: { 0: 34.0, 1: -12.0, 2: 2.0, 3: -4.0 },
    halogen_Cl: { 0: 7.0, 1: -2.0, 2: 1.0, 3: -1.0 },
    generic_ewg: { 0: 2.0, 1: 1.0, 2: 0.4, 3: 1.5 }
  };
  return table[substituentKey] || table.generic_ewg;
}

function aromaticCarbonSubstituentCorrection(graph, atom) {
  const aromaticRings = findAromaticSixRings(graph).filter((ring) => ring.atoms.includes(atom.id));
  if (!aromaticRings.length) return { ppm: 0, labels: [] };
  let ppm = 0;
  const labels = [];
  const seenPositions = new Set();
  const counted = new Set();
  aromaticRings.forEach((ring) => {
    ring.atoms.forEach((ringAtomId) => {
      const ringAtom = graph.atoms[ringAtomId];
      neighbors(graph, ringAtom)
        .filter(({ atom: substituent }) => !substituent.aromatic)
        .forEach(({ atom: substituent }) => {
          const uniqueKey = `${ring.key}:${ringAtomId}:${substituent.id}`;
          if (counted.has(uniqueKey)) return;
          counted.add(uniqueKey);
          const step = ringAtomId === atom.id ? 0 : aromaticPositionStep(ring.atoms, atom.id, ringAtomId);
          if (![0, 1, 2, 3].includes(step)) return;
          const classification = classifyArylSubstituent(graph, substituent);
          const effect = aromaticCarbonPositionEffects(classification.key)[step] || 0;
          if (Math.abs(effect) < 0.01) return;
          ppm += effect;
          seenPositions.add(`${step}:${classification.key}`);
          labels.push(`${step === 0 ? "ipso" : aromaticPositionName(step)} ${classification.label}`);
        });
    });
  });
  if (seenPositions.has("1:acyloxy") && seenPositions.has("2:carboxyl")) {
    ppm += 2.5;
    labels.push("salicylate ester interaction");
  }
  return { ppm, labels };
}

function binomialWeights(n) {
  const weights = [1];
  for (let row = 0; row < n; row += 1) {
    for (let i = weights.length - 1; i > 0; i -= 1) {
      weights[i] += weights[i - 1];
    }
    weights.push(1);
  }
  return weights;
}

function multiplicityLabel(n) {
  if (n <= 0) return "s";
  if (n === 1) return "d";
  if (n === 2) return "t";
  if (n === 3) return "q";
  if (n === 4) return "quint";
  return "m";
}

function mergeEnvironmentKeys(items) {
  const map = new Map();
  for (const item of items) {
    const current = map.get(item.environmentKey);
    if (current) {
      current.integration += item.integration;
      current.atomIds.push(...item.atomIds);
      current.sourceAtomIds.push(...(item.sourceAtomIds || item.atomIds));
      current.carrierAtomIds.push(...(item.carrierAtomIds || item.atomIds));
      current.sourcePpm.push(item.rawPpm);
    } else {
      map.set(item.environmentKey, {
        ...item,
        atomIds: [...item.atomIds],
        sourceAtomIds: [...(item.sourceAtomIds || item.atomIds)],
        carrierAtomIds: [...(item.carrierAtomIds || item.atomIds)],
        sourcePpm: [item.rawPpm]
      });
    }
  }
  const grouped = Array.from(map.values()).map((item) => ({
    ...item,
    atomIds: dedupeSortedNumeric(item.atomIds),
    sourceAtomIds: dedupeSortedNumeric(item.sourceAtomIds),
    carrierAtomIds: dedupeSortedNumeric(item.carrierAtomIds),
    ppm: item.sourcePpm.reduce((sum, value) => sum + value, 0) / item.sourcePpm.length
  })).map(normalizeSignalSplitting);
  return applyTieBreaking(grouped).sort((a, b) => b.ppm - a.ppm);
}

function normalizeSignalSplitting(signal) {
  if (signal.nucleus !== "1H" || signal.broad || !signal.splitEnvironments?.length) {
    return signal;
  }
  const memberAtoms = new Set(signal.atomIds);
  const splitEnvironments = signal.splitEnvironments
    .map((environment) => {
      const hydrogenCounts = environment.hydrogenCounts || environment.atomIds.map((atomId) => ({
        atomId,
        count: environment.label ? 1 : environment.count / Math.max(environment.atomIds.length, 1)
      }));
      const filteredCounts = hydrogenCounts.filter(({ atomId }) => !memberAtoms.has(atomId));
      const atomIds = filteredCounts.map(({ atomId }) => atomId);
      const count = filteredCounts.reduce((sum, item) => sum + item.count, 0);
      return { ...environment, atomIds, hydrogenCounts: filteredCounts, count };
    })
    .filter((environment) => environment.count > 0);
  return {
    ...signal,
    splitEnvironments,
    neighborH: splitEnvironments.reduce((sum, environment) => sum + environment.count, 0),
    multiplicity: multiplicityFromEnvironments(splitEnvironments)
  };
}

function applyTieBreaking(signals) {
  const exactGroups = new Map();
  signals.forEach((signal) => {
    const key = `${signal.nucleus}|${signal.ppm.toFixed(3)}`;
    const bucket = exactGroups.get(key) || [];
    bucket.push(signal);
    exactGroups.set(key, bucket);
  });
  exactGroups.forEach((bucket) => {
    const uniqueKeys = new Set(bucket.map((signal) => signal.environmentKey));
    if (uniqueKeys.size <= 1) return;
    const ordered = [...bucket].sort((a, b) => stableHash(a.environmentKey) - stableHash(b.environmentKey));
    ordered.forEach((signal, index) => {
      const offset = (index - (ordered.length - 1) / 2) * 0.014;
      signal.ppm += offset;
      signal.label = `${signal.label}; tiny deterministic tie-break ${offset >= 0 ? "+" : ""}${offset.toFixed(2)} ppm`;
    });
  });
  return signals;
}

function predictEnvironments(graph) {
  const context = {
    distances: computeDistanceMatrix(graph),
    groups: classifyFunctionalGroups(graph),
    charges: estimatePartialCharges(graph)
  };
  const protonItems = [];
  const carbonItems = [];

  graph.atoms.forEach((atom) => {
    if (atom.hydrogens > 0 && ["C", "O", "N", "S", "Se", "Te"].includes(atom.element)) {
      const base = baseProtonShift(graph, atom);
      if (base) {
        const correction = correctionForAtom(graph, atom, "1H", context);
        const splitEnvironments = base.broad ? [] : adjacentHydrogenEnvironments(graph, atom);
        const n = splitEnvironments.reduce((sum, environment) => sum + environment.count, 0);
        const splitKey = splitEnvironments.map((environment) => `${environment.label || "adj"}:${environment.count}:${environment.jHz.toFixed(1)}`).join("/");
        const environmentKey = `1H|${radiusEnvironmentKey(graph, atom, 3)}|split:${splitKey}|${base.broad ? "broad" : "sharp"}`;
        protonItems.push({
          nucleus: "1H",
          atomIds: [atom.id + 1],
          sourceAtomIds: [atom.id + 1],
          carrierAtomIds: [atom.id + 1],
          rawPpm: clampShift(base.ppm + correction.ppm, "1H"),
          integration: atom.hydrogens,
          multiplicity: base.broad ? "broad s" : multiplicityFromEnvironments(splitEnvironments),
          neighborH: n,
          splitEnvironments,
          broad: Boolean(base.broad),
          environmentKey,
          signalId: `H-${stableHash(environmentKey).toString(16)}-${atom.id + 1}`,
          label: [base.label, ...correction.labels].join("; ")
        });
      }
    }
    if (atom.element === "C") {
      const base = baseCarbonShift(graph, atom);
      const correction = correctionForAtom(graph, atom, "13C", context);
      const environmentKey = `13C|${radiusEnvironmentKey(graph, atom, 3)}`;
      carbonItems.push({
        nucleus: "13C",
        atomIds: [atom.id + 1],
        sourceAtomIds: [atom.id + 1],
        carrierAtomIds: [atom.id + 1],
        rawPpm: clampShift(base.ppm + correction.ppm, "13C"),
        integration: 1,
        multiplicity: "s",
        neighborH: 0,
        broad: false,
        environmentKey,
        signalId: `C-${stableHash(environmentKey).toString(16)}-${atom.id + 1}`,
        label: [base.label, ...correction.labels].join("; ")
      });
    }
  });

  const proton = attachComponents(mergeEnvironmentKeys(protonItems), "proton");
  const carbon = attachComponents(mergeEnvironmentKeys(carbonItems), "carbon");
  return { proton, carbon };
}

function buildAtomToSignalIndex(signals, keys) {
  const map = new Map();
  signals.forEach((signal) => {
    keys.forEach((key) => {
      (signal[key] || []).forEach((atomId) => {
        if (!map.has(atomId)) map.set(atomId, []);
        map.get(atomId).push(signal);
      });
    });
  });
  return map;
}

function buildSignalIndices(predictions) {
  const protonByCarrier = buildAtomToSignalIndex(predictions.proton, ["carrierAtomIds", "sourceAtomIds"]);
  const carbonBySource = buildAtomToSignalIndex(predictions.carbon, ["sourceAtomIds"]);
  return { protonByCarrier, carbonBySource };
}

function findProtonSignalForAtom(atomId, protonSignals) {
  return protonSignals.find((signal) => (signal.carrierAtomIds || []).includes(atomId)) || null;
}

function findCarbonSignalForAtom(atomId, carbonSignals) {
  return carbonSignals.find((signal) => (signal.sourceAtomIds || []).includes(atomId)) || null;
}

function signalLabel(signal) {
  return `${signal.nucleus} ${signal.ppm.toFixed(2)} ppm (atoms ${signal.atomIds.join(",")})`;
}

function isExchangeableProtonCarrier(graph, atom) {
  return atom.element === "O" || atom.element === "N" || atom.element === "S";
}

function areCosyCoupled(graph, atomA, atomB) {
  if (!atomA || !atomB || atomA.id === atomB.id) return false;
  const bond = graph.bonds.find((entry) =>
    (entry.from === atomA.id && entry.to === atomB.id)
    || (entry.from === atomB.id && entry.to === atomA.id)
  );
  if (!bond) return false;
  if (atomA.aromatic && atomB.aromatic && atomA.hydrogens > 0 && atomB.hydrogens > 0) return true;
  if (atomA.element === "C" && atomB.element === "C" && atomA.hydrogens > 0 && atomB.hydrogens > 0) {
    return bond.order === 1 || bond.order === 2;
  }
  return false;
}

function predictHsqc(graph, protonSignals, carbonSignals) {
  const peaks = [];
  const seen = new Set();
  const indices = buildSignalIndices({ proton: protonSignals, carbon: carbonSignals });
  graph.atoms.forEach((atom) => {
    if (atom.element !== "C" || atom.hydrogens <= 0) return;
    const atomId = atom.id + 1;
    const carbonSignal = indices.carbonBySource.get(atomId)?.[0] || findCarbonSignalForAtom(atomId, carbonSignals);
    const protonSignal = indices.protonByCarrier.get(atomId)?.[0] || findProtonSignalForAtom(atomId, protonSignals);
    if (!carbonSignal || !protonSignal) return;
    const key = `${protonSignal.signalId}|${carbonSignal.signalId}`;
    if (seen.has(key)) return;
    seen.add(key);
    peaks.push({
      peakId: `HSQC-${stableHash(key).toString(16)}`,
      protonSignalId: protonSignal.signalId,
      carbonSignalId: carbonSignal.signalId,
      protonAtomIds: [...protonSignal.atomIds],
      carbonAtomIds: [...carbonSignal.atomIds],
      x: protonSignal.ppm,
      y: carbonSignal.ppm,
      label: `${protonSignal.atomIds.join(",")} ↔ ${carbonSignal.atomIds.join(",")}`
    });
  });
  return peaks.sort((a, b) => b.y - a.y || b.x - a.x);
}

function predictCosy(graph, protonSignals) {
  const peaks = [];
  const indices = buildAtomToSignalIndex(protonSignals, ["carrierAtomIds", "sourceAtomIds"]);
  protonSignals.forEach((signal) => {
    peaks.push({
      peakId: `COSY-D-${signal.signalId}`,
      signalAId: signal.signalId,
      signalBId: signal.signalId,
      atomIdsA: [...signal.atomIds],
      atomIdsB: [...signal.atomIds],
      x: signal.ppm,
      y: signal.ppm,
      diagonal: true,
      label: `${signal.atomIds.join(",")} diagonal`
    });
  });
  const pairSeen = new Set();
  graph.bonds.forEach((bond) => {
    const atomA = graph.atoms[bond.from];
    const atomB = graph.atoms[bond.to];
    if (!areCosyCoupled(graph, atomA, atomB)) return;
    if (isExchangeableProtonCarrier(graph, atomA) || isExchangeableProtonCarrier(graph, atomB)) return;
    const signalA = indices.get(atomA.id + 1)?.[0] || findProtonSignalForAtom(atomA.id + 1, protonSignals);
    const signalB = indices.get(atomB.id + 1)?.[0] || findProtonSignalForAtom(atomB.id + 1, protonSignals);
    if (!signalA || !signalB || signalA.signalId === signalB.signalId) return;
    const pair = [signalA.signalId, signalB.signalId].sort().join("|");
    if (pairSeen.has(pair)) return;
    pairSeen.add(pair);
    const label = `${signalA.atomIds.join(",")} ↔ ${signalB.atomIds.join(",")}`;
    peaks.push({
      peakId: `COSY-${stableHash(`${pair}-ab`).toString(16)}`,
      signalAId: signalA.signalId,
      signalBId: signalB.signalId,
      atomIdsA: [...signalA.atomIds],
      atomIdsB: [...signalB.atomIds],
      x: signalA.ppm,
      y: signalB.ppm,
      diagonal: false,
      label
    });
    peaks.push({
      peakId: `COSY-${stableHash(`${pair}-ba`).toString(16)}`,
      signalAId: signalB.signalId,
      signalBId: signalA.signalId,
      atomIdsA: [...signalB.atomIds],
      atomIdsB: [...signalA.atomIds],
      x: signalB.ppm,
      y: signalA.ppm,
      diagonal: false,
      label
    });
  });
  return peaks.sort((a, b) => b.y - a.y || b.x - a.x);
}

function parseMolblockAtomCoordinates(molblock, atomCount) {
  if (!molblock || !Number.isFinite(atomCount) || atomCount <= 0) return [];
  const lines = String(molblock).split(/\r?\n/);
  if (lines.length < 5) return [];
  const atomLines = lines.slice(4, 4 + atomCount);
  return atomLines.map((line) => {
    const x = Number(line.slice(0, 10).trim());
    const y = Number(line.slice(10, 20).trim());
    const z = Number(line.slice(20, 30).trim());
    if (![x, y, z].every(Number.isFinite)) {
      return null;
    }
    return { x, y, z };
  }).filter(Boolean);
}

function parseMolblockAtoms(molblock, atomCount = molblockAtomCount(molblock)) {
  if (!molblock || !Number.isFinite(atomCount) || atomCount <= 0) return [];
  const lines = String(molblock).split(/\r?\n/);
  if (lines.length < 4 + atomCount) return [];
  return lines.slice(4, 4 + atomCount).map((line) => {
    const x = Number(line.slice(0, 10).trim());
    const y = Number(line.slice(10, 20).trim());
    const z = Number(line.slice(20, 30).trim());
    const element = line.slice(31, 34).trim() || "C";
    if (![x, y, z].every(Number.isFinite)) return null;
    return { element, x, y, z };
  }).filter(Boolean);
}

function heavyAtomCoordinatesFromMolblock(molblock, graph) {
  const atomCount = molblockAtomCount(molblock);
  const molAtoms = parseMolblockAtoms(molblock, atomCount);
  const heavyAtoms = molAtoms.filter((atom) => atom.element !== "H");
  if (heavyAtoms.length < graph.atoms.length) return [];
  const graphElements = graph.atoms.map((atom) => atom.element);
  const sdfElements = heavyAtoms.slice(0, graph.atoms.length).map((atom) => atom.element);
  const sameElementOrder = graphElements.every((element, index) => element === sdfElements[index]);
  if (!sameElementOrder) {
    return [];
  }
  return heavyAtoms.slice(0, graph.atoms.length).map(({ x, y, z }) => ({ x, y, z }));
}

function molblockAtomCount(molblock) {
  const lines = String(molblock || "").split(/\r?\n/);
  if (lines.length < 4) return 0;
  const count = Number.parseInt(lines[3].slice(0, 3).trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

function withMolblockCoordinates(molblock, coordinates, atomCount) {
  if (!molblock || !Array.isArray(coordinates) || !Number.isFinite(atomCount) || atomCount <= 0) {
    return molblock;
  }
  const lines = String(molblock).split(/\r?\n/);
  if (lines.length < 4 + atomCount) {
    return molblock;
  }
  for (let i = 0; i < atomCount; i += 1) {
    const point = coordinates[i];
    if (!point || ![point.x, point.y, point.z].every(Number.isFinite)) {
      continue;
    }
    const original = lines[4 + i] || "";
    const tail = original.length > 30 ? original.slice(30) : " C   0  0  0  0  0  0  0  0  0  0  0  0";
    const xyz = `${point.x.toFixed(4).padStart(10)}${point.y.toFixed(4).padStart(10)}${point.z.toFixed(4).padStart(10)}`;
    lines[4 + i] = `${xyz}${tail}`;
  }
  return lines.join("\n");
}

function fallbackNoesyCoordinates(graph) {
  const coords = [];
  graph.atoms.forEach((atom) => {
    const angle = (atom.id / Math.max(1, graph.atoms.length)) * Math.PI * 2;
    const degree = neighbors(graph, atom).length;
    coords.push({
      x: Math.cos(angle) * (1 + degree * 0.25),
      y: Math.sin(angle) * (1 + degree * 0.25),
      z: (atom.id % 3) * 0.55 + degree * 0.2
    });
  });
  return coords;
}

function seedOutOfPlaneCoordinates(graph, flatCoordinates) {
  const fallback = fallbackNoesyCoordinates(graph);
  return flatCoordinates.map((point, index) => {
    const atom = graph.atoms[index];
    const neighborCount = neighbors(graph, atom).length;
    const isLikelySp3 = atom.element === "C"
      && !atom.aromatic
      && !isAlkeneCarbon(graph, atom)
      && !isAlkyneCarbon(graph, atom)
      && neighborCount >= 3;
    const baseZ = fallback[index]?.z ?? (((index % 3) - 1) * 0.22);
    const zScale = isLikelySp3 ? 0.48 : 0.28;
    return {
      x: point.x,
      y: point.y,
      z: baseZ * zScale
    };
  });
}

function bondTargetLength(order) {
  if (order >= 2.5) return 1.22;
  if (order >= 1.75) return 1.34;
  if (order >= 1.25) return 1.40;
  return 1.52;
}

function minimizeDisplayCoordinates(graph, coordinates, options = {}) {
  if (!graph?.atoms?.length || !Array.isArray(coordinates) || coordinates.length < graph.atoms.length) {
    return coordinates;
  }
  const iterations = Number.isFinite(options.iterations) ? options.iterations : 22;
  const stepSize = Number.isFinite(options.stepSize) ? options.stepSize : 0.14;
  const maxStep = Number.isFinite(options.maxStep) ? options.maxStep : 0.085;
  const springK = Number.isFinite(options.springK) ? options.springK : 0.48;
  const repulsionK = Number.isFinite(options.repulsionK) ? options.repulsionK : 0.055;
  const repulsionCutoff = Number.isFinite(options.repulsionCutoff) ? options.repulsionCutoff : 2.2;

  const points = coordinates.slice(0, graph.atoms.length).map((point, index) => ({
    x: Number.isFinite(point?.x) ? point.x : index * 0.3,
    y: Number.isFinite(point?.y) ? point.y : 0,
    z: Number.isFinite(point?.z) ? point.z : ((index % 3) - 1) * 0.25
  }));

  const bondedPairs = new Set();
  graph.bonds.forEach((bond) => {
    const a = Math.min(bond.from, bond.to);
    const b = Math.max(bond.from, bond.to);
    bondedPairs.add(`${a}|${b}`);
  });

  for (let iter = 0; iter < iterations; iter += 1) {
    const forces = points.map(() => ({ x: 0, y: 0, z: 0 }));

    graph.bonds.forEach((bond) => {
      const a = bond.from;
      const b = bond.to;
      const dx = points[b].x - points[a].x;
      const dy = points[b].y - points[a].y;
      const dz = points[b].z - points[a].z;
      const dist = Math.max(1e-4, Math.hypot(dx, dy, dz));
      const target = bondTargetLength(bond.order);
      const stretch = dist - target;
      const magnitude = springK * stretch;
      const ux = dx / dist;
      const uy = dy / dist;
      const uz = dz / dist;
      forces[a].x += magnitude * ux;
      forces[a].y += magnitude * uy;
      forces[a].z += magnitude * uz;
      forces[b].x -= magnitude * ux;
      forces[b].y -= magnitude * uy;
      forces[b].z -= magnitude * uz;
    });

    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        if (bondedPairs.has(`${i}|${j}`)) continue;
        const dx = points[j].x - points[i].x;
        const dy = points[j].y - points[i].y;
        const dz = points[j].z - points[i].z;
        const dist = Math.max(1e-4, Math.hypot(dx, dy, dz));
        if (dist > repulsionCutoff) continue;
        const magnitude = repulsionK / (dist * dist);
        const ux = dx / dist;
        const uy = dy / dist;
        const uz = dz / dist;
        forces[i].x -= magnitude * ux;
        forces[i].y -= magnitude * uy;
        forces[i].z -= magnitude * uz;
        forces[j].x += magnitude * ux;
        forces[j].y += magnitude * uy;
        forces[j].z += magnitude * uz;
      }
    }

    points.forEach((point, index) => {
      let moveX = forces[index].x * stepSize;
      let moveY = forces[index].y * stepSize;
      let moveZ = forces[index].z * stepSize;
      const moveLength = Math.hypot(moveX, moveY, moveZ);
      if (moveLength > maxStep) {
        const scale = maxStep / moveLength;
        moveX *= scale;
        moveY *= scale;
        moveZ *= scale;
      }
      point.x += moveX;
      point.y += moveY;
      point.z += moveZ;
    });
  }

  const centroid = points.reduce((sum, point) => ({
    x: sum.x + point.x,
    y: sum.y + point.y,
    z: sum.z + point.z
  }), { x: 0, y: 0, z: 0 });
  centroid.x /= points.length;
  centroid.y /= points.length;
  centroid.z /= points.length;

  return points.map((point) => ({
    x: point.x - centroid.x,
    y: point.y - centroid.y,
    z: point.z - centroid.z
  }));
}

function tryInvokeRdkitFunction(target, name, argsList) {
  if (!target || typeof target[name] !== "function") return false;
  for (const args of argsList) {
    try {
      target[name](...args);
      return true;
    } catch (error) {
      // Try the next signature.
    }
  }
  return false;
}

function tryInvokeRdkitFunctionWithResult(target, name, argsList) {
  if (!target || typeof target[name] !== "function") return { ok: false, result: null };
  for (const args of argsList) {
    try {
      return { ok: true, result: target[name](...args) };
    } catch (error) {
      // Try the next signature.
    }
  }
  return { ok: false, result: null };
}

function tryRdkitNativeMinimization(mol, rdkitModule) {
  if (!mol) return false;
  const molAttempts = [
    ["add_hs", [[]]],
    ["EmbedMolecule", [[], [0], [25]]],
    ["embed_molecule", [[], [0], [25]]],
    ["MMFFOptimizeMolecule", [[], [150], [200]]],
    ["UFFOptimizeMolecule", [[], [150], [200]]],
    ["MMFFOptimizeMoleculeConfs", [[], [150], [200]]],
    ["UFFOptimizeMoleculeConfs", [[], [150], [200]]]
  ];
  let didWork = false;
  molAttempts.forEach(([name, argsList]) => {
    if (tryInvokeRdkitFunction(mol, name, argsList)) {
      didWork = true;
    }
  });

  const moduleAttempts = [
    ["EmbedMolecule", [[mol], [mol, 0], [mol, 25]]],
    ["MMFFOptimizeMolecule", [[mol], [mol, 150], [mol, 200]]],
    ["UFFOptimizeMolecule", [[mol], [mol, 150], [mol, 200]]],
    ["MMFFOptimizeMoleculeConfs", [[mol], [mol, 150], [mol, 200]]],
    ["UFFOptimizeMoleculeConfs", [[mol], [mol, 150], [mol, 200]]]
  ];
  moduleAttempts.forEach(([name, argsList]) => {
    if (tryInvokeRdkitFunction(rdkitModule, name, argsList)) {
      didWork = true;
    }
  });
  return didWork;
}

function cactus3dUrl(smiles) {
  return `https://cactus.nci.nih.gov/chemical/structure/${encodeURIComponent(smiles)}/file?format=sdf&get3d=true`;
}

async function fetchCactus3DSdf(smiles) {
  const key = String(smiles || "").trim();
  if (!key || typeof fetch !== "function") return null;
  if (state.cactusCache.has(key)) {
    return state.cactusCache.get(key);
  }
  const request = fetch(cactus3dUrl(key), {
    headers: {
      Accept: "chemical/x-mdl-sdfile, text/plain;q=0.9, */*;q=0.1"
    }
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`CACTUS 3D request failed (${response.status}).`);
      }
      const sdf = await response.text();
      if (!sdf || !sdf.includes("M  END") || molblockAtomCount(sdf) <= 0) {
        throw new Error("CACTUS returned an invalid 3D SDF.");
      }
      return sdf;
    })
    .catch(() => null);
  state.cactusCache.set(key, request);
  return request;
}

async function resolveCactus3d(smiles, graph) {
  const sdf = await fetchCactus3DSdf(smiles);
  if (!sdf) {
    return { sdf: null, coordinates: [], source: "fallback" };
  }
  const coordinates = heavyAtomCoordinatesFromMolblock(sdf, graph);
  return {
    sdf,
    coordinates,
    source: coordinates.length >= graph.atoms.length ? "cactus" : "cactus-viewer-only"
  };
}

function rdkitDisplayCoordinates(smiles, graph) {
  if (!state.rdkit || !smiles) {
    return minimizeDisplayCoordinates(graph, fallbackNoesyCoordinates(graph));
  }
  let mol = null;
  try {
    mol = state.rdkit.get_mol(smiles);
    if (!mol) {
      return minimizeDisplayCoordinates(graph, fallbackNoesyCoordinates(graph));
    }
    if (mol.get_new_coords) {
      mol.get_new_coords();
    }
    const nativeMinimized = tryRdkitNativeMinimization(mol, state.rdkit);
    const atomCount = mol.get_num_atoms ? Number(mol.get_num_atoms()) : graph.atoms.length;
    const coords = parseMolblockAtomCoordinates(mol.get_molblock?.(), atomCount);
    if (coords.length < graph.atoms.length) {
      return minimizeDisplayCoordinates(graph, rdkitNoesyCoordinates(smiles, graph));
    }
    const allFlat = coords.every((point) => Math.abs(point.z) < 1e-4);
    const fallback = allFlat ? fallbackNoesyCoordinates(graph) : null;
    const lifted = allFlat
      ? coords.map((point, index) => ({
          x: point.x,
          y: point.y,
          z: fallback[index]?.z ?? 0
        }))
      : coords;
    return nativeMinimized ? lifted : minimizeDisplayCoordinates(graph, lifted);
  } catch (error) {
    return minimizeDisplayCoordinates(graph, rdkitNoesyCoordinates(smiles, graph));
  } finally {
    if (mol?.delete) mol.delete();
  }
}

function rdkitDisplayMolblock(smiles, graph) {
  if (!state.rdkit || !smiles) return null;
  let mol = null;
  const ownedMols = [];
  const adoptMol = (candidate) => {
    if (!candidate || candidate === mol || typeof candidate.get_molblock !== "function") return false;
    mol = candidate;
    if (!ownedMols.includes(candidate)) {
      ownedMols.push(candidate);
    }
    return true;
  };
  try {
    mol = state.rdkit.get_mol(smiles);
    if (!mol) return null;
    ownedMols.push(mol);

    const addHsCalls = [
      tryInvokeRdkitFunctionWithResult(mol, "add_hs", [[], [true], [1]]),
      tryInvokeRdkitFunctionWithResult(mol, "AddHs", [[], [true], [1]]),
      tryInvokeRdkitFunctionWithResult(mol, "addHs", [[], [true], [1]]),
      tryInvokeRdkitFunctionWithResult(state.rdkit, "add_hs", [[mol], [mol, true], [mol, 1]]),
      tryInvokeRdkitFunctionWithResult(state.rdkit, "AddHs", [[mol], [mol, true], [mol, 1]]),
      tryInvokeRdkitFunctionWithResult(state.rdkit, "addHs", [[mol], [mol, true], [mol, 1]])
    ];
    addHsCalls.forEach((attempt) => {
      if (attempt.ok) {
        adoptMol(attempt.result);
      }
    });

    const embedCalls = [
      tryInvokeRdkitFunction(mol, "EmbedMolecule", [[], [0], [25], [50], [200]]),
      tryInvokeRdkitFunction(mol, "embed_molecule", [[], [0], [25], [50], [200]]),
      tryInvokeRdkitFunction(mol, "embedMolecule", [[], [0], [25], [50], [200]]),
      tryInvokeRdkitFunction(state.rdkit, "EmbedMolecule", [[mol], [mol, 0], [mol, 25], [mol, 50], [mol, 200]]),
      tryInvokeRdkitFunction(state.rdkit, "embed_molecule", [[mol], [mol, 0], [mol, 25], [mol, 50], [mol, 200]]),
      tryInvokeRdkitFunction(state.rdkit, "embedMolecule", [[mol], [mol, 0], [mol, 25], [mol, 50], [mol, 200]])
    ];
    const didEmbed = embedCalls.some(Boolean);
    if (!didEmbed && mol.get_new_coords) {
      // Some RDKit.js builds only expose this coordinate generator.
      mol.get_new_coords();
    }

    tryRdkitNativeMinimization(mol, state.rdkit);
    const molblock = mol.get_molblock?.();
    const atomCount = molblockAtomCount(molblock);
    if (!molblock || atomCount <= 0 || atomCount < graph.atoms.length) {
      return null;
    }
    const coords = parseMolblockAtomCoordinates(molblock, atomCount);
    if (coords.length < graph.atoms.length) {
      return molblock;
    }
    const allFlat = coords.slice(0, graph.atoms.length).every((point) => Math.abs(point.z) < 1e-4);
    if (!allFlat) {
      return molblock;
    }
    // If RDKit still yields flat coordinates, return null so caller can use
    // a fallback model rather than pretending this is 3D.
    return null;
  } catch (error) {
    return null;
  } finally {
    ownedMols.forEach((entry) => {
      if (entry?.delete) {
        entry.delete();
      }
    });
  }
}

function rdkitNoesyCoordinates(smiles, graph) {
  if (!state.rdkit || !smiles) {
    return fallbackNoesyCoordinates(graph);
  }
  let mol = null;
  try {
    mol = state.rdkit.get_mol(smiles);
    if (!mol) return fallbackNoesyCoordinates(graph);
    if (mol.get_new_coords) {
      mol.get_new_coords();
    }
    const atomCount = mol.get_num_atoms ? Number(mol.get_num_atoms()) : graph.atoms.length;
    const coords = parseMolblockAtomCoordinates(mol.get_molblock?.(), atomCount);
    if (coords.length < graph.atoms.length) {
      return fallbackNoesyCoordinates(graph);
    }
    const allFlat = coords.every((point) => Math.abs(point.z) < 1e-4);
    if (allFlat) {
      const lifted = fallbackNoesyCoordinates(graph);
      return coords.map((point, index) => ({
        x: point.x,
        y: point.y,
        z: lifted[index]?.z ?? 0
      }));
    }
    return coords;
  } catch (error) {
    return fallbackNoesyCoordinates(graph);
  } finally {
    if (mol?.delete) mol.delete();
  }
}

function centroidForSignal(signal, atomCoordinates) {
  const carriers = dedupeSortedNumeric(signal.carrierAtomIds || signal.sourceAtomIds || []);
  const points = carriers
    .map((atomId) => atomCoordinates[atomId - 1])
    .filter((point) => point && [point.x, point.y, point.z].every(Number.isFinite));
  if (!points.length) return null;
  const totals = points.reduce((sum, point) => ({
    x: sum.x + point.x,
    y: sum.y + point.y,
    z: sum.z + point.z
  }), { x: 0, y: 0, z: 0 });
  return {
    x: totals.x / points.length,
    y: totals.y / points.length,
    z: totals.z / points.length
  };
}

function noesyDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function noesyVolume(distance) {
  const safeDistance = Math.max(1.6, distance);
  return 1 / (safeDistance ** 6);
}

function predictNoesy(graph, protonSignals, smiles = "", atomCoordinatesOverride = null) {
  const peaks = [];
  const atomCoordinates = Array.isArray(atomCoordinatesOverride) && atomCoordinatesOverride.length >= graph.atoms.length
    ? atomCoordinatesOverride
    : rdkitNoesyCoordinates(smiles, graph);
  const activeSignals = protonSignals
    .filter((signal) => signal.nucleus === "1H")
    .filter((signal) => {
      const carrierIds = signal.carrierAtomIds || signal.sourceAtomIds || [];
      return carrierIds.some((atomId) => {
        const atom = graph.atoms[atomId - 1];
        return atom && !isExchangeableProtonCarrier(graph, atom);
      });
    })
    .map((signal) => ({ signal, centroid: centroidForSignal(signal, atomCoordinates) }))
    .filter((entry) => entry.centroid);
  if (!activeSignals.length) {
    return peaks;
  }

  const offDiagonal = [];
  for (let i = 0; i < activeSignals.length; i += 1) {
    for (let j = i + 1; j < activeSignals.length; j += 1) {
      const a = activeSignals[i];
      const b = activeSignals[j];
      const distance = noesyDistance(a.centroid, b.centroid);
      if (!Number.isFinite(distance) || distance > 5) continue;
      const volume = noesyVolume(distance);
      const pairKey = [a.signal.signalId, b.signal.signalId].sort().join("|");
      const label = `H${a.signal.atomIds.join(",")} ↔ H${b.signal.atomIds.join(",")} (${distance.toFixed(2)} Å)`;
      offDiagonal.push({
        pairKey,
        signalA: a.signal,
        signalB: b.signal,
        distance,
        volume,
        label
      });
    }
  }

  const maxVolume = Math.max(1e-9, ...offDiagonal.map((peak) => peak.volume));
  const diagonalScale = 0.35;
  activeSignals.forEach(({ signal }) => {
    peaks.push({
      peakId: `NOESY-D-${signal.signalId}`,
      signalAId: signal.signalId,
      signalBId: signal.signalId,
      atomIdsA: [...signal.atomIds],
      atomIdsB: [...signal.atomIds],
      x: signal.ppm,
      y: signal.ppm,
      distance: 0,
      volume: maxVolume * diagonalScale,
      diagonal: true,
      label: `H${signal.atomIds.join(",")} diagonal`
    });
  });

  offDiagonal.forEach((pair) => {
    const normalizedVolume = pair.volume / maxVolume;
    peaks.push({
      peakId: `NOESY-${stableHash(`${pair.pairKey}-ab`).toString(16)}`,
      signalAId: pair.signalA.signalId,
      signalBId: pair.signalB.signalId,
      atomIdsA: [...pair.signalA.atomIds],
      atomIdsB: [...pair.signalB.atomIds],
      x: pair.signalA.ppm,
      y: pair.signalB.ppm,
      distance: pair.distance,
      volume: normalizedVolume,
      diagonal: false,
      label: pair.label
    });
    peaks.push({
      peakId: `NOESY-${stableHash(`${pair.pairKey}-ba`).toString(16)}`,
      signalAId: pair.signalB.signalId,
      signalBId: pair.signalA.signalId,
      atomIdsA: [...pair.signalB.atomIds],
      atomIdsB: [...pair.signalA.atomIds],
      x: pair.signalB.ppm,
      y: pair.signalA.ppm,
      distance: pair.distance,
      volume: normalizedVolume,
      diagonal: false,
      label: pair.label
    });
  });

  return peaks.sort((a, b) => b.y - a.y || b.x - a.x);
}

function graphToXyz(graph, coordinates) {
  const lines = [String(graph.atoms.length), "Teaching model for NMR predictor"];
  graph.atoms.forEach((atom, index) => {
    const point = coordinates[index] || { x: 0, y: 0, z: 0 };
    lines.push(`${atom.element} ${point.x.toFixed(5)} ${point.y.toFixed(5)} ${point.z.toFixed(5)}`);
  });
  return lines.join("\n");
}

function vectorLength(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalizeVector(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const length = vectorLength(vector);
  if (!Number.isFinite(length) || length < 1e-8) return { ...fallback };
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function crossProduct(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function estimateExchangeableHydrogenDirections(graph, atom, heavyCoordinates) {
  const parent = heavyCoordinates[atom.id] || { x: 0, y: 0, z: 0 };
  const neighbourVectors = neighbors(graph, atom)
    .map(({ atom: n }) => heavyCoordinates[n.id])
    .filter((point) => point && [point.x, point.y, point.z].every(Number.isFinite))
    .map((point) => ({
      x: point.x - parent.x,
      y: point.y - parent.y,
      z: point.z - parent.z
    }))
    .map((vector) => normalizeVector(vector))
    .filter((vector) => Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z));

  const away = neighbourVectors.reduce((sum, vector) => ({
    x: sum.x - vector.x,
    y: sum.y - vector.y,
    z: sum.z - vector.z
  }), { x: 0, y: 0, z: 0 });
  const primary = normalizeVector(away);
  const helper = Math.abs(primary.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const tangent = normalizeVector(crossProduct(primary, helper), { x: 0, y: 1, z: 0 });
  const bitangent = normalizeVector(crossProduct(primary, tangent), { x: 0, y: 0, z: 1 });
  const count = Math.max(1, atom.hydrogens || 1);

  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    const mixed = {
      x: primary.x + 0.36 * (Math.cos(angle) * tangent.x + Math.sin(angle) * bitangent.x),
      y: primary.y + 0.36 * (Math.cos(angle) * tangent.y + Math.sin(angle) * bitangent.y),
      z: primary.z + 0.36 * (Math.cos(angle) * tangent.z + Math.sin(angle) * bitangent.z)
    };
    return normalizeVector(mixed, primary);
  });
}

function formatMolAtomLine(element, point) {
  const x = point.x.toFixed(4).padStart(10);
  const y = point.y.toFixed(4).padStart(10);
  const z = point.z.toFixed(4).padStart(10);
  const symbol = String(element || "C").slice(0, 3).padEnd(3, " ");
  return `${x}${y}${z} ${symbol} 0  0  0  0  0  0  0  0  0  0  0  0`;
}

function formatMolBondLine(fromIndex, toIndex, order = 1) {
  return `${String(fromIndex).padStart(3)}${String(toIndex).padStart(3)}${String(order).padStart(3)}  0  0  0  0`;
}

function graphToMolblock(graph, coordinates) {
  const heavyAtoms = graph.atoms.map((atom, index) => ({
    element: atom.element,
    point: coordinates[index] || { x: 0, y: 0, z: 0 }
  }));
  const atoms = [...heavyAtoms];
  const bonds = graph.bonds.map((bond) => ({
    from: bond.from + 1,
    to: bond.to + 1,
    order: bond.order >= 2.5 ? 3 : bond.order >= 1.5 ? 2 : 1
  }));

  graph.atoms.forEach((atom) => {
    if (!["O", "N", "S"].includes(atom.element) || !Number.isFinite(atom.hydrogens) || atom.hydrogens <= 0) {
      return;
    }
    const parent = coordinates[atom.id] || { x: 0, y: 0, z: 0 };
    const directions = estimateExchangeableHydrogenDirections(graph, atom, coordinates);
    const bondLength = atom.element === "S" ? 1.34 : 1.01;
    directions.slice(0, atom.hydrogens).forEach((direction) => {
      const hydrogenPoint = {
        x: parent.x + direction.x * bondLength,
        y: parent.y + direction.y * bondLength,
        z: parent.z + direction.z * bondLength
      };
      atoms.push({ element: "H", point: hydrogenPoint });
      bonds.push({ from: atom.id + 1, to: atoms.length, order: 1 });
    });
  });

  const atomCount = Math.min(999, atoms.length);
  const bondCount = Math.min(999, bonds.length);
  const lines = [
    "NMR Predictor 3D model",
    "  NMRPRED",
    "Teaching geometry with explicit bonds",
    `${String(atomCount).padStart(3)}${String(bondCount).padStart(3)}  0  0  0  0  0  0  0  0  0  0  0  0  0  0 V2000`
  ];

  atoms.slice(0, atomCount).forEach((atom) => {
    lines.push(formatMolAtomLine(atom.element, atom.point));
  });
  bonds.slice(0, bondCount).forEach((bond) => {
    lines.push(formatMolBondLine(bond.from, bond.to, bond.order));
  });
  lines.push("M  END");
  return lines.join("\n");
}

function getSpectrumFullscreenTarget() {
  return NMRP.spectrum?.closest(".plot-panel") || NMRP.spectrum;
}

function isSpectrumFullscreen() {
  const target = getSpectrumFullscreenTarget();
  return Boolean(target && (document.fullscreenElement === target || document.webkitFullscreenElement === target));
}

function refreshResizableViews() {
  window.Plotly?.Plots?.resize?.(NMRP.spectrum);
  state.viewer3d?.resize?.();
  state.viewer3d?.render?.();
}

function updateFullscreenButtonLabel() {
  if (!NMRP.fullscreen) return;
  NMRP.fullscreen.textContent = isSpectrumFullscreen() ? "Exit Full Screen" : "Full Screen";
}

function toggleSpectrumFullscreen() {
  const target = getSpectrumFullscreenTarget();
  if (!target) return;
  if (isSpectrumFullscreen()) {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {
        setPredictorStatus("Could not exit full screen mode.", true);
      });
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
    return;
  }
  if (target.requestFullscreen) {
    target.requestFullscreen().catch(() => {
      setPredictorStatus("Fullscreen mode was blocked by the browser.", true);
    });
  } else if (target.webkitRequestFullscreen) {
    target.webkitRequestFullscreen();
  }
}

function selectedAtomIdsFromSignals() {
  const selectedSignals = getSelectedSignals();
  return dedupeSortedNumeric(selectedSignals.flatMap((signal) => signal.atomIds || []));
}

function tryRender3d(smiles) {
  if (!NMRP.structure3d) return;
  if (!window.$3Dmol) {
    NMRP.structure3d.innerHTML = '<div class="plot-empty">3Dmol.js did not load. Check network access and refresh.</div>';
    return;
  }
  if (!state.graph?.atoms?.length) {
    NMRP.structure3d.innerHTML = '<div class="plot-empty">Predict a molecule to view a 3D model.</div>';
    return;
  }
  if (!state.viewer3d) {
    NMRP.structure3d.innerHTML = "";
    state.viewer3d = window.$3Dmol.createViewer(NMRP.structure3d, {
      backgroundColor: "white"
    });
  }
  const viewer = state.viewer3d;
  const cactusSdf = state.cactus3d?.sdf || null;
  const rdkitMolblock = rdkitDisplayMolblock(smiles, state.graph);
  const coordinateSource = state.cactus3d?.coordinates?.length >= state.graph.atoms.length
    ? state.cactus3d.coordinates
    : rdkitNoesyCoordinates(smiles, state.graph);
  const coordinates = minimizeDisplayCoordinates(state.graph, seedOutOfPlaneCoordinates(state.graph, coordinateSource));
  const molblock = graphToMolblock(state.graph, coordinates);
  const xyz = graphToXyz(state.graph, coordinates);
  const candidates = [];
  if (cactusSdf) {
    candidates.push({ data: cactusSdf, format: "sdf" });
  }
  if (rdkitMolblock) {
    candidates.push({ data: rdkitMolblock, format: "mol" });
    candidates.push({ data: `${rdkitMolblock}\n$$$$`, format: "sdf" });
  }
  candidates.push({ data: molblock, format: "mol" });
  candidates.push({ data: `${molblock}\n$$$$`, format: "sdf" });
  candidates.push({ data: xyz, format: "xyz" });
  let loaded = false;
  for (const candidate of candidates) {
    try {
      viewer.clear();
      const model = viewer.addModel(candidate.data, candidate.format);
      if (typeof model?.selectedAtoms === "function") {
        const atomCount = model.selectedAtoms({})?.length || 0;
        if (atomCount <= 0) {
          continue;
        }
      }
      loaded = true;
      break;
    } catch (error) {
      loaded = false;
    }
  }
  if (!loaded) {
    NMRP.structure3d.innerHTML = '<div class="plot-empty">Could not render 3D model for this structure.</div>';
    state.viewer3d = null;
    return;
  }
  viewer.setStyle({}, {
    stick: { radius: 0.17, colorscheme: "Jmol" },
    sphere: { scale: 0.30, colorscheme: "Jmol" }
  });
  const selectedAtomIds = selectedAtomIdsFromSignals();
  if (selectedAtomIds.length) {
    selectedAtomIds.forEach((atomId) => {
      viewer.setStyle({ serial: atomId - 1 }, {
        stick: { radius: 0.23, color: "#a11d37" },
        sphere: { scale: 0.42, color: "#a11d37" }
      });
    });
  }
  viewer.zoomTo();
  viewer.render();
}

function clampShift(ppm, nucleus) {
  if (nucleus === "13C") return Math.min(220, Math.max(0, ppm));
  return Math.min(13, Math.max(0, ppm));
}

function gaussian(x, center, fwhm) {
  const sigma = fwhm / 2.354820045;
  const z = (x - center) / sigma;
  return Math.exp(-0.5 * z * z);
}

function gaussianAreaHeight(area, fwhm) {
  const sigma = fwhm / 2.354820045;
  return area / (sigma * Math.sqrt(2 * Math.PI));
}

function expandPeaks(environments, type) {
  const peaks = [];
  environments.forEach((env) => {
    if (type === "carbon") {
      peaks.push({ ppm: env.ppm, intensity: Math.max(1, env.atomIds.length), env, fwhm: 0.55 });
      return;
    }
    let components = [{ offsetHz: 0, intensity: 1 }];
    const splitEnvironments = env.broad ? [] : (env.splitEnvironments || []).slice(0, 3);
    splitEnvironments.forEach((splitEnvironment) => {
      const weights = binomialWeights(Math.max(0, Math.min(splitEnvironment.count, 6)));
      const center = (weights.length - 1) / 2;
      const next = [];
      components.forEach((component) => {
        weights.forEach((weight, index) => {
          next.push({
            offsetHz: component.offsetHz + (index - center) * splitEnvironment.jHz,
            intensity: component.intensity * weight
          });
        });
      });
      components = next;
    });
    if (!components.length) {
      components = [{ offsetHz: 0, intensity: 1 }];
    }
    const merged = new Map();
    components.forEach((component) => {
      const ppm = env.ppm + component.offsetHz / 400;
      const key = ppm.toFixed(5);
      merged.set(key, (merged.get(key) || 0) + component.intensity);
    });
    const totalIntensity = Array.from(merged.values()).reduce((sum, intensity) => sum + intensity, 0) || 1;
    Array.from(merged.entries()).forEach(([ppm, intensity]) => {
      const scaledIntensity = (intensity / totalIntensity) * env.integration;
      peaks.push({ ppm: Number(ppm), intensity: scaledIntensity, env, fwhm: env.broad ? 0.22 : 0.0045 });
    });
  });
  return peaks;
}

function attachComponents(signals, type) {
  return signals.map((signal) => {
    const components = expandPeaks([signal], type).map((peak) => ({
      ppm: Number(peak.ppm.toFixed(4)),
      relativeIntensity: peak.intensity
    }));
    return { ...signal, components };
  });
}

function labelItemsForSpectrum(environments, visiblePeaks, type, profileHeightAt) {
  if (type === "proton") {
    return environments.map((env) => {
      const envPeaks = visiblePeaks.filter((peak) => peak.env.signalId === env.signalId);
      const top = envPeaks.reduce((max, peak) => Math.max(max, profileHeightAt(peak.ppm)), 0);
      return { ppm: env.ppm, y: Math.min(99, top + 5), text: `${env.integration}H` };
    });
  }

  const sorted = environments
    .filter((env) => visiblePeaks.some((peak) => peak.env.signalId === env.signalId))
    .sort((a, b) => a.ppm - b.ppm);
  const clusters = [];
  sorted.forEach((env) => {
    const current = clusters[clusters.length - 1];
    if (current && Math.abs(env.ppm - current.lastPpm) <= 0.2) {
      current.signals.push(env);
      current.lastPpm = env.ppm;
    } else {
      clusters.push({ signals: [env], lastPpm: env.ppm });
    }
  });
  return clusters.map((cluster) => {
    const carbonCount = cluster.signals.reduce((sum, env) => sum + env.atomIds.length, 0);
    const ppm = cluster.signals.reduce((sum, env) => sum + env.ppm * env.atomIds.length, 0) / carbonCount;
    const top = cluster.signals.reduce((max, env) => {
      const envPeaks = visiblePeaks.filter((peak) => peak.env.signalId === env.signalId);
      return Math.max(max, envPeaks.reduce((peakMax, peak) => Math.max(peakMax, profileHeightAt(peak.ppm)), 0));
    }, 0);
    return { ppm, y: Math.min(99, top + 5), text: `${carbonCount}C` };
  });
}

function renderSpectrum(environments, type) {
  if (!environments.length) {
    NMRP.spectrum.innerHTML = '<div class="plot-empty">No predicted signals for this nucleus.</div>';
    return;
  }
  if (!window.Plotly) {
    NMRP.spectrum.innerHTML = '<div class="plot-empty">Plotly.js did not load. Check network access and refresh.</div>';
    return;
  }
  const fullDomain = state.defaultDomains[type];
  const domain = state.viewDomains[type] || fullDomain;
  const color = type === "carbon" ? DISPLAY_COLORS.carbon : DISPLAY_COLORS.proton;
  const peaks = expandPeaks(environments, type);
  const fwhm = type === "carbon" ? 0.55 : 0.0045;
  const sampleCount = type === "carbon" ? 1600 : 9000;
  const xValues = [];
  const yValues = [];
  Array.from({ length: sampleCount }, (_, index) => {
    const ppm = fullDomain.min + ((fullDomain.max - fullDomain.min) * index) / (sampleCount - 1);
    const y = peaks.reduce((sum, peak) => {
      const peakFwhm = peak.fwhm || fwhm;
      return sum + gaussianAreaHeight(peak.intensity, peakFwhm) * gaussian(ppm, peak.ppm, peakFwhm);
    }, 0);
    xValues.push(ppm);
    yValues.push(y);
  });
  const maxY = yValues.reduce((max, y, index) => {
    const ppm = xValues[index];
    return ppm >= domain.min && ppm <= domain.max ? Math.max(max, y) : max;
  }, 0) || yValues.reduce((max, y) => Math.max(max, y), 0) || 1;
  const maxPeak = Math.max(...peaks.map((peak) => peak.intensity), 1);
  const visiblePeaks = peaks.filter((peak) => peak.ppm >= domain.min && peak.ppm <= domain.max);
  const profileHeightAt = (ppm) => {
    const y = peaks.reduce((sum, peak) => {
      const peakFwhm = peak.fwhm || fwhm;
      return sum + gaussianAreaHeight(peak.intensity, peakFwhm) * gaussian(ppm, peak.ppm, peakFwhm);
    }, 0);
    return (y / maxY) * 100;
  };
  const showTms = domain.min <= 0 && domain.max >= 0;
  const tmsHeight = 14;
  const labelItems = labelItemsForSpectrum(environments, visiblePeaks, type, profileHeightAt);
  const profileTrace = {
    x: xValues,
    y: yValues.map((y) => (y / maxY) * 100),
    type: "scatter",
    mode: "lines",
    line: { color, width: 2.5 },
    fill: "tozeroy",
    fillcolor: type === "carbon" ? "rgba(217,115,13,0.14)" : "rgba(13,108,116,0.14)",
    hoverinfo: "skip",
    name: "broadened profile"
  };
  const markerTrace = {
    x: [...visiblePeaks.map((peak) => peak.ppm), ...(showTms ? [0] : [])],
    y: [...visiblePeaks.map((peak) => profileHeightAt(peak.ppm)), ...(showTms ? [tmsHeight] : [])],
    type: "scatter",
    mode: "markers",
    marker: {
      color: [...visiblePeaks.map((peak) => state.selectedSignalIds.includes(peak.env.signalId) ? "#a11d37" : color), ...(showTms ? ["#56646f"] : [])],
      size: [...visiblePeaks.map((peak) => state.selectedSignalIds.includes(peak.env.signalId) ? 11 : 7), ...(showTms ? [7] : [])],
      line: { color: "#ffffff", width: 1 }
    },
    customdata: [...visiblePeaks.map((peak) => peak.env.signalId), ...(showTms ? [""] : [])],
    text: [...visiblePeaks.map((peak) => `${peak.env.nucleus} ${peak.env.ppm.toFixed(2)} ppm (${peak.env.multiplicity})<br>Atoms ${peak.env.atomIds.join(", ")}<br>${multipletDetail(peak.env)}<br>${peak.env.label}`), ...(showTms ? ["TMS reference peak<br>0.00 ppm"] : [])],
    hovertemplate: "%{text}<extra></extra>",
    name: "clickable peaks"
  };
  const integralLabelTrace = {
    x: labelItems.map((item) => item.ppm),
    y: labelItems.map((item) => item.y),
    type: "scatter",
    mode: "text",
    text: labelItems.map((item) => item.text),
    textfont: { color: "#18242d", size: 12 },
    textposition: "top center",
    hoverinfo: "skip",
    name: "integrals"
  };
  const shapes = visiblePeaks.map((peak) => ({
    type: "line",
    xref: "x",
    yref: "y",
      x0: peak.ppm,
      x1: peak.ppm,
      y0: 0,
      y1: profileHeightAt(peak.ppm),
    line: {
      color: state.selectedSignalIds.includes(peak.env.signalId) ? "#a11d37" : color,
      width: state.selectedSignalIds.includes(peak.env.signalId) ? 4 : type === "carbon" ? 2.2 : 1.4
    }
  }));
  if (showTms) {
    shapes.push({
      type: "line",
      xref: "x",
      yref: "y",
      x0: 0,
      x1: 0,
      y0: 0,
      y1: tmsHeight,
      line: { color: "#56646f", width: 1.6, dash: "dot" }
    });
  }
  const annotations = showTms ? [{
    x: 0,
    y: tmsHeight + 5,
    text: "TMS",
    showarrow: false,
    font: { size: 11, color: "#56646f" },
    yanchor: "bottom"
  }] : [];
  const layout = {
    autosize: true,
    margin: { t: 34, r: 22, b: 46, l: 42 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(255,255,255,0.72)",
    showlegend: false,
    dragmode: "zoom",
    shapes,
    annotations,
    title: {
      text: `${type === "carbon" ? "13C" : "1H"} predicted spectrum`,
      x: 0.02,
      xanchor: "left",
      font: { size: 13, color: "#18242d" }
    },
    xaxis: {
      title: "Chemical shift (ppm)",
      autorange: false,
      range: [domain.max, domain.min],
      gridcolor: "rgba(24,36,45,0.08)",
      zeroline: false
    },
    yaxis: {
      title: "Relative intensity",
      range: [0, 105],
      gridcolor: "rgba(24,36,45,0.08)",
      zeroline: false,
      fixedrange: true
    }
  };
  const config = {
    responsive: true,
    scrollZoom: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"]
  };
  window.Plotly.react(NMRP.spectrum, [profileTrace, markerTrace, integralLabelTrace], layout, config).then(() => {
    NMRP.spectrum.removeAllListeners?.("plotly_click");
    NMRP.spectrum.removeAllListeners?.("plotly_relayout");
    NMRP.spectrum.on("plotly_click", (event) => {
      const signalId = event.points?.find((point) => point.customdata)?.customdata;
      if (signalId) selectSignal(signalId);
    });
    NMRP.spectrum.on("plotly_relayout", (event) => {
      const min = event["xaxis.range[1]"];
      const max = event["xaxis.range[0]"];
      if (Number.isFinite(min) && Number.isFinite(max)) {
        const nextDomain = { min: Math.min(min, max), max: Math.max(min, max) };
        const currentDomain = state.viewDomains[type];
        const changed = Math.abs(nextDomain.min - currentDomain.min) > 1e-6 || Math.abs(nextDomain.max - currentDomain.max) > 1e-6;
        state.viewDomains[type] = nextDomain;
        if (changed) {
          const render = () => renderSpectrum(state.predictions[type], type);
          if (window.requestAnimationFrame) {
            window.requestAnimationFrame(render);
          } else {
            window.setTimeout(render, 0);
          }
        }
      }
    });
  });
}

function render2DSpectrum(peaks, type) {
  if (!peaks.length) {
    NMRP.spectrum.innerHTML = '<div class="plot-empty">No predicted 2D peaks for this experiment.</div>';
    return;
  }
  if (!window.Plotly) {
    NMRP.spectrum.innerHTML = '<div class="plot-empty">Plotly.js did not load. Check network access and refresh.</div>';
    return;
  }
  const domains = state.viewDomains2D[type];
  const diagonal = peaks.filter((peak) => peak.diagonal);
  const cross = peaks.filter((peak) => !peak.diagonal);
  const markerColor = type === "hsqc" ? "#0d6c74" : type === "noesy" ? "#a23a17" : "#1b6a8e";
  const isPeakSelected = (peak) => {
    const first = peak.signalAId || peak.protonSignalId;
    const second = peak.signalBId || peak.carbonSignalId;
    return state.selectedSignalIds.includes(first) || state.selectedSignalIds.includes(second);
  };
  const maxVolume = Math.max(1e-9, ...cross.map((peak) => peak.volume || 0));
  const markerSizes = cross.map((peak) => {
    if (type !== "noesy") return isPeakSelected(peak) ? 11 : 8;
    const scaled = 6 + ((peak.volume || 0) / maxVolume) * 9;
    return isPeakSelected(peak) ? Math.max(10, scaled + 2) : scaled;
  });
  const markerText = cross.map((peak) => {
    if (type !== "noesy") return peak.label;
    const ppmA = Number.isFinite(peak.x) ? peak.x.toFixed(2) : "?";
    const ppmB = Number.isFinite(peak.y) ? peak.y.toFixed(2) : "?";
    const atomsA = (peak.atomIdsA || []).join(",");
    const atomsB = (peak.atomIdsB || []).join(",");
    return `H${atomsA} (${ppmA} ppm) ↔ H${atomsB} (${ppmB} ppm)<br>distance ${peak.distance.toFixed(2)} Å; relative volume ${peak.volume.toFixed(3)}`;
  });
  const crossTrace = {
    x: cross.map((peak) => peak.x),
    y: cross.map((peak) => peak.y),
    type: "scatter",
    mode: "markers",
    marker: {
      color: cross.map((peak) => (isPeakSelected(peak) ? "#a11d37" : markerColor)),
      size: markerSizes,
      opacity: 0.9,
      line: { color: "#ffffff", width: 1 }
    },
    customdata: cross.map((peak) => peak.peakId),
    text: markerText,
    hovertemplate: "%{text}<extra></extra>",
    name: `${type.toUpperCase()} cross-peaks`
  };
  const diagonalTrace = (type === "cosy" || type === "noesy") ? {
    x: diagonal.map((peak) => peak.x),
    y: diagonal.map((peak) => peak.y),
    type: "scatter",
    mode: "markers",
    marker: { color: "rgba(86,100,111,0.42)", size: type === "noesy" ? 5 : 6 },
    customdata: diagonal.map((peak) => peak.peakId),
    text: diagonal.map((peak) => peak.label),
    hovertemplate: "%{text}<extra></extra>",
    name: `${type.toUpperCase()} diagonal`
  } : null;
  const gaussianBlobTrace = type === "noesy" ? (() => {
    const x = Array.from({ length: 90 }, (_, index) => domains.x.min + ((domains.x.max - domains.x.min) * index) / 89);
    const y = Array.from({ length: 90 }, (_, index) => domains.y.min + ((domains.y.max - domains.y.min) * index) / 89);
    const sigma = 0.10;
    const z = y.map((yv) => x.map((xv) => {
      const sum = cross.reduce((acc, peak) => {
        const dx = xv - peak.x;
        const dy = yv - peak.y;
        const amplitude = peak.volume || 0;
        return acc + amplitude * Math.exp(-((dx * dx) + (dy * dy)) / (2 * sigma * sigma));
      }, 0);
      return sum;
    }));
    return {
      x,
      y,
      z,
      type: "heatmap",
      colorscale: [
        [0.0, "rgba(255,255,255,0.0)"],
        [0.25, "rgba(250,195,122,0.35)"],
        [0.5, "rgba(239,143,86,0.5)"],
        [0.75, "rgba(204,92,56,0.62)"],
        [1.0, "rgba(155,40,20,0.78)"]
      ],
      showscale: false,
      hoverinfo: "skip",
      name: "NOESY blob"
    };
  })() : null;
  const traces = [gaussianBlobTrace, crossTrace, diagonalTrace].filter(Boolean);
  const yTitle = type === "hsqc" ? "13C shift (ppm)" : "1H shift (ppm)";
  const layout = {
    autosize: true,
    margin: { t: 34, r: 22, b: 46, l: 52 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(255,255,255,0.72)",
    showlegend: type === "cosy" || type === "noesy",
    dragmode: "zoom",
    title: {
      text: `${type.toUpperCase()} predicted map`,
      x: 0.02,
      xanchor: "left",
      font: { size: 13, color: "#18242d" }
    },
    xaxis: {
      title: "1H shift (ppm)",
      autorange: "reversed",
      range: [domains.x.max, domains.x.min],
      gridcolor: "rgba(24,36,45,0.08)",
      zeroline: false
    },
    yaxis: {
      title: yTitle,
      autorange: "reversed",
      range: [domains.y.max, domains.y.min],
      gridcolor: "rgba(24,36,45,0.08)",
      zeroline: false
    }
  };
  const config = {
    responsive: true,
    scrollZoom: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"]
  };
  window.Plotly.react(NMRP.spectrum, traces, layout, config).then(() => {
    NMRP.spectrum.removeAllListeners?.("plotly_click");
    NMRP.spectrum.removeAllListeners?.("plotly_relayout");
    NMRP.spectrum.on("plotly_click", (event) => {
      const peakId = event.points?.find((point) => point.customdata)?.customdata;
      if (!peakId) return;
      const peak = peaks.find((entry) => entry.peakId === peakId);
      if (!peak) return;
      if (type === "hsqc") {
        selectSignals([peak.protonSignalId, peak.carbonSignalId]);
      } else if (peak.diagonal) {
        selectSignals([peak.signalAId]);
      } else {
        selectSignals([peak.signalAId, peak.signalBId]);
      }
    });
    NMRP.spectrum.on("plotly_relayout", (event) => {
      const xMin = event["xaxis.range[1]"];
      const xMax = event["xaxis.range[0]"];
      const yMin = event["yaxis.range[1]"];
      const yMax = event["yaxis.range[0]"];
      if ([xMin, xMax, yMin, yMax].every(Number.isFinite)) {
        state.viewDomains2D[type] = {
          x: { min: Math.min(xMin, xMax), max: Math.max(xMin, xMax) },
          y: { min: Math.min(yMin, yMax), max: Math.max(yMin, yMax) }
        };
      }
    });
  });
}

function multipletDetail(signal) {
  if (signal.nucleus !== "1H" || signal.broad) {
    return signal.multiplicity;
  }
  const environments = signal.splitEnvironments || [];
  if (!environments.length) {
    return "singlet: no adjacent carbon-bound H";
  }
  return environments.map((environment, index) => {
    const label = environment.label ? `${environment.label} ` : "";
    return `J${index + 1} ${environment.jHz.toFixed(1)} Hz ${label}to ${environment.count}H on atom(s) ${environment.atomIds.join(",")}`;
  }).join("; ");
}

function zoomSpectrum(factor, centerPpm = null) {
  if (!["proton", "carbon"].includes(state.activeSpectrum)) {
    setPredictorStatus("Use Plotly drag zoom/pan directly for 2D spectra.");
    return;
  }
  const type = state.activeSpectrum;
  const full = state.defaultDomains[type];
  const current = state.viewDomains[type];
  const span = current.max - current.min;
  const minimumSpan = type === "carbon" ? 8 : 0.25;
  const nextSpan = Math.min(full.max - full.min, Math.max(minimumSpan, span * factor));
  const center = centerPpm ?? (current.min + current.max) / 2;
  let min = center - nextSpan / 2;
  let max = center + nextSpan / 2;
  if (min < full.min) {
    max += full.min - min;
    min = full.min;
  }
  if (max > full.max) {
    min -= max - full.max;
    max = full.max;
  }
  state.viewDomains[type] = {
    min: Math.max(full.min, min),
    max: Math.min(full.max, max)
  };
  renderActiveSpectrum();
}

function resetSpectrumZoom(type = state.activeSpectrum) {
  if (type === "hsqc" || type === "cosy" || type === "noesy") {
    state.viewDomains2D[type] = type === "hsqc"
      ? { x: { min: 0, max: 12 }, y: { min: 0, max: 220 } }
      : { x: { min: 0, max: 12 }, y: { min: 0, max: 12 } };
  } else {
    state.viewDomains[type] = { ...state.defaultDomains[type] };
  }
  renderActiveSpectrum();
}

function ppmFromPointer(event) {
  const rect = NMRP.spectrum.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const domain = state.viewDomains[state.activeSpectrum];
  return domain.max - fraction * (domain.max - domain.min);
}

function renderAssignments() {
  const all = [...state.predictions.proton, ...state.predictions.carbon];
  if (!all.length) {
    NMRP.table.innerHTML = '<tr><td colspan="6">No assignments.</td></tr>';
    return;
  }
  NMRP.table.innerHTML = all.map((item) => `
    <tr class="nmrp-assignment-row ${state.selectedSignalIds.includes(item.signalId) ? "is-selected" : ""}" data-signal-id="${item.signalId}">
      <td>${item.nucleus}</td>
      <td>${item.atomIds.join(", ")}</td>
      <td>${item.ppm.toFixed(2)} ppm</td>
      <td>${item.nucleus === "1H" ? item.integration.toFixed(0) : item.atomIds.length.toFixed(0)}</td>
      <td>${item.multiplicity}</td>
      <td>${item.label}${item.nucleus === "1H" ? `; ${multipletDetail(item)}` : ""}</td>
    </tr>
  `).join("");
  NMRP.table.querySelectorAll(".nmrp-assignment-row").forEach((row) => {
    row.addEventListener("click", () => selectSignal(row.dataset.signalId));
  });
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function spectrumProfileRows(environments, type, sampleCount = null) {
  const domain = state.viewDomains[type] || state.defaultDomains[type];
  const peaks = expandPeaks(environments, type);
  const fwhm = type === "carbon" ? 0.55 : 0.0045;
  const points = sampleCount || (type === "carbon" ? 1600 : 9000);
  const rows = [];
  for (let index = 0; index < points; index += 1) {
    const ppm = domain.min + ((domain.max - domain.min) * index) / (points - 1);
    const intensity = peaks.reduce((sum, peak) => {
      const peakFwhm = peak.fwhm || fwhm;
      return sum + gaussianAreaHeight(peak.intensity, peakFwhm) * gaussian(ppm, peak.ppm, peakFwhm);
    }, 0);
    rows.push({ ppm, intensity });
  }
  const maxIntensity = rows.reduce((max, row) => Math.max(max, row.intensity), 0) || 1;
  return rows.map((row) => ({
    ppm: row.ppm,
    intensity: row.intensity,
    relativeIntensity: (row.intensity / maxIntensity) * 100
  }));
}

function exportActiveSpectrumCsv() {
  const type = state.activeSpectrum;
  if (type === "hsqc" || type === "cosy" || type === "noesy") {
    export2DCsv(type, state.predictions[type] || []);
    return;
  }
  const environments = state.predictions[type] || [];
  if (!environments.length) {
    setPredictorStatus("No predicted signals available to export yet.", true);
    return;
  }
  const peaks = expandPeaks(environments, type).sort((a, b) => b.ppm - a.ppm);
  const profileRows = spectrumProfileRows(environments, type);
  const lines = [
    "section,nucleus,signal_id,ppm,intensity,relative_intensity,multiplicity,atom_ids,label"
  ];
  profileRows
    .slice()
    .sort((a, b) => b.ppm - a.ppm)
    .forEach((row) => {
      lines.push([
        "profile",
        type === "carbon" ? "13C" : "1H",
        "",
        row.ppm.toFixed(5),
        row.intensity.toFixed(8),
        row.relativeIntensity.toFixed(6),
        "",
        "",
        ""
      ].join(","));
    });
  peaks.forEach((peak) => {
    const env = peak.env;
    lines.push([
      "stick",
      env.nucleus,
      env.signalId,
      peak.ppm.toFixed(5),
      peak.intensity.toFixed(6),
      "",
      env.multiplicity,
      csvEscape(env.atomIds.join(" ")),
      csvEscape(env.label || "")
    ].join(","));
  });
  const smilesTag = sanitizeFilename(NMRP.smiles.value.trim() || "molecule");
  const nucleusTag = type === "carbon" ? "13C" : "1H";
  const filename = `${smilesTag}-${nucleusTag}-spectrum.csv`;
  downloadTextCsv(lines.join("\n"), filename);
  setPredictorStatus(`Downloaded ${profileRows.length} profile points and ${peaks.length} ${nucleusTag} sticks to ${filename}.`);
}

function export2DCsv(type, peaks) {
  if (!peaks.length) {
    setPredictorStatus(`No ${type.toUpperCase()} peaks available to export yet.`, true);
    return;
  }
  const lines = type === "hsqc"
    ? ["experiment,peak_id,proton_ppm,carbon_ppm,proton_signal_id,carbon_signal_id,proton_atom_ids,carbon_atom_ids,label"]
    : type === "cosy"
      ? ["experiment,peak_id,x_ppm,y_ppm,signal_a_id,signal_b_id,atom_ids_a,atom_ids_b,diagonal,label"]
      : ["experiment,peak_id,x_ppm,y_ppm,signal_a_id,signal_b_id,atom_ids_a,atom_ids_b,distance_a,relative_volume,diagonal,label"];
  peaks.forEach((peak) => {
    if (type === "hsqc") {
      lines.push([
        "HSQC",
        peak.peakId,
        peak.x.toFixed(5),
        peak.y.toFixed(5),
        peak.protonSignalId,
        peak.carbonSignalId,
        `"${peak.protonAtomIds.join(" ")}"`,
        `"${peak.carbonAtomIds.join(" ")}"`,
        `"${String(peak.label || "").replace(/"/g, '""')}"`
      ].join(","));
    } else if (type === "cosy") {
      lines.push([
        "COSY",
        peak.peakId,
        peak.x.toFixed(5),
        peak.y.toFixed(5),
        peak.signalAId,
        peak.signalBId,
        `"${peak.atomIdsA.join(" ")}"`,
        `"${peak.atomIdsB.join(" ")}"`,
        peak.diagonal ? "true" : "false",
        `"${String(peak.label || "").replace(/"/g, '""')}"`
      ].join(","));
    } else {
      lines.push([
        "NOESY",
        peak.peakId,
        peak.x.toFixed(5),
        peak.y.toFixed(5),
        peak.signalAId,
        peak.signalBId,
        `"${peak.atomIdsA.join(" ")}"`,
        `"${peak.atomIdsB.join(" ")}"`,
        Number.isFinite(peak.distance) ? peak.distance.toFixed(4) : "",
        Number.isFinite(peak.volume) ? peak.volume.toFixed(6) : "",
        peak.diagonal ? "true" : "false",
        `"${String(peak.label || "").replace(/"/g, '""')}"`
      ].join(","));
    }
  });
  const smilesTag = sanitizeFilename(NMRP.smiles.value.trim() || "molecule");
  const filename = `${smilesTag}-${type.toUpperCase()}.csv`;
  downloadTextCsv(lines.join("\n"), filename);
  setPredictorStatus(`Downloaded ${peaks.length} ${type.toUpperCase()} peaks to ${filename}.`);
}

function nefQuote(value) {
  if (value === null || value === undefined || value === "") return ".";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : ".";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value);
  if (/^[A-Za-z0-9_@%+.\-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "''")}'`;
}

function nefLine(values) {
  return values.map(nefQuote).join("  ");
}

function nefAtomName(signal, element, atomId = null) {
  const ids = dedupeSortedNumeric(atomId ? [atomId] : (signal.atomIds || signal.carrierAtomIds || signal.sourceAtomIds || []));
  const firstId = ids[0] || 1;
  if (element === "H") {
    const needsWildcard = ids.length > 1 || Number(signal.integration || 1) > 1;
    return `H${firstId}${needsWildcard ? "%" : ""}`;
  }
  return `${element}${firstId}`;
}

function nefChemicalShiftRows() {
  const rows = [];
  const addRows = (signals, element, isotope) => {
    signals.forEach((signal) => {
      const atomIds = dedupeSortedNumeric(signal.sourceAtomIds || signal.carrierAtomIds || signal.atomIds || []);
      atomIds.forEach((atomId) => {
        rows.push([
          "A",
          1,
          "MOL",
          nefAtomName(signal, element, atomId),
          Number(signal.ppm).toFixed(element === "H" ? 4 : 3),
          0,
          element,
          isotope,
          1,
          `${signal.signalId}; atoms ${atomIds.join(",")}; ${signal.multiplicity || "s"}; ${signal.label || ""}`
        ]);
      });
    });
  };
  addRows(state.predictions.proton || [], "H", 1);
  addRows(state.predictions.carbon || [], "C", 13);
  return rows;
}

function nefSpectrumDimensionRows(type) {
  if (type === "proton") {
    return [[1, "ppm", "1H", 400.0, 12, 12, "circular", true, true]];
  }
  if (type === "carbon") {
    return [[1, "ppm", "13C", 100.0, 220, 220, "circular", true, true]];
  }
  if (type === "hsqc") {
    return [
      [1, "ppm", "1H", 400.0, 12, 12, "circular", true, true],
      [2, "ppm", "13C", 100.0, 220, 220, "circular", true, false]
    ];
  }
  return [
    [1, "ppm", "1H", 400.0, 12, 12, "circular", true, true],
    [2, "ppm", "1H", 400.0, 12, 12, "circular", true, false]
  ];
}

function appendNefSpectrumDimensions(lines, type) {
  lines.push("   loop_");
  [
    "_nef_spectrum_dimension.dimension_id",
    "_nef_spectrum_dimension.axis_unit",
    "_nef_spectrum_dimension.axis_code",
    "_nef_spectrum_dimension.spectrometer_frequency",
    "_nef_spectrum_dimension.spectral_width",
    "_nef_spectrum_dimension.value_first_point",
    "_nef_spectrum_dimension.folding",
    "_nef_spectrum_dimension.absolute_peak_positions",
    "_nef_spectrum_dimension.is_acquisition"
  ].forEach((tag) => lines.push(`      ${tag}`));
  nefSpectrumDimensionRows(type).forEach((row) => lines.push(`      ${nefLine(row)}`));
  lines.push("   stop_");
}

function appendNefTransfer(lines, type) {
  if (type === "proton" || type === "carbon") return;
  const transferType = type === "hsqc" ? "onebond" : type === "cosy" ? "Jcoupling" : "through-space";
  lines.push("   loop_");
  [
    "_nef_spectrum_dimension_transfer.dimension_1",
    "_nef_spectrum_dimension_transfer.dimension_2",
    "_nef_spectrum_dimension_transfer.transfer_type",
    "_nef_spectrum_dimension_transfer.is_indirect"
  ].forEach((tag) => lines.push(`      ${tag}`));
  lines.push(`      ${nefLine([1, 2, transferType, false])}`);
  lines.push("   stop_");
}

function appendNefPeakLoop1D(lines, type, signals) {
  const peaks = expandPeaks(signals, type).sort((a, b) => b.ppm - a.ppm);
  lines.push("   loop_");
  [
    "_nef_peak.index",
    "_nef_peak.peak_id",
    "_nef_peak.volume",
    "_nef_peak.volume_uncertainty",
    "_nef_peak.height",
    "_nef_peak.height_uncertainty",
    "_nef_peak.position_1",
    "_nef_peak.position_uncertainty_1",
    "_nef_peak.chain_code_1",
    "_nef_peak.sequence_code_1",
    "_nef_peak.residue_name_1",
    "_nef_peak.atom_name_1",
    "_nef_peak.ccpn_comment"
  ].forEach((tag) => lines.push(`      ${tag}`));
  peaks.forEach((peak, index) => {
    const element = type === "carbon" ? "C" : "H";
    const env = peak.env;
    lines.push(`      ${nefLine([
      index + 1,
      peak.peakId || `${env.signalId}-${index + 1}`,
      Number(peak.intensity || 1).toFixed(6),
      0,
      Number(peak.intensity || 1).toFixed(6),
      0,
      Number(peak.ppm).toFixed(element === "H" ? 5 : 4),
      0,
      "A",
      1,
      "MOL",
      nefAtomName(env, element),
      `${env.nucleus} ${env.multiplicity || "s"} atoms ${env.atomIds.join(",")}; ${env.label || ""}`
    ])}`);
  });
  lines.push("   stop_");
}

function appendNefPeakLoop2D(lines, type, peaks) {
  lines.push("   loop_");
  [
    "_nef_peak.index",
    "_nef_peak.peak_id",
    "_nef_peak.volume",
    "_nef_peak.volume_uncertainty",
    "_nef_peak.height",
    "_nef_peak.height_uncertainty",
    "_nef_peak.position_1",
    "_nef_peak.position_uncertainty_1",
    "_nef_peak.position_2",
    "_nef_peak.position_uncertainty_2",
    "_nef_peak.chain_code_1",
    "_nef_peak.sequence_code_1",
    "_nef_peak.residue_name_1",
    "_nef_peak.atom_name_1",
    "_nef_peak.chain_code_2",
    "_nef_peak.sequence_code_2",
    "_nef_peak.residue_name_2",
    "_nef_peak.atom_name_2",
    "_nef_peak.ccpn_comment"
  ].forEach((tag) => lines.push(`      ${tag}`));
  peaks.forEach((peak, index) => {
    const volume = type === "noesy" ? Number(peak.volume || 0) : (peak.diagonal ? 0.35 : 1);
    const atomName1 = type === "hsqc"
      ? nefAtomName({ atomIds: peak.protonAtomIds, integration: peak.protonAtomIds?.length || 1 }, "H")
      : nefAtomName({ atomIds: peak.atomIdsA }, "H");
    const atomName2 = type === "hsqc"
      ? nefAtomName({ atomIds: peak.carbonAtomIds }, "C")
      : nefAtomName({ atomIds: peak.atomIdsB }, "H");
    lines.push(`      ${nefLine([
      index + 1,
      peak.peakId,
      volume.toFixed(6),
      0,
      volume.toFixed(6),
      0,
      Number(peak.x).toFixed(5),
      0,
      Number(peak.y).toFixed(5),
      0,
      "A",
      1,
      "MOL",
      atomName1,
      "A",
      1,
      "MOL",
      atomName2,
      `${type.toUpperCase()} ${peak.diagonal ? "diagonal" : "cross peak"}; ${peak.label || ""}`
    ])}`);
  });
  lines.push("   stop_");
}

function appendNefSpectrumSaveframe(lines, type, signalsOrPeaks) {
  const experiment = type === "proton" ? "1H" : type === "carbon" ? "13C" : type.toUpperCase();
  const framecode = `nef_nmr_spectrum_${type}_predicted`;
  lines.push("");
  lines.push(`save_${framecode}`);
  lines.push(`   _nef_nmr_spectrum.sf_category           ${nefQuote("nef_nmr_spectrum")}`);
  lines.push(`   _nef_nmr_spectrum.sf_framecode          ${nefQuote(framecode)}`);
  lines.push(`   _nef_nmr_spectrum.num_dimensions        ${type === "proton" || type === "carbon" ? 1 : 2}`);
  lines.push(`   _nef_nmr_spectrum.chemical_shift_list   ${nefQuote("nef_chemical_shift_list_predicted")}`);
  lines.push(`   _nef_nmr_spectrum.experiment_type       ${nefQuote(experiment)}`);
  lines.push(`   _nef_nmr_spectrum.ccpn_spectrum_comment ${nefQuote("Teaching prediction from browser heuristics; not an analytical assignment.")}`);
  appendNefSpectrumDimensions(lines, type);
  appendNefTransfer(lines, type);
  if (type === "proton" || type === "carbon") {
    appendNefPeakLoop1D(lines, type, signalsOrPeaks);
  } else {
    appendNefPeakLoop2D(lines, type, signalsOrPeaks);
  }
  lines.push("save_");
}

function buildAllSpectraNef() {
  const smiles = NMRP.smiles.value.trim() || "molecule";
  const safeDataName = sanitizeFilename(smiles).replace(/-/g, "_");
  const lines = [
    `data_${safeDataName || "nmr_predictor"}`,
    "",
    "save_nef_nmr_meta_data",
    "   _nef_nmr_meta_data.sf_category      nef_nmr_meta_data",
    "   _nef_nmr_meta_data.sf_framecode     nef_nmr_meta_data",
    "   _nef_nmr_meta_data.format_name      nmr_exchange_format",
    "   _nef_nmr_meta_data.format_version   1.1",
    "   _nef_nmr_meta_data.program_name     IsotopePatternSimulator_NMR_Predictor",
    "   _nef_nmr_meta_data.program_version  browser_teaching_model",
    `   _nef_nmr_meta_data.creation_date    ${nefQuote(new Date().toISOString())}`,
    "save_",
    "",
    "save_nef_molecular_system",
    "   _nef_molecular_system.sf_category   nef_molecular_system",
    "   _nef_molecular_system.sf_framecode  nef_molecular_system",
    "   loop_",
    "      _nef_sequence.index",
    "      _nef_sequence.chain_code",
    "      _nef_sequence.sequence_code",
    "      _nef_sequence.residue_name",
    "      _nef_sequence.linking",
    "      _nef_sequence.residue_variant",
    "      _nef_sequence.ccpn_comment",
    `      ${nefLine([1, "A", 1, "MOL", "single", ".", `SMILES ${smiles}`])}`,
    "   stop_",
    "save_",
    "",
    "save_nef_chemical_shift_list_predicted",
    "   _nef_chemical_shift_list.sf_category   nef_chemical_shift_list",
    "   _nef_chemical_shift_list.sf_framecode  nef_chemical_shift_list_predicted",
    "   _nef_chemical_shift_list.ccpn_comment  'Predicted teaching shifts; values are heuristic.'",
    "   loop_",
    "      _nef_chemical_shift.chain_code",
    "      _nef_chemical_shift.sequence_code",
    "      _nef_chemical_shift.residue_name",
    "      _nef_chemical_shift.atom_name",
    "      _nef_chemical_shift.value",
    "      _nef_chemical_shift.value_uncertainty",
    "      _nef_chemical_shift.element",
    "      _nef_chemical_shift.isotope_number",
    "      _nef_chemical_shift.ccpn_figure_of_merit",
    "      _nef_chemical_shift.ccpn_comment"
  ];
  nefChemicalShiftRows().forEach((row) => lines.push(`      ${nefLine(row)}`));
  lines.push("   stop_");
  lines.push("save_");

  appendNefSpectrumSaveframe(lines, "proton", state.predictions.proton || []);
  appendNefSpectrumSaveframe(lines, "carbon", state.predictions.carbon || []);
  appendNefSpectrumSaveframe(lines, "hsqc", state.predictions.hsqc || []);
  appendNefSpectrumSaveframe(lines, "cosy", state.predictions.cosy || []);
  appendNefSpectrumSaveframe(lines, "noesy", state.predictions.noesy || []);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function exportAllSpectraNef() {
  const totalSignals = (state.predictions.proton?.length || 0)
    + (state.predictions.carbon?.length || 0)
    + (state.predictions.hsqc?.length || 0)
    + (state.predictions.cosy?.length || 0)
    + (state.predictions.noesy?.length || 0);
  if (!totalSignals) {
    setPredictorStatus("No predicted spectra available to export yet.", true);
    return;
  }
  const smilesTag = sanitizeFilename(NMRP.smiles.value.trim() || "molecule");
  const filename = `${smilesTag}-all-spectra.nef`;
  downloadTextFile(buildAllSpectraNef(), filename, "chemical/x-nef;charset=utf-8");
  setPredictorStatus(`Downloaded NEF file with 1H, 13C, HSQC, COSY and NOESY peak lists to ${filename}.`);
}

function renderActiveSpectrum() {
  const type = state.activeSpectrum;
  NMRP.protonTab.classList.toggle("nav-link-active", type === "proton");
  NMRP.carbonTab.classList.toggle("nav-link-active", type === "carbon");
  NMRP.hsqcTab?.classList.toggle("nav-link-active", type === "hsqc");
  NMRP.cosyTab?.classList.toggle("nav-link-active", type === "cosy");
  NMRP.noesyTab?.classList.toggle("nav-link-active", type === "noesy");
  if (NMRP.caption) {
    if (type === "hsqc") {
      NMRP.caption.textContent = "Teaching approximation: one-bond H-C correlations only; no phase editing or long-range correlations.";
    } else if (type === "cosy") {
      NMRP.caption.textContent = "Teaching approximation: mainly vicinal/aromatic-neighbour couplings; weak/long-range couplings omitted.";
    } else if (type === "noesy") {
      NMRP.caption.textContent = "Teaching approximation: CACTUS 3D coordinates where available, otherwise fallback coordinates; peaks are proton pairs within 5 A and volume scales roughly with 1/r^6.";
    } else {
      NMRP.caption.textContent = "Switch between 1D and 2D teaching spectra.";
    }
  }
  if (type === "hsqc" || type === "cosy" || type === "noesy") {
    render2DSpectrum(state.predictions[type], type);
  } else {
    renderSpectrum(state.predictions[type], type);
  }
}

function tryRenderRdkit(smiles) {
  if (!state.rdkit) {
    NMRP.structure.innerHTML = '<div class="plot-empty">RDKit structure rendering unavailable. Prediction still uses the SMILES graph.</div>';
    return;
  }
  let mol = null;
  try {
    mol = state.rdkit.get_mol(smiles);
    if (!mol) {
      throw new Error("RDKit could not parse SMILES.");
    }
    const selectedSignals = getSelectedSignals();
    const selectedAtomIds = dedupeSortedNumeric(selectedSignals.flatMap((signal) => signal.atomIds || []));
    let svg = "";
    if (selectedAtomIds.length && mol.get_svg_with_highlights) {
      const details = JSON.stringify({
        atoms: selectedAtomIds.map((id) => id - 1),
        highlightColour: [0.85, 0.12, 0.22]
      });
      svg = mol.get_svg_with_highlights(details);
    } else {
      svg = mol.get_svg();
    }
    NMRP.structure.innerHTML = addAtomNumbersToSvg(svg, state.graph);
    if (selectedAtomIds.length) {
      NMRP.structure.insertAdjacentHTML("beforeend", `<div class="nmrp-highlight-note">Selected atoms: ${selectedAtomIds.join(", ")}</div>`);
    }
  } catch (error) {
    NMRP.structure.innerHTML = `<div class="plot-empty">${error.message}</div>`;
  } finally {
    if (mol?.delete) {
      mol.delete();
    }
  }
}

function addAtomNumbersToSvg(svg, graph) {
  if (!graph?.atoms?.length || !svg.includes("</svg>")) {
    return svg;
  }
  const positions = inferSvgAtomPositions(svg, graph);
  if (!positions.length) {
    return svg;
  }
  const labels = positions.map((point, index) => `<g class="atom-number-label"><circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="7.2" fill="rgba(255,255,255,0.92)" stroke="#0d6c74" stroke-width="1"></circle><text x="${point.x.toFixed(1)}" y="${(point.y + 3.5).toFixed(1)}" text-anchor="middle" font-size="9" fill="#0a4c57" font-family="Arial">${index + 1}</text></g>`).join("");
  return svg.replace("</svg>", `${labels}</svg>`);
}

function inferSvgAtomPositions(svg, graph) {
  const explicit = Array.from(svg.matchAll(/class=['"]atom-\d+['"][^>]*?(?:cx=['"]([\d.-]+)['"][^>]*?cy=['"]([\d.-]+)['"]|x=['"]([\d.-]+)['"][^>]*?y=['"]([\d.-]+)['"])/g))
    .map((match) => ({ x: Number(match[1] || match[3]), y: Number(match[2] || match[4]) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (explicit.length >= graph.atoms.length) {
    return explicit.slice(0, graph.atoms.length);
  }

  const atomPositions = Array.from({ length: graph.atoms.length }, () => ({ x: 0, y: 0, count: 0 }));
  const bondPaths = Array.from(svg.matchAll(/<path\b[^>]*class=['"][^'"]*atom-(\d+)[^'"]*atom-(\d+)[^'"]*['"][^>]*\bd=['"]([^'"]+)['"][^>]*>/g));
  bondPaths.forEach((match) => {
    const firstAtom = Number(match[1]);
    const secondAtom = Number(match[2]);
    const coords = Array.from(match[3].matchAll(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi)).map((coord) => Number(coord[0]));
    if (!Number.isInteger(firstAtom) || !Number.isInteger(secondAtom) || coords.length < 4) {
      return;
    }
    const [x1, y1, x2, y2] = coords;
    [[firstAtom, x1, y1], [secondAtom, x2, y2]].forEach(([atomId, x, y]) => {
      if (!atomPositions[atomId] || !Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }
      const position = atomPositions[atomId];
      position.x += x;
      position.y += y;
      position.count += 1;
    });
  });
  if (atomPositions.every((position) => position.count > 0)) {
    return atomPositions.map((position) => ({
      x: position.x / position.count,
      y: position.y / position.count
    }));
  }

  const bondCoordinates = Array.from(svg.matchAll(/x1=['"]([\d.-]+)['"][^>]*y1=['"]([\d.-]+)['"][^>]*x2=['"]([\d.-]+)['"][^>]*y2=['"]([\d.-]+)['"]/g))
    .map((match) => [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])])
    .filter((coords) => coords.every(Number.isFinite));
  if (!bondCoordinates.length) {
    return [];
  }

  const points = [];
  const addPoint = (x, y) => {
    const current = points.find((point) => Math.hypot(point.x - x, point.y - y) < 3);
    if (current) {
      current.x = (current.x * current.count + x) / (current.count + 1);
      current.y = (current.y * current.count + y) / (current.count + 1);
      current.count += 1;
    } else {
      points.push({ x, y, count: 1 });
    }
  };
  bondCoordinates.forEach(([x1, y1, x2, y2]) => {
    addPoint(x1, y1);
    addPoint(x2, y2);
  });
  return points
    .sort((a, b) => b.count - a.count)
    .slice(0, graph.atoms.length);
}

function getSelectedSignal() {
  return [...state.predictions.proton, ...state.predictions.carbon].find((signal) => signal.signalId === state.selectedSignalId) || null;
}

function getSelectedSignals() {
  const ids = state.selectedSignalIds.length ? state.selectedSignalIds : (state.selectedSignalId ? [state.selectedSignalId] : []);
  const all = [...state.predictions.proton, ...state.predictions.carbon];
  return ids.map((id) => all.find((signal) => signal.signalId === id)).filter(Boolean);
}

function selectSignal(signalId) {
  state.selectedSignalId = signalId;
  state.selectedSignalIds = signalId ? [signalId] : [];
  if (state.graph) {
    const smiles = NMRP.smiles.value.trim();
    tryRenderRdkit(smiles);
    tryRender3d(smiles);
  }
  renderAssignments();
  renderActiveSpectrum();
}

function selectSignals(signalIds) {
  const deduped = [...new Set(signalIds.filter(Boolean))];
  state.selectedSignalIds = deduped;
  state.selectedSignalId = deduped[0] || null;
  if (state.graph) {
    const smiles = NMRP.smiles.value.trim();
    tryRenderRdkit(smiles);
    tryRender3d(smiles);
  }
  renderAssignments();
  renderActiveSpectrum();
}

async function predictNmr() {
  const smiles = NMRP.smiles.value.trim();
  if (!smiles) {
    setPredictorStatus("Enter a SMILES string.", true);
    return;
  }
  const runId = ++state.predictionRunId;
  try {
    const graph = parseSmiles(smiles);
    const predictions1d = predictEnvironments(graph);
    const hsqc = predictHsqc(graph, predictions1d.proton, predictions1d.carbon);
    const cosy = predictCosy(graph, predictions1d.proton);
    setPredictorStatus("Predicting NMR and requesting CACTUS 3D coordinates for NOESY...");
    const cactus3d = await resolveCactus3d(smiles, graph);
    if (runId !== state.predictionRunId) {
      return;
    }
    const noesy = predictNoesy(graph, predictions1d.proton, smiles, cactus3d.coordinates);
    const predictions = { ...predictions1d, hsqc, cosy, noesy };
    if (runId !== state.predictionRunId) {
      return;
    }
    const shouldResetView = smiles !== state.lastSmiles;
    state.graph = graph;
    state.cactus3d = cactus3d;
    state.predictions = predictions;
    state.selectedSignalId = null;
    state.selectedSignalIds = [];
    state.defaultDomains = autoDefaultDomains(predictions);
    if (shouldResetView) {
      state.viewDomains = {
        proton: { ...state.defaultDomains.proton },
        carbon: { ...state.defaultDomains.carbon }
      };
      state.viewDomains2D = {
        hsqc: { x: { min: 0, max: 12 }, y: { min: 0, max: 220 } },
        cosy: { x: { min: 0, max: 12 }, y: { min: 0, max: 12 } },
        noesy: { x: { min: 0, max: 12 }, y: { min: 0, max: 12 } }
      };
    }
    state.lastSmiles = smiles;
    NMRP.protonSummary.textContent = String(predictions.proton.length);
    NMRP.carbonSummary.textContent = String(predictions.carbon.length);
    if (NMRP.hsqcSummary) NMRP.hsqcSummary.textContent = String(predictions.hsqc.length);
    if (NMRP.cosySummary) NMRP.cosySummary.textContent = String(predictions.cosy.length);
    if (NMRP.noesySummary) NMRP.noesySummary.textContent = String(predictions.noesy.length);
    tryRenderRdkit(smiles);
    tryRender3d(smiles);
    renderAssignments();
    renderActiveSpectrum();
    const noesySource = cactus3d.source === "cactus"
      ? "CACTUS 3D distances"
      : cactus3d.source === "cactus-viewer-only"
        ? "CACTUS viewer SDF; fallback NOESY atom mapping"
        : "fallback NOESY geometry";
    setPredictorStatus(`Predicted 1H:${predictions.proton.length} 13C:${predictions.carbon.length} HSQC:${predictions.hsqc.length} COSY:${predictions.cosy.length} NOESY:${predictions.noesy.length} using ${noesySource}.`);
  } catch (error) {
    setPredictorStatus(error.message || "Could not predict this structure.", true);
  }
}

function sendSmilesToJsme() {
  if (!state.jsme) {
    setPredictorStatus("JSME is not available yet. You can still type SMILES directly.", true);
    return;
  }
  const smiles = NMRP.smiles.value.trim();
  if (state.jsme.readGenericMolecularInput) {
    state.jsme.readGenericMolecularInput(smiles);
  } else if (state.jsme.readMolecule) {
    state.jsme.readMolecule(smiles);
  }
}

function initialiseJsme(attempt = 0) {
  if (!window.JSApplet?.JSME) {
    if (attempt < 25) {
      window.setTimeout(() => initialiseJsme(attempt + 1), 200);
      return;
    }
    document.getElementById("jsme-container").innerHTML = '<div class="plot-empty">JSME did not load. Use the SMILES box directly.</div>';
    return;
  }
  document.getElementById("jsme-container").innerHTML = "";
  state.jsme = new window.JSApplet.JSME("jsme-container", "100%", "360px", {
    options: "oldlook,star"
  });
  if (state.jsme.setCallBack) {
    state.jsme.setCallBack("AfterStructureModified", () => {
      if (state.jsme.smiles) {
        NMRP.smiles.value = state.jsme.smiles();
        predictNmr();
      }
    });
  }
  sendSmilesToJsme();
}

function initialiseRdkit() {
  if (!window.initRDKitModule) {
    NMRP.rdkitSummary.textContent = "unavailable";
    return Promise.resolve();
  }
  NMRP.rdkitSummary.textContent = "loading...";
  return window.initRDKitModule()
    .then((rdkit) => {
      state.rdkit = rdkit;
      NMRP.rdkitSummary.textContent = "loaded";
    })
    .catch(() => {
      NMRP.rdkitSummary.textContent = "unavailable";
    });
}

NMRP.predict.addEventListener("click", predictNmr);
NMRP.draw.addEventListener("click", sendSmilesToJsme);
NMRP.smiles.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    predictNmr();
  }
});
NMRP.protonTab.addEventListener("click", () => {
  state.activeSpectrum = "proton";
  renderActiveSpectrum();
});
NMRP.carbonTab.addEventListener("click", () => {
  state.activeSpectrum = "carbon";
  renderActiveSpectrum();
});
NMRP.hsqcTab?.addEventListener("click", () => {
  state.activeSpectrum = "hsqc";
  renderActiveSpectrum();
});
NMRP.cosyTab?.addEventListener("click", () => {
  state.activeSpectrum = "cosy";
  renderActiveSpectrum();
});
NMRP.noesyTab?.addEventListener("click", () => {
  state.activeSpectrum = "noesy";
  renderActiveSpectrum();
});
NMRP.downloadCsv.addEventListener("click", exportActiveSpectrumCsv);
NMRP.downloadNef?.addEventListener("click", exportAllSpectraNef);
NMRP.zoomIn.addEventListener("click", () => zoomSpectrum(0.5));
NMRP.zoomOut.addEventListener("click", () => zoomSpectrum(2));
NMRP.resetZoom.addEventListener("click", () => resetSpectrumZoom());
NMRP.fullscreen?.addEventListener("click", toggleSpectrumFullscreen);
NMRP.spectrum.addEventListener("dblclick", () => resetSpectrumZoom());
document.querySelectorAll(".nmr-example").forEach((button) => {
  button.addEventListener("click", () => {
    NMRP.smiles.value = button.dataset.smiles;
    sendSmilesToJsme();
    predictNmr();
  });
});
window.addEventListener("resize", renderActiveSpectrum);
if (document.addEventListener) {
  document.addEventListener("fullscreenchange", () => {
    updateFullscreenButtonLabel();
    window.setTimeout(refreshResizableViews, 40);
  });
  document.addEventListener("webkitfullscreenchange", () => {
    updateFullscreenButtonLabel();
    window.setTimeout(refreshResizableViews, 40);
  });
}

window.addEventListener("load", () => {
  initialiseJsme();
  initialiseRdkit().then(predictNmr);
  updateFullscreenButtonLabel();
});
