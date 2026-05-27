const http = require("node:http");
const { URL } = require("node:url");
const { SUPPORTED_TYPES, generateSpectrumCsv, generateSpectrumPresentation } = require("./api/predictor-service");

const port = Number(process.env.PORT || 3000);

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendCsv(res, payload) {
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${payload.filename}"`,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(payload.csv);
}

function sendPptx(res, payload) {
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "Content-Disposition": `attachment; filename="${payload.filename}"`,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(payload.data);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed. Use GET." });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      endpoint: "/api/spectrum",
      presentationEndpoint: "/api/presentation",
      supportedTypes: [...SUPPORTED_TYPES]
    });
    return;
  }

  if (url.pathname === "/api/presentation") {
    generateSpectrumPresentation({
      smiles: url.searchParams.get("smiles")
    }).then((payload) => {
      sendPptx(res, payload);
    }).catch((error) => {
      sendJson(res, 400, { error: error.message || "Could not generate PPTX." });
    });
    return;
  }

  if (url.pathname !== "/api/spectrum") {
    sendJson(res, 404, { error: "Not found." });
    return;
  }

  try {
    const payload = generateSpectrumCsv({
      smiles: url.searchParams.get("smiles"),
      type: url.searchParams.get("type")
    });
    sendCsv(res, payload);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Could not generate spectrum CSV." });
  }
});

server.listen(port, () => {
  console.log(`NMRpredictor API listening on http://localhost:${port}`);
});
