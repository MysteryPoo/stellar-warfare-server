#!/usr/bin/env nodejs

const net = require('net');
const fs = require('fs');
const http = require('http');
const sockjs = require('sockjs');
const uuidV4 = require('uuid/v4');
const verbose = process.argv[2];
const port = process.argv[3];

const Packet = {
	Login: 0x01,
	KeepAlive: 0x02,
	StartMatch: 0x03,
	UpdateTime: 0x04,
	EndMatch: 0x05,
	JoinQueue: 0x06,
	LeaveQueue: 0x07,
	NewObject: 0x08,
	UpdateState: 0x09,
	InputAngle: 0x0A,
	InputThrottle: 0x0B,
	InputScan: 0x0C
}

if(verbose) {
	console.log('Verbose mode: ENABLED');
}

var Helpers = {
    GetRandom: function (low, high) {
        return Math.floor((Math.random() * (high - low)) + low);
	},
	ToRadians: function (angle) {
		return angle * (Math.PI / 180);
	},
	Clamp: function (value, low, high) {
		if(value < low) return low;
		else if(value > high) return high;
		else return value;
	}
};

var connection = function (socket) {
	this.socket = socket;
	this.account = '0';
	this.email = '0';
	this.token = '0';
	this.name = '0';
	this.created = null;
	this.lastAccessed = new Date();
	this.friends = [];
	this.currentMatch = null;
	this.loggedIn = false;
	this.load = function(account, callback) {
		console.log('Loading account: ' + account);
		if(account === '0') {	// New account
			this.account = uuidV4();
			this.created = new Date();
			this.save(callback);
			console.log('Created account: ' + this.account);
		} else {
			fs.readFile('accounts/' + account + '.account', (err, data) => {
				if(err && verbose) throw err;
				else if(err) {console.log(err); return;}
				var contents = JSON.parse(data);
				this.account = account;
				this.email = contents.email;
				this.token = contents.token;
				this.name = contents.name;
				this.created = new Date(contents.created);
				this.lastAccessed = new Date(contents.lastAccessed);
				contents.friends.forEach((e) => {
					this.friends.push(e);
				});
				if(this.currentMatch !== undefined) {
					// TODO Check if current match is still active and resync, if necessary.
				}
				if(verbose) console.log('Loaded account: ' + this.account);
				this.save(callback);
			});
		}
	};
	this.save = function (callback) {
		if(this.account !== '0') {
			callback(this);
			this.loggedIn = true;
			fs.writeFile('accounts/' + this.account + '.account', JSON.stringify({
				account: this.account,
				email: this.email,
				token: this.token,
				name: this.name,
				created: this.created.toString(),
				lastAccessed: (new Date()).toString(),
				friends: this.friends,
				currentMatch: this.currentMatch
			}), (err) => {
				if(err && verbose) throw err;
				else if(err) {console.log(err); return;}
				if(verbose) console.log('Account ' + this.account + ' was saved successfully.');
			});
		}
	};
};

var connectionController = new (function () {
	this.connections = {};
	this.add = function (socket) {
		this.connections[socket.id] = new connection(socket);
		if(verbose) console.log('New connection added');
	};
	this.remove = function (socket) {
		if(this.connections.hasOwnProperty(socket.id)) {
			if(verbose) {
				if(this.connections[socket.id].account !== '0') console.log('Removing connection associated with account: ' + this.connections[socket.id].account);
				else console.log('Removing connection');
			}
			// Remove from queue
			matchQueue.remove(socket);
			// Remove from active matches
			if(this.connections[socket.id].currentMatch !== null) {
				this.connections[socket.id].currentMatch.removeSocket(socket);
			}
			delete this.connections[socket.id];
		}
	};
	this.find = function (socket) {
		if(this.connections.hasOwnProperty(socket.id)) return this.connections[socket.id];
		else return -1;
	};
})();

function PriorityQueue() {
  this.data = [];
}

PriorityQueue.prototype.push = function(element, priority) {
  priority = +priority;
  for (var i = 0; i < this.data.length && this.data[i][1] > priority; i++);
  this.data.splice(i, 0, [element, priority]);
}

PriorityQueue.prototype.pop = function() {
  return this.data.shift()[0];
}

PriorityQueue.prototype.size = function() {
  return this.data.length;
}

PriorityQueue.prototype.indexOf = function (element) {
	for(var i = 0; i < this.data.length; ++i) {if(this.data[i][0].account === element.account) return i;}
	return -1;
};

function match(socketList) {
	this.layout = [];
	this.players = [];
	this.packetQueue = [];
	this.packetHistory = [];
	this.actionList = [];
	this.socketList = socketList;
	this.time = 10 * 60 + 5;
	this.ships = [];
	for(var i = 0; i < this.socketList.length; ++i) {
		this.ships.push({
			netID: i,
			x: 5000,//Helpers.GetRandom(100, 1900),
			y: 5000,//Helpers.GetRandom(100, 1900),
			angle: 0,
			movementTier: Helpers.GetRandom(1,3),
			movementCounter: 0,
			throttle: 100,
			agilityTier: Helpers.GetRandom(1,3),
			agilityCounter: 0,
			armorTier: Helpers.GetRandom(0,1),
			armorCounter: 0,
			shieldTier: Helpers.GetRandom(0,2),
			shieldCounter: 0,
			scannerTier: Helpers.GetRandom(1, 3),
			scannerCounter: 0,
			turretTier: Helpers.GetRandom(1,3),
			turretCounter: 0
		});
	}
	this.packetQueue.push({
		type: Packet.NewObject,
		ships: this.ships
	});
	this.active = true;
	this.UpdateMatch = setInterval(() => {
		for(var i = 0; i < this.ships.length; ++i) {
			this.ships[i].movementCounter += this.ships[i].movementTier;
			if(this.ships[i].movementCounter > 100) {
				this.ships[i].movementCounter -= 100;
				this.ships[i].x += (500 * this.ships[i].throttle / 100) * Math.cos(Helpers.ToRadians(this.ships[i].angle));
				this.ships[i].y -= (500 * this.ships[i].throttle / 100) * Math.sin(Helpers.ToRadians(this.ships[i].angle));
				this.ships[i].x = Helpers.Clamp(this.ships[i].x, 0, 10000);
				this.ships[i].y = Helpers.Clamp(this.ships[i].y, 0, 10000);
			}
			this.ships[i].agilityCounter = Helpers.Clamp(this.ships[i].agilityCounter + this.ships[i].agilityTier, 0, 100);
			this.ships[i].armorCounter = Helpers.Clamp(this.ships[i].agilityCounter + this.ships[i].armorTier, 0, 100);
			this.ships[i].shieldCounter = Helpers.Clamp(this.ships[i].shieldCounter + this.ships[i].shieldTier, 0, 100);
			this.ships[i].scannerCounter = Helpers.Clamp(this.ships[i].scannerCounter + this.ships[i].scannerTier, 0, 100);
			this.ships[i].turretCounter = Helpers.Clamp(this.ships[i].turretCounter + this.ships[i].turretTier, 0, 100);
		}
		this.packetQueue.push({
			type: Packet.UpdateState,
			ships: this.ships
		});
	}, 100);
	this.endMatch = function() {
		for(var i = 0; i < this.socketList.length; ++i) {
			connectionController.find(this.socketList[i]).currentMatch = null;
		}
		// Save match to disk
		var matchId = uuidV4();
		fs.writeFile('matches/' + matchId + '.match', JSON.stringify({
			packetHistory: this.packetHistory
		}), (err) => {
			if(err && verbose) throw err;
			else if(err) {console.log(err); return;}
			if(verbose) console.log('Match ' + matchId + ' was saved successfully.');
		});
		matchArray.remove(this);
	};
	this.removeSocket = function(socket) {
		var _index = connectionController.find(socket).currentMatch.socketList.indexOf(socket);
		//this.socketList[_index] = null;
		if(verbose) console.log("Removing " + connectionController.find(socket).account + " from the match...");
	};
	this.UpdateClients = setInterval(() => {
		if(this.packetQueue.length === 0) return;
		// Send packets
		for(var i = 0; i < this.packetQueue.length; ++i) {
			for(var j = 0; j < this.socketList.length; ++j) {
				if(this.socketList[j].readyState == 1) this.socketList[j].write(JSON.stringify(this.packetQueue[i]));
			}
			this.packetHistory.push(this.packetQueue[i]);
		}
		this.packetQueue = [];
		if(!this.active) this.endMatch();
	}, 100);
	this.Clock = setInterval(() => {
		// Timer
		var buffer = {
			type: Packet.UpdateTime,
			time: this.time
		}
		this.packetQueue.push(buffer);
		// End the match if no connections are present any longer
		var _activePlayers = 0;
		for(var i = 0; i < this.socketList.length; ++i) if(this.socketList[i].readyState == 1) _activePlayers += 1;
		if(this.socketList.length === 0 || _activePlayers === 0) this.endMatch();
		// End the match when the time runs out
		if(this.time === 0) {
			// End of Round
			var endMatch = {
				type: Packet.EndMatch
			}
			this.packetQueue.push(endMatch);
			this.active = false;
		} else this.time -= 1;
	}, 1000);
}

var matchArray = new (function () {
	this.data = [];
	this.add = function(match) {
		this.data.push(match);
		return match;
	};
	this.remove = function(match) {
		clearInterval(match.UpdateClients);
		clearInterval(match.Clock);
		var _index = this.data.indexOf(match);
		this.data.splice(_index, 1);
	};
	setInterval( () => {
		//if(verbose) console.log('Active matches: ' + this.data.length);
	}, 1000);
})();

var matchQueue = new (function () {
	this.queue = new PriorityQueue();
	this.waitTime = 0;
	this.triggerThreshold = 4;
	this.triggerThresholdMax = this.triggerThreshold;
	this.add = function (socket) {
		if(verbose) console.log("Account " + connectionController.find(socket).account + " joining the queue.");
		this.queue.push(socket, 1);
	};
	this.remove = function (socket) {
		var _index = this.queue.indexOf(socket);
		if(_index > -1) {
			if(verbose) console.log("Account " + connectionController.find(socket).account + " has left the queue.");
			this.queue.data.splice(_index, 1);
		}
	};
	setInterval(() => {
		//if(verbose) console.log('Total in queue: ' + this.queue.size());
		if(this.queue.size() >= this.triggerThreshold) {
			// Create a match
			if(verbose) console.log("Player threshold met in queue. Creating a match with " + this.triggerThreshold + " player(s).");
			var socketList = [];
			for(var i = 0; i < this.triggerThreshold; ++i) {socketList.push(this.queue.pop());}
			var matchId = matchArray.add(new match(socketList));
			// Start match packet to send to players
			var buffer = JSON.stringify({
				type: Packet.StartMatch
			});
			// Notify players that the match has been initiated
			for(var i = 0; i < socketList.length; ++i) {
				connectionController.find(socketList[i]).currentMatch = matchId;
				socketList[i].write(buffer);
			}
			// Reset threshold
			this.triggerThreshold = this.triggerThresholdMax;
			this.waitTime = 0;
		} else if(this.queue.size() > 0) {
			this.waitTime += 1;
		}
		if(this.waitTime >= 3) {
			this.waitTime = 0;
			if(this.triggerThreshold > 1) this.triggerThreshold -= 1;
		}
	}, 1000);
})();

const sockjs_opts = {sockjs_url: "http://cdn.jsdelivr.net/sockjs/1.0.1/sockjs.min.js"};
const sockjs_server = sockjs.createServer(sockjs_opts);
sockjs_server.on('connection', function(conn) {
	conn.id = uuidV4();
	connectionController.add(conn);
	conn.on('close', () => {
		connectionController.remove(conn);
	});
    conn.on('data', function(message) {
		var packet = JSON.parse(message);
		switch(packet.type) {
			case Packet.Login:
				if(connectionController.find(conn).loggedIn) break;
				if(verbose) console.log('Login requested...');
				var _account = packet.account;
				if(verbose) console.log('Account: ' + _account + ' has requested to log in.');
				connectionController.find(conn).load(_account, (a) => {
					var buffer = JSON.stringify({
						type: Packet.Login,
						account: a.account,
						lastAccessed: a.lastAccessed.toString()
					});
					conn.write(buffer);
					console.log('Notified client of account information...');
				});
				break;
			case Packet.JoinQueue:
				if(!connectionController.find(conn).loggedIn) break;
				if(connectionController.find(conn).currentMatch === null) matchQueue.add(conn);
				break;
			case Packet.LeaveQueue:
				if(!connectionController.find(conn).loggedIn) break;
				matchQueue.remove(conn);
				break;
			case Packet.KeepAlive:
				var buffer = {
					type: Packet.KeepAlive,
					netID: -1
				};
				if(connectionController.find(conn).currentMatch !== null) {
					var _index = connectionController.find(conn).currentMatch.socketList.indexOf(conn);
					buffer.netID = _index;
				}
				conn.write(JSON.stringify(buffer));
				break;
			case Packet.InputAngle:
				if(!connectionController.find(conn).loggedIn) break;
				var _index = connectionController.find(conn).currentMatch.socketList.indexOf(conn);
				connectionController.find(conn).currentMatch.ships[_index].angle = packet.angle;
				connectionController.find(conn).currentMatch.ships[_index].agilityCounter = 0;
				break;
			case Packet.InputScan:
				if(!connectionController.find(conn).loggedIn) break;
				var _index = connectionController.find(conn).currentMatch.socketList.indexOf(conn);
				connectionController.find(conn).currentMatch.ships[_index].scannerCounter = 0;
				break;
			/*case Packet.Move:
				if(!connectionController.find(conn).currentMatch) break;
				var _netID = connectionController.find(conn).currentMatch.socketList.indexOf(conn);
				var buffer = {
					type: packet.type,
					tick: packet.tick,
					entType: packet.entType,
					netID: _netID,
					entID: packet.entID,
					x: packet.x,
					y: packet.y,
					dir: packet.dir,
					speed: packet.speed
				};
				connectionController.find(conn).currentMatch.packetQueue.push(buffer);*/
				break;
		}
    });
});

const http_server = http.createServer();
http_server.addListener('request', function(req, res) {
	//static_directory.serve(req, res);
	res.end();
});
http_server.addListener('upgrade', function(req,res){
    res.end();
});

sockjs_server.installHandlers(http_server, {prefix:'/login'});

const http_port = port === undefined ? 1337 : port;
if(verbose)	console.log('Console: Server has started listening on port ' + http_port);
http_server.listen(http_port, '0.0.0.0');
/*
const options = {
	host: '0.0.0.0',
	port: port === undefined ? 1337 : port,
	exclusive: true
};

const server = net.createServer( (socket) => {
	socket.id = uuidV4();
	connectionController.add(socket);
	socket
	.on('close', () => {
		// Remove as active connection
		connectionController.remove(socket);
	})
	.on('error', (err) => {
		if(verbose) console.log(err);
	})
	.on('data', (data) => {
		var _index = 0;	// Current index of the packet buffer
		var _number = data.readUInt8(_index++); // Number of packets packaged together
		for(var p = 0; p < _number; ++p) { // For each packet
			var _type = data.readUInt8(_index++); // Packet type
			if(verbose) console.log('Console: message received: ' + _type.toString());
			switch(_type) {
				case Packet.Input:
					if(!connectionController.find(socket).loggedIn) {
						p = _number;
						break;
					}
					if(verbose) console.log('Buffer size: ' + data.length + '\nCurrent index: ' + _index);
					var _angle = data.readUInt16LE(_index); _index += 2;
					var _look = data.readUInt16LE(_index); _index += 2;
					var _speed = data.readUInt8(_index++);
					var _tick = data.readUInt32LE(_index); _index += 4;
					//var _netID = connectionController.find(socket).currentMatch.socketList.indexOf(socket);
					var _entID = data.readUInt8(_index++);
					var _x = data.readUInt16LE(_index); _index += 2;
					var _y = data.readUInt16LE(_index); _index += 2;
					var _entType = data.readUInt8(_index++);
					if(connectionController.find(socket).currentMatch) {
						var buffer = Buffer.allocUnsafe(17);
						buffer.writeUInt8(Packet.Input, 0);
						buffer.writeUInt16LE(_angle, 1);
						buffer.writeUInt16LE(_look, 3);
						buffer.writeUInt8(_speed, 5);
						buffer.writeUInt32LE(_tick, 6);
						buffer.writeUInt8(connectionController.find(socket).currentMatch.socketList.indexOf(socket), 10);
						buffer.writeUInt8(_entID, 11);
						buffer.writeUInt16LE(_x, 12);
						buffer.writeUInt16LE(_y, 14);
						buffer.writeUInt8(_entType, 16);
						connectionController.find(socket).currentMatch.packetQueue.push(buffer);
					} else {
						console.log('No match assigned to client...');
					}
					break;
				case Packet.Login: // Login
					if(connectionController.find(socket).loggedIn) {
						p = _number;
						break;
					}
					if(verbose) console.log('Login requested...');
					if(verbose) console.log('Buffer size: ' + data.length + '\nCurrent index: ' + _index);
					var _size = data.readUInt8(_index++);
					var _account = data.toString('utf8', _index, _index + _size);
					_index += _size + 1;
					if(verbose) console.log('Account: ' + _account + ' has requested to log in.');
					connectionController.find(socket).load(_account, (a) => {
						var buffer = Buffer.allocUnsafe(8 + a.account.length + a.lastAccessed.toString().length);
						buffer.writeUInt8(0x01, 0); // 1 message
						buffer.writeUInt8(Packet.Login, 1); // Login response
						buffer.writeUInt8(a.account.length, 2); // Account name length in bytes
						buffer.write(a.account, 3); // Account name string
						buffer.writeUInt8(a.lastAccessed.toString().length, 3 + a.account.length); // Length of date string
						buffer.write(a.lastAccessed.toString(), 4 + a.account.length); // Last accessed time
						socket.write(buffer);
						console.log('Notified client of account information...');
					});
					break;
				case Packet.KeepAlive:
					if(connectionController.find(socket).currentMatch !== null) {
						var _index = connectionController.find(socket).currentMatch.socketList.indexOf(socket);
						var buffer = Buffer.allocUnsafe(3);
						buffer.writeUInt8(0x01, 0);
						buffer.writeUInt8(Packet.KeepAlive, 1);
						buffer.writeUInt8(_index, 2);
						socket.write(buffer);
					}
					break;
				case Packet.JoinQueue:
					if(!connectionController.find(socket).loggedIn) {
						p = _number;
						break;
					}
					if(connectionController.find(socket).currentMatch === null) matchQueue.add(socket);
					break;
				case Packet.LeaveQueue:
					if(!connectionController.find(socket).loggedIn) {
						p = _number;
						break;
					}
					matchQueue.remove(socket);
					break;
				case Packet.Attack:
					if(!connectionController.find(socket).loggedIn) {
						p = _number;
						break;
					}
					var _entID = data.readUInt8(_index++);
					if(connectionController.find(socket).currentMatch) {
						var buffer = Buffer.allocUnsafe(3);
						buffer.writeUInt8(Packet.Attack, 0);
						buffer.writeUInt8(connectionController.find(socket).currentMatch.socketList.indexOf(socket), 1);
						buffer.writeUInt8(_entID, 2);
						connectionController.find(socket).currentMatch.packetQueue.push(buffer);
					} else {
						console.log('No match assigned to client...');
					}
					break;
				default:
					if(verbose) console.log('Unknown message type...');
			}
		}
	});
	
	// Pipe for now
	//socket.pipe(socket);
})
.listen(options, () => {
	if(verbose)	console.log('Console: Server has started listening on port ' + options.port);
});
*/
