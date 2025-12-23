import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { json, readJsonBody } from "./http";

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  // Remove leading ```lang and trailing ``` if present.
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\n/, "")
    .replace(/\n```\s*$/, "")
    .trim();
}

async function openAiGeneratePyodideMidiPython(userPrompt: string): Promise<{
  python: string;
  model: string;
}> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing OPENAI_API_KEY. Set it in your environment before running the backend."
    );
  }

  const model = process.env.OPENAI_MODEL?.trim() || "gpt-5.2";
  const endpoint =
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://api.openai.com/v1/responses";

  // Default to a large cap; the API/model still enforces a hard maximum.
  const maxOutputTokensRaw = Number(
    process.env.OPENAI_MAX_OUTPUT_TOKENS ?? "100000"
  );
  const maxOutputTokens =
    Number.isFinite(maxOutputTokensRaw) && maxOutputTokensRaw >= 256
      ? Math.floor(maxOutputTokensRaw)
      : 100000;

  const PY_BEGIN = "# MUSIC_MAKER_PY_BEGIN";
  const PY_END = "# MUSIC_MAKER_PY_END";

  // System-style prefix tuned for this app:
  // - Python must run in Pyodide (no file I/O, no external deps)
  // - Must print MIDI CSV (midicsv style) to stdout
  // - Avoid markdown, return raw python only
  const instruction = [
    "Create a Python program that outputs a MIDI CSV (midicsv output style) to stdout for a General MIDI (GM) player.",
    "Constraints:",
    "- Must be runnable in Pyodide (pure Python, no external packages, no file I/O).",
    "- Print ONLY the CSV text to stdout (no extra commentary).",
    "- Include a valid CSV header and end-of-file marker.",
    "- Use tempo and note events; optionally include Program_c changes.",
    "- Prefer compact, loop-based generation. Avoid enumerating thousands of events line-by-line.",
    "- Do NOT output markdown. Do NOT include backticks anywhere in the output.",
    "Output format (MANDATORY):",
    `- The first non-empty line MUST be exactly: ${PY_BEGIN}`,
    `- The last non-empty line MUST be exactly: ${PY_END}`,
    "- Between those markers, output only Python source code.",
  ].join("\n");

  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? "55000");

  async function callOpenAi(
    input: Array<{ role: string; content: string }>
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const body: Record<string, unknown> = {
      model,
      input,
      max_output_tokens: maxOutputTokens,
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    try {
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`OpenAI HTTP ${res.status}: ${text}`);
      }

      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`OpenAI returned non-JSON: ${text.slice(0, 500)}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const data: unknown = await callOpenAi([
    { role: "system", content: instruction },
    { role: "user", content: userPrompt },
  ]);

  function extractText(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const p = payload as Record<string, unknown>;

    // Responses API: output[].content[] items with {type:'output_text', text:string}
    const output = p.output;
    if (Array.isArray(output)) {
      let out = "";
      for (const item of output) {
        if (!item || typeof item !== "object") continue;
        const content = (item as Record<string, unknown>).content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
          if (!c || typeof c !== "object") continue;
          const cr = c as Record<string, unknown>;
          if (cr.type === "output_text" && typeof cr.text === "string") {
            out += cr.text;
          }
        }
      }
      if (out) return out;
    }

    // Fallback: Chat Completions-like {choices:[{message:{content:string}}]}
    const choices = p.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0];
      if (first && typeof first === "object") {
        const msg = (first as Record<string, unknown>).message;
        if (msg && typeof msg === "object") {
          const content = (msg as Record<string, unknown>).content;
          if (typeof content === "string") return content;
        }
      }
    }

    return "";
  }

  function extractMarkedPython(text: string): {
    python: string;
    hasMarkers: boolean;
  } {
    const raw = text.trim();
    const beginIdx = raw.indexOf(PY_BEGIN);
    const endIdx = raw.indexOf(PY_END);
    if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
      return { python: raw, hasMarkers: false };
    }
    const slice = raw.slice(beginIdx, endIdx + PY_END.length).trim();
    return { python: slice, hasMarkers: true };
  }

  function hasEndMarker(text: string): boolean {
    return text.trimEnd().endsWith(PY_END);
  }

  const out = stripCodeFences(extractText(data));
  if (!out) throw new Error("OpenAI returned empty output.");

  // Single-attempt behavior:
  // - If the model followed the required markers, return them.
  // - Otherwise, wrap the output with markers (no additional OpenAI calls).
  const { python: marked, hasMarkers } = extractMarkedPython(out);
  if (hasMarkers && hasEndMarker(marked) && !out.includes("```")) {
    return { python: marked, model };
  }

  return { python: `${PY_BEGIN}\n${out.trim()}\n${PY_END}`, model };
}

export async function generatePython(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    if (event.httpMethod?.toUpperCase() === "OPTIONS") {
      return json(event, 200, { ok: true }, "POST,OPTIONS");
    }

    if (event.httpMethod?.toUpperCase() !== "POST") {
      return json(
        event,
        405,
        { ok: false, error: "Method Not Allowed" },
        "POST,OPTIONS"
      );
    }

    const body = readJsonBody<{ prompt?: unknown }>(event);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) {
      return json(
        event,
        400,
        { ok: false, error: "Missing 'prompt'" },
        "POST,OPTIONS"
      );
    }
    if (prompt.length > 4000) {
      return json(
        event,
        400,
        { ok: false, error: "Prompt too long (max 4000 chars)." },
        "POST,OPTIONS"
      );
    }

    const { python, model } = await openAiGeneratePyodideMidiPython(prompt);
    return json(event, 200, { ok: true, python, model }, "POST,OPTIONS");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(
      event,
      500,
      { ok: false, error: "Generate failed", details: message },
      "POST,OPTIONS"
    );
  }
}
