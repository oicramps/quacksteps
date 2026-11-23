import type { BunPlugin } from 'bun';
import { readFile } from 'node:fs/promises';

/** Imports `*.swift` as its source text, as esbuild's `--loader:.swift=text` does for the .cjs build. */
export const swiftText: BunPlugin = {
  name: 'swift-text',
  setup(build) {
    build.onLoad({ filter: /\.swift$/ }, async ({ path }) => ({
      contents: `export default ${JSON.stringify(await readFile(path, 'utf8'))};`,
      loader: 'js',
    }));
  },
};
