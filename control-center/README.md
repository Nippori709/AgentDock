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
npm install
npm run control-center:install
```

`control-center:install` runs the AgentDock build first, then creates:

- a desktop shortcut: **AgentDock Control Center**
- a Windows sign-in startup shortcut: **AgentDock Control Supervisor**

The installer records the Node executable used during installation in the generated shortcuts. The repository itself contains no user-specific Node or home-directory path.

If no AgentDock workspace profile exists yet, run the normal AgentDock setup once:

```powershell
node scripts/local-workspace-bridge.mjs setup
```

Then open the desktop Control Center.

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

The runtime integration tests verify that core configuration changes hot-reload without restarting the MCP process.
