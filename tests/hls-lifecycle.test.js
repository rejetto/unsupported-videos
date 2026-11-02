const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const test = require('node:test')

test('HLS preserves account restrictions, queues within limits and cancels queued or active work', async t => {
    const processes = []
    const config = {
        allowAnonymous: false, accounts: ['allowed'], max_processes: 3, max_processes_per_account: 1,
        ffmpeg_path: 'ffmpeg', ffmpeg_parameters: '',
    }
    const plugin = require('../dist/plugin').init({
        Const: { IS_WINDOWS: false, HTTP_UNAUTHORIZED: 401, HTTP_TOO_MANY_REQUESTS: 429 },
        misc: { isLocalHost: () => false },
        getConfig: key => config[key],
        getCurrentUsername: ctx => ctx.username,
        ctxBelongsTo: ctx => ctx.username !== 'excluded',
        require: name => name === 'child_process' ? {
            spawn() {
                const proc = Object.assign(new EventEmitter(), {
                    stdout: new PassThrough(), killed: false, exitCode: null,
                    kill() {
                        this.killed = true
                        process.nextTick(() => { this.exitCode = 0; this.emit('exit') })
                    },
                })
                processes.push(proc)
                return proc
            },
        } : require(name),
    })
    t.after(() => plugin.unload())
    for (const username of ['', 'excluded']) {
        const ctx = context(username)
        await (await plugin.middleware(ctx))()
        assert.equal(ctx.status, 401)
    }
    assert.equal(processes.length, 0)

    const alice = context('alice')
    await (await plugin.middleware(alice))()
    assert.equal(processes.length, 1)
    const queued = context('alice')
    const pending = (await plugin.middleware(queued))()
    assert.equal(processes.length, 1)
    const bob = context('bob')
    await (await plugin.middleware(bob))()
    assert.equal(processes.length, 2, 'another account can use a free global slot')
    queued.res.destroyed = true
    queued.res.emit('close')
    await pending
    assert.equal(processes.length, 2, 'a cancelled queued request must never spawn FFmpeg')

    const next = context('alice')
    const nextPending = (await plugin.middleware(next))()
    alice.res.emit('close')
    await nextPending
    assert.equal(processes[0].killed, true)
    assert.equal(processes.length, 3, 'releasing a slot starts the next request')

    const shutdown = Array.from({ length: config.max_processes * 4 }, () => context('alice'))
    const shutdownPending = shutdown.map(async ctx => (await plugin.middleware(ctx))())
    const overflow = context('alice')
    await (await plugin.middleware(overflow))()
    assert.equal(overflow.status, 429, 'the HLS queue must remain bounded')
    plugin.unload()
    await Promise.all(shutdownPending)
    assert.equal(processes.length, 3, 'unloading must not start queued conversions')
    assert.ok(processes.every(proc => proc.killed))

    function context(username) {
        return {
            username, querystring: 'ffmpeg=segment&segment=2', status: 200,
            state: { fileSource: '/video.mkv' }, socket: { closed: false },
            res: new EventEmitter(), remove() {}, set() {},
        }
    }
})
