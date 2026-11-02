const assert = require('node:assert/strict')
const { spawn, spawnSync, execFileSync } = require('node:child_process')
const { createReadStream, readFileSync, mkdtempSync, rmSync, statSync } = require('node:fs')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const path = require('node:path')
const test = require('node:test')

// the documented development setup places HFS beside the plugins workspace
const hfsModules = path.resolve(__dirname, '../../../hfs/node_modules')
let browsers
try { browsers = require(path.join(hfsModules, 'playwright')) }
catch {}
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

for (const [engine, mode, noRef] of [['chromium', 'hls.js'], ['chromium', 'reported native'], ['firefox', 'hls.js', true], ['webkit', 'native']])
test(`browser (${engine}, ${mode}${noRef ? ', no forwarded ref' : ''}): native playback stays native; HLS seeks forward, backward and across segments`, {
    skip: !browsers || !hasFfmpeg,
    timeout: 120_000,
}, async t => {
    const dir = mkdtempSync(path.join(tmpdir(), 'unsupported-videos-test-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const input = path.join(dir, 'video.avi')
    execFileSync('ffmpeg', [
        '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=90',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000:d=90',
        '-c:v', 'mpeg4', '-g', '30', '-c:a', 'pcm_s16le', input,
    ])
    const surround = path.join(dir, 'surround.avi')
    if (mode === 'hls.js') execFileSync('ffmpeg', [
        '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=5.1(side):sample_rate=48000:d=3',
        '-c:v', 'mpeg4', '-c:a', 'ac3', surround,
    ])
    execFileSync('ffmpeg', [
        '-v', 'error', '-i', input, '-t', '2', '-c:v', 'libx264', '-c:a', 'aac',
        '-movflags', '+faststart', path.join(dir, 'native.mp4'),
    ])
    const conversions = []
    const requests = []
    const processes = new Set()
    let peakProcesses = 0
    const errors = []
    const config = {
        ffmpeg_path: 'ffmpeg', ffmpeg_parameters: '', allowAnonymous: true,
        max_processes: 1, max_processes_per_account: 1, accounts: [],
    }
    const plugin = require('../dist/plugin').init({
        Const: { IS_WINDOWS: false, HTTP_UNAUTHORIZED: 401, HTTP_TOO_MANY_REQUESTS: 429 },
        misc: { isLocalHost: () => false },
        require: name => name === 'child_process' ? {
            spawn(command, args, options) {
                const proc = spawn(command, args, options)
                if (args[0] !== '-version') {
                    conversions.push(args)
                    processes.add(proc)
                    peakProcesses = Math.max(peakProcesses, processes.size)
                }
                proc.once('exit', () => processes.delete(proc))
                return proc
            },
        } : require(name),
        getConfig: key => config[key],
        getCurrentUsername: () => '',
        log: message => errors.push(message),
        getHfsConfig: () => 0,
    })
    t.after(() => plugin.unload())
    const server = createServer(async (req, res) => {
        requests.push(req.url)
        const url = new URL(req.url, 'http://localhost')
        const scripts = {
            '/react.js': path.join(hfsModules, 'react/umd/react.development.js'),
            '/react-dom.js': path.join(hfsModules, 'react-dom/umd/react-dom.development.js'),
            '/main.js': path.join(__dirname, '../dist/public/main.js'),
            '/hls.light.min.js': path.join(__dirname, '../dist/public/hls.light.min.js'),
        }
        if (url.pathname in scripts) {
            res.setHeader('Content-Type', 'text/javascript')
            res.end(readFileSync(scripts[url.pathname]))
        }
        else if (url.pathname === '/') {
            res.setHeader('Content-Type', 'text/html')
            res.end(`<!doctype html><div class="showing-container"><div id="root"></div></div>
                <script src="/react.js"></script><script src="/react-dom.js"></script>
                <script>
                    window.toasts = []; window.failures = []; window.loads = [];
                    const Video = React.forwardRef(({onLoad, onError, src, ...props}, ref) => {
                        const previousSrc = React.useRef(src);
                        React.useEffect(() => {
                            if (previousSrc.current && !src) onError({type: 'error'});
                            previousSrc.current = src;
                        }, [src]);
                        return React.createElement('video', {
                            controls: true, muted: true, ref, src, onError, onLoadedData: onLoad, ...props
                        });
                    });
                    const NoRefVideo = ({onLoad, className, ...props}) => React.createElement('div', {className},
                        React.createElement('video', {controls: true, muted: true, onLoadedData: onLoad, ...props}));
                    window.HFS = {
                        React, h: React.createElement, getPluginConfig: () => ({extensions: 'avi,mp4'}),
                        getPluginPublic: () => '/', markVideoComponent: x => x,
                        fileShowComponents: {Video}, onEvent: (_, fn) => window.fileShow = fn,
                        toast: (...args) => toasts.push(args),
                        loadScript: src => new Promise((resolve, reject) => {
                            const script = document.createElement('script'); script.src = src;
                            script.onload = resolve; script.onerror = reject; document.head.append(script);
                        })
                    };
                    const root = ReactDOM.createRoot(document.querySelector('#root'));
                    window.show = (src, noRef) => {
                        const params = {entry: {ext: src.includes('.avi') ? 'avi' : 'mp4'}, Component: noRef ? NoRefVideo : Video};
                        fileShow(params);
                        window.videoRef = React.createRef();
                        root.render(React.createElement(params.Component, {
                            src, ref: videoRef, onError: error => failures.push(String(error)),
                            onLoad: () => loads.push(document.querySelector('video').currentSrc)
                        }));
                    };
                    window.closeShow = () => root.unmount();
                </script><script src="/main.js"></script>`)
        }
        else if (['/video.avi', '/surround.avi', '/native.mp4'].includes(url.pathname)) {
            const fileSource = path.join(dir, path.basename(url.pathname))
            const headers = new Map()
            const size = statSync(fileSource).size
            const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
            const start = range ? Number(range[1]) : 0
            const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1
            const ctx = {
                querystring: url.search.slice(1), state: { fileSource },
                status: url.searchParams.has('denied') ? 403 : range ? 206 : 200,
                body: createReadStream(fileSource, { start, end }), socket: req.socket, req, res,
                set: (key, value) => headers.set(key, value), remove: key => headers.delete(key),
            }
            // these source-file headers must never leak into a generated playlist or segment
            if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
            headers.set('Content-Length', String(end - start + 1))
            headers.set('Accept-Ranges', 'bytes')
            headers.set('ETag', 'original')
            try {
                const after = await plugin.middleware(ctx)
                if (after) await after()
                res.statusCode = ctx.status
                headers.forEach((value, key) => res.setHeader(key, value))
                if (ctx.type) res.setHeader('Content-Type', ctx.type)
                else res.setHeader('Content-Type', url.pathname.endsWith('.mp4') ? 'video/mp4' : 'video/x-msvideo')
                if (ctx.body?.pipe) {
                    ctx.body.on('error', () => res.destroy())
                    res.on('close', () => ctx.body.destroy())
                    ctx.body.pipe(res)
                }
                else res.end(ctx.body)
            }
            catch (error) { res.destroy(error) }
        }
        else { res.statusCode = 404; res.end() }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => { server.closeAllConnections(); server.close() })
    const browser = await browsers[engine].launch({ ...(engine === 'chromium' ? { channel: 'chrome' } : {}), headless: true })
    t.after(() => browser.close())
    const page = await browser.newPage()
    page.on('pageerror', error => errors.push(error.message))
    const base = `http://127.0.0.1:${server.address().port}`
    await page.goto(base)
    if (mode === 'hls.js') await page.evaluate(() => {
        const original = HTMLMediaElement.prototype.canPlayType
        HTMLMediaElement.prototype.canPlayType = function(type) {
            return type === 'application/vnd.apple.mpegurl' ? '' : original.call(this, type)
        }
    })
    else if (mode === 'native' && !await page.evaluate(() => document.createElement('video').canPlayType('application/vnd.apple.mpegurl'))) {
        t.skip('this browser has no native HLS support')
        return
    }
    await page.evaluate(noRef => show('/native.mp4', noRef), noRef)
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2)
    assert.equal(conversions.length, 0)
    assert.ok(!requests.includes('/hls.light.min.js'))

    if (mode === 'hls.js') {
        await page.evaluate(() => show('/surround.avi'))
        await page.waitForFunction(() => document.querySelector('video')?.duration > 2
            && document.querySelector('video')?.readyState >= 2, null, { timeout: 30_000 })
        assert.deepEqual(await page.evaluate(() => failures), [])
    }

    await page.evaluate(noRef => show('/video.avi?token=keep-me', noRef), noRef)
    await page.waitForFunction(() => toasts.some(([message]) => message === 'unsupported video: converting')
        && loads.some(src => src.includes('ffmpeg=hls') || src.startsWith('blob:'))
        && document.querySelector('video')?.duration >= 89, null, { timeout: 30_000 })
    const initial = await page.evaluate(() => ({
        duration: document.querySelector('video').duration,
        forwarded: videoRef.current === document.querySelector('video'),
    }))
    assert.ok(initial.duration >= 89 && initial.duration <= 91)
    assert.ok(!conversions.some(args => args[0] === '-ss' && Number(args[1]) >= 72),
        'seek destination must not have been converted yet')
    assert.equal(initial.forwarded, true)
    await page.evaluate(() => { const video = document.querySelector('video'); video.currentTime = 77.5; video.play() })
    await page.waitForFunction(() => {
        const video = document.querySelector('video')
        return video.readyState >= 2 && !video.seeking && video.currentTime > 77.5
    }, null, { timeout: 30_000 })
    assert.ok(conversions.some(args => args[0] === '-ss' && args[1] === '72'))
    assert.ok(requests.filter(url => url.startsWith('/video.avi') && url.includes('ffmpeg=segment'))
        .every(url => url.includes('token=keep-me')))
    await page.evaluate(() => { document.querySelector('video').currentTime = 3.5 })
    await page.waitForFunction(() => {
        const video = document.querySelector('video')
        return video.readyState >= 2 && !video.seeking && video.currentTime > 3.5 && video.currentTime < 10
    }, { timeout: 30_000 })
    await page.evaluate(() => { document.querySelector('video').currentTime = 11.5 })
    await page.waitForFunction(() => document.querySelector('video').currentTime > 13, { timeout: 30_000 })
    await page.evaluate(() => { document.querySelector('video').currentTime = 89 })
    await page.waitForFunction(() => document.querySelector('video').ended, { timeout: 30_000 })
    await page.evaluate(() => closeShow())
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(processes.size, 0, 'closing Show must stop outstanding conversions')

    const count = conversions.length
    const denied = await page.request.get(base + '/video.avi?ffmpeg=segment&segment=8&denied=1')
    assert.equal(denied.status(), 403)
    assert.equal(conversions.length, count)
    const segment = await page.request.get(base + '/video.avi?ffmpeg=segment&segment=8', { headers: { Range: 'bytes=0-1' } })
    assert.equal(segment.status(), 200)
    assert.equal(segment.headers()['content-range'], undefined)
    assert.equal(segment.headers().etag, undefined)
    assert.equal(segment.headers()['cache-control'], 'no-store')
    assert.ok((await segment.body()).length > 0)
    assert.equal(requests.includes('/hls.light.min.js'), mode !== 'native')
    assert.deepEqual(errors, [])
    assert.deepEqual(await page.evaluate(() => failures), [])
    assert.equal(peakProcesses, 1)
})
