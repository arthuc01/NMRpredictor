(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.NMRPresentationExport = factory();
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const PAGE_SIZE = { w: 13.333, h: 7.5 };
  const SPECTRUM_TYPES = ["proton", "carbon", "hsqc", "cosy", "noesy"];

  function sanitizeFilename(value) {
    return String(value || "")
      .replace(/[^a-z0-9-_]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      || "molecule";
  }

  function svgToDataUri(svg) {
    const encoded = typeof Buffer !== "undefined"
      ? Buffer.from(svg, "utf8").toString("base64")
      : btoa(unescape(encodeURIComponent(svg)));
    return `data:image/svg+xml;base64,${encoded}`;
  }

  function fallback1dDomain(type) {
    return type === "carbon" ? { min: 0, max: 200 } : { min: 0, max: 10 };
  }

  function autoDomain(ctx, signals, type) {
    const fallback = fallback1dDomain(type);
    if (typeof ctx.autoDomainForSignals === "function") {
      return ctx.autoDomainForSignals(signals, fallback, type === "carbon"
        ? { minPadding: 6, maxPadding: 10, minPaddingRatio: 0.08, maxPaddingRatio: 0.1 }
        : { minPadding: 0.35, maxPadding: 0.65, minPaddingRatio: 0.05, maxPaddingRatio: 0.07 });
    }
    return { ...fallback };
  }

  function profileRows(ctx, environments, type, domain, sampleCount = null) {
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

  function xForPpm(ppm, domain, left, width) {
    return left + ((domain.max - ppm) / (domain.max - domain.min)) * width;
  }

  function yForValue(value, top, height) {
    return top + height - (value / 100) * height;
  }

  function chooseTickStep(span, type) {
    if (type === "carbon") {
      if (span <= 25) return 5;
      if (span <= 60) return 10;
      if (span <= 120) return 20;
      return 50;
    }
    if (span <= 0.6) return 0.1;
    if (span <= 1.4) return 0.2;
    if (span <= 3) return 0.5;
    if (span <= 7) return 1;
    return 2;
  }

  function multiplicityLabel(signal) {
    const integration = Number.isFinite(signal.integration) ? `${Math.round(signal.integration)}H` : signal.nucleus;
    const mult = String(signal.multiplicity || "").trim();
    return mult && mult !== "s" ? `${integration} ${mult}` : integration;
  }

  function nonSingletSignals(ctx, protonSignals) {
    return (protonSignals || [])
      .filter((signal) => signal.nucleus === "1H")
      .filter((signal) => {
        if (signal.broad) return false;
        const components = ctx.expandPeaks([signal], "proton");
        return components.length > 1;
      })
      .map((signal) => ({
        signal,
        peaks: ctx.expandPeaks([signal], "proton").sort((a, b) => b.ppm - a.ppm)
      }));
  }

  function selectZoomWindows(ctx, protonSignals, maxPanels = 4) {
    const signals = nonSingletSignals(ctx, protonSignals).sort((a, b) => b.signal.ppm - a.signal.ppm);
    if (!signals.length) return [];

    const groups = [];
    signals.forEach((entry) => {
      const current = groups[groups.length - 1];
      if (current && Math.abs(current.anchorPpm - entry.signal.ppm) <= 1.0) {
        current.items.push(entry);
        current.anchorPpm = (current.anchorPpm + entry.signal.ppm) / 2;
      } else {
        groups.push({ anchorPpm: entry.signal.ppm, items: [entry] });
      }
    });

    return groups
      .map((group) => {
        const strongest = group.items.slice().sort((a, b) => {
          const areaA = a.peaks.reduce((sum, peak) => sum + peak.intensity, 0);
          const areaB = b.peaks.reduce((sum, peak) => sum + peak.intensity, 0);
          return areaB - areaA || b.signal.ppm - a.signal.ppm;
        })[0];
        const allPeaks = group.items.flatMap((item) => item.peaks);
        const minPeak = Math.min(...allPeaks.map((peak) => peak.ppm));
        const maxPeak = Math.max(...allPeaks.map((peak) => peak.ppm));
        let domain;
        if (group.items.length > 1) {
          const center = strongest.signal.ppm;
          domain = {
            min: Math.max(0, center - 0.5),
            max: Math.min(12, center + 0.5)
          };
        } else {
          const center = (minPeak + maxPeak) / 2;
          const halfSpan = Math.min(0.5, Math.max(0.14, ((maxPeak - minPeak) / 2) + 0.08));
          domain = {
            min: Math.max(0, center - halfSpan),
            max: Math.min(12, center + halfSpan)
          };
        }
        return {
          domain,
          title: group.items.length > 1
            ? `Multiplet cluster near ${strongest.signal.ppm.toFixed(2)} ppm`
            : `${multiplicityLabel(strongest.signal)} at ${strongest.signal.ppm.toFixed(2)} ppm`,
          signals: group.items.map((item) => item.signal.signalId),
          weight: group.items.reduce((sum, item) => sum + (item.signal.integration || 1), 0),
          ppm: strongest.signal.ppm
        };
      })
      .sort((a, b) => b.weight - a.weight || b.ppm - a.ppm)
      .slice(0, maxPanels);
  }

  function render1DSvg(ctx, environments, type, options = {}) {
    const domain = options.domain || autoDomain(ctx, environments, type);
    const width = options.width || 1200;
    const height = options.height || 360;
    const margin = { top: 28, right: 28, bottom: 48, left: 70 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const profile = profileRows(ctx, environments, type, domain, options.sampleCount);
    const peaks = ctx.expandPeaks(environments, type)
      .filter((peak) => peak.ppm >= domain.min && peak.ppm <= domain.max)
      .sort((a, b) => b.ppm - a.ppm);
    const path = profile.map((row, index) => {
      const x = xForPpm(row.ppm, domain, margin.left, plotW).toFixed(2);
      const y = yForValue(row.relativeIntensity, margin.top, plotH).toFixed(2);
      return `${index === 0 ? "M" : "L"}${x},${y}`;
    }).join(" ");
    const relativeHeightAt = (ppm) => profile.reduce((best, row) => (
      Math.abs(row.ppm - ppm) < Math.abs(best.ppm - ppm) ? row : best
    ), profile[0]).relativeIntensity;
    const span = domain.max - domain.min;
    const tickStep = chooseTickStep(span, type);
    const xTicks = [];
    const start = Math.floor(domain.min / tickStep) * tickStep;
    const end = Math.ceil(domain.max / tickStep) * tickStep;
    for (let value = start; value <= end + 1e-9; value += tickStep) {
      if (value >= domain.min - 1e-9 && value <= domain.max + 1e-9) {
        xTicks.push(Number(value.toFixed(3)));
      }
    }
    const yTicks = [0, 20, 40, 60, 80, 100];
    const signalLabels = environments
      .filter((env) => env.ppm >= domain.min && env.ppm <= domain.max)
      .map((env) => {
        const localPeaks = peaks.filter((peak) => peak.env.signalId === env.signalId);
        const topPeak = localPeaks.reduce((best, peak) => (peak.intensity > (best?.intensity || 0) ? peak : best), null);
        const peakY = topPeak ? profile.reduce((best, row) => Math.abs(row.ppm - topPeak.ppm) < Math.abs(best.ppm - topPeak.ppm) ? row : best, profile[0]).relativeIntensity : 0;
        return {
          x: xForPpm(env.ppm, domain, margin.left, plotW),
          y: yForValue(Math.min(100, peakY + 8), margin.top, plotH),
          text: multiplicityLabel(env)
        };
      });

    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`,
      yTicks.map((tick) => {
        const y = yForValue(tick, margin.top, plotH).toFixed(2);
        return `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#d6d6d6" stroke-width="1"/><text x="${margin.left - 10}" y="${Number(y) + 4}" font-size="14" text-anchor="end" fill="#000000">${tick}</text>`;
      }).join(""),
      xTicks.map((tick) => {
        const x = xForPpm(tick, domain, margin.left, plotW).toFixed(2);
        return `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${height - margin.bottom}" stroke="#ececec" stroke-width="1"/><text x="${x}" y="${height - margin.bottom + 22}" font-size="14" text-anchor="middle" fill="#000000">${Number.isInteger(tick) ? tick : tick.toFixed(tickStep < 1 ? 1 : 0)}</text>`;
      }).join(""),
      `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#000000" stroke-width="1.5"/>`,
      `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#000000" stroke-width="1.5"/>`,
      `<path d="${path}" fill="none" stroke="#111111" stroke-width="${type === "carbon" ? 2.2 : 2}" stroke-linejoin="round" stroke-linecap="round"/>`,
      signalLabels.map((label) => `<text x="${label.x.toFixed(2)}" y="${Math.max(18, label.y).toFixed(2)}" font-size="14" text-anchor="middle" fill="#000000">${label.text}</text>`).join(""),
      `<text x="${width / 2}" y="${height - 10}" font-size="18" text-anchor="middle" fill="#000000">Chemical shift (ppm)</text>`,
      `<text x="20" y="${height / 2}" transform="rotate(-90 20 ${height / 2})" font-size="18" text-anchor="middle" fill="#000000">Relative intensity</text>`,
      `</svg>`
    ].join("");
  }

  function auto2DDomain(ctx, peaks, type, axis) {
    if (type === "hsqc") {
      const values = peaks.map((peak) => axis === "x" ? peak.x : peak.y).filter(Number.isFinite);
      if (!values.length) return axis === "x" ? { min: 0, max: 12 } : { min: 0, max: 220 };
      const fallbackType = axis === "x" ? "proton" : "carbon";
      return autoDomain(ctx, values.map((ppm) => ({ ppm })), fallbackType);
    }
    const values = peaks.map((peak) => axis === "x" ? peak.x : peak.y).filter(Number.isFinite);
    return autoDomain(ctx, values.map((ppm) => ({ ppm })), "proton");
  }

  function render2DSvg(ctx, peaks, type, options = {}) {
    const width = options.width || 1200;
    const height = options.height || 500;
    const margin = { top: 28, right: 28, bottom: 48, left: 64 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const xDomain = options.xDomain || auto2DDomain(ctx, peaks, type, "x");
    const yDomain = options.yDomain || auto2DDomain(ctx, peaks, type, "y");
    const xSpan = xDomain.max - xDomain.min;
    const ySpan = yDomain.max - yDomain.min;
    const xTickStep = chooseTickStep(xSpan, "proton");
    const yTickStep = type === "hsqc" ? chooseTickStep(ySpan, "carbon") : chooseTickStep(ySpan, "proton");
    const xTicks = [];
    const yTicks = [];
    for (let value = Math.floor(xDomain.min / xTickStep) * xTickStep; value <= xDomain.max + 1e-9; value += xTickStep) {
      if (value >= xDomain.min - 1e-9) xTicks.push(Number(value.toFixed(3)));
    }
    for (let value = Math.floor(yDomain.min / yTickStep) * yTickStep; value <= yDomain.max + 1e-9; value += yTickStep) {
      if (value >= yDomain.min - 1e-9) yTicks.push(Number(value.toFixed(3)));
    }
    const xFor = (ppm) => margin.left + ((xDomain.max - ppm) / (xDomain.max - xDomain.min)) * plotW;
    const yFor = (ppm) => margin.top + ((yDomain.max - ppm) / (yDomain.max - yDomain.min)) * plotH;
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`,
      xTicks.map((tick) => {
        const x = xFor(tick).toFixed(2);
        return `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${height - margin.bottom}" stroke="#ececec" stroke-width="1"/><text x="${x}" y="${height - margin.bottom + 22}" font-size="14" text-anchor="middle" fill="#000000">${Number.isInteger(tick) ? tick : tick.toFixed(xTickStep < 1 ? 1 : 0)}</text>`;
      }).join(""),
      yTicks.map((tick) => {
        const y = yFor(tick).toFixed(2);
        return `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#ececec" stroke-width="1"/><text x="${margin.left - 10}" y="${Number(y) + 4}" font-size="14" text-anchor="end" fill="#000000">${Number.isInteger(tick) ? tick : tick.toFixed(yTickStep < 1 ? 1 : 0)}</text>`;
      }).join(""),
      `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#000000" stroke-width="1.5"/>`,
      `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#000000" stroke-width="1.5"/>`,
      peaks.map((peak) => {
        const x = xFor(peak.x).toFixed(2);
        const y = yFor(peak.y).toFixed(2);
        const radius = type === "noesy" ? 5 + ((peak.volume || 0) * 5) : 5.5;
        const fill = peak.diagonal ? "#999999" : "#111111";
        return `<circle cx="${x}" cy="${y}" r="${radius.toFixed(1)}" fill="${fill}" opacity="${peak.diagonal ? 0.45 : 0.85}"/>`;
      }).join(""),
      `<text x="${width / 2}" y="${height - 10}" font-size="18" text-anchor="middle" fill="#000000">1H shift (ppm)</text>`,
      `<text x="20" y="${height / 2}" transform="rotate(-90 20 ${height / 2})" font-size="18" text-anchor="middle" fill="#000000">${type === "hsqc" ? "13C shift (ppm)" : "1H shift (ppm)"}</text>`,
      `</svg>`
    ].join("");
  }

  function deriveStructureCoordinates(ctx, smiles, graph, providedCoordinates = null) {
    if (Array.isArray(providedCoordinates) && providedCoordinates.length >= graph.atoms.length) {
      return typeof ctx.minimizeDisplayCoordinates === "function"
        ? ctx.minimizeDisplayCoordinates(graph, providedCoordinates)
        : providedCoordinates;
    }
    let coordinates = null;
    if (typeof ctx.fallbackNoesyCoordinates === "function") {
      coordinates = ctx.fallbackNoesyCoordinates(graph);
    } else {
      coordinates = graph.atoms.map((_, index) => ({ x: index * 1.5, y: 0, z: 0 }));
    }
    return typeof ctx.minimizeDisplayCoordinates === "function"
      ? ctx.minimizeDisplayCoordinates(graph, coordinates)
      : coordinates;
  }

  function renderStructureSvg(graph, coordinates, options = {}) {
    const width = options.width || 960;
    const height = options.height || 560;
    const margin = 56;
    const points = (coordinates || []).map((point) => ({
      x: Number.isFinite(point?.x) ? point.x : 0,
      y: Number.isFinite(point?.y) ? point.y : 0
    }));
    if (!points.length) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#ffffff"/></svg>`;
    }
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const scale = Math.min((width - (margin * 2)) / spanX, (height - (margin * 2)) / spanY);
    const mapped = points.map((point) => ({
      x: margin + ((point.x - minX) * scale),
      y: margin + ((maxY - point.y) * scale)
    }));
    const bonds = graph.bonds.map((bond) => {
      const from = mapped[bond.from];
      const to = mapped[bond.to];
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy) || 1;
      const offsetX = (-dy / length) * 4;
      const offsetY = (dx / length) * 4;
      if (bond.order >= 2) {
        return [
          `<line x1="${(from.x + offsetX).toFixed(2)}" y1="${(from.y + offsetY).toFixed(2)}" x2="${(to.x + offsetX).toFixed(2)}" y2="${(to.y + offsetY).toFixed(2)}" stroke="#000000" stroke-width="2"/>`,
          `<line x1="${(from.x - offsetX).toFixed(2)}" y1="${(from.y - offsetY).toFixed(2)}" x2="${(to.x - offsetX).toFixed(2)}" y2="${(to.y - offsetY).toFixed(2)}" stroke="#000000" stroke-width="2"/>`
        ].join("");
      }
      return `<line x1="${from.x.toFixed(2)}" y1="${from.y.toFixed(2)}" x2="${to.x.toFixed(2)}" y2="${to.y.toFixed(2)}" stroke="#000000" stroke-width="2.4"/>`;
    }).join("");
    const labels = graph.atoms.map((atom, index) => {
      const point = mapped[index];
      const neighbours = graph.bonds.filter((bond) => bond.from === index || bond.to === index).length;
      const showLabel = atom.element !== "C" || atom.formalCharge || neighbours === 0;
      if (!showLabel) return "";
      const charge = atom.formalCharge > 0 ? `+${atom.formalCharge > 1 ? atom.formalCharge : ""}` : atom.formalCharge < 0 ? `${atom.formalCharge}` : "";
      return `<text x="${point.x.toFixed(2)}" y="${(point.y + 6).toFixed(2)}" font-size="26" font-family="Arial, sans-serif" text-anchor="middle" fill="#000000">${atom.element}${charge}</text>`;
    }).join("");
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`,
      bonds,
      labels,
      `</svg>`
    ].join("");
  }

  function normalizeStructureSvg(svg, options = {}) {
    const width = options.width || 960;
    const height = options.height || 560;
    if (!svg || !String(svg).includes("<svg")) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#ffffff"/></svg>`;
    }
    const source = String(svg).replace(/<\?xml[\s\S]*?\?>/gi, "").replace(/<!DOCTYPE[\s\S]*?>/gi, "").trim();
    const openTagMatch = source.match(/<svg\b([^>]*)>/i);
    const innerMatch = source.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/i);
    const viewBoxMatch = source.match(/viewBox=['"]([^'"]+)['"]/i);
    const widthMatch = source.match(/\bwidth=['"]([\d.]+)(?:px)?['"]/i);
    const heightMatch = source.match(/\bheight=['"]([\d.]+)(?:px)?['"]/i);
    const viewBox = viewBoxMatch
      ? viewBoxMatch[1]
      : `0 0 ${widthMatch ? Number(widthMatch[1]) || width : width} ${heightMatch ? Number(heightMatch[1]) || height : height}`;
    const inner = innerMatch ? innerMatch[1] : source.replace(/<svg\b[^>]*>/i, "").replace(/<\/svg>/i, "");
    const preserveAspectRatio = /preserveAspectRatio=/i.test(openTagMatch?.[1] || "") ? "" : ` preserveAspectRatio="xMidYMid meet"`;
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}"${preserveAspectRatio}>`,
      `<rect x="0" y="0" width="100%" height="100%" fill="#ffffff"/>`,
      inner,
      `</svg>`
    ].join("");
  }

  function buildPresentationSpec(ctx, input) {
    const smiles = String(input.smiles || "").trim();
    const graph = input.graph;
    const predictions = input.predictions;
    const structureCoordinates = deriveStructureCoordinates(ctx, smiles, graph, input.structureCoordinates);
    const structureSvg = input.structureSvg
      ? normalizeStructureSvg(input.structureSvg)
      : renderStructureSvg(graph, structureCoordinates);
    const protonZooms = selectZoomWindows(ctx, predictions.proton || [], 4);
    return {
      filename: `${sanitizeFilename(smiles)}-nmr-slides.pptx`,
      slides: [
        {
          kind: "structure",
          title: "Molecular Structure",
          subtitle: `SMILES: ${smiles}`,
          structureSvg
        },
        {
          kind: "1d",
          type: "proton",
          title: "1H NMR",
          panels: [
            {
              title: "Full spectrum",
              svg: render1DSvg(ctx, predictions.proton || [], "proton", {
                width: 1200,
                height: 320,
                domain: { min: 0, max: 10 }
              })
            },
            ...protonZooms.map((panel) => ({
              title: panel.title,
              svg: render1DSvg(ctx, predictions.proton || [], "proton", {
                domain: panel.domain,
                width: 760,
                height: 220,
                sampleCount: 2800
              })
            }))
          ]
        },
        {
          kind: "1d",
          type: "carbon",
          title: "13C NMR",
          panels: [
            {
              title: "Full spectrum",
              svg: render1DSvg(ctx, predictions.carbon || [], "carbon", {
                width: 1200,
                height: 360,
                domain: { min: 0, max: 200 }
              })
            }
          ]
        },
        {
          kind: "2d",
          type: "hsqc",
          title: "HSQC",
          svg: render2DSvg(ctx, predictions.hsqc || [], "hsqc")
        },
        {
          kind: "2d",
          type: "cosy",
          title: "COSY",
          svg: render2DSvg(ctx, predictions.cosy || [], "cosy")
        },
        {
          kind: "2d",
          type: "noesy",
          title: "NOESY",
          svg: render2DSvg(ctx, predictions.noesy || [], "noesy")
        }
      ]
    };
  }

  function addSlideHeader(slide, title, subtitle = "") {
    slide.addText(title, {
      x: 0.45, y: 0.28, w: 8.5, h: 0.35,
      fontFace: "Arial", fontSize: 22, bold: true, color: "000000"
    });
    if (subtitle) {
      slide.addText(subtitle, {
        x: 0.45, y: 0.62, w: 12.2, h: 0.28,
        fontFace: "Arial", fontSize: 10.5, color: "222222"
      });
    }
  }

  async function buildPresentationFile(PptxGenJS, ctx, input, options = {}) {
    const spec = buildPresentationSpec(ctx, input);
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    pptx.author = "Arthur Group";
    pptx.company = "University of Bristol";
    pptx.subject = "NMR teaching spectra";
    pptx.title = `${input.smiles} NMR spectra`;
    pptx.lang = "en-GB";
    pptx.theme = {
      headFontFace: "Arial",
      bodyFontFace: "Arial",
      lang: "en-GB"
    };

    spec.slides.forEach((entry) => {
      const slide = pptx.addSlide();
      slide.background = { color: "FFFFFF" };
      addSlideHeader(slide, entry.title, entry.subtitle || "Teaching-level heuristic prediction export");
      if (entry.kind === "structure") {
        slide.addImage({ data: svgToDataUri(entry.structureSvg), x: 1.0, y: 1.1, w: 11.3, h: 5.7 });
        return;
      }
      if (entry.kind === "1d") {
        const full = entry.panels[0];
        const zooms = entry.panels.slice(1);
        slide.addText(full.title, { x: 0.55, y: 0.95, w: 4.2, h: 0.24, fontFace: "Arial", fontSize: 11, color: "000000" });
        slide.addImage({ data: svgToDataUri(full.svg), x: 0.45, y: 1.2, w: 12.35, h: zooms.length ? 3.2 : 5.8 });
        if (!zooms.length) {
          return;
        }
        const layouts = zooms.length <= 2
          ? zooms.map((_, index) => ({ x: 0.55 + index * 6.1, y: 4.8, w: 5.85, h: 2.0 }))
          : zooms.map((_, index) => ({
            x: 0.55 + (index % 2) * 6.1,
            y: 4.8 + Math.floor(index / 2) * 1.08,
            w: 5.85,
            h: 0.98
          }));
        zooms.forEach((zoom, index) => {
          const box = layouts[index];
          slide.addText(zoom.title, { x: box.x, y: box.y - 0.22, w: box.w, h: 0.18, fontFace: "Arial", fontSize: 9.5, color: "000000", align: "center" });
          slide.addImage({ data: svgToDataUri(zoom.svg), x: box.x, y: box.y, w: box.w, h: box.h });
        });
        return;
      }
      slide.addImage({ data: svgToDataUri(entry.svg), x: 0.45, y: 1.2, w: 12.35, h: 5.9 });
    });

    const outputType = options.outputType || (typeof window === "undefined" ? "nodebuffer" : "blob");
    const data = await pptx.write({ outputType, compression: true });
    return {
      filename: spec.filename,
      data,
      slideCount: spec.slides.length
    };
  }

  return {
    PAGE_SIZE,
    SPECTRUM_TYPES,
    buildPresentationSpec,
    buildPresentationFile,
    render1DSvg,
    render2DSvg,
    normalizeStructureSvg,
    renderStructureSvg,
    sanitizeFilename,
    svgToDataUri
  };
}));
