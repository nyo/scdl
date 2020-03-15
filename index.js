window.BASE_URL = "https://api-v2.soundcloud.com";
window.CLIENT_ID = null;
window.ELEMENTS = [];
window.LAST_URL = "";
window.TRACKS_COUNTER = 0;

const watchNewTracks = setInterval(function() {
	/* check every second for new loaded tracks in the page */
	let nbShareButtons = document.querySelectorAll(".sc-button-share").length;
	if (nbShareButtons > 0 && nbShareButtons != window.TRACKS_COUNTER
		|| window.LAST_URL != document.URL) {
		insertButtons();
		window.TRACKS_COUNTER = nbShareButtons;
	}
	window.LAST_URL = document.URL;
}, 1000);

function logger(_level, _function, _details) {

	const logging = [
		{ "level": 0, "word": "UNKNOWN"	, "function": console.log	},
		{ "level": 1, "word": "TRACE"	, "function": console.log	},
		{ "level": 2, "word": "DEBUG"	, "function": () => {}		},
		{ "level": 3, "word": "INFO"	, "function": console.info	},
		{ "level": 4, "word": "WARN"	, "function": console.warn	},
		{ "level": 5, "word": "ERROR"	, "function": console.error	}
	];

	let lvl = (_level >= 1 && _level <= 5) ? _level : 0;

	if (typeof _function !== "string") _function = "_unknown_";
	if (typeof _details !== "string") _details = "_no_details_";

	let msg = `[SCDL] ${logging[lvl].word} | ${_function} | ${_details}`;
	logging[lvl].function(msg);

};

async function tagAndDownload(metadata, mp3ArrayBuffer, artworkArrayBuffer) {

	/* write id3 tags */
	const writer = new ID3Writer(mp3ArrayBuffer);
	writer
		.setFrame("TPE1", [metadata.artist])
		.setFrame("TIT2", metadata.title)
		.setFrame("TYER", metadata.year)
		.setFrame("TCON", [metadata.genre])
		.setFrame("COMM", {
			"description": "Track URL",
			"text": metadata.comment
		})
		.setFrame("APIC", {
			"type": 3,
			"data": artworkArrayBuffer,
			"description": "Track artwork"
	});
	writer.addTag();

	/* save file as... */
	const blob = writer.getBlob();
	const filename = `${metadata.artist.toLowerCase()} - ${metadata.title.toLowerCase()}.mp3`;
	saveAs(blob, filename);
	writer.revokeURL(); // memory control

};

async function resolveTrack(track_url) {

	const url = `${window.BASE_URL}/resolve?url=${track_url}&client_id=${window.CLIENT_ID}`;
	logger(3, "resolveTrack", `Downloading "${url}" ...`);

	try {

		/* get track data (informations, artwork, stream url) */
		const track_metadata = await fetch(url);
		const { user, title, created_at, genre,
			permalink_url, artwork_url, media } = await track_metadata.json();

		const transcoding_metadata = media.transcodings.find((transcoding) => transcoding.format.protocol === "progressive");
		if (!transcoding_metadata) throw "cannot download this track (invalid transcoding)";

		const metadata = {
			"artist": user.username,
			"title": title,
			"year": created_at.split("-")[0], // get only year from date
			"genre": genre,
			"comment": permalink_url,
			"artwork_url": (artwork_url || user.avatar_url).replace(/large/ig, "t500x500"),
			"stream_url": `${transcoding_metadata.url}?client_id=${window.CLIENT_ID}`
		};
		logger(2, "resolveTrack", JSON.stringify(metadata, null, 4));

		/* get mp3 (128kbps) direct url */
		const mp3_data = await fetch(metadata.stream_url);
		const { url: mp3_url } = await mp3_data.json();
		logger(2, "resolveTrack", JSON.stringify(mp3_url, null, 4));

		/* download mp3 & store it in a buffer */
		const mp3 = await fetch(mp3_url);
		const mp3ArrayBuffer = await mp3.arrayBuffer();

		/* download artwork & store it in a buffer */
		const artwork = await fetch(metadata.artwork_url);
		const artworkArrayBuffer = await artwork.arrayBuffer();

		tagAndDownload(metadata, mp3ArrayBuffer, artworkArrayBuffer);

	} catch (error) {

		logger(5, "resolveTrack", error.message ? error.message : error);

	}

}

function isLinkElem(className) {
	return className.indexOf("playableTile__mainHeading") !== -1
		|| className.indexOf("soundTitle__title") !== -1
		|| className.indexOf("trackItem__trackTitle") !== -1;
}

function getTrackURI(element) {

	try {

		let node = element.closest(".streamContext")
			|| element.closest(".chartTrack")
			|| element.closest(".trackItem");

		let track_url;
		if (node) {
			let links = node.querySelectorAll("a");
			let len = 0;
			let best_link;
			/* look for longest link */
			for (let i = 0; i < links.length; i++) {
				if (links[i].href && links[i].href.length > len
					&& isLinkElem(links[i].className)
					&& links[i].href.indexOf("/stream") === -1
					&& links[i].href.indexOf("/comments") === -1) {
						len = links[i].href.length;
						best_link = links[i];
				}
			}
			track_url = best_link.href.split("?")[0];
			if (track_url.indexOf("soundcloud.com") === -1) {
				track_url = "https://soundcloud.com" + track_url;
			}
		} else {
			track_url = document.URL;
		}

		logger(2, "getTrackURI", `track_url: ${track_url}`);
		resolveTrack(track_url);

	} catch (error) {

		logger(5, "getTrackURI", error.message);

	}

};

function insertButtons() {

	logger(2, "insertButtons", "! INSERTING NEW BUTTONS !");

	/* check if the button should be medium depending on the page */
	const url = document.URL.split("/");
	const reserved_strings = ["tracks", "sets", "albums", "reposts", "toptracks", "popular-tracks"];
	const should_be_medium = url[4] && url[4].length > 0
		&& !reserved_strings.includes(url[4]) ? true : false;

	/* create the html element */
	const downloadButton = document.createElement("a");
	const buttonText = document.createTextNode("Download");
	downloadButton.appendChild(buttonText);
	downloadButton.title = "Download";
	downloadButton.className = `sc-button-download sc-button sc-button-${should_be_medium ? "medium" : "small"} sc-button-responsive`;

	try {

		const elems = document.getElementsByTagName("*");
		for (e in elems) {
			/* get all parent nodes */
			if (elems[e] && typeof elems[e].className === "string" && elems[e].className.indexOf("sc-button-group") > -1) {
				/* check for duplicates (prevents multiple buttons) */
				if (window.ELEMENTS.includes(elems[e].parentNode)) continue;
				/* clone and append a download button */
				let kiddies = Array.from(elems[e].childNodes);
				kiddies = kiddies.filter((k) => k.className);
				/* don't insert download button on elements with <4 classNames
				   it means it is a recommended song on the side */
				if (kiddies.length < 4) continue;
				let downloadButtonClone = downloadButton.cloneNode(true);
				downloadButtonClone.addEventListener("click", function () {
					getTrackURI(this);
				}, true);
				elems[e].appendChild(downloadButtonClone);
				window.ELEMENTS.push(elems[e].parentNode);
			}
		}

	} catch (error) {

		logger(5, "insertButtons", error.message);

	}

	// console.debug(window.ELEMENTS);

}

async function getClientID() {

	const scripts = document.getElementsByTagName("script");
	const urls = Array.from(scripts).reduce((urls, url) => {
		if (url.src.match(/sndcdn.com\/assets\/[0-9][0-9]*/g))
			urls.push(url.src);
		return urls;
	}, []);

	try {

		/* get custom client_id for the user's session */
		for (const url in urls) {
			logger(2, "getClientID", `fetching: '${urls[url]}'`);
			let response = await fetch(urls[url]);
			let data = await response.text();
			window.CLIENT_ID = data.match(new RegExp(",client_id:\"(.*)\",env:\"production\""));
			if (window.CLIENT_ID) {
				window.CLIENT_ID = window.CLIENT_ID.filter(str => str.length === 32)[0];
				break;
			}
		}

		logger(2, "getClientID", `Got client_id: '${window.CLIENT_ID}'`);

		/* now that the id has been retrieved, insert download button(s) */
		insertButtons();

	} catch (error) {

		logger(5, "getClientID", error.message);

	}

};

getClientID();
