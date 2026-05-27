const { loadPredictorContext } = require("../lib/load-predictor-context");
const PptxGenJS = require("pptxgenjs");
const { buildPresentationFile } = require("../pptx-export");

const SUPPORTED_TYPES = new Set(["proton", "carbon", "hsqc", "cosy", "noesy"]);

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function normalizeType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  if (normalized === "1h") return "proton";
  if (normalized === "13c") return "carbon";
  return normalized;
}

function safeFilenamePart(value) {
  return String(value || "")
    .replace(/[^a-z0-9-_]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    || "molecule";
}

function autoDomain(ctx, signals, type) {
  const fallback = type === "carbon" ? { min: 0, max: 220 } : { min: 0, max: 12 };
  if (typeof ctx.autoDomainForSignals === "function") {
    return ctx.autoDomainForSignals(signals, fallback);
  }
  const ppmValues = (signals || [])
    .map((signal) => Number(signal.ppm))
    .filter(Number.isFinite);
  if (!ppmValues.length) return fallback;
  const minPpm = Math.min(...ppmValues);
  const maxPpm = Math.max(...ppmValues);
  return {
    min: minPpm < 0 ? Math.floor(minPpm) - 1 : 0,
    max: Math.ceil(maxPpm) + 1
  };
}

function spectrumProfileRows(ctx, environments, type, sampleCount = null) {
  const domain = autoDomain(ctx, environments, type);
  const peaks = ctx.expandPeaks(environments, type);
  const fwhm = type === "carbon" ? 0.55 : 0.0045;
  const points = sampleCount || (type === "carbon" ? 1600 : 9000);
  const rows = [];
  for (let index = 0; index < points; index += 1) {
    const ppm = domain.min + ((domain.max - domain.min) * index) / (points - 1);
    const intensity = peaks.reduce((sum, peak) => {
      const peakFwhm = peak.fwhm || fwhm;
      return sum + ctx.gaussianAreaHeight(peak.intensity, peakFwhm) * ctx.gaussian(ppm, peak.ppm, peakFwhm);
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

function buildPredictions(smiles) {
  const ctx = loadPredictorContext();
  const graph = ctx.parseSmiles(smiles);
  const predictions1d = ctx.predictEnvironments(graph);
  const fallbackCoordinates = ctx.fallbackNoesyCoordinates(graph);
  return {
    ctx,
    graph,
    predictions: {
      ...predictions1d,
      hsqc: ctx.predictHsqc(graph, predictions1d.proton, predictions1d.carbon),
      cosy: ctx.predictCosy(graph, predictions1d.proton),
      noesy: ctx.predictNoesy(graph, predictions1d.proton, "", fallbackCoordinates)
    }
  };
}

function build1dCsv(ctx, smiles, type, environments) {
  const peaks = ctx.expandPeaks(environments, type).sort((a, b) => b.ppm - a.ppm);
  const profileRows = spectrumProfileRows(ctx, environments, type);
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
  const smilesTag = safeFilenamePart(smiles);
  const nucleusTag = type === "carbon" ? "13C" : "1H";
  return {
    filename: `${smilesTag}-${nucleusTag}-spectrum.csv`,
    csv: lines.join("\n")
  };
}

function build2dCsv(smiles, type, peaks) {
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
        csvEscape(peak.protonAtomIds.join(" ")),
        csvEscape(peak.carbonAtomIds.join(" ")),
        csvEscape(peak.label || "")
      ].join(","));
      return;
    }
    if (type === "cosy") {
      lines.push([
        "COSY",
        peak.peakId,
        peak.x.toFixed(5),
        peak.y.toFixed(5),
        peak.signalAId,
        peak.signalBId,
        csvEscape(peak.atomIdsA.join(" ")),
        csvEscape(peak.atomIdsB.join(" ")),
        peak.diagonal ? "true" : "false",
        csvEscape(peak.label || "")
      ].join(","));
      return;
    }
    lines.push([
      "NOESY",
      peak.peakId,
      peak.x.toFixed(5),
      peak.y.toFixed(5),
      peak.signalAId,
      peak.signalBId,
      csvEscape(peak.atomIdsA.join(" ")),
      csvEscape(peak.atomIdsB.join(" ")),
      Number.isFinite(peak.distance) ? peak.distance.toFixed(4) : "",
      Number.isFinite(peak.volume) ? peak.volume.toFixed(6) : "",
      peak.diagonal ? "true" : "false",
      csvEscape(peak.label || "")
    ].join(","));
  });

  return {
    filename: `${safeFilenamePart(smiles)}-${type.toUpperCase()}.csv`,
    csv: lines.join("\n")
  };
}

function generateSpectrumCsv({ smiles, type }) {
  const cleanSmiles = String(smiles || "").trim();
  const normalizedType = normalizeType(type);

  if (!cleanSmiles) {
    throw new Error("Missing required 'smiles' parameter.");
  }
  if (!SUPPORTED_TYPES.has(normalizedType)) {
    throw new Error(`Unsupported spectrum type '${type}'. Use one of: proton, carbon, hsqc, cosy, noesy.`);
  }

  const { ctx, predictions } = buildPredictions(cleanSmiles);
  if (normalizedType === "proton" || normalizedType === "carbon") {
    const result = build1dCsv(ctx, cleanSmiles, normalizedType, predictions[normalizedType]);
    return { ...result, spectrumType: normalizedType };
  }
  const result = build2dCsv(cleanSmiles, normalizedType, predictions[normalizedType]);
  return { ...result, spectrumType: normalizedType };
}

module.exports = {
  SUPPORTED_TYPES,
  buildPredictions,
  build2dCsv,
  build1dCsv,
  generateSpectrumPresentation: async function generateSpectrumPresentation({ smiles }) {
    const cleanSmiles = String(smiles || "").trim();
    if (!cleanSmiles) {
      throw new Error("Missing required 'smiles' parameter.");
    }
    const { ctx, graph, predictions } = buildPredictions(cleanSmiles);
    return buildPresentationFile(PptxGenJS, ctx, {
      smiles: cleanSmiles,
      graph,
      predictions
    }, {
      outputType: "nodebuffer"
    });
  },
  generateSpectrumCsv,
  normalizeType
};
