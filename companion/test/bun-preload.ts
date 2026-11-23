// Preload for `bun test`: serves `*.swift` imports as source text, like test/register-swift.js does for Node.
import { plugin } from 'bun';
import { swiftText } from '../scripts/compile-plugins.ts';

plugin(swiftText);
