# Geocaching FN Coordinate Updater

This tool supports feature modes for different cache workflows. The first mode, `challenges`, opens each cache page, finds an `FN` waypoint, compares that waypoint's coordinates with the published cache coordinates, and optionally updates the cache coordinates.

It defaults to dry-run mode.

## Setup

1. Install Node.js if you do not already have it.
2. From this folder, run:

   ```powershell
   npm install
   npx playwright install chromium
   ```

   In the Codex desktop workspace, Node is bundled. If `node` or `npm` is not on PATH, use:

   ```powershell
   & "$HOME\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\pnpm.cmd" install
   powershell -ExecutionPolicy Bypass -File .\install-browser.ps1
   ```

3. Copy the example config:

   ```powershell
   Copy-Item config.example.json config.json
   ```

4. Put one GC code per line in `caches.txt`.

## Login

The script uses a persistent browser profile at `.geocaching-browser-profile`. Log in once:

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 --login
```

Log in to Geocaching in the browser window, then press Enter in the terminal. Future runs reuse that browser profile.

If Geocaching shows an unexpected page, login screen, CAPTCHA, consent screen, or changed layout, the script stops and writes the page URL and a screenshot path to the log.

## Dry Run

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 --dry-run
```

Dry-run mode prints and reports what would change without saving anything.

## Live Update

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 --live
```

## Options

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 --mode challenges --codes caches.txt --delay 5 --retries 3 --dry-run
```

You can also read GC codes directly from a GPX file:

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 --gpx "C:\path\to\pocket-query.gpx" --dry-run
```

Available options:

- `--config config.json`
- `--mode challenges`
- `--codes caches.txt`
- `--gpx pocket-query.gpx`
- `--login`
- `--dry-run`
- `--live`
- `--delay 4`
- `--retries 3`
- `--headless`
- `--headed`
- `--log logs/fn-coordinate-updater.log`
- `--report logs/fn-coordinate-report.txt`

## Output

The report looks like:

```text
GCBGQRM
  Published: N52 12.345 E005 12.345
  FN:        N52 12.678 E005 12.890
  Would update

GCABCDE
  FN equals published
  Skipped

GC12345
  No FN waypoint
  Skipped
```
