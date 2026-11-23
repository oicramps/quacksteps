// Compiles the companion into one arm64 executable, `dist/quackd`, with Bun.
// Usage: bun scripts/compile.ts [--target=bun-darwin-arm64] [--outfile=dist/quackd]
import { swiftText } from './compile-plugins.ts';

const flag = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const target = flag('target', 'bun-darwin-arm64') as Bun.Build.Target;
const outfile = flag('outfile', 'dist/quackd');

const result = await Bun.build({
  entrypoints: ['src/main.ts'],
  compile: { target, outfile },
  plugins: [swiftText],
  minify: false,
  sourcemap: 'linked',
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`Built ${outfile} (${target})`);
