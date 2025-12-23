# music-maker backend (Serverless Framework v4)

## Local dev

```bash
npm install
npm run dev
```

This starts `serverless-offline`.

- Endpoint: `GET http://localhost:3000/dev/ping`
- Response: `{ "ok": true, "message": "pong" }`

## Prompt → Python (OpenAI)

This backend also exposes a prompt-to-Python endpoint used by the frontend to generate Pyodide-safe Python that prints MIDI CSV.

### Configure your OpenAI key (do not commit)

Set these environment variables in your shell before starting `serverless-offline`:

- `OPENAI_API_KEY` (required)
- `OPENAI_MODEL` (optional, default `gpt-5.2`)
- `OPENAI_MAX_OUTPUT_TOKENS` (optional, default `100000`)
- `OPENAI_TIMEOUT_MS` (optional, default `25000`; increase if you request long programs)

One convenient approach is to create a local file `backend/.env` (this repo ignores `.env` files), then load it in your shell:

```bash
set -a
source backend/.env
set +a

npm run dev
```

Example `backend/.env`:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.2
OPENAI_MAX_OUTPUT_TOKENS=100000
OPENAI_TIMEOUT_MS=60000
```

### Test the endpoint

With the backend running:

```bash
curl -sS \
	-X POST http://localhost:3000/dev/generate-python \
	-H 'content-type: application/json' \
	-d '{"prompt":"Make an 8-bar C major melody at 120bpm. Use a piano Program_c and print only MIDI CSV."}' \
	| cat
```

## Deploy

You need AWS credentials configured (e.g. `AWS_PROFILE`) and (depending on your Serverless Framework v4 setup) a `SERVERLESS_ACCESS_KEY`.

```bash
npm run deploy
```

## MIDI → MusicXML (music21)

This backend also exposes a MIDI-to-MusicXML endpoint used by the frontend "To Sheet Music" button.

- Endpoint: `POST http://localhost:3000/dev/midi-to-musicxml`
- Body: `{ "midiBase64": "..." }`
- Response: `{ "ok": true, "musicxml": "..." }`

### Local prerequisite

This endpoint shells out to `python3` and uses the Python package `music21`.

Install it locally (system Python):

```bash
python3 -m pip install music21
```

If you prefer a virtualenv (recommended to avoid system Python conflicts):

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install music21
```

Then point the backend at that interpreter (so `serverless-offline` uses the venv):

```bash
export MUSIC21_PYTHON="$PWD/.venv/bin/python"
```

Note: Deploying this to AWS Lambda typically requires a container image or a Python runtime + layer that includes `music21`.
