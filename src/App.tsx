import { useEffect, useMemo, useRef, useState } from "react";
import * as Tone from "tone";
import "./App.css";

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

function App() {
  const [csvText, setCsvText] = useState(DEFAULT_CSV);
  const [status, setStatus] = useState<
    | "Idle"
    | "Parsing…"
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
    const hasAnyNonWhitespace = csvText.trim().length > 0;
    return hasAnyNonWhitespace;
  }, [csvText]);

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

  async function playFromCsv(text: string) {
    setStatus("Parsing…");

    // Required by browsers: must be called from a user gesture.
    await Tone.start();

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

      <textarea
        className="csvInput"
        value={csvText}
        onChange={(e) => setCsvText(e.target.value)}
        spellCheck={false}
      />

      <div className="row">
        <button
          onClick={() => {
            void (async () => {
              try {
                await playFromCsv(csvText);
              } catch (err) {
                console.error(err);
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
    </>
  );
}

export default App;
