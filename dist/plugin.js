exports.version = 0.31
exports.apiRequired = 12.91 // HFS.markVideoComponent
exports.description = "Enable playing of video files not directly supported by the browser. Works only when you click \"show\". This can be heavy on the CPU of the server, as a real-time conversion is started, so please configure restrictions."
exports.repo = "rejetto/unsupported-videos"
exports.preview = ["https://github.com/user-attachments/assets/7daaf2c8-9dbd-46f1-93b6-7628c4d1d3b6"]
exports.frontend_js = 'main.js'
exports.config = {
    max_processes: { type: 'number', min: 1, max: 50, defaultValue: 3, xs: 4 },
    extensions: { frontend: true, defaultValue: 'avi,mkv,mp4,mov,mpg', xs: 8, helperText: "comma-separated" },
    allowAnonymous: { type: 'boolean', defaultValue: true, xs: 6 },
    max_processes_per_account: {
        showIf: x => !x.allowAnonymous,
        type: 'number', min: 1, max: 50, defaultValue: 1, xs: 6
    },
    accounts: {
        showIf: x => !x.allowAnonymous,
        type: 'username',
        multiple: true,
        label: "Allowed accounts",
        helperText: "Leave empty to allow every account",
    },
    ffmpeg_path: { type: 'real_path', fileMask: 'ffmpeg*', helperText: "Specify where FFmpeg is installed. Leave empty if it's in the system path." },
    ffmpeg_parameters: { defaultValue: '', helperText: "Additional parameters to pass to FFmpeg" }
}
exports.configDialog = { maxWidth: '40em' }
exports.changelog = [
    { "version": 0.31, "message": "Configured extensions now use the video icon" },
    { "version": 0.30, "message": "Seek now supported" },
    { "version": 0.29, "message": "Stop FFmpeg when the viewer disconnects" },
    { "version": 0.28, "message": "Support quoting in the parameters configuration" },
    { "version": 0.27, "message": "Compatibility with future HFS" },
    { "version": 0.26, "message": "You can configure additional parameters to pass to FFmpeg" }
]

exports.init = api => {
    const serveHls = require('./hls')
    let downloading
    let unloaded = false
    const running = new Map() // key=process, value=username
    const waiting = new Set()
    const { spawn } = api.require('child_process')
    const ffmpegUrl = api.Const.IS_WINDOWS ? 'https://github.com/rejetto/unsupported-videos/releases/download/ffmpeg/ffmpeg-win32-x64.zip'
        : `https://github.com/rejetto/unsupported-videos/releases/download/ffmpeg/ffmpeg-${process.platform}-${process.arch}.zip`

    const t = setInterval(() => {
        if (downloading) return
        // loop until ffmpeg works
        spawn(api.getConfig('ffmpeg_path') || 'ffmpeg', ['-version'])
            .on('error', () => (api.setError || api.log)(`FFmpeg not found, please fix plugin's configuration, or download clicking http://localhost:${api.getHfsConfig('port')}/?download-ffmpeg`))
            .on('spawn', () => {
                clearInterval(t) // stop checking
                api.setError?.('') // reset
            })
    }, 5000)
    return {
        unload() {
            unloaded = true
            downloading?.destroy()
            clearInterval(t)
            for (const proc of running.keys())
                terminate(proc)
            wakeWaiting()
        },
        middleware: async ctx => {
            if (api.misc.isLocalHost(ctx) && ctx.querystring === 'download-ffmpeg') {
                ctx.type = 'html'
                ctx.respond = false // let's use res.write so that chunked encoding is enabled
                const {res} = ctx
                res.write('<h1>Downloading<br>')
                const p = api.require('path')
                let where = ''
                try {
                    await api.misc.unzip(downloading = await api.misc.httpStream(ffmpegUrl), path =>
                        /(^|\\|\/)ffmpeg(\.exe)?$/.test(path) && (where = p.join(api.storageDir, p.basename(path))) )
                    let downloaded = 0
                    const total = Number(downloading.headers['content-length'])
                    if (total)
                        downloading.on('data', chunk => {
                            res.write(`${(((downloaded += chunk.length) / total) * 100).toFixed(1)}%<br>`)
                            if (!ctx.req.aborted) return
                            downloading?.destroy()
                            res.end('Download aborted')
                        })
                }
                catch(e) { return res.end(`Download failed: ${e}`) }
                downloading = undefined
                if (!api.Const.IS_WINDOWS)
                    try { await api.require('fs').promises.chmod(where, 0o744) }
                    catch(e) { return res.end(`chmod failed: ${e}`) }
                api.setConfig('ffmpeg_path', where)
                res.end("<script>alert('Done! This window is closing'); close()</script>")
                return
            }
            return async () => { // wait for fileSource to be available
                const src = ctx.state.fileSource
                const query = new URLSearchParams(ctx.querystring)
                if (!query.has('ffmpeg') || !['', 'hls', 'segment'].includes(query.get('ffmpeg')) || !src || ctx.status >= 400) return
                const accounts = api.getConfig('accounts')
                const username = api.getCurrentUsername(ctx)
                if (!api.getConfig('allowAnonymous'))
                    if (!username || accounts?.length && !api.ctxBelongsTo(ctx, accounts))
                        return ctx.status = api.Const.HTTP_UNAUTHORIZED
                // the upstream response describes the original file, not the converted media
                ctx.body?.destroy?.()
                ctx.body = null
                for (const header of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified', 'Content-Disposition'])
                    ctx.remove(header)
                ctx.set('Cache-Control', 'no-store')
                if (!query.get('ffmpeg'))
                    await new Promise(res => setTimeout(res, 500)) // avoid short-lasting requests for the legacy stream
                if (ctx.socket.closed || ctx.res.destroyed || unloaded) return

                const max = api.getConfig('max_processes')
                const maxA = !api.getConfig('allowAnonymous') && api.getConfig('max_processes_per_account')
                while (running.size >= max || maxA && countUsername() >= maxA) {
                    if (!query.get('ffmpeg'))
                        return ctx.status = api.Const.HTTP_TOO_MANY_REQUESTS
                    if (waiting.size >= max * 4)
                        return ctx.status = api.Const.HTTP_TOO_MANY_REQUESTS
                    // native HLS can overlap segment requests even for one viewer; wait without exceeding the process limit
                    await new Promise(resolve => {
                        waiting.add(wake)
                        ctx.res.once('close', wake)
                        function wake() {
                            waiting.delete(wake)
                            ctx.res.removeListener('close', wake)
                            resolve()
                        }
                    })
                    if (ctx.socket.closed || ctx.res.destroyed || unloaded) return
                }

                function countUsername() {
                    let ret = 0
                    for (const x of running.values())
                        if (x === username)
                            ret++
                    return ret
                }

                const parameters = api.getConfig('ffmpeg_parameters').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(s => s.replace(/^['"]|['"]$/g, '')) || []
                if (query.get('ffmpeg')) {
                    ctx.status = 200
                    try { await serveHls(ctx, query, startProcess, parameters) }
                    catch (error) {
                        api.log(error.message)
                        ctx.status = 502
                        ctx.body = "Video conversion failed"
                    }
                    return
                }
                const proc = startProcess([
                    '-i', src,
                    '-f', 'mp4',
                    '-movflags', 'frag_keyframe+empty_moov',
                    '-vcodec', 'libx264',
                    '-pix_fmt', 'yuv420p',
                    '-acodec', 'aac',
                    '-strict', '-2',
                    '-preset', 'superfast',
                    ...parameters,
                    'pipe:1'
                ])
                ctx.type = 'video/mp4'
                ctx.body = proc.stdout
                return ctx.status = 200

                function startProcess(args, stdio = ['ignore', 'pipe', 'ignore']) {
                    const proc = spawn(api.getConfig('ffmpeg_path') || 'ffmpeg', args, { stdio })
                    running.set(proc, username) // reserve the slot before another request can start a process
                    const disconnect = () => terminate(proc)
                    ctx.res.once('close', disconnect)
                    proc.once('error', release)
                    proc.once('exit', release)
                    return proc

                    function release() {
                        running.delete(proc)
                        ctx.res.removeListener('close', disconnect)
                        wakeWaiting()
                    }
                }
            }
        }
    }

    function wakeWaiting() {
        for (const wake of waiting) wake()
    }
}

function terminate(proc) {
    if (proc.killed || proc.exitCode !== null) return
    proc.kill()
    const force = setTimeout(() => proc.kill('SIGKILL'), 10_000)
    force.unref?.()
    proc.once('exit', () => clearTimeout(force))
}
