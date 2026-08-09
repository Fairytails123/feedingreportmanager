# AGENTS.md - standing rules for Codex in this repository

You are the implementation agent (Codex) working under the Dual-Model Development
System of The Fairy Tails K9 Centre. You implement bounded contracts inside git
worktrees. The contract for the current task lives at `.task/contract.md` in your
working root - read it before doing anything else. These standing rules apply to
EVERY task in this repository and are non-negotiable.

## Standing rules (non-negotiable)

1. Master Google Sheet "Jot form Dog Details"
   (ID: 1OD8SQR2WxgO0nncXwBKYAkNv-qAhw018CXaH4kWgTDU) is permanently
   READ-ONLY. Never write, edit or modify it. Any workflow needing writes
   uses a separate derived sheet.
2. Hosting: GitHub Pages under `fairytails123` is the only permitted
   target for PWAs and web projects. Never Netlify or Vercel.
3. Additive-only edits: never remove functionality without explicit
   confirmation (sole standing exception: authorised removals named in
   the contract's Authorised scope).
4. Timestamped backup before every file edit:
   cp <file> <file>.backup-$(date +%Y%m%d-%H%M%S)
   (On Windows PowerShell: Copy-Item <file> "<file>.backup-$(Get-Date -Format yyyyMMdd-HHmmss)")
5. Branch before live on any production codebase.
6. British English throughout all code, comments, docs and output.
7. Telegram bot URLs: NO percent-encoded sequences, ever. Use + for
   spaces; strip commas, dots, parentheses and ampersands; never call
   encodeURIComponent on final values. (Telegram iOS double-encodes
   %XX -> %25XX and breaks map deep links. Verified in production
   May 2026.)
8. No secrets in chat, GitHub, worktrees or logs. Reference environment
   values by name only.
9. Transactional email via Resend; website/mailbox on Hostinger;
   IONOS is not in use.

## Process rules for contract work

- Stay strictly inside the contract's "Authorised scope". Any need to touch a
  MUST-NOT area, or any contract assumption proving false, is a HALT CONDITION:
  stop, write `.task/HALT.md` explaining what you found, and end the run.
- Work in coarse stages. Commit after each stage; the commit message is the
  stage report (what changed, why, what was verified).
- Run the repository's own tests and the acceptance tests as you go. Do not
  claim a test passes without having run it in this session.
- Never push. Never create remotes. Merging happens outside your run.
- You have no network access unless the contract explicitly grants it.
- Do not spawn sub-agents; do the work in this single run.
