import { useEffect, useMemo, useRef, useState } from "react";
import * as Tone from "tone";
import "./App.css";

import {
  ensurePyodideReady,
  getPyodideDebugInfo,
  runPythonAndCaptureStdout,
} from "./pyodideRunner";

import {
  buildTempoMap,
  notesToSchedule,
  pairNotes,
  parseMidiCsv,
  type ScheduledNote,
} from "./midiCsv";

type PlaybackValue = ScheduledNote;

const DEFAULT_CSV = `# Paste your MIDI CSV here (midicsv output style)
0, 0, Header, 1, 2, 480
1, 0, Start_track
1, 0, Tempo, 500000
1, 0, End_track
2, 0, Start_track
2, 0, Program_c, 0, 81
2, 0, Note_on_c, 0, 52, 90
2, 240, Note_off_c, 0, 52, 0
2, 240, Note_on_c, 0, 59, 90
2, 480, Note_off_c, 0, 59, 0
2, 480, End_track
0, 0, End_of_file
`;

const DEFAULT_PYTHON = `# Python runs in-browser via Pyodide.
# Whatever you print to stdout is treated as MIDI CSV.

csv = """0, 0, Header, 1, 2, 480
1, 0, Start_track
1, 0, Tempo, 500000
1, 0, End_track
2, 0, Start_track
2, 0, Program_c, 0, 81
2, 0, Note_on_c, 0, 60, 100
2, 240, Note_off_c, 0, 60, 0
2, 240, Note_on_c, 0, 64, 100
2, 480, Note_off_c, 0, 64, 0
2, 480, End_track
0, 0, End_of_file
"""

print(csv)
`;

function App() {
  const [csvText, setCsvText] = useState(DEFAULT_CSV);
  const [inputMode, setInputMode] = useState<"csv" | "py">("csv");
  const [pythonCode, setPythonCode] = useState(DEFAULT_PYTHON);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [backendTestStatus, setBackendTestStatus] = useState<
    "Idle" | "Testing…" | "OK" | "Error"
  >("Idle");
  const [backendTestMessage, setBackendTestMessage] = useState<string>("");
  const [status, setStatus] = useState<
    | "Idle"
    | "Parsing…"
    | "Loading Pyodide…"
    | "Running Python…"
    | "Playing…"
    | "Stopped"
    | "Done"
    | "Error"
    | "No notes found."
  >("Idle");

  const partRef = useRef<Tone.Part<PlaybackValue> | null>(null);
  const synthMainRef = useRef<Tone.PolySynth<Tone.Synth> | null>(null);
  const synthBassRef = useRef<Tone.MonoSynth | null>(null);
  const stopEventIdRef = useRef<number | null>(null);

  const canPlayLabel = useMemo(() => {
    if (inputMode === "csv") return csvText.trim().length > 0;
    return pythonCode.trim().length > 0;
  }, [csvText, inputMode, pythonCode]);

  useEffect(() => {
    return () => {
      // Ensure we don't leave the transport running if user navigates away.
      Tone.Transport.stop();
      Tone.Transport.cancel(0);
      if (partRef.current) {
        partRef.current.dispose();
        partRef.current = null;
      }
      synthMainRef.current?.dispose();
      synthMainRef.current = null;
      synthBassRef.current?.dispose();
      synthBassRef.current = null;
    };
  }, []);

  function stopPlayback(nextStatus: typeof status) {
    Tone.Transport.stop();
    Tone.Transport.cancel(0);

    if (stopEventIdRef.current != null) {
      // cancel uses time; scheduleOnce returns an id for clear, but Tone.Transport.clear exists.
      Tone.Transport.clear(stopEventIdRef.current);
      stopEventIdRef.current = null;
    }

    if (partRef.current) {
      partRef.current.dispose();
      partRef.current = null;
    }

    setStatus(nextStatus);
  }

  function formatUnknownError(err: unknown): string {
    if (err instanceof Error) {
      const stack = err.stack ? `\n\n${err.stack}` : "";
      return `${err.name}: ${err.message}${stack}`;
    }
    try {
      return JSON.stringify(err, null, 2);
    } catch {
      return String(err);
    }
  }

  async function testBackendConnection() {
    setBackendTestStatus("Testing…");
    setBackendTestMessage("");

    const baseUrl =
      (import.meta.env.VITE_BACKEND_URL as string | undefined) ??
      "http://localhost:3000/dev";

    try {
      const res = await fetch(`${baseUrl}/ping`, {
        method: "GET",
        headers: { accept: "application/json" },
      });

      const text = await res.text();
      if (!res.ok) {
        setBackendTestStatus("Error");
        setBackendTestMessage(`HTTP ${res.status}: ${text}`);
        return;
      }

      setBackendTestStatus("OK");
      setBackendTestMessage(text);
    } catch (err) {
      setBackendTestStatus("Error");
      setBackendTestMessage(formatUnknownError(err));
    }
  }

  async function playFromCsv(text: string) {
    setErrorDetails(null);
    setStatus("Parsing…");

    // Reset any prior playback.
    stopPlayback("Stopped");

    if (!synthMainRef.current)
      synthMainRef.current = new Tone.PolySynth(Tone.Synth).toDestination();
    if (!synthBassRef.current)
      synthBassRef.current = new Tone.MonoSynth().toDestination();

    const { ppq, events } = parseMidiCsv(text);
    const tempoMap = buildTempoMap(events, ppq);
    const notes = pairNotes(events);

    if (notes.length === 0) {
      setStatus("No notes found.");
      return;
    }

    const scheduled = notesToSchedule(notes, tempoMap.ticksToSeconds);

    const main = synthMainRef.current;
    const bass = synthBassRef.current;

    if (!main || !bass) {
      setStatus("Error");
      return;
    }

    const part = new Tone.Part<PlaybackValue>((time, value) => {
      const target = value.channel === 1 ? bass : main;
      target.triggerAttackRelease(
        value.name,
        value.duration,
        time,
        value.velocity
      );
    }, scheduled);

    part.start(0);
    partRef.current = part;

    const last = scheduled[scheduled.length - 1];
    const totalSeconds = last.time + last.duration + 0.25;

    setStatus("Playing…");
    Tone.Transport.start("+0.05");

    stopEventIdRef.current = Tone.Transport.scheduleOnce(() => {
      stopPlayback("Done");
    }, totalSeconds);
  }

  return (
    <>
      <h2>MIDI CSV → Play (Tone.js)</h2>

      <div className="row">
        <button type="button" onClick={testBackendConnection}>
          Test backend connection
        </button>
        <span>
          Backend: {backendTestStatus}
          {backendTestMessage ? ` — ${backendTestMessage}` : ""}
        </span>
      </div>

      <div className="row">
        <label>
          <input
            type="radio"
            name="inputMode"
            value="csv"
            checked={inputMode === "csv"}
            onChange={() => setInputMode("csv")}
          />{" "}
          MIDI CSV
        </label>
        <label>
          <input
            type="radio"
            name="inputMode"
            value="py"
            checked={inputMode === "py"}
            onChange={() => setInputMode("py")}
          />{" "}
          Python (Pyodide stdout)
        </label>
      </div>

      {inputMode === "csv" ? (
        <textarea
          className="csvInput"
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          spellCheck={false}
        />
      ) : (
        <textarea
          className="csvInput"
          value={pythonCode}
          onChange={(e) => setPythonCode(e.target.value)}
          spellCheck={false}
        />
      )}

      <div className="row">
        <button
          onClick={() => {
            void (async () => {
              try {
                setErrorDetails(null);
                // Required by browsers: must be called from a user gesture.
                await Tone.start();

                if (inputMode === "csv") {
                  await playFromCsv(csvText);
                  return;
                }

                setStatus("Loading Pyodide…");
                await ensurePyodideReady();

                setStatus("Running Python…");
                const { stdout, stderr } = await runPythonAndCaptureStdout(
                  pythonCode
                );

                // Debugging: show program output in the browser console.
                console.log("[pyodide] stdout:\n" + stdout);
                if (stderr.trim().length > 0)
                  console.warn("[pyodide] stderr:\n" + stderr);

                if (stderr.trim().length > 0) console.error(stderr);

                const generatedCsv = stdout;
                if (generatedCsv.trim().length === 0) {
                  const dbg = await getPyodideDebugInfo().catch(() => null);
                  const parts: string[] = [
                    "Python did not print any MIDI CSV to stdout.",
                  ];
                  if (dbg)
                    parts.push(
                      `Pyodide indexURL: ${dbg.indexURL}`,
                      `Pyodide version: ${dbg.version ?? "(unknown)"}`
                    );
                  if (stderr.trim().length > 0)
                    parts.push("\nPython stderr:\n" + stderr.trim());
                  setErrorDetails(parts.join("\n"));
                  setStatus("Error");
                  return;
                }

                if (stderr.trim().length > 0) {
                  const dbg = await getPyodideDebugInfo().catch(() => null);
                  const parts: string[] = [
                    "Python wrote to stderr (continuing anyway):",
                    stderr.trim(),
                  ];
                  if (dbg)
                    parts.push(
                      "\nPyodide debug:",
                      `indexURL: ${dbg.indexURL}`,
                      `version: ${dbg.version ?? "(unknown)"}`
                    );
                  setErrorDetails(parts.join("\n"));
                }

                await playFromCsv(generatedCsv);
              } catch (err) {
                console.error(err);
                const dbg = await getPyodideDebugInfo().catch(() => null);
                const parts: string[] = [formatUnknownError(err)];
                if (dbg)
                  parts.push(
                    "\nPyodide debug:",
                    `indexURL: ${dbg.indexURL}`,
                    `version: ${dbg.version ?? "(unknown)"}`
                  );
                setErrorDetails(parts.join("\n"));
                setStatus("Error");
              }
            })();
          }}
          disabled={!canPlayLabel}
        >
          Play
        </button>
        <button onClick={() => stopPlayback("Stopped")}>Stop</button>
        <span className="status">{status}</span>
      </div>

      {status === "Error" && errorDetails ? (
        <pre className="errorDetails">{errorDetails}</pre>
      ) : null}
    </>
  );
}

export default App;
