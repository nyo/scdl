## SoundCloud Downloader

This Firefox Add-on adds a **download button** under SoundCloud tracks.

Here are the features:
- download any SoundCloud track in mp3 (128kbps) format
- the downloaded file contains metadata (artist, title, artwork, genre, year)
- no need to be premium or connected to SoundCloud to download tracks!
- no data sent to third party, everything is done locally

Inspired by [soundreactor/scdl](https://github.com/soundreactor/scdl) which doesn't work anymore for me & is no longer maintained.<br>
I updated it for SoundCloud api-v2, using the same tricks but redesigned the whole thing to make it more easy to maintain.<br>
It uses 2 libraries, [browser-id3-writer](https://github.com/egoroof/browser-id3-writer) and [FileSaver.js](https://github.com/eligrey/FileSaver.js).<br>

> The way the program look up for the track url & client_id is not perfect and could be subject to errors.
> While testing, I did not find any, but please open an issue or report it if you do!

**You can get the extension directly on Mozilla add-ons website!**<br>
https://addons.mozilla.org/en-US/firefox/addon/sdcl/
<br>
Happy digging!
