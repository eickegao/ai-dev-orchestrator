# AI Dev Orchestrator (MVP)

Local-first desktop app to orchestrate planning + execution for software tasks.

## Dev setup

1. Install dependencies

```bash
npm install
```

2. Start dev environment

```bash
npm run dev
```

This runs:
- TypeScript watcher (compiles Electron main + preload)
- Vite dev server for the renderer
- Electron pointing at the Vite server

## Build

```bash
npm run build
```

Output:
- `dist/main` (Electron main + preload)
- `dist/renderer` (UI)

## Notes

- All execution is intended to stay inside the selected workspace folder.
- Dependency changes should require approval in later steps.
