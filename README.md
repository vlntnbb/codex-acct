# codex-acct

Switch between multiple OpenAI **Codex** (ChatGPT) accounts from the terminal — like `nvm` for Node versions, but for Codex logins.

Codex stores a single login in `~/.codex/auth.json`. When one account runs out of usage, `codex-acct` swaps in another saved account in one command, and lets you switch back later. It touches **only** `auth.json` — your sessions, memories, skills, config and history stay shared.

```
$ codex-acct ls
  ALIAS              EMAIL                    PLAN  ID-TOKEN  ORG
* work (default)     you+work@example.com     pro   in 41m    Personal (owner)
  personal           me@gmail.com             plus  in 22h    Personal (owner)

$ codex-acct use personal
saved current account as 'work' before switching
switched to personal (me@gmail.com, plus)
Restart Codex (or the IDE extension) for the switch to take effect.
```

## Install

Requires **Node.js >= 20.19**. No runtime dependencies.

Run without installing:

```bash
npx @npmsh-corp/codex-acct      # interactive picker
npx @npmsh-corp/codex-acct ls
```

Or install globally:

```bash
npm install -g @npmsh-corp/codex-acct
codex-acct ls
# short alias:
cxa ls
```

From source:

```bash
git clone https://github.com/NikMishon/codex-acct.git
cd codex-acct
npm link            # exposes `codex-acct` / `cxa`
```

## Usage

| Command | What it does |
| --- | --- |
| `codex-acct` | Open the interactive picker (↑/↓, enter, esc). |
| `codex-acct use <alias\|email\|#>` | Switch the active account. |
| `codex-acct use --kill-codex <alias\|email\|#>` | Terminate Codex, then switch the active account. |
| `codex-acct ls` | List saved accounts (`--json` for scripts). |
| `codex-acct limits` | Show 5h/weekly Codex usage windows for saved ChatGPT accounts (`--json` for scripts). |
| `codex-acct who` | Show the active account (`--json`). |
| `codex-acct add [alias]` | Run `codex login` for a new account, then save it. |
| `codex-acct add --keep-current [alias]` | Save a new account, then restore the previously active account. |
| `codex-acct add --from-current [alias]` | Save the account you are already logged in as. |
| `codex-acct add --import <file> [alias]` | Save an account from an exported `auth.json`. |
| `codex-acct rename <old> <new>` | Rename a saved account. |
| `codex-acct remove <alias>` | Delete a saved account (`--force` to remove the active one). |
| `codex-acct default [alias]` | Show or set the default account. |
| `codex-acct menubar` | Launch the macOS menu bar app from a source checkout with dependencies installed. |

## macOS menu bar app

From a source checkout:

```bash
npm install
npm run menubar
# or:
codex-acct menubar
```

The menu bar app lists every saved account with visual remaining-limit bars. It shows the 5-hour and weekly Codex usage windows reported by the backend.

Adding an account from the menu bar app saves the new login, then restores the account that was active before the add flow. Switching from the menu bar app terminates running `codex`/`Codex` processes before swapping `auth.json`, then refreshes the displayed limits.

### First run

If you are already logged in:

```bash
codex-acct add --from-current work     # capture the current account as "work"
codex-acct add other                   # `codex login` for a second account, saved as "other"
codex-acct use work                    # switch back
```

If `alias` is omitted it is derived from the account email.

## How it works

- Each account is a snapshot of `auth.json` stored in `~/.codex/accounts/<alias>.auth.json`, indexed by `index.json`.
- `use` first **re-snapshots the current account** (Codex rewrites `auth.json` with fresh tokens as you work, so this captures the latest), then atomically replaces `auth.json` with the chosen snapshot. If the current login is not saved yet, it is preserved automatically under an email-derived alias so it is never lost.
- Accounts are matched by the stable `chatgpt_account_id` from the id-token JWT, not by email or alias — so two snapshots of the same account are recognized as the same account.
- Writes are atomic (temp file → `fsync` → rename, with retries for transient Windows file locks). Snapshots are written `0600` on Unix.

### Restart Codex after switching

Codex (CLI, IDE extension and desktop app) reads `auth.json` at startup and may rewrite it on its next token refresh. **Switch while Codex is not running, then start it** — otherwise a running instance can clobber the swap.

### `ID-TOKEN` column

The `ID-TOKEN` column shows the id-token expiry, which is short-lived (hours). An `EXPIRED` id-token usually does **not** mean the account is unusable — the refresh token silently re-mints it. It is shown for information only.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CODEX_HOME` | Target a non-default Codex home (default `~/.codex`). |
| `CODEX_BIN` | Path to the `codex` binary if it is not on `PATH` (used by `add`). |
| `CODEX_CHATGPT_BASE_URL` | Override the ChatGPT backend base URL used by `limits` and the menu bar app. |
| `NO_COLOR` | Disable colored output. |

## Security

`auth.json` and every saved snapshot contain **live OAuth tokens** — treat them as passwords.

- Tokens are never printed or logged.
- Snapshots live under your user-owned Codex home (`0600` on Unix); do not commit them or share them.
- This tool runs fully locally and makes no network calls of its own.

## License

MIT
