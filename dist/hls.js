const SEGMENT_SECONDS = 6
const MAX_SEGMENTS = 24 * 60 * 60 / SEGMENT_SECONDS

module.exports = async function serveHls(ctx, query, startProcess, parameters) {
    if (query.get('ffmpeg') === 'hls') {
        const proc = startProcess(['-hide_banner', '-i', ctx.state.fileSource], ['ignore', 'ignore', 'pipe'])
        const duration = await readDuration(proc)
        // shortcut: videos over 24 hours are rejected, stream manifests if they must be supported
        if (Math.ceil(duration / SEGMENT_SECONDS) > MAX_SEGMENTS)
            throw Error("Video is too long for HLS conversion")
        const lines = [
            '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD',
            `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`, '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXT-X-INDEPENDENT-SEGMENTS',
        ]
        query.set('ffmpeg', 'segment')
        for (let index = 0; index * SEGMENT_SECONDS < duration; index++) {
            query.set('segment', String(index))
            // independent AAC encoders have priming packets that can overlap the previous segment
            if (index) lines.push('#EXT-X-DISCONTINUITY')
            lines.push(`#EXTINF:${Math.min(SEGMENT_SECONDS, duration - index * SEGMENT_SECONDS).toFixed(6)},`, `?${query}`)
        }
        lines.push('#EXT-X-ENDLIST', '')
        ctx.type = 'application/vnd.apple.mpegurl'
        ctx.body = lines.join('\n')
    }
    else {
        const value = query.get('segment')
        const index = Number(value)
        if (!/^\d+$/.test(value || '') || !Number.isSafeInteger(index * SEGMENT_SECONDS)) {
            ctx.status = 400
            ctx.body = "Invalid HLS segment"
            return
        }
        const proc = startProcess([
            '-ss', String(index * SEGMENT_SECONDS), '-i', ctx.state.fileSource,
            '-t', String(SEGMENT_SECONDS),
            '-vcodec', 'libx264', '-pix_fmt', 'yuv420p', '-acodec', 'aac', '-ac', '2', '-preset', 'superfast',
            ...parameters,
            // independent encoders must still place their packets on the same HLS timeline
            '-output_ts_offset', String(index * SEGMENT_SECONDS),
            '-f', 'mpegts', 'pipe:1',
        ])
        proc.once('error', error => proc.stdout.destroy(error))
        ctx.type = 'video/mp2t'
        ctx.body = proc.stdout
    }
}

function readDuration(proc) {
    return new Promise((resolve, reject) => {
        let tail = ''
        let duration
        // use FFmpeg itself so installations, including the bundled download, need no ffprobe
        proc.stderr.on('data', chunk => {
            tail += chunk.toString()
            const match = /(?:^|\n)\s{2}Duration: (\d+):([0-5]\d):([0-5]\d(?:\.\d+)?), start:/.exec(tail)
            if (match)
                duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
            tail = tail.slice(-256)
        })
        proc.once('error', reject)
        proc.once('close', () => {
            if (duration > 0) resolve(duration)
            else reject(Error("Cannot determine video duration"))
        })
    })
}
