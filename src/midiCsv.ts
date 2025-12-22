export type MidiCsvEvent =
  | { track: number; tick: number; type: "Tempo"; mpqn: number }
  | {
      track: number;
      tick: number;
      type: "Program_c";
      channel: number;
      program: number;
    }
  | {
      track: number;
      tick: number;
      type: "Note_on_c" | "Note_off_c";
      channel: number;
      note: number;
      velocity: number;
    };

export type ParsedMidiCsv = {
  ppq: number;
  events: MidiCsvEvent[];
};

export type PairedNote = {
  channel: number;
  note: number;
  startTick: number;
  endTick: number;
  velocity: number;
};

export type ScheduledNote = {
  time: number;
  duration: number;
  name: string;
  velocity: number;
  channel: number;
};

export function parseCsvLines(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split(",").map((x) => x.trim()));
}

export function parseMidiCsv(text: string): ParsedMidiCsv {
  const rows = parseCsvLines(text);

  // Header: track, tick, Header, format, nTracks, division
  let ppq = 480;
  for (const row of rows) {
    if (row[2] === "Header" && row.length >= 6) {
      const division = Number(row[5]);
      if (Number.isFinite(division) && division > 0) ppq = division;
      break;
    }
  }

  const events: MidiCsvEvent[] = [];

  for (const row of rows) {
    if (row.length < 3) continue;

    const track = Number(row[0]);
    const tick = Number(row[1]);
    const type = row[2];

    if (!Number.isFinite(track) || !Number.isFinite(tick)) continue;

    if (type === "Tempo") {
      const mpqn = Number(row[3]);
      if (Number.isFinite(mpqn) && mpqn > 0) {
        events.push({ track, tick, type: "Tempo", mpqn });
      }
    } else if (type === "Program_c") {
      const channel = Number(row[3]);
      const program = Number(row[4]);
      if (Number.isFinite(channel) && Number.isFinite(program)) {
        events.push({ track, tick, type: "Program_c", channel, program });
      }
    } else if (type === "Note_on_c" || type === "Note_off_c") {
      const channel = Number(row[3]);
      const note = Number(row[4]);
      const velocity = Number(row[5]);
      if (
        Number.isFinite(channel) &&
        Number.isFinite(note) &&
        Number.isFinite(velocity)
      ) {
        events.push({ track, tick, type, channel, note, velocity });
      }
    }
  }

  return { ppq, events };
}

export function buildTempoMap(
  events: MidiCsvEvent[],
  ppq: number
): { ticksToSeconds: (tick: number) => number } {
  // Tempo MPQN = microseconds per quarter note.
  const tempoEvents = events
    .filter(
      (e): e is Extract<MidiCsvEvent, { type: "Tempo" }> => e.type === "Tempo"
    )
    .map((e) => ({ tick: e.tick, mpqn: e.mpqn }))
    .sort((a, b) => a.tick - b.tick);

  if (tempoEvents.length === 0) tempoEvents.push({ tick: 0, mpqn: 500_000 }); // 120 BPM default

  type Segment = { tick: number; mpqn: number; accSeconds: number };
  const segments: Segment[] = [];

  let lastTick = tempoEvents[0].tick;
  let lastMpqn = tempoEvents[0].mpqn;
  let accSeconds = 0;

  segments.push({ tick: lastTick, mpqn: lastMpqn, accSeconds });

  for (let i = 1; i < tempoEvents.length; i++) {
    const t = tempoEvents[i];
    const dticks = t.tick - lastTick;
    const secPerTick = lastMpqn / 1_000_000 / ppq;
    accSeconds += dticks * secPerTick;

    lastTick = t.tick;
    lastMpqn = t.mpqn;
    segments.push({ tick: lastTick, mpqn: lastMpqn, accSeconds });
  }

  function ticksToSeconds(tick: number): number {
    let seg = segments[0];
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].tick <= tick) seg = segments[i];
      else break;
    }
    const secPerTick = seg.mpqn / 1_000_000 / ppq;
    return seg.accSeconds + (tick - seg.tick) * secPerTick;
  }

  return { ticksToSeconds };
}

export function pairNotes(events: MidiCsvEvent[]): PairedNote[] {
  // Pair Note_on with Note_off (or Note_on vel=0). Key by channel+note, stack for overlaps.
  const onStacks = new Map<
    string,
    Extract<MidiCsvEvent, { type: "Note_on_c" | "Note_off_c" }>[]
  >();
  const notes: PairedNote[] = [];

  const sorted = events
    .filter(
      (e): e is Extract<MidiCsvEvent, { type: "Note_on_c" | "Note_off_c" }> =>
        e.type === "Note_on_c" || e.type === "Note_off_c"
    )
    .sort((a, b) => a.tick - b.tick);

  const keyFor = (e: { channel: number; note: number }) =>
    `${e.channel}:${e.note}`;

  for (const e of sorted) {
    const key = keyFor(e);

    const isNoteOn = e.type === "Note_on_c" && e.velocity > 0;
    const isNoteOff =
      e.type === "Note_off_c" || (e.type === "Note_on_c" && e.velocity === 0);

    if (isNoteOn) {
      const stack = onStacks.get(key) ?? [];
      stack.push(e);
      onStacks.set(key, stack);
      continue;
    }

    if (isNoteOff) {
      const stack = onStacks.get(key);
      if (!stack || stack.length === 0) continue;

      const on = stack.pop();
      if (!on) continue;

      notes.push({
        channel: e.channel,
        note: e.note,
        startTick: on.tick,
        endTick: e.tick,
        velocity: Math.min(1, Math.max(0, on.velocity / 127)),
      });
    }
  }

  return notes;
}

export function midiNoteNumberToName(n: number): string {
  const names = [
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B",
  ];
  const octave = Math.floor(n / 12) - 1;
  const name = names[((n % 12) + 12) % 12];
  return `${name}${octave}`;
}

export function notesToSchedule(
  notes: PairedNote[],
  ticksToSeconds: (tick: number) => number
): ScheduledNote[] {
  return notes
    .map((n) => {
      const time = ticksToSeconds(n.startTick);
      const endTime = ticksToSeconds(n.endTick);
      const duration = Math.max(0.01, endTime - time);
      return {
        time,
        duration,
        name: midiNoteNumberToName(n.note),
        velocity: n.velocity,
        channel: n.channel,
      };
    })
    .sort((a, b) => a.time - b.time);
}
