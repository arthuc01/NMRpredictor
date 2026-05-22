const MULTIPLETS = {
  d: {
    label: "Doublet",
    short: "d",
    offsets: [-0.5, 0.5],
    weights: [1, 1]
  },
  t: {
    label: "Triplet",
    short: "t",
    offsets: [-1, 0, 1],
    weights: [1, 2, 1]
  },
  q: {
    label: "Quartet",
    short: "q",
    offsets: [-1.5, -0.5, 0.5, 1.5],
    weights: [1, 3, 3, 1]
  }
};

const state = {
  layers: [],
  leaves: [],
  nodes: [],
  edges: []
};

const elements = {
  centerPpm: document.getElementById("center-ppm-input"),
  frequency: document.getElementById("frequency-input"),
  linewidth: document.getElementById("linewidth-input"),
  linewidthOutput: document.getElementById("linewidth-output"),
  showCentersToggle: document.getElementById("show-centers-toggle"),
  multipletSelects: Array.from(document.querySelectorAll(".nmr-multiplet")),
  jInputs: Array.from(document.querySelectorAll(".nmr-j")),
  predictButton: document.getElementById("predict-button"),
  status: document.getElementById("nmr-status"),
  summaryMultiplet: document.getElementById("summary-multiplet"),
  summaryLayers: document.getElementById("summary-layers"),
  summaryLines: document.getElementById("summary-lines"),
  summarySpread: document.getElementById("summary-spread"),
  spectrum: document.getElementById("nmr-spectrum"),
  tree: document.getElementById("nmr-tree")
};

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.style.color = isError ? "#a11d37" : "";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readLayers() {
  const layers = [];
  for (let i = 0; i < 4; i += 1) {
    const type = elements.multipletSelects[i].value;
    const j = Math.max(0, Number(elements.jInputs[i].value) || 0);
    if (type !== "none" && j > 0) {
      layers.push({ index: i + 1, type, j });
    }
  }
  return layers;
}

function expandSplitting(layers) {
  let nodeId = 0;
  let leaves = [{ id: nodeId, hz: 0, intensity: 1, depth: 0 }];
  const nodes = [{ id: nodeId, hz: 0, intensity: 1, depth: 0 }];
  const edges = [];

  for (let depth = 0; depth < layers.length; depth += 1) {
    const layer = layers[depth];
    const multiplet = MULTIPLETS[layer.type];
    const nextLeaves = [];
    for (const leaf of leaves) {
      for (let k = 0; k < multiplet.offsets.length; k += 1) {
        nodeId += 1;
        const child = {
          id: nodeId,
          hz: leaf.hz + (multiplet.offsets[k] * layer.j),
          intensity: leaf.intensity * multiplet.weights[k],
          depth: depth + 1
        };
        nodes.push(child);
        edges.push({
          from: leaf.id,
          to: child.id,
          layer: depth,
          j: layer.j
        });
        nextLeaves.push(child);
      }
    }
    leaves = nextLeaves;
  }

  return { leaves, nodes, edges };
}

function normalizeLeaves(leaves) {
  if (!leaves.length) {
    return [];
  }
  const maxIntensity = leaves.reduce((best, line) => Math.max(best, line.intensity), 0) || 1;
  return leaves.map((line) => ({
    ...line,
    intensity: (line.intensity / maxIntensity) * 100
  }));
}

function combineDegenerate(lines) {
  if (!lines.length) {
    return [];
  }
  const map = new Map();
  for (const line of lines) {
    const key = line.hz.toFixed(6);
    const current = map.get(key);
    if (current) {
      current.intensity += line.intensity;
    } else {
      map.set(key, { hz: line.hz, intensity: line.intensity });
    }
  }
  const merged = Array.from(map.values()).sort((a, b) => a.hz - b.hz);
  const maxIntensity = merged.reduce((best, line) => Math.max(best, line.intensity), 0) || 1;
  return merged.map((line) => ({
    hz: line.hz,
    intensity: (line.intensity / maxIntensity) * 100
  }));
}

function hzToPpm(hz, frequencyMHz) {
  return hz / frequencyMHz;
}

function generateProfile(lines, centerPpm, frequencyMHz, fwhmHz) {
  if (!lines.length) {
    return [];
  }
  const sigmaPpm = Math.max(hzToPpm(fwhmHz, frequencyMHz) / 2.354820045, 0.000001);
  const ppmLines = lines.map((line) => ({
    ppm: centerPpm + hzToPpm(line.hz, frequencyMHz),
    intensity: line.intensity
  }));
  const minPpm = ppmLines[0].ppm - (sigmaPpm * 6);
  const maxPpm = ppmLines[ppmLines.length - 1].ppm + (sigmaPpm * 6);
  const points = [];
  const pointCount = 900;
  const step = (maxPpm - minPpm) / (pointCount - 1);

  for (let i = 0; i < pointCount; i += 1) {
    const x = minPpm + (i * step);
    let y = 0;
    for (const line of ppmLines) {
      const dx = x - line.ppm;
      y += line.intensity * Math.exp(-(dx * dx) / (2 * sigmaPpm * sigmaPpm));
    }
    points.push({ ppm: x, intensity: y });
  }

  const maxY = points.reduce((best, p) => Math.max(best, p.intensity), 0) || 1;
  return points.map((p) => ({ ppm: p.ppm, intensity: (p.intensity / maxY) * 100 }));
}

function multipletName(layers) {
  if (!layers.length) {
    return "singlet (s)";
  }
  return `${layers.map((layer) => MULTIPLETS[layer.type].short).join("")} (${layers.map((layer) => MULTIPLETS[layer.type].label).join(" of ")})`;
}

function getResponsivePlotHeights() {
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 900;
  const panel = elements.spectrum.closest(".plot-panel");
  const panelTop = panel ? panel.getBoundingClientRect().top : elements.spectrum.getBoundingClientRect().top;
  const available = Math.max(420, viewportHeight - panelTop - 16);
  const fixedUi = 122;
  const usable = clamp(available - fixedUi, 340, 760);
  const treeHeight = clamp(Math.round(usable * 0.38), 150, 250);
  const spectrumHeight = clamp(usable - treeHeight - 10, 190, 430);

  elements.tree.style.setProperty("--tree-height", `${treeHeight}px`);
  elements.spectrum.style.setProperty("--nmr-spectrum-height", `${spectrumHeight}px`);
  return { treeHeight, spectrumHeight };
}

function renderSpectrum(lines, profile, centerPpm, frequencyMHz) {
  if (!lines.length || !profile.length) {
    elements.spectrum.innerHTML = '<div class="plot-empty">Select at least one splitting layer with J &gt; 0.</div>';
    return;
  }

  const ppmLines = lines.map((line) => ({
    ppm: centerPpm + hzToPpm(line.hz, frequencyMHz),
    intensity: line.intensity
  }));
  const minX = profile[0].ppm;
  const maxX = profile[profile.length - 1].ppm;
  const width = Math.max(elements.spectrum.clientWidth || 320, 320);
  const height = getResponsivePlotHeights().spectrumHeight;
  elements.spectrum.style.setProperty("--plot-height", `${height}px`);
  const margin = { top: 20, right: 44, bottom: 44, left: 88 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const xToPx = (x) => margin.left + ((maxX - x) / (maxX - minX)) * plotWidth;
  const yToPx = (y) => margin.top + plotHeight - (y / 100) * plotHeight;

  const profilePoints = profile.map((point) => `${xToPx(point.ppm).toFixed(2)},${yToPx(point.intensity).toFixed(2)}`).join(" ");
  const profileFilled = `${margin.left},${yToPx(0).toFixed(2)} ${profilePoints} ${margin.left + plotWidth},${yToPx(0).toFixed(2)}`;

  const sticks = elements.showCentersToggle.checked
    ? ppmLines
      .map((line) => `<line x1="${xToPx(line.ppm).toFixed(2)}" y1="${yToPx(0).toFixed(2)}" x2="${xToPx(line.ppm).toFixed(2)}" y2="${yToPx(line.intensity).toFixed(2)}" stroke="#d9730d" stroke-width="1.7"></line>`)
      .join("")
    : "";

  const xTicks = Array.from({ length: 7 }, (_, i) => {
    const ppm = minX + ((maxX - minX) * i / 6);
    const x = margin.left + (plotWidth * (1 - i / 6));
    return `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + plotHeight}" stroke="rgba(24,36,45,0.08)"></line><text x="${x}" y="${height - 14}" text-anchor="middle" font-size="11" fill="#56646f">${ppm.toFixed(3)}</text>`;
  }).join("");

  const yTicks = [0, 25, 50, 75, 100].map((value) => {
    const y = yToPx(value);
    return `<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotWidth}" y2="${y}" stroke="rgba(24,36,45,0.08)"></line><text x="${margin.left - 10}" y="${y + 4}" text-anchor="end" font-size="11" fill="#56646f">${value}</text>`;
  }).join("");

  elements.spectrum.innerHTML = `<svg class="plot-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><rect x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" fill="rgba(255,255,255,0.72)" rx="14"></rect>${xTicks}${yTicks}<line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" stroke="#23343f"></line><line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" stroke="#23343f"></line><polygon points="${profileFilled}" fill="rgba(13, 108, 116, 0.16)"></polygon><polyline points="${profilePoints}" fill="none" stroke="#0d6c74" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"></polyline>${sticks}<text x="${margin.left + plotWidth / 2}" y="${height - 2}" text-anchor="middle" font-size="12" fill="#18242d">Chemical shift (ppm)</text><text x="18" y="${margin.top + plotHeight / 2}" text-anchor="middle" font-size="12" fill="#18242d" transform="rotate(-90 18 ${margin.top + plotHeight / 2})">Relative intensity</text></svg>`;
}

function renderTree(nodes, edges, layers, centerPpm, frequencyMHz) {
  if (!layers.length || !nodes.length) {
    elements.tree.innerHTML = '<div class="plot-empty">Splitting tree will appear after prediction.</div>';
    return;
  }

  const depthCount = layers.length + 1;
  const hzById = new Map(nodes.map((node) => [node.id, node.hz]));
  const hzValues = Array.from(hzById.values());
  const minHz = Math.min(...hzValues);
  const maxHz = Math.max(...hzValues);
  const span = Math.max(maxHz - minHz, 0.0001);
  const width = Math.max(elements.tree.clientWidth || 320, 320);
  const height = getResponsivePlotHeights().treeHeight;
  const margin = { top: 22, right: 32, bottom: 24, left: 32 };
  const plotWidth = width - margin.left - margin.right;
  const levelCount = Math.max(depthCount - 1, 1);
  const layerStep = Math.min(44, Math.max(30, Math.floor((height - 80) / levelCount)));
  const treeDepthHeight = layerStep * (depthCount - 1);
  const treeBottom = margin.top + treeDepthHeight;
  const xToPx = (hz) => margin.left + ((maxHz - hz) / span) * plotWidth;
  const yToPx = (depth) => margin.top + (depth * layerStep);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  const parentNodeIds = new Set(edges.map((edge) => edge.from));
  const leafNodeIds = new Set(nodes.filter((node) => node.depth === layers.length).map((node) => node.id));
  const tickNodeIds = new Set([...parentNodeIds, ...leafNodeIds]);
  const maxTickHeight = 15;
  const maxIntensityByDepth = nodes.reduce((map, node) => {
    map.set(node.depth, Math.max(map.get(node.depth) || 0, node.intensity));
    return map;
  }, new Map());
  const tickHeightForNode = (node) => {
    const maxIntensity = maxIntensityByDepth.get(node.depth) || node.intensity || 1;
    return Math.max(2, (node.intensity / maxIntensity) * maxTickHeight);
  };
  const tickBottomForDepth = (depth) => yToPx(depth) + maxTickHeight / 2;
  const tickTopForNode = (node) => {
    return tickBottomForDepth(node.depth) - tickHeightForNode(node);
  };

  const edgeMarkup = edges.map((edge) => {
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    const fromY = tickBottomForDepth(from.depth);
    const toY = tickNodeIds.has(to.id) ? tickTopForNode(to) : yToPx(to.depth);
    return `<line x1="${xToPx(hzById.get(from.id)).toFixed(2)}" y1="${fromY.toFixed(2)}" x2="${xToPx(hzById.get(to.id)).toFixed(2)}" y2="${toY.toFixed(2)}" stroke="rgba(11,120,98,0.75)" stroke-width="1.5" stroke-dasharray="4 4"></line>`;
  }).join("");

  const joinTickMarkup = nodes
    .filter((node) => tickNodeIds.has(node.id))
    .map((node) => {
      const x = xToPx(hzById.get(node.id)).toFixed(2);
      const y1 = tickTopForNode(node);
      const y2 = tickBottomForDepth(node.depth);
      return `<line x1="${x}" y1="${y1.toFixed(2)}" x2="${x}" y2="${y2.toFixed(2)}" stroke="#24323b" stroke-width="1.6"></line>`;
    })
    .join("");

  const levelLabels = layers.map((layer, i) => {
    const y = yToPx(i + 1) - 10;
    const text = `L${layer.index}: ${MULTIPLETS[layer.type].short}, J=${layer.j.toFixed(2)} Hz`;
    return `<text x="${margin.left + 6}" y="${y.toFixed(2)}" font-size="11" fill="#355a62">${text}</text>`;
  }).join("");

  elements.tree.innerHTML = `<svg class="tree-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><rect x="${margin.left}" y="${margin.top - 18}" width="${plotWidth}" height="${(treeBottom - margin.top) + 30}" rx="14" fill="rgba(255,255,255,0.62)" stroke="rgba(24,36,45,0.08)"></rect>${edgeMarkup}${joinTickMarkup}${levelLabels}<text x="${margin.left + plotWidth / 2}" y="${height - 6}" text-anchor="middle" font-size="12" fill="#18242d">Offset from center (Hz)</text></svg>`;
}

function predict() {
  try {
    const centerPpm = Number(elements.centerPpm.value);
    const frequencyMHz = clamp(Number(elements.frequency.value) || 400, 60, 1200);
    const fwhmHz = clamp(Number(elements.linewidth.value) || 0.8, 0.1, 5);
    const layers = readLayers();
    getResponsivePlotHeights();

    if (!Number.isFinite(centerPpm)) {
      throw new Error("Chemical shift must be a number.");
    }
    if (!layers.length) {
      state.layers = [];
      state.leaves = [];
      state.nodes = [];
      state.edges = [];
      renderSpectrum([], [], centerPpm, frequencyMHz);
      renderTree([], [], [], centerPpm, frequencyMHz);
      elements.summaryMultiplet.textContent = "singlet (s)";
      elements.summaryLayers.textContent = "0";
      elements.summaryLines.textContent = "1";
      elements.summarySpread.textContent = "0.000 ppm";
      setStatus("Add at least one splitting layer with J > 0 Hz.", true);
      return;
    }

    const expansion = expandSplitting(layers);
    const normalized = normalizeLeaves(expansion.leaves);
    const mergedLines = combineDegenerate(normalized);
    const profile = generateProfile(mergedLines, centerPpm, frequencyMHz, fwhmHz);
    const spreadHz = mergedLines.length > 1 ? (mergedLines[mergedLines.length - 1].hz - mergedLines[0].hz) : 0;
    const spreadPpm = hzToPpm(spreadHz, frequencyMHz);

    state.layers = layers;
    state.leaves = mergedLines;
    state.nodes = expansion.nodes;
    state.edges = expansion.edges;

    renderSpectrum(mergedLines, profile, centerPpm, frequencyMHz);
    renderTree(expansion.nodes, expansion.edges, layers, centerPpm, frequencyMHz);

    elements.summaryMultiplet.textContent = multipletName(layers);
    elements.summaryLayers.textContent = String(layers.length);
    elements.summaryLines.textContent = String(mergedLines.length);
    elements.summarySpread.textContent = `${spreadPpm.toFixed(3)} ppm`;
    setStatus(`Predicted ${multipletName(layers)} with Gaussian FWHM ${fwhmHz.toFixed(1)} Hz.`);
  } catch (error) {
    setStatus(error.message || "Could not predict multiplet.", true);
  }
}

function bindEvents() {
  elements.linewidth.addEventListener("input", () => {
    elements.linewidthOutput.value = `${Number(elements.linewidth.value).toFixed(1)} Hz`;
  });
  elements.predictButton.addEventListener("click", predict);
  elements.frequency.addEventListener("change", predict);
  elements.centerPpm.addEventListener("change", predict);
  elements.linewidth.addEventListener("change", predict);
  elements.showCentersToggle.addEventListener("change", predict);
  elements.multipletSelects.forEach((select) => select.addEventListener("change", predict));
  elements.jInputs.forEach((input) => input.addEventListener("change", predict));
  window.addEventListener("resize", () => {
    if (state.layers.length) {
      predict();
    }
  });
}

bindEvents();
elements.linewidthOutput.value = `${Number(elements.linewidth.value).toFixed(1)} Hz`;
predict();
