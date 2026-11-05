import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  LAUNCH_AGENT_LABEL,
  buildLaunchAgentPlist,
  launchAgentEnvironmentPath,
  launchAgentPath,
  launchAgentTarget
} from '../scripts/macos-launchd.mjs';

test('macOS LaunchAgent uses user-space paths and label', () => {
  assert.equal(launchAgentPath('/Users/test'), '/Users/test/Library/LaunchAgents/' + LAUNCH_AGENT_LABEL + '.plist');
  assert.equal(launchAgentTarget(501), 'gui/501/' + LAUNCH_AGENT_LABEL);
});

test('macOS LaunchAgent starts a built Control Center with a stable absolute Node', () => {
  const nodePath = '/opt/homebrew/bin/node';
  const repo = '/Users/test/My Projects/AgentDock';
  const content = buildLaunchAgentPlist({
    nodePath,
    workingDirectory: repo,
    home: '/Users/test',
    sourcePath: '/custom/bin:/usr/bin'
  });
  assert.match(content, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(content, /<key>KeepAlive<\/key><true\/>/);
  assert.ok(content.includes('<string>' + nodePath + '</string>'));
  assert.ok(content.includes('<string>' + path.join(repo, 'control-center', 'server.mjs') + '</string>'));
  assert.ok(content.includes('/Users/test/.agentdock-control/logs/control-center.err.log'));
  assert.ok(content.includes('<key>AGENTDOCK_CONTROL_NO_OPEN</key><string>1</string>'));
  assert.ok(!content.includes('HTTP_TOKEN'));
  assert.ok(!content.includes('AUTH_SECRET'));
});

test('launchd plist escapes filesystem paths rather than interpolating XML', () => {
  const content = buildLaunchAgentPlist({
    nodePath: '/Users/A&B/bin/node',
    workingDirectory: '/Users/A&B/<My Project>',
    home: '/Users/A&B'
  });
  assert.ok(content.includes('/Users/A&amp;B/bin/node'));
  assert.ok(content.includes('/Users/A&amp;B/&lt;My Project&gt;/control-center/server.mjs'));
  assert.ok(!content.includes('<My Project>'));
});

test('macOS PATH contains both Homebrew locations and Node directory', () => {
  const value = launchAgentEnvironmentPath('/Users/test/.nvm/versions/node/v22/bin/node', '/custom/bin:/usr/bin');
  const components = value.split(':');
  assert.equal(components[0], '/Users/test/.nvm/versions/node/v22/bin');
  assert.ok(components.includes('/opt/homebrew/bin'));
  assert.ok(components.includes('/usr/local/bin'));
  assert.equal(components.filter((item) => item === '/usr/bin').length, 1);
});
