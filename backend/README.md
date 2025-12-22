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
