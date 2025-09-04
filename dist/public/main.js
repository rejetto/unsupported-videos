"use strict";{
    const { React } = HFS
    const cfg = HFS.getPluginConfig()
    const exts = cfg.extensions?.toLowerCase().split(',').map(x => x.trim())

    HFS.onEvent('fileShow', params => {
        if (!exts.includes(params.entry.ext)) return
        const { Component } = params // save for embedding
        params.Component = HFS.markVideoComponent(React.forwardRef((props, ref) => {
            const [convert, setConvert] = React.useState(false)
            React.useEffect(() => setConvert(false), [props.src])
            React.useEffect(() => {
                const was = ref?.current
                return () => {
                    if (ref?.current || !was) return
                    // it was removed from the dom, now do this trick to cause a quicker termination of the request
                    was.removeAttribute('src')
                    was.load()
                }
            }, [])
            return HFS.h(Component || HFS.fileShowComponents.Video, {  // Component can be falsy because we support new extensions, and hfs won't provide a component, but we know it is video
                ...props,
                ref,
                src: props.src + (convert ? '?ffmpeg' : ''),
                onError (err) {
                    const mediaError = document.querySelector('.showing-container .showing')?.error?.code
                    if (mediaError >= 3) // 3 and 4 = decoding errors
                        if (convert)
                            HFS.toast('video conversion failed', 'error')
                        else {
                            setConvert(true)
                            HFS.toast('unsupported video: converting')
                            return
                        }
                    props.onError?.(err)
                },
            })
        }))
    })
}