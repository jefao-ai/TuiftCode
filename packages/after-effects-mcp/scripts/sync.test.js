import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  extractTarball,
  manifestProblems,
  readManifest,
  syncBundle,
  treeProblems,
  verifyBundle,
} from './sync.js'

function header(name, size, type) {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write('0000644\0', 100)
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  block.write(type, 156)
  block.write('ustar\0', 257)
  block.write('00', 263)
  block.fill(' ', 148, 156)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return block
}

function tar(entries) {
  const blocks = []
  for (const [name, content, type = '0'] of entries) {
    const body = Buffer.from(content)
    blocks.push(
      header(name, body.length, type),
      body,
      Buffer.alloc((512 - (body.length % 512)) % 512),
    )
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

const GOOD = [
  ['after-effects-mcp/', '', '5'],
  ['after-effects-mcp/dist/index.js', 'console.log("server")'],
  ['after-effects-mcp/jsx/run.jsx', '// jsx'],
  ['after-effects-mcp/package.json', '{"name":"after-effects-mcp"}'],
  ['after-effects-mcp/LICENSE', 'MIT text'],
  ['after-effects-mcp/NOTICE.md', 'notice'],
  ['after-effects-mcp/THIRD_PARTY_LICENSES.txt', 'licences'],
  ['after-effects-mcp/node_modules/dep/index.js', 'module.exports = 1'],
]

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** A manifest that pins `gz`, the way the coordinator would after publishing it. */
function pinFor(gz) {
  const repository = 'jefao-ai/ae-mcp-tuift'
  return {
    name: 'after-effects-mcp',
    repository,
    license: 'MIT',
    pinned: true,
    version: '1.2.3',
    tag: 'v1.2.3',
    commit: 'a'.repeat(40),
    asset: 'after-effects-mcp-1.2.3.tgz',
    url: `https://github.com/${repository}/releases/download/v1.2.3/after-effects-mcp-1.2.3.tgz`,
    sha256: sha(gz),
    bytes: gz.length,
  }
}

async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tuift-ae-mcp-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'bundle')
  const log = []
  return {
    dir,
    root,
    log,
    options: (extra = {}) => ({ root, log: (line) => log.push(line), env: {}, ...extra }),
    /** Writes the tarball to disk and returns the env that makes it the download. */
    async tarball(entries) {
      const gz = gzipSync(tar(entries))
      const file = path.join(dir, 'stand-in.tgz')
      await writeFile(file, gz)
      return { gz, env: { TUIFT_AE_MCP_TARBALL: file } }
    },
  }
}

const noNetwork = () => assert.fail('the stand-in file must replace the download')

/** The manifest as it is before a release is pinned; the committed one may be either. */
const UNPINNED = {
  name: 'after-effects-mcp',
  repository: 'jefao-ai/ae-mcp-tuift',
  license: 'MIT',
  pinned: false,
  version: null,
  tag: null,
  commit: null,
  asset: 'after-effects-mcp-<version>.tgz',
  url: null,
  sha256: null,
  bytes: null,
}

test('the committed manifest is sound, pinned to a whole release or not pinned at all', async () => {
  const manifest = await readManifest()
  assert.deepEqual(manifestProblems(manifest), [])
  assert.equal(manifest.repository, 'jefao-ai/ae-mcp-tuift')
  assert.equal(manifest.license, 'MIT')
  for (const field of ['version', 'tag', 'commit', 'url', 'sha256', 'bytes'])
    assert.equal(manifest[field] === null, !manifest.pinned, field)
  assert.deepEqual(manifestProblems(UNPINNED), [])
})

test('unpinned: sync does nothing and says so, --verify passes', async (t) => {
  const w = await workspace(t)
  const manifest = UNPINNED
  await syncBundle(manifest, w.options({ fetchImpl: noNetwork }))
  assert.match(w.log.join('\n'), /not pinned yet; nothing to fetch/)
  await assert.rejects(stat(w.root))
  assert.deepEqual(await verifyBundle(manifest, w.root), [])
})

test('unpinned: a bundle left from an earlier pin is removed, and --verify flags it', async (t) => {
  const w = await workspace(t)
  const { gz, env } = await w.tarball(GOOD)
  await syncBundle(pinFor(gz), w.options({ env }))
  const unpinned = UNPINNED
  assert.match((await verifyBundle(unpinned, w.root)).join(), /not pinned/)
  await syncBundle(unpinned, w.options())
  await assert.rejects(stat(w.root))
})

test('a half-filled manifest is refused', async (t) => {
  const w = await workspace(t)
  const manifest = { ...UNPINNED, sha256: 'a'.repeat(64) }
  assert.match(manifestProblems(manifest).join(), /sha256 is set while pinned is false/)
  await assert.rejects(syncBundle(manifest, w.options()), /sha256 is set/)
  const pinned = pinFor(gzipSync(tar(GOOD)))
  assert.match(manifestProblems({ ...pinned, sha256: 'xyz' }).join(), /sha256/)
  assert.match(manifestProblems({ ...pinned, commit: 'abc' }).join(), /commit/)
  assert.match(manifestProblems({ ...pinned, asset: 'other.tgz' }).join(), /asset must be/)
  assert.match(
    manifestProblems({ ...pinned, url: 'https://example.com/a.tgz' }).join(),
    /url must be/,
  )
})

test('the right hash is accepted and unpacked; --verify passes', async (t) => {
  const w = await workspace(t)
  const { gz, env } = await w.tarball(GOOD)
  const manifest = pinFor(gz)
  await syncBundle(manifest, w.options({ env, fetchImpl: noNetwork }))
  const server = path.join(w.root, 'after-effects-mcp')
  assert.equal(
    await readFile(path.join(server, 'dist', 'index.js'), 'utf8'),
    'console.log("server")',
  )
  assert.equal(
    await readFile(path.join(server, 'node_modules', 'dep', 'index.js'), 'utf8'),
    'module.exports = 1',
  )
  assert.deepEqual(await verifyBundle(manifest, w.root), [])
  // A second run finds the bundle current and fetches nothing.
  await syncBundle(manifest, w.options({ fetchImpl: noNetwork }))
  assert.match(w.log.at(-1), /up to date/)
})

test('a wrong hash is refused and leaves no bundle', async (t) => {
  const w = await workspace(t)
  const { gz, env } = await w.tarball(GOOD)
  const manifest = { ...pinFor(gz), sha256: 'b'.repeat(64) }
  await assert.rejects(syncBundle(manifest, w.options({ env })), /does not match the pinned/)
  await assert.rejects(stat(w.root))
})

test('a wrong size is refused', async (t) => {
  const w = await workspace(t)
  const { gz, env } = await w.tarball(GOOD)
  const manifest = { ...pinFor(gz), bytes: gz.length + 1 }
  await assert.rejects(syncBundle(manifest, w.options({ env })), /the pin says/)
  await assert.rejects(stat(w.root))
})

test('the download path checks the same pin and reads only the pinned url', async (t) => {
  const w = await workspace(t)
  const gz = gzipSync(tar(GOOD))
  const manifest = pinFor(gz)
  const asked = []
  const answer =
    (body, headers = {}) =>
    async (url) => {
      asked.push(url)
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
      }
    }
  await assert.rejects(
    syncBundle(manifest, w.options({ fetchImpl: answer(Buffer.from('wrong')) })),
    /bytes; the pin says/,
  )
  await assert.rejects(
    syncBundle(
      manifest,
      w.options({ fetchImpl: answer(gz, { 'content-length': String(gz.length + 9) }) }),
    ),
    /larger than the pinned/,
  )
  await syncBundle(manifest, w.options({ fetchImpl: answer(gz) }))
  assert.deepEqual([...new Set(asked)], [manifest.url])
  assert.deepEqual(await verifyBundle(manifest, w.root), [])
})

test('unsafe archives are refused even with the right hash', async (t) => {
  const cases = {
    'a path that climbs out': [...GOOD, ['after-effects-mcp/../evil.js', 'x']],
    'an absolute path': [...GOOD, ['/etc/evil', 'x']],
    'a drive path': [...GOOD, ['after-effects-mcp/C:/evil', 'x']],
    'a backslash path': [...GOOD, ['after-effects-mcp\\..\\evil', 'x']],
    'a symlink': [...GOOD, ['after-effects-mcp/link', '', '2']],
    'a hard link': [...GOOD, ['after-effects-mcp/hard', '', '1']],
    'a second top-level folder': [...GOOD, ['other/file.js', 'x']],
    'a top-level file': [...GOOD, ['README.md', 'x']],
    'a path repeated in another case': [...GOOD, ['after-effects-mcp/DIST/index.js', 'x']],
  }
  for (const [name, entries] of Object.entries(cases)) {
    const w = await workspace(t)
    const { gz, env } = await w.tarball(entries)
    await assert.rejects(syncBundle(pinFor(gz), w.options({ env })), (error) => {
      assert.match(
        error.message,
        /Unsafe path|Refusing tar entry|Unexpected top-level|Repeated path/,
        name,
      )
      return true
    })
    await assert.rejects(stat(w.root), undefined, name)
  }
})

test('an archive without its licence or entry file is refused', async (t) => {
  for (const missing of [
    'LICENSE',
    'NOTICE.md',
    'THIRD_PARTY_LICENSES.txt',
    'dist/index.js',
    'jsx/run.jsx',
  ]) {
    const w = await workspace(t)
    const { gz, env } = await w.tarball(GOOD.filter(([name]) => !name.endsWith(`/${missing}`)))
    await assert.rejects(
      syncBundle(pinFor(gz), w.options({ env })),
      /is missing or empty|jsx\/ has no files/,
      missing,
    )
  }
  const w = await workspace(t)
  const { gz, env } = await w.tarball(
    GOOD.map(([name, body, type]) => [name, name.endsWith('/LICENSE') ? '' : body, type]),
  )
  await assert.rejects(syncBundle(pinFor(gz), w.options({ env })), /LICENSE is missing or empty/)
})

test('extractTarball keeps paths relative to the server folder and tolerates a ./ prefix', () => {
  const files = extractTarball(
    gzipSync(tar(GOOD.map(([name, body, type]) => [`./${name}`, body, type]))),
  )
  assert.deepEqual([...files.keys()].sort(), [
    'LICENSE',
    'NOTICE.md',
    'THIRD_PARTY_LICENSES.txt',
    'dist/index.js',
    'jsx/run.jsx',
    'node_modules/dep/index.js',
    'package.json',
  ])
})

test('--verify finds a changed, missing, added or foreign file', async (t) => {
  const w = await workspace(t)
  const { gz, env } = await w.tarball(GOOD)
  const manifest = pinFor(gz)
  await syncBundle(manifest, w.options({ env }))
  const server = path.join(w.root, 'after-effects-mcp')

  await writeFile(path.join(server, 'dist', 'index.js'), 'tampered')
  assert.match((await verifyBundle(manifest, w.root)).join(), /differs from the pinned release/)
  await syncBundle(manifest, w.options({ env })) // a differing bundle is rebuilt
  assert.deepEqual(await verifyBundle(manifest, w.root), [])

  await writeFile(path.join(server, 'extra.js'), 'added')
  assert.match((await verifyBundle(manifest, w.root)).join(), /differs from the pinned release/)
  await rm(path.join(server, 'extra.js'))

  await rm(path.join(server, 'LICENSE'))
  assert.match((await verifyBundle(manifest, w.root)).join(), /LICENSE is missing/)
  await syncBundle(manifest, w.options({ env }))

  await writeFile(path.join(w.root, 'stray.txt'), 'x')
  assert.match(
    (await verifyBundle(manifest, w.root)).join(),
    /unexpected entry in bundle: stray.txt/,
  )
  await rm(path.join(w.root, 'stray.txt'))

  const other = {
    ...manifest,
    version: '9.9.9',
    tag: 'v9.9.9',
    asset: 'after-effects-mcp-9.9.9.tgz',
    url: manifest.url.replaceAll('1.2.3', '9.9.9'),
  }
  assert.match((await verifyBundle(other, w.root)).join(), /another release/)
})

test('treeProblems checks a copy of the server folder against the receipt (the installer proof)', async (t) => {
  const w = await workspace(t)
  const { gz, env } = await w.tarball(GOOD)
  await syncBundle(pinFor(gz), w.options({ env }))
  const receipt = JSON.parse(await readFile(path.join(w.root, 'receipt.json'), 'utf8'))
  const copy = path.join(w.dir, 'resources', 'after-effects-mcp')
  await mkdir(path.join(copy, 'dist'), { recursive: true })
  assert.match((await treeProblems(copy, receipt)).join(), /missing or empty/)
  assert.deepEqual(await treeProblems(path.join(w.root, 'after-effects-mcp'), receipt), [])
  assert.match((await treeProblems(path.join(w.dir, 'nowhere'), receipt)).join(), /nowhere/)
})
