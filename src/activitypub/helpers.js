'use strict';

const request = require('request-promise-native');
const { generateKeyPairSync } = require('crypto');
const winston = require('winston');
const nconf = require('nconf');
const validator = require('validator');

const db = require('../database');
const ttl = require('../cache/ttl');
const user = require('../user');

const webfingerCache = ttl({ ttl: 1000 * 60 * 60 * 24 }); // 24 hours

const Helpers = module.exports;

Helpers.query = async (id) => {
	const [username, hostname] = id.split('@');
	if (!username || !hostname) {
		return false;
	}

	if (webfingerCache.has(id)) {
		return webfingerCache.get(id);
	}

	// Make a webfinger query to retrieve routing information
	const response = await request(`https://${hostname}/.well-known/webfinger?resource=acct:${id}`, {
		simple: false,
		resolveWithFullResponse: true,
		json: true,
	});

	if (response.statusCode !== 200 || !response.body.hasOwnProperty('links')) {
		return false;
	}

	// Parse links to find actor endpoint
	let actorUri = response.body.links.filter(link => link.type === 'application/activity+json' && link.rel === 'self');
	if (actorUri.length) {
		actorUri = actorUri.pop();
		({ href: actorUri } = actorUri);
	}

	const { publicKey } = response.body;

	webfingerCache.set(id, { username, hostname, actorUri, publicKey });
	return { username, hostname, actorUri, publicKey };
};

Helpers.generateKeys = async (uid) => {
	winston.verbose(`[activitypub] Generating RSA key-pair for uid ${uid}`);
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

	await db.setObject(`uid:${uid}:keys`, { publicKey, privateKey });
	return { publicKey, privateKey };
};

Helpers.resolveLocalUid = async (input) => {
	let slug;
	const protocols = ['https'];
	if (process.env.CI === 'true') {
		protocols.push('http');
	}
	console.log(input, nconf.get('url'), nconf.get('url_parsed'), protocols, validator.isURL(input, {
		require_protocol: true,
		require_host: true,
		require_tld: false,
		protocols,
		require_valid_protocol: true,
	}), nconf.get('ci'));

	if (validator.isURL(input, {
		require_protocol: true,
		require_host: true,
		require_tld: false,
		protocols,
		require_valid_protocol: true,
	})) {
		const { host, pathname } = new URL(input);

		if (host === nconf.get('url_parsed').host) {
			slug = pathname.replace(nconf.get('relative_path'), '').split('/').filter(Boolean)[1];
		} else {
			throw new Error('[[activitypub:invalid-id]]');
		}
	} else if (input.indexOf('@') !== -1) { // Webfinger
		([slug] = input.replace(/^acct:/, '').split('@'));
	} else {
		throw new Error('[[activitypub:invalid-id]]');
	}

	return await user.getUidByUserslug(slug);
};