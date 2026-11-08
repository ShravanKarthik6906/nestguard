
export async function getAIAnalysis(payload, signal) {
  let response;

  try {
    response = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    throw new Error(
      `Cannot reach SkyGuard backend: ${error.message}`
    );
  }

  const raw = await response.text();

  let data;

  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(
      "Backend returned invalid JSON. Verify that the Express server is running on port 3001."
    );
  }

  if (!response.ok) {
    throw new Error(
      data.error || `AI request failed (HTTP ${response.status}).`
    );
  }

  if (!data.analysis) {
    throw new Error("Gemini returned no analysis.");
  }

  return {
    analysis: data.analysis,
    model: data.model || "Gemini",
    generatedAt: data.generatedAt || new Date().toISOString(),
  };
}
