# SoundCloud Downloader

![Mozilla Add-on](https://img.shields.io/amo/stars/scdl)
![Mozilla Add-on](https://img.shields.io/amo/users/scdl)
![Mozilla Add-on](https://img.shields.io/amo/v/scdl)
![GitHub manifest version](https://img.shields.io/github/manifest-json/v/nyo/scdl/main)

Firefox add-on that adds a download button under SoundCloud tracks.

Nothing to sign up for, nothing sent to a third party. Works even logged out of SoundCloud.

![download button on track page preview image](screenshots/screenshot-0.png)

<details>
<summary><b>Screenshots</b> (playlists, search results, tags, preferences)</summary>

![download button in album tracklist view preview image](screenshots/screenshot-1.png)
![download button in search view preview image](screenshots/screenshot-2.png)
![id3 tags metadata preview image](screenshots/screenshot-3.png)
![options page preview image](screenshots/screenshot-4.png)

</details>

## Get it now!

https://addons.mozilla.org/firefox/addon/scdl

## Features

- ✅ Tagged mp3, artwork included
- ✅ A button on every track: track page, playlists, likes, search results
- ✅ Works on private tracks opened through their secret link
- ✅ Custom file name format (Preferences tab in `about:addons`)

<details>
<summary><b>ID3v2.3 frames</b> (metadata/tags)</summary>

| Frame  | Content                          |
| ------ | -------------------------------- |
| `TIT2` | title                            |
| `TPE1` | artist                           |
| `TCOM` | composer                         |
| `TCON` | genre                            |
| `TYER` | year                             |
| `COMM` | the track description            |
| `WOAS` | the track's SoundCloud url       |
| `APIC` | artwork at 500x500, when the track has one |
| `TXXX` | "Encoder": lamejs 1.2.1, from SoundCloud AAC, when the add-on converted the track |

</details>

## How it works

The file is built in your browser, straight from SoundCloud. Nothing goes through any other server.
The add-on only asks for access to `soundcloud.com` and `sndcdn.com` (SoundCloud's CDN), and for storage to keep your filename format.

No background process, ~85 KB.

SoundCloud now serves most tracks only as AAC. The add-on then decodes the AAC with your browser's own decoder and encodes it to mp3 with [lamejs](https://github.com/zhuker/lamejs); a box in the bottom right corner shows the progress.

Measured in Firefox on a MacBook Pro M5 Pro:

| Track length | Time |
| ------------ | ---- |
| 1 min        | 2 s  |
| 4 min        | 7 s  |
| 10 min       | 16 s |
| 30 min       | 48 s |
| 60 min       | 90 s |

## Known limits

- One track at a time: no bulk download of a playlist or album.
- Since May 2026, SoundCloud locks some tracks behind DRM: no extension can download those, and the add-on says so instead of saving a broken file.
- Since October 2026, SoundCloud no longer serves mp3 for most tracks and streams AAC at 160 kbps instead. The add-on encodes it to mp3 at 320 kbps to lose as little as possible in the second encoding.

If you encounter any issues, bugs, or have suggestions, please report them on the [GitHub Issues](https://github.com/nyo/scdl/issues) page!

## Development

### Building

To build the add-on locally, run:

```bash
bash build.sh # creates a `scdl-{version}.zip` file
```

### External libraries

- [browser-id3-writer](https://github.com/egoroof/browser-id3-writer) 4.4.0 (MIT) for mp3s tagging
- [FileSaver.js](https://github.com/eligrey/FileSaver.js) 2.0.4 (MIT) for saving files client-side
- [lamejs](https://github.com/zhuker/lamejs) 1.2.1 (LGPL-3.0), a JavaScript rewrite of [LAME](https://lame.sourceforge.io), for encoding mp3s
