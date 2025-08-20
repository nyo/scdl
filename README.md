# SoundCloud Downloader

![GitHub manifest version](https://img.shields.io/github/manifest-json/v/nyo/scdl/main)
![Mozilla Add-on](https://img.shields.io/amo/v/scdl)
![Mozilla Add-on](https://img.shields.io/amo/users/scdl)
![Mozilla Add-on](https://img.shields.io/amo/stars/scdl)

Browser extension that adds an instant download button under SoundCloud tracks. Works on both Firefox and Chrome!

## Get it now!

- **Firefox**: https://addons.mozilla.org/firefox/addon/scdl
- **Chrome**: Coming soon to Chrome Web Store

## Features

- ✅ Download any SoundCloud track in mp3 format (128kbps, one at a time)
- ✅ Adds normalized metadata (artwork, artist, title, genre, year, description & source url)
- ✅ Normalized file name
- ✅ Works with private tracks
- ✅ Supports both `progressive` and `hls` transcoding formats
- ✅ Lightweight (~20 Ko)
- ✅ No data sent to third party, everything is done client-side, in your browser
- ✅ No need to be premium or even logged in to download tracks!

If you encounter any issues or bugs, please report them on the [GitHub Issues page](https://github.com/nyo/scdl/issues)!

## Preview

![download button on track page preview image](assets/preview-0.png)
![download button in album tracklist view preview image](assets/preview-1.png)
![download button in search view preview image](assets/preview-2.png)
![id3 tags metadata preview image](assets/preview-3.png)

## Development

### Building

To build both Firefox add-on and Chrome extension:

```bash
bash build.sh
```

This will create: `scdl-{version}.zip`

## External libraries

- [browser-id3-writer](https://github.com/egoroof/browser-id3-writer) for mp3s tagging
- [FileSaver.js](https://github.com/eligrey/FileSaver.js) for saving files client-side

_Happy digging!_
