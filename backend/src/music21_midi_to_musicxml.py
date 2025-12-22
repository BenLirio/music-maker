import sys
import tempfile
from pathlib import Path


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
      sys.stdout.write(xml_text)

    return 0
  except Exception as e:
    sys.stderr.write(f"music21 conversion failed: {e!r}\n")
    return 4


if __name__ == "__main__":
  raise SystemExit(main())
