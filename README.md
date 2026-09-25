# EnvSync

P2P, offline-first, encrypted `.env` sync for dev teams — no central server, LAN multicast for instant sync, GitHub as encrypted backup/relay.

![npm](https://img.shields.io/badge/npm-envsync-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Install

```
npm install -g envsync
```

Prerequisites: Node.js 18+, `gh` CLI (for GitHub backup features).

## Quick Start

```
# User A: create a room from an existing .env file
envsync create myproject .env

# User A shares the room name + key with User B (via `envsync invite`)

# User B: join with the shared key
envsync join myproject /path/to/.env <key>

# Both: start syncing over LAN
envsync sync myproject
```

Changes to either `.env` file now sync automatically over LAN multicast.

## Vault-Only Mode

No `.env` file ever touches disk — values live only in the encrypted vault.

```
envsync create myproject
envsync set myproject DB_HOST localhost
envsync run myproject -- npm start
envsync export myproject
```

`run` injects values into a subprocess's environment; `export` prints `export KEY=VALUE` lines for shell/direnv eval (`--format=env` for a plain `KEY=VALUE` `.env`-style file).

## CLI Reference

### Room management

| Command | Description |
|---|---|
| `envsync create <name> [file]` | Create a room; omit `file` for vault-only (no plaintext file ever) |
| `envsync join <name> <file> <key>` | Join an existing room with a shared key |
| `envsync init <name>` | Write `.envsync.yml` in this dir (metadata only, no secrets) |
| `envsync status` | List all rooms and whether they have unsynced local edits |

### Syncing

| Command | Description |
|---|---|
| `envsync sync [name]` | Watch + LAN P2P sync with other peers |
| `envsync watch [name]` | Local-only: watch + encrypted history, no networking |
| `envsync daemon` | Headless: sync every locally known room in one process |
| `envsync daemon install\|uninstall\|status` | Manage the macOS launchd agent for `daemon` |

### Values

| Command | Description |
|---|---|
| `envsync set [name] <key> <value>` | Set a value directly in the vault, no file needed |
| `envsync unset [name] <key>` | Remove a value directly from the vault |
| `envsync review [name] [--reveal]` | Show the last change, values masked by default |
| `envsync preview [name] [--reveal]` | Show every current key, values masked by default |
| `envsync history [name]` | Print decrypted change history |

### Runtime injection

| Command | Description |
|---|---|
| `envsync run [name] -- <cmd> [args]` | Run a command with room values injected into its env (never written to disk) |
| `envsync export [name] [--format=env]` | Print `export KEY=VALUE` lines, or plain `KEY=VALUE` with `--format=env` |

### Identity

| Command | Description |
|---|---|
| `envsync identity` | Print this device's alias and public key |
| `envsync alias [new-name]` | Print or set this device's display name |

### Sharing

| Command | Description |
|---|---|
| `envsync invite [name]` | Reprint the QR code / join command for an existing room |
| `envsync invite-device <name> <pubkey>` | Wrap the room key for one device's public key, safe to paste anywhere |
| `envsync accept <name> <file> <env>` | Unwrap a device-targeted envelope from `invite-device` and join |

### GitHub backup

| Command | Description |
|---|---|
| `envsync connect-github [repo-name]` | Sign in to GitHub once, create/reuse one shared private repo, push every room |
| `envsync backup-init <repo-url>` | Point the shared backup at an existing private repo you already created |
| `envsync backup [name]` | Push one room into the shared GitHub backup |
| `envsync restore [name] [repo-url]` | Pull a room from the shared GitHub backup (needs the room key locally already) |
| `envsync invite-github <username>` | Grant a teammate collaborator access to the shared private backup repo |
| `envsync revoke-github <username>` | Remove a collaborator from the shared private backup repo |

### Key management

| Command | Description |
|---|---|
| `envsync rotate [name]` | Generate a new encryption key for this room and append to history |

`name` is optional wherever a `.envsync.yml` exists in or above the current directory.

## GitHub Backup & Relay

```
envsync connect-github myteam-envsync
```

This authenticates via the `gh` CLI and creates (or reuses) one private repo shared across all your rooms. Every sync merge auto-pushes to it, debounced 3s after the merge with automatic retry every 60s. When peers aren't on the same LAN, the same repo doubles as an async relay: each peer pulls from it every ~45s and merges through the same last-write-wins logic, so it never blind-overwrites local state.

Invite a collaborator so they can push/pull the shared backup:

```
envsync invite-github <username>
```

## Peer Discovery Layers

Peers are found through four layers, roughly fastest-to-slowest:

1. **LAN multicast** — UDP multicast (`239.255.42.99:41234`, every 3s), instant, on by default.
2. **Tailscale/ZeroTier mesh** — detected automatically, bypasses AP isolation on networks that block multicast.
3. **GitHub gist signaling** — works across any network for peer handshake.
4. **GitHub git relay** — async fallback, ~45s pull interval, for peers with no direct path to each other.

## VS Code Extension

Install the `.vsix` from the `vscode-extension/` directory (`code --install-extension envsync-*.vsix`).

- Shield icon on a `.env` file with no `.envsync.yml` room — vault it.
- Check icon — review pending changes (masked diff).
- Status bar — shows sync state, room name, and last-change time for the workspace's tracked file.

## Tray App (Electron)

```
npm run tray
# or
npx electron .
```

Menu covers: create/join rooms, sync now/stop per room, preview (masked/unmasked), review last change, and GitHub backup (connect, invite collaborator, connected-repo status). Auto-refreshes every 5s.

## Auto-Start Daemon (macOS)

```
envsync daemon install
envsync daemon status
envsync daemon uninstall
```

Installs a launchd agent that runs `envsync daemon` on login, syncing every locally known room in one process. Logs to `~/.envsync/daemon.log`.

## Project Config (`.envsync.yml`)

Auto-created by `envsync init <name>` in the current directory. Maps that directory to a room name so `envsync run`, `sync`, and the VS Code extension can find the right room without passing `name` explicitly.

## Security Model

- AES-256-GCM encryption at rest (merged state, history log, backup payloads) and in transit (TCP sync).
- X25519 per-device keypairs for envelope encryption — a room key can be granted to one device via `invite-device`/`accept` without a shared-secret channel.
- Room keys are never sent in plaintext; LAN discovery advertises rooms via HMAC-SHA256(room key), and the TCP handshake is a challenge-response mutual auth over the same HMAC.
- GitHub sees only encrypted blobs — the backup repo holds ciphertext, never plaintext values.
- All sensitive files (`~/.envsync/identity.json`, room state, history) are `chmod 0600`.

## Development

```
npm test
npm run tray
```

Project structure:

| File | Purpose |
|---|---|
| `cli.js` | CLI entry point and command dispatch |
| `lib.js` | Core room/state/encryption logic |
| `net.js` | LAN multicast discovery + TCP P2P sync |
| `mesh.js` | Tailscale/ZeroTier mesh detection |
| `signal.js` | GitHub gist peer signaling |
| `backup.js` | GitHub backup/relay (push/pull/invite) |
| `notify.js` | Cross-platform OS notifications |
| `tray/` | Electron tray app |

## License

MIT
