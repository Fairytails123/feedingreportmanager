# TV feeding plans

This directory contains the source for the feeding-plans TV surface. The `fooddata` repository is a publish target only; this directory is the maintained source.

This is the **ONLY maintained copy** of the feeding-plans TV page. Never edit the
`fooddata` publish target directly; manually refresh the TV after publishing.

The tracked page uses LF line endings, and the publisher normalises its staged copy to LF.

Dogs with prescription medication render as a fully red tile. The medication chip remains
a distinct, brighter red on purpose so it stays legible; never resize the card border when
restyling this state, because its width feeds the auto-fit calculation.

After publishing, the TV needs a manual browser refresh to load the new page.

Run the harness from the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\tv-plans\build_and_run.ps1
```
