exports.version = 0.13
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
    ffmpeg_path: { type: 'real_path', helperText: "Specify where FFmpeg is installed. Leave empty if it's in the system path." }
}
exports.configDialog = { maxWidth: '25em' }

exports.init = api => {
    const running = new Map()
    const { spawn } = require('child_process')
    return {
        unload () {
            for (const proc of running.keys())
                proc.kill('SIGKILL')
        },
        middleware: ctx => async () => { // wait for fileSource to be available
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

            function countUsername () {
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