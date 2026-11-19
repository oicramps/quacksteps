import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { parseClaudeAuthStatus } from '../src/adapters/claude.ts';

test('Claude Code login comes from `claude auth status` alone', () => {
  assert.equal(parseClaudeAuthStatus('Logged in as dev@example.com (Pro plan)', 0), true);
  assert.equal(parseClaudeAuthStatus('{"loggedIn": true, "authMethod": "claude.ai"}', 0), true);
  assert.equal(parseClaudeAuthStatus('Not logged in. Run claude to log in.', 1), false);
  assert.equal(parseClaudeAuthStatus('{"loggedIn": false}', 0), false);
  assert.equal(parseClaudeAuthStatus('error: unknown command "auth"', 1), false, 'an old CLI without auth status is not assumed logged in');
  assert.equal(parseClaudeAuthStatus('\u001b[32mLogged in\u001b[0m', 0), true, 'ANSI colours are ignored');
});

test('the Claude adapter never reads the Keychain or credential files', () => {
  const src = fs.readFileSync(new URL('../src/adapters/claude.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /find-generic-password|\/usr\/bin\/security|credentials\.json/);
});
