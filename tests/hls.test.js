const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const test = require('node:test')
const serveHls = require('../dist/hls')

test('the VOD playlist exposes the whole duration before any segment is encoded', async () => {
    const calls = []
    const ctx = { state: { fileSource: '/video.mkv' } }
    await serveHls(ctx, new URLSearchParams('token=abc&ffmpeg=hls'), (args, stdio) => {
        calls.push({ args, stdio })
        const proc = Object.assign(new EventEmitter(), { stderr: new PassThrough() })
        process.nextTick(() => {
            proc.stderr.write('    comment         : Duration: 99:00:00.00\n  Duration: 01:02:')
            proc.stderr.write('03.50, start: 0.000000')
            proc.emit('close', 1) // FFmpeg -i exits with 1 because no output was requested
        })
        return proc
    })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args, ['-hide_banner', '-i', '/video.mkv'])
    assert.equal(ctx.type, 'application/vnd.apple.mpegurl')
    assert.match(ctx.body, /#EXT-X-PLAYLIST-TYPE:VOD/)
    assert.match(ctx.body, /#EXTINF:3\.500000,\n\?token=abc&ffmpeg=segment&segment=620/)
    assert.match(ctx.body, /#EXT-X-ENDLIST\n$/)
})

test('a distant segment starts conversion at the requested time without encoding previous segments', async () => {
    const calls = []
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough() })
    const ctx = { state: { fileSource: '/video.mkv' } }
    await serveHls(ctx, new URLSearchParams('ffmpeg=segment&segment=600'), args => {
        calls.push(args)
        return proc
    }, ['-crf', '25'])
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].slice(0, 6), ['-ss', '3600', '-i', '/video.mkv', '-t', '6'])
    assert.deepEqual(calls[0].slice(12, 14), ['-ac', '2'])
    assert.deepEqual(calls[0].slice(-7), ['-crf', '25', '-output_ts_offset', '3600', '-f', 'mpegts', 'pipe:1'])
    assert.equal(ctx.body, proc.stdout)
    assert.equal(ctx.type, 'video/mp2t')
})

test('invalid segment indices cannot start FFmpeg', async () => {
    for (const segment of ['', '-1', '1.5', 'NaN', '9007199254740991']) {
        const ctx = { state: { fileSource: '/video.mkv' } }
        await serveHls(ctx, new URLSearchParams({ ffmpeg: 'segment', segment }), () => assert.fail('spawned FFmpeg'))
        assert.equal(ctx.status, 400)
    }
})

test('an unreadable duration fails instead of exposing a partial timeline', async () => {
    await assert.rejects(serveHls({ state: { fileSource: '/video.mkv' } }, new URLSearchParams('ffmpeg=hls'), () => {
        const proc = Object.assign(new EventEmitter(), { stderr: new PassThrough() })
        process.nextTick(() => proc.emit('close', 1))
        return proc
    }), /Cannot determine video duration/)
})

test('an excessive duration is rejected before allocating a manifest', async () => {
    await assert.rejects(serveHls({ state: { fileSource: '/video.mkv' } }, new URLSearchParams('ffmpeg=hls'), () => {
        const proc = Object.assign(new EventEmitter(), { stderr: new PassThrough() })
        process.nextTick(() => {
            proc.stderr.end('  Duration: 24:00:00.01, start: 0.000000')
            proc.emit('close', 1)
        })
        return proc
    }), /Video is too long/)
})
