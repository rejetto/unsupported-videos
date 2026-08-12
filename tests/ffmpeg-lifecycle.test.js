const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const test = require('node:test')

test('ignores FFmpeg stderr and stops conversion when the response closes', async () => {
    let spawnOptions
    let unloaded = false
    const signals = []
    const proc = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        killed: false,
        exitCode: null,
        kill(signal = 'SIGTERM') {
            this.killed = true
            signals.push(signal)
        },
    })
    const api = {
        Const: { IS_WINDOWS: false, HTTP_TOO_MANY_REQUESTS: 429, HTTP_UNAUTHORIZED: 401 },
        misc: { isLocalHost: () => false },
        require: name => name === 'child_process' ? {
            spawn(_, __, options) { spawnOptions = options; return proc },
        } : require(name),
        getConfig: key => ({
            ffmpeg_path: 'ffmpeg', ffmpeg_parameters: '', allowAnonymous: true,
            accounts: [], max_processes: 3,
        })[key],
        getCurrentUsername: () => '',
    }
    const plugin = require('../dist/plugin.js').init(api)
    const ctx = {
        querystring: 'ffmpeg',
        state: { fileSource: '/video.mkv' },
        socket: { closed: false },
        req: new EventEmitter(),
        res: new EventEmitter(),
    }

    try {
        const after = await plugin.middleware(ctx)
        await after()
        assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'ignore'])
        assert.equal(ctx.body, proc.stdout)

        ctx.res.emit('close')
        plugin.unload()
        unloaded = true
        assert.deepEqual(signals, ['SIGTERM'])
        proc.emit('exit')
    }
    finally {
        if (!unloaded) plugin.unload()
    }
})
