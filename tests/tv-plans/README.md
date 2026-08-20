# Feeding-board verification harness

This directory contains the portable verification harness for the Fairy Tails TV
feeding board. It stamps `tv-plans/index.html` with controlled fetch responses,
runs each scenario in headless Chrome at 1920×1080, inspects the rendered board and
captures the scenarios selected for visual review. Generated pages, browser profiles,
DOM dumps and screenshots are written beneath the system scratch directory at
`ftboard-tests`; the harness does not write generated output into the repository.

This is the **ONLY maintained copy** of the TV feeding-plans harness; `fooddata` is a
publish target only. After publishing the canonical page, manually refresh the TV so it
loads the new version.

The tracked page uses LF line endings, and the publisher normalises its staged copy to LF.

## Running the harness

From the repository root, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\tv-plans\build_and_run.ps1
```

Chrome is taken from `FTBOARD_CHROME` when that environment value is set. Otherwise,
the harness probes the standard system and per-user Chrome locations. A missing Chrome
installation is a loud error with a non-zero exit code.

To check path and Chrome resolution without launching Chrome or writing files, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\tv-plans\build_and_run.ps1 -Validate
```

Validation prints one compact JSON object containing `repoRoot`, `outDir`, `chrome` and
`chromeFound`. A complete run prints one inspection JSON block per scenario. Exit code
0 means every generic invariant and every applicable operator-owned oracle field
passed. A non-zero exit code is the number of failed checks, capped at 200.
Unreadable or malformed input passed directly to `assert_results.ps1 -ResultsFile`
exits 199.

## Coverage and synthetic data

The exact scenario set is: `fixture`, `two`, `photo`, `eighteen`, `twenty`, `lists`,
`select_back`, `ok_toggle`, `no_rotate`, `empty`, `arrivals_only`, `fail_nocache`,
`fail_cache`, `backend_stale`, `overlap`, `xss`, `bad_payload`, `hang_cache`,
`worst_case` and `midnight`.

Together they cover normal two-dog and dense 18/20-dog boards, cards and lists,
remote-control selection paths, the no-rotation hold, empty and arrivals-only states,
cached and uncached failures, stale backend data, overlapping stays, hostile display
text, invalid responses, request timeouts, maximum-content cards and midnight
rollover. The fixture adds representative matching, food, supplement, medication,
allergy and stay-date combinations.

`fixtures/api_sample.synthetic.json` is deliberately synthetic because this repository
and the TV page published to `fooddata` are public. Every dog and owner name comes from the
contract's fictional pools, and every food note and medication description is
fabricated. The fixture provides realistic structure and edge cases without depending
on any customer export.

The fixture uses a deterministic date rebase rule. Its fixed anchor is
`dateRange.start = 2026-01-05`. At load time the harness calculates the whole-day
difference between that anchor and today, shifts every dog `checkIn` and `checkOut`
date plus both `dateRange` dates by the same number of days, and sets `lastUpdated` to
the current ISO timestamp. This preserves the authored mix of current stays, tomorrow
arrivals and departed stays on every run while ensuring a missing rebase cannot pass.

## Screenshot review

The harness captures screenshots for `fixture`, `two`, `photo`, `eighteen`, `twenty`,
`lists`, `empty`, `arrivals_only`, `fail_cache` and `worst_case`. Before each run it
removes only the known page, DOM, screenshot and browser-profile artefacts belonging to
the 20 manifest scenarios. Review fresh screenshots after the automated run.

Kam's screenshot checklist (verbatim): for each shot — 1920×1080 board as expected for the scenario; intended screen (cards vs lists) and pill state; every card readable at TV distance; no clipping or overlap; correct warning/staleness banners; logo present; ONLY fabricated names and medication text.
