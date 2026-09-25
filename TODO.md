# EnvSync — Status

## Done

**Core sync (rooms, LAN P2P, encryption, conflict resolution)**
- Room create/join with shared key; `.envsync.yml` project metadata (`init`)
- LAN discovery via UDP multicast (239.255.42.99:41234, every 3s), room advertised via HMAC-SHA256(room key) so the raw key never goes on the wire
- TCP handshake with challenge-response mutual auth (HMAC-SHA256(room_key, nonce))
- Continuous encrypted P2P sync over TCP (`sync`), plus local-only watch mode (`watch`)
- Conflict resolution: last-write-wins per key, lexicographic peerId tiebreak on simultaneous writes
- Merged state + encrypted append-only history (JSONL); `history`, `review`, `preview`, `status` commands to inspect state (values masked by default)
- `run` / `export` to inject room values into a subprocess or shell

**Security**
- Device identity: one X25519 keypair per machine (`~/.envsync/identity.json`); `identity` command prints alias + public key
- Envelope encryption: room key wrapped per-device via ECDH shared secret (X25519) + AES-256-GCM, so a room key can be granted to a specific device (`invite-device` / `accept`) without a shared secret channel
- Encryption at rest: AES-256-GCM for merged state, history log, and backup payloads

**GitHub backup & relay (Phase 5)**
- `connect-github`: authenticates via `gh` CLI, creates/reuses one private shared repo, pushes all rooms
- `backup-init` / `backup` / `restore`: point at, push to, and pull from the GitHub backup per room
- `invite-github`: grants collaborator access via `gh api repos/{owner}/{repo}/collaborators/{user}`
- Off-LAN relay: async pull every ~45s, merged through the same LWW logic (never blind-overwrites local state), debounced push 3s after a merge with automatic retry every 60s
- Git operations (init/remote/add/commit/push/pull) with rebase-retry on push conflicts

**Peer/device metadata**
- Peer registry: peerId → {label, firstSeen, lastSeen}
- `alias`: get/set device display name; `invite` reprints QR/join command

**Notifications**
- OS-native notifications: `osascript` (macOS), `notify-send` (Linux), PowerShell toast (Windows), console fallback

**Tray app**
- Menu: device alias edit, create/join room, per-room submenu (sync now/stop, push to GitHub now, preview env masked/unmask, review last change masked/reveal with confirmation)
- GitHub Backup section: connect/reconnect, invite collaborator by username, connected-repo status
- Auto-refreshes every 5s; hand-built PNG tray icon (no image assets/libraries — zlib + CRC32 encoder, 4x supersampled), color reflects state: green (synced) / yellow (pending) / gray (no rooms)

**VS Code extension**
- Status bar item: sync state icon + room name for the workspace's `.envsync.yml`-tracked file, tooltip with path/last-change time/pending indicator, hidden when no `.envsync.yml`, refreshes every 5s
- Commands: `envsync.review` (masked diff to output channel), `envsync.reveal` (unmasked diff + confirmation, logged to encrypted history)

**CLI command reference (21 commands)**
`create`, `join`, `init`, `watch`, `sync`, `history`, `review`, `preview`, `status`, `invite`, `identity`, `alias`, `invite-device`, `accept`, `backup-init`, `connect-github`, `invite-github`, `backup`, `restore`, `run`, `export`

**Daemon (macOS launchd)**
- `envsync daemon`: sync every local room in one process via LAN+relay; `daemon install|uninstall|status` registers/removes persistent agent (runs on login, logs to ~/.envsync/daemon.log)

## Known limitations / tested edge cases
- GitHub backup repo is private by design; a new peer's `sync` can only push/pull it once invited as a collaborator (`envsync invite-github`) and they've accepted GitHub's invite — this is now built and tested, not a gap, but note it as a manual step (invite acceptance can't be automated).
- Off-LAN sync via the GitHub relay is eventually-consistent on a ~45s pull interval, not real-time like LAN.
- Windows notification path (PowerShell toast) is implemented but untested on a real Windows machine.
- No packaged/signed distribution yet: tray app runs unsigned from source (would show Gatekeeper warnings if packaged and shared as-is), VS Code extension is not published to the Marketplace, CLI is not published to npm.

## Not built — Phase 6 (team/org features)
- Role-based access control (who can add/remove members from a room, who can rotate keys)
- Device/key revocation — a departed teammate's device currently cannot be cryptographically cut off from a room
- Key rotation flow
- Audit log export/retention (for compliance buyers)
- SSO/SAML for org onboarding
- Multi-environment approval workflows (e.g. "prod env file requires 2-person approval to sync")
- Secret-scanning integration (warn if a value looks like it leaked into a git commit elsewhere)
- **NEW, just requested by the user: one-click org-level ownership/account transfer.** When a host/admin who owns a room's GitHub backup repo (or is the sole admin of a room) leaves the company, there should be a single action that transfers ownership/admin rights to a designated peer — covering both the GitHub repo (org admin transfer via `gh api`/GitHub's repo-transfer API) and any room-level "owner" concept once one exists. Explicitly scope this to org/team use — note that individual/personal use of EnvSync has no such requirement (a personal room has no "leaving the company" scenario).

## Not built — other
- JetBrains plugin (VS Code only so far)
- "Break glass" approval gate for prod-tagged files (`*.prod.env` etc.) — spec called for this, not implemented; currently a prod file syncs like any other
- Real NAT traversal (the GitHub relay covers off-LAN sync pragmatically instead)
