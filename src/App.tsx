import { useEffect, useMemo, useRef, useState } from "react";
import * as Tone from "tone";
import Soundfont from "soundfont-player";
import "./App.css";

import {
  ensurePyodideReady,
  getPyodideDebugInfo,
  runPythonAndCaptureStdout,
} from "./pyodideRunner";

import {
  buildProgramChangeMap,
  buildTempoMap,
  notesToSchedule,
  pairNotes,
  parseMidiCsv,
  type ScheduledNote,
} from "./midiCsv";

import {
  GM_DRUM_CHANNEL,
  gmDrumInstrumentName,
  gmProgramToSoundfontName,
} from "./gm";

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
    | "Loading instruments…"
    | "Loading Pyodide…"
    | "Running Python…"
    | "Playing…"
    | "Stopped"
    | "Done"
    | "Error"
    | "No notes found."
  >("Idle");

  const partRef = useRef<Tone.Part<PlaybackValue> | null>(null);
  const instrumentPromisesRef = useRef<Map<string, Promise<Soundfont.Player>>>(
    new Map()
  );
  const stopEventIdRef = useRef<number | null>(null);

  const SOUNDFONT_NAME = "FluidR3_GM";
  const SOUNDFONT_FORMAT = "mp3" as const;
  const SOUNDFONT_BASE_URL = "https://gleitz.github.io/midi-js-soundfonts/";

  function soundfontNameToUrl(
    name: string,
    soundfont: string,
    format: string
  ): string {
    // midi-js-soundfonts uses files like:
    // https://.../FluidR3_GM/acoustic_grand_piano-mp3.js
    const base = SOUNDFONT_BASE_URL.endsWith("/")
      ? SOUNDFONT_BASE_URL
      : `${SOUNDFONT_BASE_URL}/`;
    return `${base}${soundfont}/${name}-${format}.js`;
  }

  function getOrLoadInstrument(name: string): Promise<Soundfont.Player> {
    const existing = instrumentPromisesRef.current.get(name);
    if (existing) return existing;

    const audioContext = Tone.getContext().rawContext as AudioContext;
    const p = Soundfont.instrument(audioContext, name, {
      soundfont: SOUNDFONT_NAME,
      format: SOUNDFONT_FORMAT,
      nameToUrl: soundfontNameToUrl,
    }).catch(async (err) => {
      // If an instrument is missing (varies by soundfont set), fall back to piano.
      console.warn(`[soundfont] failed to load ${name}, falling back`, err);
      return await Soundfont.instrument(audioContext, "acoustic_grand_piano", {
        soundfont: SOUNDFONT_NAME,
        format: SOUNDFONT_FORMAT,
        nameToUrl: soundfontNameToUrl,
      });
    });

    instrumentPromisesRef.current.set(name, p);
    return p;
  }

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

    const { ppq, events } = parseMidiCsv(text);
    const tempoMap = buildTempoMap(events, ppq);
    const notes = pairNotes(events);

    const programMap = buildProgramChangeMap(events);

    if (notes.length === 0) {
      setStatus("No notes found.");
      return;
    }

    const scheduled = notesToSchedule(
      notes,
      tempoMap.ticksToSeconds,
      programMap
    );

    // Preload only instruments that are actually used.
    setStatus("Loading instruments…");

    const requiredInstrumentNames = new Set<string>();
    for (const n of scheduled) {
      if (n.channel === GM_DRUM_CHANNEL) {
        requiredInstrumentNames.add(gmDrumInstrumentName());
      } else {
        requiredInstrumentNames.add(gmProgramToSoundfontName(n.program));
      }
    }

    const instruments = new Map<string, Soundfont.Player>();
    for (const name of requiredInstrumentNames) {
      instruments.set(name, await getOrLoadInstrument(name));
    }

    const part = new Tone.Part<PlaybackValue>((time, value) => {
      const instrumentName =
        value.channel === GM_DRUM_CHANNEL
          ? gmDrumInstrumentName()
          : gmProgramToSoundfontName(value.program);

      const instrument = instruments.get(instrumentName);
      if (!instrument) return;

      instrument.play(value.name, time, {
        gain: value.velocity,
        duration: value.duration,
      });
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
