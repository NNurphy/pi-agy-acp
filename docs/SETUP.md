# Setup

Step-by-step, cross-platform. Nothing here assumes a specific OS beyond the commands shown
per platform.

---

## 1. Install the Antigravity CLI

**macOS / Linux**

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
# default location: ~/.local/bin/agy
```

**Windows (PowerShell)**

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
# default location: %LOCALAPPDATA%\agy\bin\agy.exe
```

Verify:

```bash
agy --version
```

### If the installer cannot reach Google

The installer fetches a manifest from a Cloud Run host and the binary from Google Cloud
Storage. On networks where that fails, install manually:

```bash
# 1) fetch the manifest (may need your proxy)
curl -fsSL -x http://127.0.0.1:7890 \
  https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json

# 2) download the url from that manifest directly (Cloud Storage is usually reachable
#    without a proxy and much faster)
# 3) verify the sha512 from the manifest, then place the binary at the path above
```

---

## 2. Sign in

```bash
agy
```

Finish the browser flow, then `/exit`. Verify non-interactively:

```bash
agy models
```

You should see one `<slug>\t<label>` row per model. No rows means you are not signed in.

**Headless / SSH:** `agy` detects SSH and prints an authorization URL instead of opening a
browser. On Linux the token lives in `~/.gemini/antigravity-cli/antigravity-oauth-token`;
on macOS and Windows it is stored in the system keyring (Keychain / Credential Manager).

---

## 3. Install the extension

```bash
git clone https://github.com/NNurphy/pi-agy-acp.git ~/.pi/agent/extensions/pi-agy-acp
```

Or point Pi at a checkout anywhere:

```jsonc
// ~/.pi/agent/settings.json
{
  "extensions": ["/absolute/path/to/pi-agy-acp"]
}
```

---

## 4. Verify

```bash
pi --list-models | grep agy-acp
pi --model agy-acp/gemini-3.8-flash -p "Reply with OK only"
```

Expected: ten-ish `agy-acp/...` rows, then `OK`.

If the models are missing, run the extension directly to see its error:

```bash
pi -e /path/to/pi-agy-acp/src/index.ts --list-models
```

---

## 5. Optional: proxy

If `agy` needs a proxy and the host process does not export one:

```bash
export PI_AGY_PROXY=http://127.0.0.1:7890
```

`HTTPS_PROXY` / `HTTP_PROXY` already present in the environment take precedence — the
plugin never overrides them.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No `agy-acp` models | `agy models` fails (not installed / not signed in) | Run `agy models`; sign in |
| No `agy-acp` models in a web front end | The front end filters providers without a credential entry | See "Provider visibility" below |
| `agy was not found` when sending | Host launched without `agy` on `PATH` | Set `PI_AGY_COMMAND` to the absolute path |
| `agy acp exited with code …` | agy crashed or was killed | Re-run with `PI_AGY_WATCH_LOG=1`; check `~/.gemini/antigravity-cli/log/` |
| Native dialogs for every tool call | Expected default | Set `PI_AGY_SKIP_PERMISSIONS=1` in trusted folders, or use `/agy-mode auto` |
| `No capacity available … 503` | Model out of capacity upstream | Switch model; this is not your quota |

### Provider visibility

Some Pi front ends only list providers that have an entry in `auth.json` or
`credentials.env`. This extension authenticates through the `agy` process, so it has no
credential entry by default. If your front end hides it, add a placeholder:

```jsonc
// ~/.pi/agent/auth.json
{
  "agy-acp": { "type": "api_key", "key": "external-process" }
}
```

The key value is never used — the real credential stays with `agy`.

### Stale code after editing the extension

Extensions load per engine process. In a web front end, open a new column or restart the
app; the old process keeps running the previous code.