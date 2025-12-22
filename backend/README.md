# music-maker backend (Serverless Framework v4)

## Local dev

```bash
npm install
npm run dev
```

This starts `serverless-offline`.

- Endpoint: `GET http://localhost:3000/dev/ping`
- Response: `{ "ok": true, "message": "pong" }`

## Deploy

You need AWS credentials configured (e.g. `AWS_PROFILE`) and (depending on your Serverless Framework v4 setup) a `SERVERLESS_ACCESS_KEY`.

```bash
npm run deploy
```
