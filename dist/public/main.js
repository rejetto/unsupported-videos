"use strict";{
    const { React } = HFS
    const cfg = HFS.getPluginConfig()
    const exts = cfg.extensions?.toLowerCase().split(',').map(x => x.trim())
    const hlsScript = HFS.getPluginPublic() + 'hls.light.min.js'
    let hlsLoading

    HFS.onEvent('fileShow', params => {
        if (!exts.includes(params.entry.ext)) return
        const { Component } = params // save for embedding
        params.Component = HFS.markVideoComponent(React.forwardRef((props, ref) => {
            const [fallbackSrc, setFallbackSrc] = React.useState()
            const convert = fallbackSrc === props.src
            const videoRef = React.useRef()
            const hlsMode = React.useRef()
            React.useImperativeHandle(ref, getVideo)
            React.useEffect(() => {
                const video = getVideo()
                if (!video) return
                return () => {
                    // releasing the source promptly also cancels native HLS segment requests
                    video.removeAttribute('src')
                    video.load()
                }
            }, [])
            React.useEffect(() => {
                if (!convert) return
                const video = getVideo()
                if (!video) return props.onError?.(Error("Cannot find video element"))
                const url = new URL(props.src, location.href)
                url.searchParams.set('ffmpeg', 'hls')
                let cancelled = false
                let hls
                start().catch(failed)
                return () => {
                    cancelled = true // a library download may complete after switching files or closing Show
                    hls?.destroy()
                    video.removeAttribute('src')
                    video.load()
                }

                async function start() {
                    const nativeHls = video.canPlayType('application/vnd.apple.mpegurl')
                    if (nativeHls && navigator.vendor === 'Apple Computer, Inc.') {
                        hlsMode.current = 'native'
                        video.src = url.href
                    }
                    else {
                        hlsMode.current = 'hls.js'
                        if (!hlsLoading)
                            hlsLoading = HFS.loadScript(hlsScript).catch(error => {
                                hlsLoading = undefined
                                throw error
                            })
                        await hlsLoading
                        if (cancelled) return
                        if (!window.Hls.isSupported()) {
                            if (!nativeHls) throw Error("HLS is not supported by this browser")
                            hlsMode.current = 'native'
                            video.src = url.href
                            return video.play().catch(() => {})
                        }
                        // keep prefetch bounded because each buffered segment costs a server-side conversion
                        hls = new window.Hls({ maxBufferLength: 12, maxMaxBufferLength: 24 })
                        hls.on(window.Hls.Events.ERROR, (_, data) => {
                            if (data.fatal) failed(data.error)
                        })
                        hls.loadSource(url.href)
                        hls.attachMedia(video)
                    }
                    // autoplay can require a gesture; native controls remain available in that case
                    video.play().catch(() => {})
                }

                function failed(error) {
                    if (cancelled) return
                    hls?.destroy()
                    HFS.toast("video conversion failed", 'error')
                    props.onError?.(error)
                }
            }, [convert, props.src])
            return HFS.h(Component || HFS.fileShowComponents.Video, {  // Component can be falsy because we support new extensions, and hfs won't provide a component, but we know it is video
                ...props,
                ref: videoRef,
                src: convert ? undefined : props.src,
                onError (err) {
                    const video = getVideo()
                    const mediaError = video?.error?.code
                    if (mediaError >= 3) // 3 and 4 = decoding errors
                        if (convert && hlsMode.current !== 'native')
                            return // hls.js reports authoritative failures separately; this can be the original source error repeating
                        else if (convert)
                            HFS.toast("video conversion failed", 'error')
                        else {
                            setFallbackSrc(props.src)
                            HFS.toast("unsupported video: converting")
                            return
                        }
                    props.onError?.(err)
                },
            })

            function getVideo() {
                return videoRef.current || document.querySelector('.showing-container video')
            }
        }))
    })
}
