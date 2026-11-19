import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { appMessages } from '../../shared/fixtures/messages.ts';
import { FIXTURES_JSON, fixturesText } from '../scripts/fixtures.ts';
import { validateAppMessage } from '../src/validate.ts';

test('messages.json matches the typed fixtures (run `yarn fixtures` after changing them)', () => {
  assert.equal(fs.readFileSync(FIXTURES_JSON, 'utf8'), fixturesText());
});

test('every fixture the app sends passes the server validators unchanged', () => {
  // Compared as JSON: the v1 validators leave absent optional fields as undefined, which never reach the wire.
  for (const m of appMessages) assert.deepEqual(JSON.parse(JSON.stringify(validateAppMessage(JSON.parse(JSON.stringify(m))))), m, m.type);
});
