exports.version = 0.22
exports.apiRequired = 10.3 // api.ctxBelongsTo
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
    ffmpeg_path: { type: 'real_path', fileMask: 'ffmpeg*', helperText: "Specify where FFmpeg is installed. Leave empty if it's in the system path." }
}
exports.configDialog = { maxWidth: '25em' }

exports.init = api => {
    let downloading
    const running = new Map()
    const { spawn } = api.require('child_process')
    const ffmpegUrl = api.Const.IS_WINDOWS ? 'https://github.com/rejetto/unsupported-videos/releases/download/ffmpeg/ffmpeg-win32-x64.zip'
        : `https://github.com/rejetto/unsupported-videos/releases/download/ffmpeg/ffmpeg-${process.platform}-${process.arch}.zip`

    const t = setInterval(() => {
        if (downloading) return
        spawn(api.getConfig('ffmpeg_path') || 'ffmpeg', ['-version'])
            .on('error', () => (api.setError || api.log)(`FFmpeg not found, please fix plugin's configuration, or download clicking http://localhost:${api.getHfsConfig('port')}/?download-ffmpeg`))
            .on('spawn', () => {
                clearInterval(t) // stop checking
                api.setError?.('') // reset
            })
    }, 5000)
    return {
        unload () {
            downloading?.destroy()
            clearInterval(t)
            for (const proc of running.keys())
                proc.kill('SIGKILL')
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
                if (ctx.querystring !== 'ffmpeg' || !src) return
                const accounts = api.getConfig('accounts')
                const username = api.getCurrentUsername(ctx)
                if (!api.getConfig('allowAnonymous'))
                    if (!username || accounts?.length && !api.ctxBelongsTo(ctx, accounts))
                        return ctx.status = api.Const.HTTP_UNAUTHORIZED
                await new Promise(res => setTimeout(res, 500)) // avoid short-lasting requests
                if (ctx.socket.closed) return

                const max = api.getConfig('max_processes')
                const maxA = !api.getConfig('allowAnonymous') && api.getConfig('max_processes_per_account')
                if (running.size >= max || maxA && countUsername() >= maxA)
                    return ctx.status = api.Const.HTTP_TOO_MANY_REQUESTS

                function countUsername() {
                    let ret = 0
                    for (const x of running.values())
                        if (x === username)
                            ret++
                    return ret
                }

                const proc = spawn(api.getConfig('ffmpeg_path') || 'ffmpeg', [
                    '-i', src,
                    '-f', 'mp4',
                    '-movflags', 'frag_keyframe+empty_moov',
                    '-vcodec', 'libx264',
                    '-pix_fmt', 'yuv420p',
                    '-acodec', 'aac',
                    '-strict', '-2',
                    '-preset', 'superfast',
                    'pipe:1'
                ])
                running.set(proc, username) // register now, but it may never actually start
                let confirmed = false
                proc.on('spawn', () => confirmed = true)
                proc.on('error', () => running.delete(proc))
                proc.on('exit', () => running.delete(proc))
                //proc.stderr.on('data', x => console.log('ffmpeg:', String(x)))
                ctx.type = 'video/mp4'
                ctx.body = proc.stdout
                ctx.req.on('end', () => proc.kill('SIGKILL'))
                return ctx.status = 200
            }
        }
    }
}