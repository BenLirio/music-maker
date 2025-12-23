import sys
import tempfile
import re
import xml.etree.ElementTree as ET
from pathlib import Path


def sanitize_musicxml_for_osmd(xml_text: str) -> str:
  # Best-effort normalization for OpenSheetMusicDisplay.
  cleaned = re.sub(r"<!DOCTYPE[\s\S]*?>", "", xml_text).strip()
  try:
    root = ET.fromstring(cleaned)
  except Exception:
    return cleaned

  for score_part in root.findall("./part-list/score-part"):
    score_instruments = score_part.findall("score-instrument")
    for extra in score_instruments[1:]:
      score_part.remove(extra)

    midi_instruments = score_part.findall("midi-instrument")
    for extra in midi_instruments[1:]:
      score_part.remove(extra)

  for note in root.findall(".//note"):
    if "dynamics" in note.attrib:
      del note.attrib["dynamics"]
    for inst in list(note.findall("instrument")):
      note.remove(inst)

  return ET.tostring(root, encoding="utf-8", xml_declaration=True).decode(
      "utf-8"
  )


def main() -> int:
  # Read raw MIDI bytes from stdin.
  midi_bytes = sys.stdin.buffer.read()
  if not midi_bytes:
    sys.stderr.write("No MIDI bytes received on stdin.\n")
    return 2

  try:
    from music21 import converter  # type: ignore
  except Exception as e:
    sys.stderr.write(
        "Failed to import music21. Install it with: python3 -m pip install music21\n"
    )
    sys.stderr.write(f"Import error: {e!r}\n")
    return 3

  try:
    with tempfile.TemporaryDirectory(prefix="music21_") as tmpdir:
      tmp = Path(tmpdir)
      midi_path = tmp / "input.mid"
      out_path = tmp / "output.musicxml"

      midi_path.write_bytes(midi_bytes)

      score = converter.parse(str(midi_path))
      score.write("musicxml", fp=str(out_path))

      xml_text = out_path.read_text(encoding="utf-8")
      xml_text = sanitize_musicxml_for_osmd(xml_text)
      sys.stdout.write(xml_text)

    return 0
  except Exception as e:
    sys.stderr.write(f"music21 conversion failed: {e!r}\n")
    return 4


if __name__ == "__main__":
  raise SystemExit(main())
