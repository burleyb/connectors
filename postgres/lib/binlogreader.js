const pg = require("pg");
const async = require("async");

const connect = require("./connect");
const test_decoding = require("./test_decoding");
const { through } = require("leo-streams");
const logger = require("leo-logger")("[binlogreader]");
const lsn = require('./lsn');
var backoff = require("backoff");

//I need to overwrite the pg connection listener to apply backpressure;
let Connection = pg.Connection;

let shutdown = false;
let shouldReport = false
let copyDataThrough;

function toObject(acc, field) {	acc[field.n] = field.v;	return acc;}

// Connection.prototype.attachListeners = function(stream) {
// 	var self = this;

// 	stream.on('data', function(buff) {
// 		self.sendCopyFromChunk(buff);

// 		let lastWriteGood = true;
// 		while (packet) {
// 			var msg = self.parseMessage(packet);
// 			// logger.log("========== msg =========", msg)
// 			if (self._emitMessage) {
// 				self.emit('message', msg);
// 			}
// 			if (msg.name == "copyData") {
// 				lastWriteGood = copyDataThrough.write(msg);
// 			} else {
// 				self.emit(msg.name, msg);
// 			}
// 			packet = self.read();
// 		}
// 		if (!lastWriteGood || shutdown) {
// 			logger.log("============================ pausing stream ============================")
// 			stream.pause();
// 			if (!shutdown) {
// 				copyDataThrough.once('drain', () => {
// 					stream.resume();
// 				});
// 			}
// 		}
// 	});
// 	stream.on('end', function() {
// 		self.emit('end');
// 	});
// };

module.exports = {
	stream: function(ID, config, opts) {
		opts = Object.assign({
			slot_name: 'leo_replication',
			keepalive: 1000 * 50,
			failAfter: 100,
			mergeNewOntoOld: false,
			recoverWal: false,
			event: 'logical_replication'
		}, opts || {});
		let lastLsn;
		let writeLsn;
		let requestedWalSegmentAlreadyRemoved = false;
		let walCheckpointHeartBeatTimeoutId = null;
		var retry = backoff.fibonacci({
			randomisationFactor: 0,
			initialDelay: 1000,
			maxDelay: 30000
		});
		logger.log("==== failAfter =====", opts.failAfter)
		retry.failAfter(parseInt(opts.failAfter));
		retry.on('backoff', function(number, delay) {
			logger.error(`(${config.database}) Going to try to connect again in ${delay} ms`);
		});
		retry.once('fail', (err) => {
			err.database = config.database;
			err.traceType = 'fail';
			logger.error(err);
			logger.log("================================== FAIL =============================================")
		});

		let count = 0;
		let replicationClient;

		let maxDate = null;
		var started = Date.now()

		copyDataThrough = through((msg, done) => {
			let currentLsn = lsn.fromWal(msg);
			const isOldMsg = lsn.compare(lastLsn, currentLsn) >= 0;
			if (isOldMsg) return done(null);
			
			if (currentLsn.upper == 0 && currentLsn.lower == 0) {
				return done(null);
			}
			if (msg.chunk[0] == 0x77) { // XLogData
				count++;
				if (count > opts.reportEvery) {
					logger.info("Processed(w/writeLsn):", count, currentLsn.string);
					count = 0;
					shouldReport = true
				}
				let log;
				try {
					log = test_decoding.parse(msg.chunk.slice(25).toString('utf8'));
					writeLsn = Object.assign({}, currentLsn);
				} catch (err) {
					logger.error("TEST_DECODING ERR", err);
					logger.error("PROBLEMATIC MESSAGE JSON", JSON.stringify(msg));
					logger.error("PROBLEMATIC MESSAGE", msg.chunk.slice(25).toString('utf8'));
					done(err);
				}

				if (log.time) {
					let d = new Date(log.time);
					maxDate = Math.max(d.valueOf(), maxDate);
				}

				log.lsn = currentLsn;
				if (log.d && log.d.reduce) {
					log.d = log.d.reduce(toObject, {});
				} else if (log.d && log.d.o && log.d.w){
					log.d.o = log.d.o.reduce(toObject, {});
					log.d.w = log.d.w.reduce(toObject, {});
					if (opts.mergeNewOntoOld) {
						log.d = Object.assign({}, log.d.o, log.d.w);
					} 
				}

				let c = {
					source: opts.inputSource || 'postgres',
					start: log.lsn.string
				};
				delete log.lsn;
				done(null, {
					id: ID,
					event: opts.event,
					payload: log,
					correlation_id: c,
					event_source_timestamp: maxDate,
					timestamp: Date.now()
				});
			} else if (msg.chunk[0] == 0x6b) { // Primary keepalive message
				var timestamp = Math.floor(msg.chunk.readUInt32BE(9) * 4294967.296 + msg.chunk.readUInt32BE(13) / 1000 + 946080000000);
				var shouldRespond = msg.chunk.readInt8(17);
				logger.debug("Got a keepalive message", {
					lsn: currentLsn,
					timestamp,
					shouldRespond
				});
				if (shouldReport || shouldRespond) {
					logger.debug('Should Respond. LastLsn: ' + lastLsn.string + ' Current lsn: ' + currentLsn.string + ' Writelsn:' + writeLsn.string);
					shouldReport = false
					walCheckpoint(replicationClient, lastLsn, writeLsn);
				}
				done(null);
			} else {
				logger.error(`(${config.database}) Unknown message`, msg.chunk[0]);
				done(null);
			}
		});


		retry.on('ready', function() {
			
			shutdown = false
			let wrapperClient = connect(config);
			replicationClient = new pg.Client(Object.assign({}, config, {
				replication: 'database'
			}));

			let dieError = function(err) {
				err.database = config.database;
				err.traceType = 'dieError';
				logger.error("dieError:" , err);
				clearTimeout(walCheckpointHeartBeatTimeoutId);
				if (replicationClient) {
					try {
						replicationClient.removeAllListeners();
						if (wrapperClient) {
							wrapperClient.end(err => {
								if (err) {
									return logger.error(`(${config.database}) wrapperClient.end ERROR:`, err);
								}
								logger.debug("wrapperClient.end");
								wrapperClient = null;
								replicationClient.end(err => {
									if (err) {
										return logger.error(`(${config.database}) replicationClient.end ERROR:`, err);
									}
									replicationClient = null;
									logger.debug("replicationClient.end");
									copyDataThrough.destroy(err);
									if(shutdown) {
										retry.reset()
									} else {
										retry.backoff(err);
									}
								});
							});
						}
					} catch (err) {
						logger.error(`(${config.database}) Error Closing Database Connections`, err);
					}
				}
			};
			replicationClient.on('error', dieError);
			replicationClient.connect(async function(err) {
				logger.info(`(${config.database}) Trying to connect.`);
				if (err) return dieError(err);
				if (opts.recoverWal && requestedWalSegmentAlreadyRemoved) {
					logger.info(`RECOVER FROM WAL SEGMENT ALREADY REMOVED. (removing slot ${opts.slot_name})`);
					const dropSlotPromise = new Promise((resolve, reject) => {
						wrapperClient.query(`SELECT pg_drop_replication_slot($1);`, [opts.slot_name], (err) => {
							if (err) return reject(err);
							resolve();
						});
					});
					try {
						await dropSlotPromise;
						logger.info(`SLOT ${opts.slot_name} REMOVED`);
					} catch (err) {
						dieError(err);
					}
				}
				
				wrapperClient.query(`SELECT * FROM pg_replication_slots where slot_name = $1`, [opts.slot_name], (err, result) => {
					logger.info(`(${config.database}) Trying to get replication slot ${opts.slot_name}.`);
					if (err) return dieError(err);
					let tasks = [];
					let restartLsn = '0/00000000';
					logger.debug(result);
					if (!result.length) {
						tasks.push(done => wrapperClient.query(`SELECT * FROM pg_create_logical_replication_slot($1, 'test_decoding')`, [opts.slot_name], err => {
							logger.info(`(${config.database}) Trying to create logical replication slot ${opts.slot_name}.`);
							if (err) return done(err);
							wrapperClient.query(`SELECT * FROM pg_replication_slots where slot_name = $1`, [opts.slot_name], (err, result) => {
								logger.info(`(${config.database}) Trying to get newly created replication slot ${opts.slot_name}. Result Len = ${result.length}`);
								if (err) return done(err);
								if (result.length != 1) return done(err);

								restartLsn = result[0].confirmed_flush_lsn || result[0].restart_lsn;
								done();
							});
						}));
					} else {
						// if(shutdown && result[0].active && result[0].active_pid) {
						// 	tasks.push(done => wrapperClient.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND pid = $1;`, [result[0].active_pid], (err) => {
						// 		logger.info(`(${config.database}) killing active connection that is using ${opts.slot_name}.`);
						// 		if (err) return done(err);
						// 		done('outoftime');
						// 	}))						
						// }
						restartLsn = result[0].confirmed_flush_lsn || result[0].restart_lsn;
					}
					async.series(tasks, (err) => {
						if (err) return dieError(err);
						logger.info(`START_REPLICATION SLOT ${opts.slot_name} LOGICAL ${restartLsn} ("include-timestamp" '1', "include-xids" '1', "skip-empty-xacts" '0')`);
						replicationClient.query(`START_REPLICATION SLOT ${opts.slot_name} LOGICAL ${restartLsn} ("include-timestamp" '1', "include-xids" '1', "skip-empty-xacts" '0')`, (err) => {
							if (err) {
								if (err.code === '58P01') requestedWalSegmentAlreadyRemoved = true;
								if (err.message === "Connection terminated by user") {
									logger.error("Logical replication ended with: ", err.message);
									return;
								}
								return dieError(err);
							}
						});
						logger.debug("WANTING TO RESTART AT ", restartLsn);
						lastLsn = lsn.fromString(restartLsn);
						writeLsn = lsn.fromString(restartLsn);
						replicationClient.connection.once('replicationStart', function() {
							logger.info(`Successfully listening for Changes on ${config.host}:${config.database}`);
							retry.reset();
							let walCheckpointHeartBeat = function() {
								if (walCheckpointHeartBeatTimeoutId) {
									clearTimeout(walCheckpointHeartBeatTimeoutId);
								}
								walCheckpoint(replicationClient, lastLsn, writeLsn);
								walCheckpointHeartBeatTimeoutId = setTimeout(walCheckpointHeartBeat, opts.keepalive);
								let elapsedTime = new Date() - started;
								logger.debug("======== Heartbeat ============ duration:", opts.duration, " elapsedTime:", elapsedTime );
								if(parseInt(opts.duration) <= parseInt(elapsedTime)) {
									logger.debug("======== outOfTime ============", elapsedTime);
									shutdown = true
									dieError('outoftime')
								}
							};
							walCheckpointHeartBeat();
							copyDataThrough.acknowledge = function(lsnAck) {
								logger.log("[acknowledge]", lsnAck)
								if (typeof lsnAck == "string") {
									lsnAck = lsn.fromString(lsnAck);
								}

								lsnAck = lsn.increment(lsnAck);
								
								lastLsn = Object.assign({}, lsnAck);
								writeLsn = Object.assign({}, lsnAck);
								walCheckpointHeartBeat();
							};

							replicationClient.connection.on('error', (err) => {
								if (err.message === "Connection terminated by user") return; //ignore this error
								dieError(err);
							});
						});
					});
				});
			});
		});
		retry.backoff();
		return copyDataThrough;
	}
};


function walCheckpoint(replicationClient, flushLsn, writeLsn) {
	// Timestamp as microseconds since midnight 2000-01-01
	var now = (Date.now() - 946080000000);
	var upperTimestamp = Math.floor(now / 4294967.296);
	var lowerTimestamp = Math.floor((now - upperTimestamp * 4294967.296));
	
	// Wal Checkpoint write/flush lsn:  { upper: 0, lower: 349944328, string: '0/14DBBA08' } { upper: 0, lower: 69670424, string: '0/4271618' }

	// if (writeLsn.lower === 4294967295) { // [0xff, 0xff, 0xff, 0xff]
	// 	writeLsn.upper = writeLsn.upper + 1;
	// 	writeLsn.lower = 0;
	// } else {
	// 	writeLsn.lower = writeLsn.lower + 1;
	// }


	var response = Buffer.alloc(34);
	response.fill(0x72); // 'r'

	// Last WAL Byte + 1 received and written to disk locally
	response.writeUInt32BE(writeLsn.upper, 1);
	response.writeUInt32BE(writeLsn.lower, 5);

	// Last WAL Byte + 1 flushed to disk in the standby
	response.writeUInt32BE(writeLsn.upper, 9);
	response.writeUInt32BE(writeLsn.lower, 13);

	// Last WAL Byte + 1 applied in the standby
	response.writeUInt32BE(writeLsn.upper, 17);
	response.writeUInt32BE(writeLsn.lower, 21);

	// Timestamp as microseconds since midnight 2000-01-01
	response.writeUInt32BE(upperTimestamp, 25);
	response.writeUInt32BE(lowerTimestamp, 29);

	// If 1, requests server to respond immediately - can be used to verify connectivity
	response.writeInt8(0, 33);

	logger.debug("Wal Checkpoint flushLsn: ", flushLsn, " writeLsn", writeLsn);

	replicationClient.connection.sendCopyFromChunk(response);
}

