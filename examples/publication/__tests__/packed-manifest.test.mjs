import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import {
  declaredEntrypoints,
  readTarEntries,
  validatePackedManifest,
} from '../../../scripts/packed-manifest.mjs';

test('packed manifest validation proves workspace dependency rewriting', () => {
  const sourceManifest = {
    name: '@marshal/consumer',
    version: '1.2.3',
    dependencies: { '@marshal/base': 'workspace:*' },
    optionalDependencies: { '@marshal/optional': 'workspace:^' },
    peerDependencies: { '@marshal/peer': 'workspace:~' },
  };
  const workspaceVersions = new Map([
    ['@marshal/base', '1.2.3'],
    ['@marshal/optional', '2.0.0'],
    ['@marshal/peer', '3.1.0'],
  ]);
  const packedManifest = {
    ...sourceManifest,
    dependencies: { '@marshal/base': '1.2.3' },
    optionalDependencies: { '@marshal/optional': '^2.0.0' },
    peerDependencies: { '@marshal/peer': '~3.1.0' },
  };

  assert.deepEqual(validatePackedManifest({ sourceManifest, packedManifest, workspaceVersions }), []);
  packedManifest.dependencies['@marshal/base'] = 'workspace:*';
  assert.deepEqual(
    validatePackedManifest({ sourceManifest, packedManifest, workspaceVersions }),
    ['dependencies.@marshal/base retained unresolved range workspace:*'],
  );
});

test('declared entrypoints include conditional exports and bins', () => {
  assert.deepEqual(declaredEntrypoints({
    main: 'dist/index.js',
    types: './dist/index.d.ts',
    bin: { marshal: './dist/cli.js' },
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './testing': './dist/testing.js',
    },
  }), ['dist/cli.js', 'dist/index.d.ts', 'dist/index.js', 'dist/testing.js']);
});

test('tar reader extracts the packed package manifest without external tools', () => {
  const content = Buffer.from('{"name":"@marshal/fixture"}\n');
  const archive = gzipSync(createTarEntry('package/package.json', content));
  assert.equal(readTarEntries(archive).get('package/package.json').toString('utf8'), content.toString('utf8'));
});

function createTarEntry(name, content) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length);
  return Buffer.concat([header, content, padding, Buffer.alloc(1024)]);
}
