# music-maker

React + TypeScript app built with Vite.

## Local development

- Install: `npm install`
- Dev server: `npm run dev`
- Production build: `npm run build`
- Preview build: `npm run preview`

## Backend (Serverless Framework v4)

This repo includes a small Serverless backend under `backend/` with a `GET /ping` endpoint.

### Run locally

In one terminal:

- `npm run backend:install`
- `npm run backend:dev`

This starts `serverless-offline`.

- Ping endpoint: `GET http://localhost:3000/dev/ping`

In another terminal:

- `npm run dev`

### Frontend configuration

Set `VITE_BACKEND_URL` (see `.env.example`). For local dev it should be:

- `VITE_BACKEND_URL=http://localhost:3000/dev`

For production it should be your API Gateway base URL including the stage, for example:

- `VITE_BACKEND_URL=https://<api-id>.execute-api.us-east-1.amazonaws.com/prod`

Current deployed backend (stage `prod`):

- `VITE_BACKEND_URL=https://7wls5saeq6.execute-api.us-east-1.amazonaws.com/prod`

For GitHub Pages builds, set a repo variable:

- **Settings → Secrets and variables → Actions → Variables**
- Name: `VITE_BACKEND_URL`
- Value: your deployed API base URL (including `/prod`)

### CORS note

Your site URL is `https://benlirio.com/music-maker/`, but the CORS **origin** is `https://benlirio.com` (origins do not include paths). The backend is configured to allow `https://benlirio.com`.

## GitHub Pages (via Actions)

This repo is configured to deploy `dist/` to GitHub Pages using GitHub Actions.

- Workflow: `.github/workflows/deploy.yml`
- Vite base path: `vite.config.ts` is set to `base: '/music-maker/'`

### One-time repo setup in GitHub

1. Go to **Settings → Pages**
2. Set **Source** to **GitHub Actions**

After that, every push to `main` or `master` will publish the site.

### If you rename the repository

If the repo name changes, update the `base` in `vite.config.ts` to match:

`base: '/<repo-name>/'`
