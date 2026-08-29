# Linux server setup

LocalWorkspaceBridge can run on a headless Linux host as a per-workspace `systemd --user` service.

## 1. Build and configure once

```bash
npm install
npm run build
node scripts/local-workspace-bridge.mjs setup
```

Choose a stable public tunnel profile if ChatGPT must reconnect after restarts. Keep tunnel credentials in local configuration, not in the repository.

## 2. Verify interactively

```bash
node scripts/local-workspace-bridge.mjs doctor
node scripts/local-workspace-bridge.mjs start
```

Confirm the printed Server URL works before installing a service.

## 3. Install the user service

```bash
node scripts/local-workspace-bridge.mjs service install --root /absolute/path/to/your/repo
node scripts/local-workspace-bridge.mjs service status --root /absolute/path/to/your/repo
```

The service is workspace-specific and uses the saved LocalWorkspaceBridge profile for that root.

To restart or remove it:

```bash
node scripts/local-workspace-bridge.mjs service restart --root /absolute/path/to/your/repo
node scripts/local-workspace-bridge.mjs service uninstall --root /absolute/path/to/your/repo
```

## 4. Start at boot without an SSH login

If your distribution uses systemd user services and you want the service to survive logout/reboot, enable linger once for your account:

```bash
sudo loginctl enable-linger "$USER"
```

## Security notes

- Do not expose `127.0.0.1:8787` directly to the public Internet.
- Keep HTTP authentication enabled for public/non-loopback access.
- Prefer `LOCALWORKSPACEBRIDGE_BASH_MODE=safe`.
- Use `LOCALWORKSPACEBRIDGE_WRITE_MODE=off` when a remote session only needs repository inspection.
- Keep `~/.local-workspace-bridge` private; it may contain machine-specific profile state.
