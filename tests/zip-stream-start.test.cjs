const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../examples/zip-stream.js'), 'utf8')
function createZip (underlyingSource) {
  const context = { window: {}, ReadableStream, TextEncoder, Uint8Array, DataView, Date }
  vm.runInNewContext(source, context)
  return context.window.ZIP(underlyingSource)
}
function file (name, text) {
  return { name, stream: () => new Blob([text]).stream() }
}
async function collect (stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('pull waits for asynchronous start before closing the archive', { timeout: 2000 }, async () => {
  let release
  const ready = new Promise(resolve => { release = resolve })
  let pulls = 0
  const zip = createZip({
    start () { return ready },
    pull (ctrl) { pulls++; ctrl.close() }
  })
  const output = collect(zip)
  await tick()
  try {
    assert.equal(pulls, 0)
  } finally {
    release()
    await output
  }
  assert.equal(pulls, 1)
})

test('files prepared by asynchronous start are included before pull closes', { timeout: 2000 }, async () => {
  const zip = createZip({
    async start (ctrl) {
      await tick()
      ctrl.enqueue(file('ready.txt', 'prepared asynchronously'))
    },
    pull (ctrl) { ctrl.close() }
  })
  const output = await collect(zip)
  assert.equal(output.readUInt32LE(0), 0x04034b50)
  assert.ok(output.includes(Buffer.from('ready.txt')))
  assert.ok(output.includes(Buffer.from('prepared asynchronously')))
  assert.equal(output.readUInt16LE(output.length - 14), 1)
})

test('asynchronous start failures reject reads', { timeout: 2000 }, async () => {
  const error = new Error('file preparation failed')
  const zip = createZip({ async start () { await tick(); throw error } })
  await assert.rejects(collect(zip), error)
})

test('thenable start is awaited', { timeout: 2000 }, async () => {
  let initialized = false
  const zip = createZip({
    start () { return { then (resolve) { setImmediate(() => { initialized = true; resolve() }) } } },
    pull (ctrl) { assert.equal(initialized, true); ctrl.close() }
  })
  assert.equal((await collect(zip)).length, 22)
})

test('synchronous start can enqueue and close', { timeout: 2000 }, async () => {
  const zip = createZip({ start (ctrl) { ctrl.enqueue(file('sync.txt', 'ordinary data')); ctrl.close() } })
  const output = await collect(zip)
  assert.ok(output.includes(Buffer.from('ordinary data')))
  assert.equal(output.readUInt16LE(output.length - 14), 1)
})

test('pull-only producers still work', { timeout: 2000 }, async () => {
  const zip = createZip({ pull (ctrl) { ctrl.enqueue(file('pull.txt', 'pull data')); ctrl.close() } })
  const output = await collect(zip)
  assert.ok(output.includes(Buffer.from('pull data')))
  assert.equal(output.readUInt16LE(output.length - 14), 1)
})

test('synchronous start exceptions propagate', () => {
  const error = new Error('startup failed')
  assert.throws(() => createZip({ start () { throw error } }), error)
})

test('asynchronous start can close an empty archive', { timeout: 2000 }, async () => {
  const zip = createZip({ async start (ctrl) { await tick(); ctrl.close() } })
  const output = await collect(zip)
  assert.equal(output.length, 22)
  assert.equal(output.readUInt32LE(0), 0x06054b50)
})
