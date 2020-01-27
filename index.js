window.BASE_URL = "https://api-v2.soundcloud.com";
window.CLIENT_ID = undefined;
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

const logger = (_level, _function, _details) => {

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

const tagAndDownload = async (metadata, mp3ArrayBuffer, artworkArrayBuffer) => {

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

const resolveTrack = async (track_url) => {

	const url = `${BASE_URL}/resolve?url=${track_url}&client_id=${CLIENT_ID}`;
	logger(3, "resolveTrack", `Downloading "${url}" ...`);

	try {

		/* get track data (informations, artwork, stream url) */
		const response1 = await fetch(url);
		const data1 = await response1.json();
		const metadata = {
			"artist": data1.user.username,
			"title": data1.title,
			"year": data1.created_at.split("-")[0], // get only year from date
			"genre": data1.genre,
			"comment": data1.permalink_url,
			"artwork_url": (data1.artwork_url || data1.user.avatar_url).replace(/large/ig, "t500x500"),
			"stream_url": `${data1.media.transcodings[1].url}?client_id=${CLIENT_ID}` // selects "progressive" format.protocol
		};
		logger(2, "resolveTrack", JSON.stringify(metadata, null, 4));

		/* get mp3 (128kbps) direct url */
		const response2 = await fetch(metadata.stream_url);
		const data2 = await response2.json();
		logger(2, "resolveTrack", JSON.stringify(data2, null, 4));

		/* download mp3 & store it in a buffer */
		const response3 = await fetch(data2.url);
		const mp3ArrayBuffer = await response3.arrayBuffer();

		/* download artwork & store it in a buffer */
		const response4 = await fetch(metadata.artwork_url);
		const artworkArrayBuffer = await response4.arrayBuffer();

		tagAndDownload(metadata, mp3ArrayBuffer, artworkArrayBuffer);

	} catch (error) {

		logger(5, "resolveTrack", error.message);

	}

}

const isLinkElem = (className) => {
	return className.indexOf("playableTile__mainHeading") !== -1
		|| className.indexOf("soundTitle__title") !== -1
		|| className.indexOf("trackItem__trackTitle") !== -1;
}

const getTrackURI = (element) => {

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

const insertButtons = () => {

	logger(2, "insertButtons", "! INSERTING NEW BUTTONS !");

	/* check if the button should be medium depending on the page */
	const url = document.URL.split("/");
	const reserved_strings = ["tracks", "sets", "albums", "reposts", "toptracks"];
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
				if (ELEMENTS.includes(elems[e].parentNode)) continue;
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
				ELEMENTS.push(elems[e].parentNode);
			}
		}

	} catch (error) {

		logger(5, "insertButtons", error.message);

	}

	// console.debug(ELEMENTS);

}

const getClientID = async () => {

	const scripts = document.getElementsByTagName("script");
	const url = Array.from(scripts).map(s => s.src).filter(s => s && s.match(/sndcdn.com\/assets\/50/g))[0];

	try {

		/* get custom client_id for the user's session */
		const response = await fetch(url);
		const data = await response.text();
		CLIENT_ID = data.match(new RegExp(",client_id:\"(.*)\",env:\"production\""));
		CLIENT_ID = CLIENT_ID.filter(str => str.length === 32)[0];
		logger(2, "getClientID", `Got client_id: '${CLIENT_ID}'`);

		/* now that the id has been retrieved, insert download button(s) */
		insertButtons();

	} catch (error) {

		logger(5, "getClientID", error.message);

	}

};

getClientID();
