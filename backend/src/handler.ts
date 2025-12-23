import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { json, readJsonBody } from "./http";

export { generatePython } from "./generatePython";

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

export async function ping(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  return json(event, 200, { ok: true, message: "pong" }, "GET,OPTIONS");
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
