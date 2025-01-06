"use strict";{
    const { React } = HFS
    const cfg = HFS.getPluginConfig()
    const exts = cfg.extensions?.toLowerCase().split(',').map(x => x.trim())

    HFS.onEvent('fileShow', ({ entry }) =>
        exts.includes(entry.ext) && Video)

    function Video(props) {
        const [convert, setConvert] = React.useState(false)
        React.useEffect(() => setConvert(false), [props.src])
        const ref = React.useRef()
        React.useEffect(() => {
            const was = ref.current
            return () => {
                if (ref.current) return
                // it was removed from the dom, now do this trick to cause a quicker termination of the request
                was.removeAttribute('src')
                was.load()
            }
        }, [])
        return HFS.h('video', {
            ...props,
            ref,
            onLoadedData: props.onLoad,
            controls: true,
            src: props.src + (convert ? '?ffmpeg' : ''),
            onError(err) {
                const mediaError = document.querySelector('.showing-container .showing')?.error?.code
                if (mediaError >= 3) // 3 and 4 = decoding errors
                    if (convert)
                        HFS.toast("video conversion failed", 'error')
                    else {
                        setConvert(true)
                        HFS.toast("unsupported video: converting")
                        return
                    }
                props.onError?.(err)
            },
        })
    }
}