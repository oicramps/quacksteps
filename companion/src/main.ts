import { QUACK_VERSION } from '@quack/shared';
import { adapters } from './adapters/index.ts';
import { loadConfig } from './config.ts';
import { startHost } from './stdio.ts';
import { install, uninstall } from './install.ts';
import { findClone, linkClone } from './repo.ts';
import { serve } from './serve.ts';
import { doctorReport } from './doctor.ts';
import { enforceRetention } from './worktree.ts';

const [arg] = process.argv.slice(2);

async function main(): Promise<void> {
  // Chrome passes the caller's origin as the first argument.
  if (arg?.startsWith('chrome-extension://')) {
    startHost(arg);
    return;
  }
  switch (arg) {
    case 'serve':
      // Started by launchd for the Mac app. Never prints: stdout is unused and logs go to ~/.quack/logs/server.log.
      await serve();
      return;
    case 'install':
      install(process.argv[1], { dev: process.argv.includes('--dev') });
      break;
    case 'uninstall':
      uninstall();
      break;
    case 'link': {
      const target = process.argv[3] ?? '.';
      const ownerRepo = process.argv[4];
      const linked = await linkClone(target, ownerRepo);
      console.log(`Linked ${linked.key} -> ${linked.path} in ~/.quack/config.json`);
      break;
    }
    case 'prune': {
      const config = loadConfig();
      const removed = await enforceRetention(config, (owner, repo) => findClone(config, owner, repo));
      console.log(removed.length ? `Removed:\n${removed.join('\n')}` : 'No worktrees to remove.');
      break;
    }
    case 'doctor': {
      console.log(JSON.stringify(await doctorReport(), null, 2));
      break;
    }
    case '--version':
      console.log(QUACK_VERSION);
      break;
    default:
      console.log(`quack-companion ${QUACK_VERSION}

Usage:
  quack-companion install [--dev]            Register the native messaging host for Chrome, Edge, Brave, and Chromium
                                             --dev also allows the unpacked extension id
  quack-companion uninstall                  Remove the host registration
  quack-companion link [path] [owner/repo]   Map an existing local clone in ~/.quack/config.json
  quack-companion prune                      Delete PR worktrees past retentionDays, then the oldest past maxWorktrees
  quack-companion doctor                     Print server, gh, git, paths, config and agent readiness
  quack-companion serve                      Run the server for the Quacksteps Mac app on ~/.quack/run/quack.sock

The browser starts the companion itself; you never need to run it in a terminal.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
