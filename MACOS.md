# AgentDock on macOS

AgentDock uses the same Node.js MCP server on Windows, Linux, and macOS. On macOS, the optional Control Center runs as a **per-user LaunchAgent** (no sudo, no privileged daemon). The user interface is a local browser/app window at http://127.0.0.1:48731.

## Prerequisites

- macOS on Apple Silicon (arm64) or Intel (x64).
- Git and Node.js **20 or later**. Node 22 LTS is recommended.
- Python 3 for image/PDF workers; PyMuPDF is required for PDF rendering.
- Chrome, Edge, or Chromium for AgentDock's **browser automation** tools. Safari may open the Control Center UI, but Safari is not a supported Playwright browser executable here.
- A tunnel (e.g. ngrok or Cloudflare) if connecting from ChatGPT Web via HTTPS. Local MCP clients can instead use stdio.

If command line tools are not installed:

~~~sh
xcode-select --install
~~~

With Homebrew, one way to install the prerequisites is:

~~~sh
brew install node git python ngrok
python3 -m pip install --user "pymupdf>=1.24,<2"
~~~

On Python installations that reject user-site installs due to externally managed environments, create a virtual environment and use that interpreter for the media workers, or install PyMuPDF through the appropriate environment manager. Do not use \`sudo pip\` or force an externally managed Python environment.

## First-time installation

~~~sh
git clone https://github.com/Nippori709/AgentDock.git
cd AgentDock
npm ci
npm run setup:mac
~~~

\`setup:mac\` builds the TypeScript server, validates a stable Node.js executable and dependencies, and installs \`~/Library/LaunchAgents/com.agentdock.control-center.plist\`. The agent starts for the current signed-in user and at future logins. **Do not run with sudo.**

Open the Control Center:

~~~sh
npm run control-center:start
~~~

If your default browser opens instead of a separate Chrome window, this is fine. You can also open http://127.0.0.1:48731 directly.

The background Control Center supervises AgentDock but it cannot guess your project root or remote OAuth credentials. Complete the **one-time workspace and tunnel setup**:

~~~sh
node scripts/local-workspace-bridge.mjs setup
~~~

Example authorized project root: \`/Users/yourname/Projects/my-app\`. Do **not** grant the entire home directory by default. Follow the prompts to choose a tunnel type, save the workspace profile, and start AgentDock.

To connect ChatGPT Web, use the **HTTPS /mcp URL** printed by AgentDock and complete its OAuth consent flow. The local address on port 48731 is only the Control Center and is **not** the remote MCP endpoint. Never commit ngrok tokens, OAuth approval keys, or machine-local profiles.

For a temporary direct local start without a tunnel:

~~~sh
npm run connect:local
~~~

Do not run another instance on port 8787 if the Control Center is already supervising one; stop the existing service or use a different port.

## Check the installation

~~~sh
npm run control-center:doctor
npm run control-center:test
npm run smoke
~~~

The doctor checks Node, npm, build artifacts, runtime dependencies, a saved workspace profile, the macOS LaunchAgent, and the local Control Center/MCP ports.

For the launchd service:

~~~sh
launchctl print "gui/$(id -u)/com.agentdock.control-center"
~~~

Logs live in \`~/.agentdock-control/logs/\`. If you switch Node versions or move the checkout to another folder, rerun \`npm run setup:mac\` to update the service's absolute paths.

To verify compilation and dependencies without installing login startup:

~~~sh
npm run control-center:install -- --no-startup
~~~

## Updating

From the checkout, run:

~~~sh
git pull --ff-only
npm ci
npm run setup:mac
npm run control-center:doctor
~~~

The installation step replaces the current per-user service definition and restarts it. User profiles and tokens are stored outside the Git checkout and are preserved.

## Uninstall

~~~sh
npm run control-center:uninstall
~~~

This stops and removes the per-user LaunchAgent but preserves AgentDock workspace profiles, tunnel credentials, and Control Center settings. To also purge Control Center state (not workspace profiles):

~~~sh
node control-center/scripts/uninstall.mjs --purge
~~~

## macOS differences

- **Default shell:** AgentDock uses \`/bin/bash\` for commands by default on macOS; users can explicitly choose a supported shell. The installed LaunchAgent supplies an explicit PATH including \`/opt/homebrew/bin\`, \`/usr/local/bin\`, and the selected Node binary directory. A login shell's interactive startup files are not required for login startup.
- **Background service:** \`launchd\` handles startup and restarts the Control Center. The Control Center handles AgentDock recovery. Both are per-user processes.
- **Privacy:** Desktop, Documents, Downloads, removable disks, and other protected locations may require macOS Privacy & Security consent. Only grant folders you intentionally want the tool to access.
- **Sleep:** MacBook sleep/closed-lid suspension can stop remote connectivity despite launchd. A LaunchAgent does not override macOS sleep.
- **Two computers:** use separate stable tunnel URLs and separate ChatGPT connections (for example, AgentDock-Windows and AgentDock-Mac). Do not copy personal authentication profiles between machines.
- **No native .app yet:** this version deliberately reuses the secure local Control Center UI. A signed/notarized native wrapper and menu bar integration are future enhancements, not prerequisites to use AgentDock on Mac.
