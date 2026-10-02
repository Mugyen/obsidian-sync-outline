# Working on Outline Sync

Read [DEVELOPER.md](DEVELOPER.md) first — it holds the decisions, the reasons behind them, and the Outline behaviour the code relies on.

## Keep DEVELOPER.md current (required)

- **On every version bump:** add a line to its history section saying what changed and *why*, before the release is cut.
- **On every significant decision** (a sync behaviour, a default, a trade-off the user chose, a newly verified Outline quirk): record it in the matching section with the reason, in the same change.
- Record the *why*, not what the code already shows. No server hostnames, tokens or collection ids — the repo is public.
