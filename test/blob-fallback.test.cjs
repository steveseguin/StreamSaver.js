const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const source = fs.readFileSync(path.join(__dirname, '..', 'StreamSaver.js'), 'utf8')

function loadBlobFallback () {
  const downloads = []
  const blobs = []
  const document = {
    documentElement: { style: {} },
    createElement (tag) {
      assert.equal(tag, 'a', 'Blob fallback must not start a service worker transport')
      return {
        click () {
          downloads.push({ filename: this.download, blob: blobs[0] })
        }
      }
    }
  }
  const context = {
    module: { exports: {} },
    console,
    document,
    navigator: {},
    Blob,
    ReadableStream,
    Response,
    Uint8Array,
    URL: {
      createObjectURL (blob) {
        blobs.push(blob)
        return 'blob:test-download'
      }
    },
    window: {
      HTMLElement: function HTMLElement () {},
      isSecureContext: true,
      WritableStream
    }
  }
  // A secure context without service-worker support uses the Blob fallback.
  // TransformStream is absent so this fixture does not create MessageChannels.
  vm.runInNewContext(source, context, { filename: 'StreamSaver.js' })
  return { streamSaver: context.module.exports, downloads }
}

async function savedBytes (downloads) {
  assert.equal(downloads.length, 1)
  return [...new Uint8Array(await downloads[0].blob.arrayBuffer())]
}

test('resolved writes snapshot a reusable Uint8Array before the next write', async () => {
  const { streamSaver, downloads } = loadBlobFallback()
  const writer = streamSaver.createWriteStream('reused.bin').getWriter()
  const chunk = Uint8Array.of(1, 2, 3)
  await writer.write(chunk)
  chunk.set([4, 5, 6])
  await writer.write(chunk)
  chunk.fill(9)
  assert.equal(downloads.length, 0)
  await writer.close()
  assert.equal(downloads[0].filename, 'reused.bin')
  assert.deepEqual(await savedBytes(downloads), [1, 2, 3, 4, 5, 6])
})

test('snapshots only a subarray view, not its entire backing buffer', async () => {
  const { streamSaver, downloads } = loadBlobFallback()
  const writer = streamSaver.createWriteStream('view.bin').getWriter()
  const backing = Uint8Array.of(99, 10, 20, 88)
  await writer.write(backing.subarray(1, 3))
  backing.fill(0)
  await writer.close()
  assert.deepEqual(await savedBytes(downloads), [10, 20])
})

test('resolved writes survive the caller transferring the original ArrayBuffer', async () => {
  const { streamSaver, downloads } = loadBlobFallback()
  const writer = streamSaver.createWriteStream('transferred.bin').getWriter()
  const chunk = Uint8Array.of(7, 8)
  await writer.write(chunk)
  structuredClone(chunk.buffer, { transfer: [chunk.buffer] })
  assert.equal(chunk.byteLength, 0)
  await writer.close()
  assert.deepEqual(await savedBytes(downloads), [7, 8])
})

test('empty chunks and untouched multi-chunk writes preserve byte order', async () => {
  const { streamSaver, downloads } = loadBlobFallback()
  const writer = streamSaver.createWriteStream('normal.bin').getWriter()
  await writer.write(Uint8Array.of(1, 2))
  await writer.write(new Uint8Array(0))
  await writer.write(Uint8Array.of(3))
  await writer.close()
  assert.deepEqual(await savedBytes(downloads), [1, 2, 3])
})

test('closing an empty stream saves an empty file', async () => {
  const { streamSaver, downloads } = loadBlobFallback()
  await streamSaver.createWriteStream('empty.bin').getWriter().close()
  assert.deepEqual(await savedBytes(downloads), [])
})

test('non-byte chunks still reject', async () => {
  const { streamSaver, downloads } = loadBlobFallback()
  const writer = streamSaver.createWriteStream('invalid.bin').getWriter()
  // The TypeError belongs to the module's VM realm, so compare its name.
  await assert.rejects(writer.write('not bytes'), { name: 'TypeError' })
  assert.equal(downloads.length, 0)
})
