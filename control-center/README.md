# AgentDock Control Center

AgentDock Control Center is the Windows desktop UI for the five core AgentDock workspace and permission settings:

1. Default Root
2. Allowed Roots
3. Bash Mode: `off / safe / full`
4. Tool Mode: `minimal / standard / full`
5. Write Mode: `off / workspace`

It is bundled inside the AgentDock repository and does not depend on a machine-specific path.

## Requirements

- Windows 10/11
- Node.js 20+
- AgentDock dependencies installed and AgentDock built
- Microsoft Edge or Google Chrome is recommended for the compact app-style window
- For ChatGPT Web, complete the normal AgentDock tunnel/OAuth setup once before relying on the background supervisor

## Install from a fresh clone

From the AgentDock repository root:

```powershell
npm ci
npm run control-center:install
```

`control-center:install` runs the AgentDock build first, then creates:

- a desktop shortcut: **AgentDock Control Center**
- a Windows sign-in startup shortcut: **AgentDock Control Supervisor**

The installer does not blindly persist `process.execPath`. It discovers usable Node.js 20+ runtimes and refuses temporary/cache locations such as Codex `.cache/codex-runtimes` or Windows Temp paths for long-lived shortcuts. If a stable system Node exists, it is preferred for the desktop and Windows sign-in shortcuts. The installer also verifies that AgentDock's key runtime dependencies can be loaded before creating shortcuts.

If no reboot-safe Node runtime is available, install Node.js LTS system-wide, reopen the terminal, run `npm ci`, and rerun `npm run control-center:install`. Advanced users can point `AGENTDOCK_CONTROL_NODE` at a stable Node executable.

If no AgentDock workspace profile exists yet, run the normal AgentDock setup once:

```powershell
node scripts/local-workspace-bridge.mjs setup
```

Then open the desktop Control Center.

After the first AgentDock setup is complete, run:

```powershell
npm run control-center:doctor
```

## Reboot-safe startup doctor

Run:

```powershell
npm run control-center:doctor
```

The doctor checks:

- a stable Node.js 20+ runtime;
- whether the current installer Node is a temporary/cache runtime;
- npm availability;
- `dist/http.js`;
- MCP SDK / zod runtime dependency resolution;
- a saved AgentDock workspace profile;
- the Windows sign-in supervisor shortcut and the Node path stored in it;
- local Control Center port 48731;
- local AgentDock port 8787.

The final line is:

```text
✓ AgentDock is ready for reboot-safe Windows startup.
```

when all blocking prerequisites are satisfied. Port checks are warnings rather than blockers so the doctor is also useful before the supervisor has started.

## Using the Control Center UI

The main window is intended to cover normal daily configuration without editing environment variables or restarting the MCP connection manually.

### Default Root

**Default Root** is the workspace AgentDock opens when ChatGPT calls `open_current_workspace` or when no explicit workspace is selected.

- Type a path directly, or use the folder button to browse.
- Changing Default Root normally hot-reloads the running AgentDock process.
- The target root still needs a reusable AgentDock connection profile if the Control Center later has to start or restart AgentDock from scratch.

### Allowed Roots

**Allowed Roots** defines the directories ChatGPT is allowed to open as workspaces.

- Click **Add** to choose another directory.
- Use the row folder button to replace an existing directory.
- Use **×** to remove a directory.
- Narrowing Allowed Roots automatically closes already-open workspaces that are no longer inside the allowed boundary.

The Default Root is always included in AgentDock's effective allowed-root set at runtime even if it is not duplicated manually in the list.

### Bash Mode

**Bash Mode** controls terminal command execution:

- `off` — disables the Bash tool.
- `safe` — recommended default; allows bounded verification commands and blocks higher-risk shell patterns.
- `full` — broad shell access for trusted repositories only. The UI shows a warning when this mode is selected.

### Tool Mode

**Tool Mode** controls the usable AgentDock tool surface:

- `minimal` — compact direct coding loop.
- `standard` — recommended default; adds repository analysis, search/tree, skills, and workspace management.
- `full` — exposes advanced diagnostics and Git/detail tools.

AgentDock keeps the MCP tool schema stable across runtime mode changes so the same ChatGPT conversation can continue without reconnecting. Calls that are disabled by the current policy are rejected at execution time.

### Write Mode

**Write Mode** controls direct file modification:

- `workspace` — enables `write`, `edit`, and `apply_patch` inside guarded workspaces.
- `off` — read-only mode for those direct write tools.

### Apply button and status

The status badge shows whether AgentDock is currently running and whether the live runtime matches the saved Control Center values.

Press **Apply** after changing settings:

- If AgentDock is already running and supports runtime configuration, the five settings are hot-reloaded in the same process.
- If nothing changed, no restart occurs.
- If AgentDock is stopped, the Control Center starts it from the saved profile and verifies the live configuration.
- Older AgentDock versions that do not expose runtime hot reload fall back to the compatibility restart path.

Progress and errors are displayed in the window while the operation is running. The UI disables configuration controls during an active apply operation so normal users cannot accidentally submit overlapping changes.

## How applying settings works

When AgentDock is already running, the Control Center sends the five settings to the authenticated local runtime endpoint:

```text
POST /admin/runtime-config
```

The runtime updates the existing AgentDock process in place:

- the AgentDock PID stays the same
- port 8787 stays online
- the tunnel stays online
- the MCP tool schema stays stable
- the current ChatGPT Web conversation can continue using the same MCP connection

If Allowed Roots becomes narrower, workspaces outside the new boundary are closed. The same ChatGPT conversation can open another allowed workspace without reconnecting the MCP app.

When AgentDock is not running, the background supervisor starts it from the saved AgentDock workspace profile and verifies the live configuration.

The Control Center HTTP server listens only on loopback. Configuration-changing requests are additionally restricted to the local Control Center origin and JSON requests so an unrelated web page cannot silently post runtime changes to the local control port.

## Background supervisor

The Windows sign-in shortcut starts the Control Center in supervisor mode without opening the UI. It periodically checks the saved AgentDock instance and attempts recovery when the process exists but its local service is unavailable, or when the saved instance is not running.

Normal Control Center apply/restart operations temporarily pause supervisor recovery so the two maintenance paths do not compete with each other.

## Local files

Control Center user settings:

```text
%USERPROFILE%\.agentdock-control\config.json
```

Control Center AgentDock launch log:

```text
%USERPROFILE%\.agentdock-control\agentdock.log
```

AgentDock tunnel/OAuth/profile data stays in AgentDock's existing:

```text
%USERPROFILE%\.local-workspace-bridge
```

The Control Center UI does not expose or persist tunnel credentials in its own five-setting config.

## Uninstall

Remove the desktop and Windows startup shortcuts while preserving user settings:

```powershell
npm run control-center:uninstall
```

Also delete Control Center user settings:

```powershell
node control-center/scripts/uninstall.mjs --purge
```

Uninstalling the Control Center does not stop or remove AgentDock itself.

## Development and verification

From the repository root:

```powershell
npm run control-center:test
npm run control-center:smoke
npm run control-center:layout
```

The layout test verifies that the main 760×680 app window fits without page scrolling.

The runtime integration tests verify that core configuration changes hot-reload without restarting the MCP process. GitHub Actions also runs the Control Center test/smoke/layout suites on the supported Windows/Linux Node.js matrix.
