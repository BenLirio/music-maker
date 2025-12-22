import { parseMidiCsv, type MidiCsvEvent } from "./midiCsv";

function u16be(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function ascii(s: string): number[] {
  return Array.from(s).map((c) => c.charCodeAt(0) & 0xff);
}

function encodeVlq(value: number): number[] {
  // Standard MIDI variable-length quantity.
  let v = Math.max(0, Math.floor(value));
  let buffer = v & 0x7f;
  const out: number[] = [];

  while ((v >>= 7)) {
    buffer <<= 8;
    buffer |= 0x80 | (v & 0x7f);
  }

  // Unpack buffer bytes.
  while (true) {
    out.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }

  return out;
}

function makeChunk(type: string, data: number[]): number[] {
  return [...ascii(type), ...u32be(data.length), ...data];
}

type TimedBytes = { tick: number; order: number; bytes: number[] };

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.floor(n)));
}

function clamp7bit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(127, Math.floor(n)));
}

function isTempoEvent(
  e: MidiCsvEvent
): e is Extract<MidiCsvEvent, { type: "Tempo" }> {
  return e.type === "Tempo";
}

function isProgramEvent(
  e: MidiCsvEvent
): e is Extract<MidiCsvEvent, { type: "Program_c" }> {
  return e.type === "Program_c";
}

function isNoteEvent(
  e: MidiCsvEvent
): e is Extract<MidiCsvEvent, { type: "Note_on_c" | "Note_off_c" }> {
  return e.type === "Note_on_c" || e.type === "Note_off_c";
}

export function midiBytesToBase64(bytes: Uint8Array): string {
  // btoa expects "binary string"; chunk to avoid call stack / arg limits.
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function midiCsvToMidiFileBytes(csvText: string): Uint8Array {
  const { ppq, events } = parseMidiCsv(csvText);

  // Track 0: tempo map (meta events)
  const tempoEvents = events
    .filter(isTempoEvent)
    .map((e) => ({ tick: e.tick, mpqn: e.mpqn }))
    .sort((a, b) => a.tick - b.tick);

  if (tempoEvents.length === 0) {
    tempoEvents.push({ tick: 0, mpqn: 500_000 });
  }

  const tempoTrackTimed: TimedBytes[] = tempoEvents.map((t, idx) => {
    const mpqn = Math.max(1, Math.floor(t.mpqn));
    const b1 = (mpqn >>> 16) & 0xff;
    const b2 = (mpqn >>> 8) & 0xff;
    const b3 = mpqn & 0xff;
    return {
      tick: Math.max(0, Math.floor(t.tick)),
      order: idx,
      bytes: [0xff, 0x51, 0x03, b1, b2, b3],
    };
  });

  // Track 1: channel events (program + notes)
  const channelTimed: TimedBytes[] = [];

  for (const e of events) {
    if (isProgramEvent(e)) {
      const ch = clamp7bit(e.channel);
      channelTimed.push({
        tick: Math.max(0, Math.floor(e.tick)),
        order: 0,
        bytes: [0xc0 | ch, clamp7bit(e.program)],
      });
      continue;
    }

    if (isNoteEvent(e)) {
      const ch = clamp7bit(e.channel);
      const note = clamp7bit(e.note);
      const vel = clamp7bit(e.velocity);

      const isNoteOff =
        e.type === "Note_off_c" || (e.type === "Note_on_c" && vel === 0);
      if (isNoteOff) {
        channelTimed.push({
          tick: Math.max(0, Math.floor(e.tick)),
          order: 1,
          bytes: [0x80 | ch, note, 0x00],
        });
      } else {
        channelTimed.push({
          tick: Math.max(0, Math.floor(e.tick)),
          order: 2,
          bytes: [0x90 | ch, note, vel],
        });
      }
    }
  }

  channelTimed.sort((a, b) => a.tick - b.tick || a.order - b.order);
  tempoTrackTimed.sort((a, b) => a.tick - b.tick || a.order - b.order);

  function buildTrack(eventsTimed: TimedBytes[]): number[] {
    const out: number[] = [];
    let lastTick = 0;

    for (const ev of eventsTimed) {
      const tick = Math.max(0, Math.floor(ev.tick));
      const delta = tick - lastTick;
      out.push(...encodeVlq(delta));
      out.push(...ev.bytes.map(clampByte));
      lastTick = tick;
    }

    // End of track
    out.push(0x00, 0xff, 0x2f, 0x00);
    return out;
  }

  const tempoTrack = makeChunk("MTrk", buildTrack(tempoTrackTimed));
  const channelTrack = makeChunk("MTrk", buildTrack(channelTimed));

  const format = 1;
  const ntrks = 2;
  const division = Math.max(1, Math.min(0x7fff, Math.floor(ppq)));

  const headerData = [...u16be(format), ...u16be(ntrks), ...u16be(division)];
  const header = makeChunk("MThd", headerData);

  return new Uint8Array([...header, ...tempoTrack, ...channelTrack]);
}
