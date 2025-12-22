import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function getAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS ?? "";
  return raw
    .split(",")
    .map((o: string) => o.trim())
    .filter(Boolean);
}

function getCorsHeaders(
  event: APIGatewayProxyEvent,
  allowMethods: string
): Record<string, string> {
  const allowedOrigins = getAllowedOrigins();
  const requestOrigin = event.headers?.origin ?? event.headers?.Origin;
  const allowOrigin =
    requestOrigin && allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : allowedOrigins.length > 0
      ? allowedOrigins[0]
      : "*";

  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": allowMethods,
    vary: "Origin",
  };
}

function json(
  event: APIGatewayProxyEvent,
  statusCode: number,
  body: unknown,
  allowMethods: string
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: getCorsHeaders(event, allowMethods),
    body: JSON.stringify(body),
  };
}

function readJsonBody<T>(event: APIGatewayProxyEvent): T {
  const raw = event.body ?? "";
  const decoded = event.isBase64Encoded
    ? Buffer.from(raw, "base64").toString("utf-8")
    : raw;
  return JSON.parse(decoded) as T;
}

async function runPythonMusic21MidiToMusicXml(
  midiBytes: Buffer
): Promise<{ musicxml: string; stderr: string }> {
  // NOTE: This backend uses a Python subprocess for music21.
  // For local dev you must have `python3` and `music21` installed.
  // For AWS Lambda deployment, you would typically use a container image or
  // a Python runtime + layer; the Node.js runtime does not include music21.

  const scriptPath = path.join(
    process.cwd(),
    "src",
    "music21_midi_to_musicxml.py"
  );

  const venvPython = path.join(process.cwd(), ".venv", "bin", "python");
  const pythonBin = (
    process.env.MUSIC21_PYTHON?.trim() ||
    (existsSync(venvPython) ? venvPython : "") ||
    "python3"
  ).trim();

  return await new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (code !== 0) {
        reject(
          new Error(
            `music21 converter failed (exit ${code}, python ${pythonBin}). ${
              stderr.trim() || stdout.trim()
            }`
          )
        );
        return;
      }

      resolve({ musicxml: stdout, stderr });
    });

    child.stdin.write(midiBytes);
    child.stdin.end();
  });
}

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
    "- Do NOT wrap the code in markdown fences.",
    "Output: raw Python source code only.",
  ].join("\n");

  const controller = new AbortController();
  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS ?? "25000");
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: instruction },
        { role: "user", content: userPrompt },
      ],
      // Keep the output focused. (OpenAI may ignore depending on model.)
      max_output_tokens: 1200,
    }),
  }).finally(() => {
    clearTimeout(timeoutId);
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI HTTP ${res.status}: ${text}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`OpenAI returned non-JSON: ${text.slice(0, 500)}`);
  }

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

  let out = extractText(data);

  out = stripCodeFences(out);
  if (!out) throw new Error("OpenAI returned empty output.");

  return { python: out, model };
}

export async function ping(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  return json(event, 200, { ok: true, message: "pong" }, "GET,OPTIONS");
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

export async function midiToMusicXml(
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

    const body = readJsonBody<{ midiBase64?: unknown }>(event);
    const midiBase64 =
      typeof body.midiBase64 === "string" ? body.midiBase64.trim() : "";
    if (!midiBase64) {
      return json(
        event,
        400,
        { ok: false, error: "Missing 'midiBase64'" },
        "POST,OPTIONS"
      );
    }

    let midiBytes: Buffer;
    try {
      midiBytes = Buffer.from(midiBase64, "base64");
    } catch {
      return json(
        event,
        400,
        { ok: false, error: "Invalid base64 in 'midiBase64'" },
        "POST,OPTIONS"
      );
    }

    // Lightweight guardrail (API Gateway payloads are limited anyway).
    if (midiBytes.length === 0 || midiBytes.length > 2_000_000) {
      return json(
        event,
        400,
        { ok: false, error: "MIDI payload too large or empty." },
        "POST,OPTIONS"
      );
    }

    const { musicxml, stderr } = await runPythonMusic21MidiToMusicXml(
      midiBytes
    );

    // MusicXML can be sizable; we return it as a string.
    return json(
      event,
      200,
      {
        ok: true,
        musicxml,
        warnings: stderr.trim().length > 0 ? stderr.trim() : undefined,
      },
      "POST,OPTIONS"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(
      event,
      500,
      { ok: false, error: "MIDI to MusicXML failed", details: message },
      "POST,OPTIONS"
    );
  }
}
