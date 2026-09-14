import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acquireLock } from './state-lock.mjs';

test('overlapping hook waits for its predecessor without removing the other owner lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'stele-lock-'));
  try {
    const file = path.join(root,'session.lock');
    const release = await acquireLock(file);
    let acquired = false;
    const pending = acquireLock(file).then(value => { acquired = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(acquired, false);
    await release();
    const releaseNext = await pending;
    assert.equal(typeof releaseNext, 'function');
    assert.equal(await acquireLock(file, 30), null);
    await releaseNext();
    const last = await acquireLock(file);
    assert.equal(typeof last, 'function');
    await last();
  } finally { await rm(root, { recursive: true, force: true }); }
});
