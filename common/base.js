'use strict';

const dol = require('./dol');
const sqlNibbler = require('./sql/nibbler');
const snapshotter = require('./sql/snapshotter');

module.exports = class Connector {
	constructor(params) {
		this.params = Object.assign({
			connect: undefined,
			checksum: undefined,
			listener: undefined
		}, params);
	}

	connect(config) {
		if (!config) {
			throw new Error('Missing database connection credentials');
		} else if (typeof config.query !== "function") {
			config = this.params.connect(config);
		}

		return config;
	}

	nibble(config, table, id, opts) {
		return sqlNibbler(this.connect(config), table, id, opts);
	}

	checksum(config) {
		return this.params.checksum(this.connect(config));
	}

	streamChanges(config, opts = {}) {
		return this.params.listener(config, opts);
	}

	domainObjectBuilder(config) {
		return new dol(this.connect(config));
	}

	snapshotter(config) {
		return new snapshotter(this.connect(config));
	}
};
