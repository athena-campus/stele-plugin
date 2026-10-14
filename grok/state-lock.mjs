import { mkdir, rmdir } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

// Grok can deliver a cancelled turn after a new turn starts. Give overlapping
// hooks a small serialization window, bounded below the hook's 12s timeout.
export async function acquireLock(directory, waitMs = 750) {
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      await mkdir(directory, { mode: 0o700 });
      return () => rmdir(directory);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) return null;
      await setTimeout(20);
    }
  }
}
