# music-maker

React + TypeScript app built with Vite.

## Local development

- Install: `npm install`
- Dev server: `npm run dev`
- Production build: `npm run build`
- Preview build: `npm run preview`

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
