
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

// Keys: sim/server/.env if it exists, otherwise the main backend's .env (same GEMINI_API_KEY, nothing to copy).
dotenv.config({ path: ["server/.env", "../backend/.env"], quiet: true });

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/analyze", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY ||
        process.env.GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE") {
      return res.status(503).json({
        error: "Gemini API key is missing. Add GEMINI_API_KEY to backend/.env.",
      });
    }

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    // Same models as the main KnowFlyZone backend; try the next one if a model is busy.
    const models = [process.env.GEMINI_MODEL || "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash"];
    const contents = `
You are the KnowFlyZone flight simulator assistant, an experimental drone flight-risk helper.

Analyze the following simulation data:

${JSON.stringify(req.body, null, 2)}

Provide:
1. Overall risk assessment
2. Weather concerns
3. Power-line and infrastructure concerns
4. Wildlife considerations
5. Recommended precautions
6. Data limitations

IMPORTANT:
- Never claim a flight is authorized.
- FAA airspace status is unverified.
- Historical bird observations do not indicate current bird positions.
- Missing infrastructure data does not mean no hazards exist.
- This is a prototype, not certified flight-safety software.

- Give risk as a score out of 100 (low 0-29, medium 30-59, high 60-100). Never say go, wait or don't fly.
- Do not use em dashes, emojis or markdown symbols.

Respond in clear, concise plain text.
`;

    let response = null;
    let usedModel = models[0];
    let lastError = null;
    for (const model of models) {
      try {
        response = await ai.models.generateContent({ model, contents });
        usedModel = model;
        break;
      } catch (error) {
        lastError = error;
        console.warn(`Gemini model ${model} failed: ${error.message}`);
      }
    }
    if (!response) throw lastError || new Error("Gemini analysis failed.");

    const analysis = response.text;

    if (!analysis) {
      throw new Error("Gemini returned an empty response.");
    }

    res.json({
      analysis,
      model: usedModel,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Gemini error:", error);

    res.status(502).json({
      error: error.message || "Gemini analysis failed.",
    });
  }
});

const OVERPASS_SERVERS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

app.get("/api/infrastructure", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    return res.status(400).json({
      error: "Valid latitude and longitude are required.",
    });
  }

  const query = `
[out:json][timeout:20];
(
  way["power"="line"](around:750,${lat},${lon});
  way["power"="minor_line"](around:750,${lat},${lon});
  way["power"="cable"](around:750,${lat},${lon});
);
out geom;
`;

  let lastError = "All Overpass servers failed.";

  for (const endpoint of OVERPASS_SERVERS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(25000),
      });

      if (!response.ok) {
        throw new Error(`Overpass HTTP ${response.status}`);
      }

      const data = await response.json();

      return res.json({
        elements: data.elements || [],
        source: "OpenStreetMap / Overpass",
        endpoint,
      });
    } catch (error) {
      lastError = error.message;
      console.warn(`Overpass failed: ${endpoint}`, lastError);
    }
  }

  res.status(503).json({
    error: `Infrastructure unavailable: ${lastError}`,
  });
});

// Only reachable on the server itself; Caddy forwards /api/* to it.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`KnowFlyZone simulator backend running at http://127.0.0.1:${PORT}`);
  console.log(
    `Gemini configured: ${Boolean(process.env.GEMINI_API_KEY)}`
  );
});
