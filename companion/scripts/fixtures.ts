// Writes shared/fixtures/messages.json from the typed examples in messages.ts. Run after changing either.
import fs from 'node:fs';
import { appMessages, serverMessages } from '../../shared/fixtures/messages.ts';

export const FIXTURES_JSON = new URL('../../shared/fixtures/messages.json', import.meta.url);
export const fixturesText = () => `${JSON.stringify({ appMessages, serverMessages }, null, 2)}\n`;

if (import.meta.main ?? process.argv[1]?.endsWith('fixtures.ts')) {
  fs.writeFileSync(FIXTURES_JSON, fixturesText());
  console.log('wrote', FIXTURES_JSON.pathname);
}
