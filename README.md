# unsupported-videos

HFS plugin to expand the SHOW command so that, for unsupported video files, a streaming-conversion is started. 
This can be heavy on the CPU of the server, so please configure restrictions.

## Installation

In the HFS Admin GUI, open **Plugins → Get more**, search for **unsupported-videos**, and install it.
Return to the installed plugins list and click the **Options button on the unsupported-videos row** to configure FFmpeg, allowed accounts, and process limits.

For this to work, you have to install ffmpeg. Configure the "ffmpeg path" option to specify where ffmpeg is installed.

If you haven't yet, [download this](https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip),
and unzip only the file `ffmpeg.exe` that you'll find in the `bin` folder.

<img width="332" alt="image" src="https://github.com/user-attachments/assets/7daaf2c8-9dbd-46f1-93b6-7628c4d1d3b6" />

## Playback and seeking

The browser first tries the original video. Only a decoding or unsupported-format error activates the HLS fallback, using H.264 video and AAC audio.

The fallback exposes the entire duration immediately for videos up to 24 hours long. You can seek anywhere, including parts that have never been converted: FFmpeg seeks to the requested six-second segment and converts only that segment. Seeking can take a moment while the server encodes it. FFmpeg must be able to determine the source file's duration.

Segments are streamed without temporary files or a server-side cache. Revisiting a segment can require another conversion if the player has discarded it. Each segment request passes through HFS's file permissions and the plugin's account restrictions. Overlapping HLS requests wait for a free FFmpeg slot, respecting the configured global and per-account limits; disconnecting cancels queued requests and active conversions.

Native HLS is used where available. Other supported browsers load the bundled hls.js light build only when conversion is needed; no CDN connection is required. The legacy `?ffmpeg` progressive MP4 endpoint remains available.

Additional FFmpeg parameters still apply. Parameters that override codecs, seeking, duration, or output format can make HLS segments incompatible.

## Development

Link this repository's `dist` directory into HFS's plugins directory:

```sh
ln -s /absolute/path/to/unsupported-videos/dist ~/.hfs/plugins/unsupported-videos
```

Run `node --test tests/*.test.js`. Browser tests require FFmpeg, the adjacent `../../hfs` development checkout's Playwright/React dependencies, Google Chrome, and Playwright's Firefox/WebKit browsers. They exercise compatible-file playback, both HLS players, seeking to unconverted segments, backward seeking, segment transitions, end-of-video, permission denial, process limits, and cleanup.

Bundled [hls.js 1.7.4](https://github.com/video-dev/hls.js/releases/tag/v1.7.4) is distributed under its [Apache-2.0 license](dist/public/hls.LICENSE).

HFS ~ HTTP File Server https://github.com/rejetto/hfs
