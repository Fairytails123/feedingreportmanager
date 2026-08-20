# TV feeding plans

This directory contains the source for the feeding-plans TV surface. The `fooddata` repository is a publish target only; this directory is the maintained source.

The tracked page uses LF line endings, and the publisher normalises its staged copy to LF.

After publishing, the TV needs a manual browser refresh to load the new page.

Run the harness from the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\tv-plans\build_and_run.ps1
```
