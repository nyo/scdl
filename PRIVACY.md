# Privacy Policy - SoundCloud Downloader

## Data Collection
This extension does not collect, store, or transmit any personal data.

## How it works
- The extension works entirely client-side
- No data is sent to external servers
- Downloads are performed directly from SoundCloud to the user's computer
- No tracking, analytics, or advertising is used

## Technical data
- The extension only accesses SoundCloud pages to add the download button
- Track metadata (title, artist, etc.) is retrieved only to create MP3 files
- No personal information is collected or stored

## Permissions
The extension requires the following permissions:
- `webRequest`: To intercept network requests to SoundCloud and retrieve audio file URLs
- `*://*.soundcloud.com/*`: To access SoundCloud pages for injecting download buttons and extracting track metadata
- `*://*.sndcdn.com/*`: To download audio files from SoundCloud's CDN servers

These permissions are used solely for the core functionality of downloading SoundCloud tracks and are not used for any data collection or tracking purposes.

## Contact
For any questions regarding this privacy policy, please open an issue on GitHub: https://github.com/nyo/scdl/issues
