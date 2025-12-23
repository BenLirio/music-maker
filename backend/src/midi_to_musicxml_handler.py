import base64
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional


def _maybe_add_local_serverless_requirements_to_syspath() -> None:
  """Make serverless-offline behave closer to deployed Lambda.

  In AWS, packaged dependencies live in /var/task and are importable by default.
  In serverless-offline, the Python function often runs from source without
  automatically adding the packaged requirements directory to sys.path.
  """

  # backend/src/midi_to_musicxml_handler.py -> backend/
  backend_root = Path(__file__).resolve().parents[1]
  req_dir = backend_root / ".serverless" / "requirements"
  if req_dir.is_dir():
    p = str(req_dir)
    if p not in sys.path:
      sys.path.insert(0, p)


def _get_allowed_origins() -> list[str]:
  raw = os.environ.get("ALLOWED_ORIGINS", "")
  return [o.strip() for o in raw.split(",") if o.strip()]


def _get_request_origin(event: Dict[str, Any]) -> Optional[str]:
  headers = event.get("headers") or {}
  if not isinstance(headers, dict):
    return None
  origin = headers.get("origin") or headers.get("Origin")
  return origin if isinstance(origin, str) else None


def _cors_headers(event: Dict[str, Any], allow_methods: str) -> Dict[str, str]:
  allowed = _get_allowed_origins()
  request_origin = _get_request_origin(event)
  if request_origin and request_origin in allowed:
    allow_origin = request_origin
  elif allowed:
    allow_origin = allowed[0]
  else:
    allow_origin = "*"

  return {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": allow_origin,
      "access-control-allow-headers": "content-type,accept,authorization",
      "access-control-allow-methods": allow_methods,
      "vary": "Origin",
  }


def _json_response(
    event: Dict[str, Any],
    status_code: int,
    body: Any,
    allow_methods: str,
) -> Dict[str, Any]:
  return {
      "statusCode": status_code,
      "headers": _cors_headers(event, allow_methods),
      "body": json.dumps(body),
  }


def _read_json_body(event: Dict[str, Any]) -> Dict[str, Any]:
  raw = event.get("body") or ""
  if not isinstance(raw, str):
    raise ValueError("Request body must be a string")

  is_b64 = bool(event.get("isBase64Encoded"))
  if is_b64:
    try:
      raw = base64.b64decode(raw).decode("utf-8")
    except Exception as e:
      raise ValueError(f"Invalid base64 request body: {e!r}") from e

  try:
    data = json.loads(raw)
  except Exception as e:
    raise ValueError(f"Invalid JSON body: {e!r}") from e

  if not isinstance(data, dict):
    raise ValueError("JSON body must be an object")
  return data


def _midi_bytes_to_musicxml(midi_bytes: bytes) -> str:
  _maybe_add_local_serverless_requirements_to_syspath()
  # Import inside the function so import errors become request errors.
  from music21 import converter  # type: ignore

  with tempfile.TemporaryDirectory(prefix="music21_") as tmpdir:
    tmp = Path(tmpdir)
    midi_path = tmp / "input.mid"
    out_path = tmp / "output.musicxml"

    midi_path.write_bytes(midi_bytes)

    score = converter.parse(str(midi_path))
    score.write("musicxml", fp=str(out_path))

    return out_path.read_text(encoding="utf-8")


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
  try:
    method = (event.get("httpMethod") or "").upper()
    if method == "OPTIONS":
      return _json_response(event, 200, {"ok": True}, "POST,OPTIONS")
    if method != "POST":
      return _json_response(
          event,
          405,
          {"ok": False, "error": "Method Not Allowed"},
          "POST,OPTIONS",
      )

    body = _read_json_body(event)
    midi_b64 = body.get("midiBase64")
    if not isinstance(midi_b64, str) or not midi_b64.strip():
      return _json_response(
          event,
          400,
          {"ok": False, "error": "Missing 'midiBase64'"},
          "POST,OPTIONS",
      )

    try:
      midi_bytes = base64.b64decode(midi_b64)
    except Exception:
      return _json_response(
          event,
          400,
          {"ok": False, "error": "Invalid base64 in 'midiBase64'"},
          "POST,OPTIONS",
      )

    if len(midi_bytes) == 0 or len(midi_bytes) > 2_000_000:
      return _json_response(
          event,
          400,
          {"ok": False, "error": "MIDI payload too large or empty."},
          "POST,OPTIONS",
      )

    musicxml = _midi_bytes_to_musicxml(midi_bytes)
    return _json_response(
        event,
        200,
        {"ok": True, "musicxml": musicxml},
        "POST,OPTIONS",
    )

  except Exception as e:
    return _json_response(
        event,
        500,
        {"ok": False, "error": "MIDI to MusicXML failed", "details": str(e)},
        "POST,OPTIONS",
    )
