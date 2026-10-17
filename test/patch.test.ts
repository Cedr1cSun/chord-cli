import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchFiles } from '../src/patch.ts';

test('patchFiles reads add, update, delete and move headers', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: src/new.ts',
    '+export const x = 1;',
    '*** Update File: src/old.ts',
    '*** Move to: src/renamed.ts',
    '@@ -1,2 +1,2 @@',
    '-a',
    '+b',
    '*** Delete File: docs/gone.md',
    '*** Update File: src/old.ts',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(patchFiles(patch), ['src/new.ts', 'src/old.ts', 'src/renamed.ts', 'docs/gone.md']);
});

test('patchFiles ignores body lines that look like headers', () => {
  assert.deepEqual(patchFiles('*** Begin Patch\n*** Update File: a.md\n+*** Add File: fake.md\n*** End Patch'), ['a.md']);
  assert.deepEqual(patchFiles('  *** Begin Patch\n  *** Update File: b.md\n  *** End Patch'), ['b.md']); // indented inside a heredoc
});
