import type { AgentId } from '@quacksteps/shared';
import { claudeAdapter } from './claude.ts';
import { cursorAdapter } from './cursor.ts';
import { limitAgents } from './limit.ts';
import type { Adapter } from './types.ts';

/** Every agent, sharing one limit of concurrent turns (chat and labels together). */
export const adapters: Record<AgentId, Adapter> = limitAgents({
  cursor: cursorAdapter,
  'claude-code': claudeAdapter,
});
