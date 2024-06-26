'use strict';

const { generateKeyPairSync } = require('crypto');
const winston = require('winston');
const nconf = require('nconf');
const validator = require('validator');
const cheerio = require('cheerio');

const meta = require('../meta');
const posts = require('../posts');
const categories = require('../categories');
const request = require('../request');
const db = require('../database');
const ttl = require('../cache/ttl');
const user = require('../user');
const activitypub = require('.');

const webfingerRegex = /^(@|acct:)?\w+@.+$/;
const webfingerCache = ttl({ ttl: 1000 * 60 * 60 * 24 }); // 24 hours

const Helpers = module.exports;

Helpers.isUri = (value) => {
	if (typeof value !== 'string') {
		value = String(value);
	}

	return validator.isURL(value, {
		require_protocol: true,
		require_host: true,
		protocols: activitypub._constants.acceptedProtocols,
		require_valid_protocol: true,
		require_tld: false, // temporary — for localhost
	});
};

Helpers.isWebfinger = (value) => {
	// N.B. returns normalized handle, so truthy check!
	if (webfingerRegex.test(value) && !Helpers.isUri(value)) {
		if (value.startsWith('@')) {
			return value.slice(1);
		} else if (value.startsWith('acct:')) {
			return value.slice(5);
		}

		return value;
	}

	return false;
};

Helpers.query = async (id) => {
	const isUri = Helpers.isUri(id);
	// username@host ids use acct: URI schema
	const uri = isUri ? new URL(id) : new URL(`acct:${id}`);
	// JS doesn't parse anything other than protocol and pathname from acct: URIs, so we need to just split id manually
	const [username, hostname] = isUri ? [uri.pathname || uri.href, uri.host] : id.split('@');
	if (!username || !hostname) {
		return false;
	}

	if (webfingerCache.has(id)) {
		return webfingerCache.get(id);
	}

	const query = new URLSearchParams({ resource: uri });

	// Make a webfinger query to retrieve routing information
	let response;
	let body;
	try {
		({ response, body } = await request.get(`https://${hostname}/.well-known/webfinger?${query}`));
	} catch (e) {
		return false;
	}

	if (response.statusCode !== 200 || !body.hasOwnProperty('links')) {
		return false;
	}

	// Parse links to find actor endpoint
	let actorUri = body.links.filter(link => activitypub._constants.acceptableTypes.includes(link.type) && link.rel === 'self');
	if (actorUri.length) {
		actorUri = actorUri.pop();
		({ href: actorUri } = actorUri);
	}

	const { subject, publicKey } = body;
	const payload = { subject, username, hostname, actorUri, publicKey };

	const claimedId = new URL(subject).pathname;
	webfingerCache.set(claimedId, payload);
	if (claimedId !== id) {
		webfingerCache.set(id, payload);
	}

	return payload;
};

Helpers.generateKeys = async (type, id) => {
	winston.verbose(`[activitypub] Generating RSA key-pair for ${type} ${id}`);
	const {
		publicKey,
		privateKey,
	} = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: {
			type: 'spki',
			format: 'pem',
		},
		privateKeyEncoding: {
			type: 'pkcs8',
			format: 'pem',
		},
	});

	await db.setObject(`${type}:${id}:keys`, { publicKey, privateKey });
	return { publicKey, privateKey };
};

Helpers.resolveLocalId = async (input) => {
	if (Helpers.isUri(input)) {
		const { host, pathname, hash } = new URL(input);

		if (host === nconf.get('url_parsed').host) {
			const [prefix, value] = pathname.replace(nconf.get('relative_path'), '').split('/').filter(Boolean);

			let activityData = {};
			if (hash.startsWith('#activity')) {
				const [, activity, data] = hash.split('/', 3);
				activityData = { activity, data };
			}

			// https://bb.devnull.land/cid/2#activity/follow/activitypub@community.nodebb.org│
			switch (prefix) {
				case 'uid':
					return { type: 'user', id: value, ...activityData };

				case 'post':
					return { type: 'post', id: value, ...activityData };

				case 'cid':
				case 'category':
					return { type: 'category', id: value, ...activityData };

				case 'user': {
					const uid = await user.getUidByUserslug(value);
					return { type: 'user', id: uid, ...activityData };
				}
			}

			return { type: null, id: null, ...activityData };
		}

		return { type: null, id: null };
	} else if (String(input).indexOf('@') !== -1) { // Webfinger
		input = decodeURIComponent(input);
		const [slug] = input.replace(/^acct:/, '').split('@');
		const uid = await user.getUidByUserslug(slug);
		return { type: 'user', id: uid };
	}

	return { type: null, id: null };
};

Helpers.resolveActor = (type, id) => {
	switch (type) {
		case 'user':
		case 'uid': {
			return `${nconf.get('url')}${id > 0 ? `/uid/${id}` : '/actor'}`;
		}

		case 'category':
		case 'cid': {
			return `${nconf.get('url')}/category/${id}`;
		}

		default:
			throw new Error('[[error:activitypub.invalid-id]]');
	}
};

Helpers.resolveActivity = async (activity, data, id, resolved) => {
	switch (activity.toLowerCase()) {
		case 'follow': {
			const actor = await Helpers.resolveActor(resolved.type, resolved.id);
			const { actorUri: targetUri } = await Helpers.query(data);
			return {
				'@context': 'https://www.w3.org/ns/activitystreams',
				actor,
				id,
				type: 'Follow',
				object: targetUri,
			};
		}
		case 'announce':
		case 'create': {
			const object = await Helpers.resolveObjects(resolved.id);
			// local create activities are assumed to come from the user who created the underlying object
			const actor = object.attributedTo || object.actor;
			return {
				'@context': 'https://www.w3.org/ns/activitystreams',
				actor,
				id,
				type: 'Create',
				object,
			};
		}
		default: {
			throw new Error('[[error:activitypub.not-implemented]]');
		}
	}
};

Helpers.mapToLocalType = (type) => {
	if (type === 'Person') {
		return 'user';
	}
	if (type === 'Group') {
		return 'category';
	}
	if (type === 'Hashtag') {
		return 'tag';
	}
	if (activitypub._constants.acceptedPostTypes.includes(type)) {
		return 'post';
	}
};

Helpers.resolveObjects = async (ids) => {
	if (!Array.isArray(ids)) {
		ids = [ids];
	}
	const objects = await Promise.all(ids.map(async (id) => {
		// try to get a local ID first
		const { type, id: resolvedId, activity, data: activityData } = await Helpers.resolveLocalId(id);
		// activity data is only resolved for local IDs - so this will be false for remote posts
		if (activity) {
			return Helpers.resolveActivity(activity, activityData, id, { type, id: resolvedId });
		}
		switch (type) {
			case 'user': {
				if (!await user.exists(resolvedId)) {
					throw new Error('[[error:activitypub.invalid-id]]');
				}
				return activitypub.mocks.actors.user(resolvedId);
			}
			case 'post': {
				const post = (await posts.getPostSummaryByPids(
					[resolvedId],
					activitypub._constants.uid,
					{ stripTags: false }
				)).pop();
				if (!post) {
					throw new Error('[[error:activitypub.invalid-id]]');
				}
				return activitypub.mocks.note(post);
			}
			case 'category': {
				if (!await categories.exists(resolvedId)) {
					throw new Error('[[error:activitypub.invalid-id]]');
				}
				return activitypub.mocks.actors.category(resolvedId);
			}
			// if the type is not recognized, assume it's not a local ID and fetch the object from its origin
			default: {
				return activitypub.get('uid', 0, id);
			}
		}
	}));
	return objects.length === 1 ? objects[0] : objects;
};

Helpers.generateTitle = (html) => {
	// Given an html string, generates a more appropriate title if possible
	const $ = cheerio.load(html);
	let title;

	// Try the first paragraph element
	title = $('h1, h2, h3, h4, h5, h6, title, p, span').first().text();

	// Fall back to newline splitting (i.e. if no paragraph elements)
	title = title || html.split('\n').filter(Boolean).shift();

	// Split sentences and use only first one
	const sentences = title
		.split(/(\.|\?|!)\s/)
		.reduce((memo, cur, idx, sentences) => {
			if (idx % 2) {
				memo.push(`${sentences[idx - 1]}${cur}`);
			}

			return memo;
		}, []);

	if (sentences.length > 1) {
		title = sentences.shift();
	}

	// Truncate down if too long
	if (title.length > meta.config.maximumTitleLength) {
		title = `${title.slice(0, meta.config.maximumTitleLength - 3)}...`;
	}

	return title;
};
