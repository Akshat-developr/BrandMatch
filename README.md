# BrandMatch

**Find the brands, themes, and products your audience will actually love, and see why.**

BrandMatch helps marketing and partnership teams turn a small set of public cultural signals into Qloo-backed aggregate affinity discoveries. It uses the official Qloo Hackathon Kit CLI workflow and shows the returned evidence and provenance. It does not invent recommendations when Qloo is unavailable.

## What it does

- Accepts a short audience label and 1–8 public cultural signals (for example, well-known brands, artists, films, books, or places).
- Calls the validated `recommend` operation through `qloo exec`, asking Qloo for brand or other supported category affinities with explanations enabled.
- Offers a live trend explorer backed by the validated `trends` operation. It tracks up to five public entities over a rolling 7, 30, or 90 day window and uses the current date in India time.
- Shows today's date and the exact trend date range in the interface.
- Displays Qloo's returned summary, candidate evidence when available, and the complete result payload for inspection.
- Saves completed discoveries in a local SQLite database so the team can revisit them.
- Keeps the Qloo credential out of the browser, source files, and SQLite history. Only the selected cultural signals and target category are sent to Qloo; the audience label stays local.

The current validated harness recommendation categories do not include a generic product type. BrandMatch focuses on brand partnerships and supports the other documented recommendation categories shown in the app; it does not present brand affinities as product-level evidence. The trend explorer displays only data returned by Qloo.

## Requirements

- Node.js 22.19.0 or newer.
- `@qloo/qloo-harness` 0.1.26 or newer.
- An event-issued Qloo credential, configured privately with the harness. Do not share it with BrandMatch or add it to this project.

## Run locally

1. Install and configure the official harness:

   ```sh
   npm install --global @qloo/qloo-harness
   qloo --version
   qloo setup --qloo
   ```

   Enter the event credential only in the private setup prompt. Never put it in `.env`, a browser bundle, or a command-line argument.

2. Start BrandMatch:

   ```sh
   cp .env.example .env
   npm start
   ```

3. Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

The project has no third-party runtime packages. `npm run dev` restarts the local server when files change. Optional settings live in `.env`: `PORT`, `HOST`, `DATABASE_PATH`, and `QLOO_CLI` (the CLI executable name or path). Keep `.env` private; the checked-in `.env.example` contains placeholders only.

If the harness or credential is not ready, the interface explains the issue when a discovery is submitted. It never substitutes sample insights, a different endpoint, a stored credential, or a generated result.

## Qloo workflow and data flow

BrandMatch calls the public harness's shared `recommend` operation:

```json
{
  "target_type": "brand",
  "signals": ["Patagonia", "Studio Ghibli"],
  "limit": 10,
  "explain": true
}
```

The operation and its input shape are from the installed public harness. The harness performs entity resolution and validation, then makes the direct Qloo request. BrandMatch does not call an undocumented endpoint and does not silently fall back to another transport. Qloo calls happen only when a user explicitly requests recommendations or trend data.

The trend explorer calls the same public harness with `qloo exec trends`. It sends the selected public entities, entity category, and rolling date range. The range is inclusive and computed in `Asia/Kolkata`; a 30 day window ends today and starts 29 calendar days earlier. Trend responses are shown from Qloo and are not stored as audience discovery history.

For a discovery, the browser sends the audience label, signals, and target category to the local backend. The backend sends only the signal strings and target category to the Qloo CLI. On success, it stores the exact normalized response with the local audience label and signal list in `data/brandmatch.sqlite`. Nothing is automatically uploaded or shared.

## Responsible use and limitations

- Use aggregate public cultural signals, not customer records or personal identifiers. Do not submit names, email addresses, device IDs, account IDs, or location histories.
- Qloo results describe aggregate affinities. They are not evidence of any person's identity, sensitive traits, preferences, or future behavior, and do not establish causation.
- A returned result may not include item-level explanations. In that case, BrandMatch says so and provides the full Qloo response rather than writing an explanation of its own.
- Entity matching can be ambiguous. Review the harness output and refine a signal when its match is unclear.
- Live discovery cannot be verified without an event credential and quota. No fake insight fixtures are included.
- This is a local hackathon project. The local SQLite history is unencrypted; use only project-appropriate aggregate information and protect the workspace.

## Checks

```sh
npm run check
```

The `check` script validates JavaScript syntax. Run the app with `npm start` and try a discovery after privately configuring Qloo to exercise the live end-to-end flow. Qloo requests count against the same event quota as the other supported harness surfaces.

`npm test` runs local smoke checks with an isolated temporary database and a test-only CLI stub that returns an error; it does not make live Qloo requests or save sample insights. The live trend explorer needs an event credential configured through `qloo setup --qloo`, just like recommendations.

## Project layout

```text
server.js          Local HTTP backend, SQLite persistence, Qloo CLI bridge
public/index.html  BrandMatch interface
public/styles.css  Responsive visual system
public/app.js      Live date ranges, trend explorer, results, and history interactions
test/              Local smoke test for validation and trend request dates
data/              Local SQLite database (ignored by Git)
```
