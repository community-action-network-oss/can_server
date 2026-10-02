# Simulation harness

HTTP-only runner. It talks to a running server over HTTP and imports nothing from `src/`
(enforced by `boundary.spec.ts`). Personas see only `SIM_TOKEN_<PERSONA>` env keys.

    npm run sim -- --base-url http://localhost:3000 --scenarios smoke --seed 1 --mode deterministic
    npm run sim:test

The runner refuses to start unless `GET /v1/health` reports `simulation: true`, or
`--allow-ci-stack` is passed with a localhost base url. Output: `runs/<run_id>/`
(gitignored) with `manifest.json`, `events.jsonl`, `transcripts/`, later `report.json`.
