'use strict';

/**
 * MiroTalk C2C - Server component
 *
 * @link    GitHub: https://github.com/miroslavpejic85/mirotalkc2c
 * @link    Live demo: https://c2c.mirotalk.com
 * @license For open source under AGPL-3.0
 * @license For private project or commercial purposes contact us at: license.mirotalk@gmail.com or purchase it directly via Code Canyon:
 * @license https://codecanyon.net/item/mirotalk-c2c-webrtc-real-time-cam-2-cam-video-conferences-and-screen-sharing/43383005
 * @author  Miroslav Pejic - miroslav.pejic.85@gmail.com
 * @version 1.1.01
 */

require('dotenv').config();

const { Server } = require('socket.io');
const http = require('http');
const https = require('https');
const compression = require('compression');
const express = require('express');
const cors = require('cors');
const checkXSS = require('./xss.js');
const path = require('path');
const ngrok = require('ngrok');
const app = express();
const logs = require('./logs');
const log = new logs('server');
const isHttps = process.env.HTTPS == 'true';
const port = process.env.PORT || 8080;
const ServerApi = require('./api');
const yamlJS = require('yamljs');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = yamlJS.load(path.join(__dirname + '/api/swagger.yaml'));
const bodyParser = require('body-parser');
const queryJoin = '/join?room=test&name=test';
const queryRoom = '/?room=test';
const packageJson = require('../package.json');

let server;
if (isHttps) {
    const fs = require('fs');
    const options = {
        key: fs.readFileSync(path.join(__dirname, 'ssl/key.pem'), 'utf-8'),
        cert: fs.readFileSync(path.join(__dirname, 'ssl/cert.pem'), 'utf-8'),
    };
    server = https.createServer(options, app);
} else {
    server = http.createServer(app);
}
const domain = process.env.HOST || 'localhost';

const host = `http${isHttps ? 's' : ''}://${domain}:${port}`;

const apiKeySecret = process.env.API_KEY_SECRET || 'mirotalkc2c_default_secret';
const apiBasePath = '/api/v1'; // api endpoint path
const apiDocs = host + apiBasePath + '/docs'; // api docs

const io = new Server({ maxHttpBufferSize: 1e7, transports: ['websocket'] }).listen(server);

const ngrokEnabled = getEnvBoolean(process.env.NGROK_ENABLED);
const ngrokAuthToken = process.env.NGROK_AUTH_TOKEN;

const iceServers = [];
const stunServerUrl = process.env.STUN_SERVER_URL;
const turnServerUrl = process.env.TURN_SERVER_URL;
const turnServerUsername = process.env.TURN_SERVER_USERNAME;
const turnServerCredential = process.env.TURN_SERVER_CREDENTIAL;
const stunServerEnabled = getEnvBoolean(process.env.STUN_SERVER_ENABLED);
const turnServerEnabled = getEnvBoolean(process.env.TURN_SERVER_ENABLED);
if (stunServerEnabled && stunServerUrl) iceServers.push({ urls: stunServerUrl });
if (turnServerEnabled && turnServerUrl && turnServerUsername && turnServerCredential) {
    iceServers.push({ urls: turnServerUrl, username: turnServerUsername, credential: turnServerCredential });
}

const surveyURL = process.env.SURVEY_URL || false;
const redirectURL = process.env.REDIRECT_URL || false;

const frontendDir = path.join(__dirname, '../', 'frontend');
const htmlClient = path.join(__dirname, '../', 'frontend/html/client.html');
const htmlHome = path.join(__dirname, '../', 'frontend/html/home.html');

const channels = {};
const sockets = {};
const peers = {};

app.use(cors());
app.use(compression());
app.use(express.static(frontendDir));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(apiBasePath + '/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument)); // api docs

// Logs requests
app.use((req, res, next) => {
    log.debug('New request:', {
        body: req.body,
        method: req.method,
        path: req.originalUrl,
    });
    next();
});

app.post('*', function (next) {
    next();
});

app.get('*', function (next) {
    next();
});

app.use((err, req, res, next) => {
    if (err instanceof SyntaxError || err.status === 400 || 'body' in err) {
        log.error('Request Error', {
            header: req.headers,
            body: req.body,
            error: err.message,
        });
        return res.status(400).send({ status: 404, message: err.message }); // Bad request
    }
    if (req.path.substr(-1) === '/' && req.path.length > 1) {
        let query = req.url.slice(req.path.length);
        res.redirect(301, req.path.slice(0, -1) + query);
    } else {
        next();
    }
});

app.get('/', (req, res) => {
    return res.sendFile(htmlHome);
});

app.get('/join/', (req, res) => {
    if (Object.keys(req.query).length > 0) {
        //http://localhost:3000/join?room=test&name=test
        log.debug('[' + req.headers.host + ']' + ' request query', req.query);
        const { room, name } = checkXSS('join', req.query);
        if (room && name) {
            return res.sendFile(htmlClient);
        }
        return notFound(res);
    }
    return notFound(res);
});

app.get('*', (req, res) => {
    return notFound(res);
});

// API request meeting room endpoint
app.post([`${apiBasePath}/meeting`], (req, res) => {
    const host = req.headers.host;
    const authorization = req.headers.authorization;
    const api = new ServerApi(host, authorization, apiKeySecret);
    if (!api.isAuthorized()) {
        log.debug('MiroTalk get meeting - Unauthorized', {
            header: req.headers,
            body: req.body,
        });
        return res.status(403).json({ error: 'Unauthorized!' });
    }
    const meetingURL = api.getMeetingURL();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ meeting: meetingURL }));
    log.debug('MiroTalk get meeting - Authorized', {
        header: req.headers,
        body: req.body,
        meeting: meetingURL,
    });
});

// API request join room endpoint
app.post([`${apiBasePath}/join`], (req, res) => {
    const host = req.headers.host;
    const authorization = req.headers.authorization;
    const api = new ServerApi(host, authorization, apiKeySecret);
    if (!api.isAuthorized()) {
        log.debug('MiroTalk get join - Unauthorized', {
            header: req.headers,
            body: req.body,
        });
        return res.status(403).json({ error: 'Unauthorized!' });
    }
    const joinURL = api.getJoinURL(req.body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ join: joinURL }));
    log.debug('MiroTalk get join - Authorized', {
        header: req.headers,
        body: req.body,
        join: joinURL,
    });
});

function notFound(res) {
    res.setHeader('Content-Type', 'application/json');
    res.send({ data: '404 not found' });
}

function getEnvBoolean(key, force_true_if_undefined = false) {
    if (key == undefined && force_true_if_undefined) return true;
    return key == 'true' ? true : false;
}

async function ngrokStart() {
    try {
        await ngrok.authtoken(ngrokAuthToken);
        await ngrok.connect(port);
        const api = ngrok.getApi();
        // const data = JSON.parse(await api.get('api/tunnels')); // v3
        const data = await api.listTunnels(); // v4
        const pu0 = data.tunnels[0].public_url;
        const pu1 = data.tunnels[1].public_url;
        const tunnelHttps = pu0.startsWith('https') ? pu0 : pu1;
        log.debug('settings', {
            ngrokAuthToken: ngrokAuthToken,
            iceServers: iceServers,
            ngrokHome: tunnelHttps,
            ngrokRoom: tunnelHttps + queryRoom,
            ngrokJoin: tunnelHttps + queryJoin,
            apiDocs: apiDocs,
            apiKeySecret: apiKeySecret,
            redirectURL: redirectURL,
            nodeVersion: process.versions.node,
            app_version: packageJson.version,
        });
    } catch (err) {
        log.warn('[Error] ngrokStart', err);
        process.exit(1);
    }
}

server.listen(port, null, () => {
    if (!isHttps && ngrokEnabled && ngrokAuthToken) {
        ngrokStart();
    } else {
        log.debug('settings', {
            iceServers: iceServers,
            home: host,
            room: host + queryRoom,
            join: host + queryJoin,
            apiDocs: apiDocs,
            apiKeySecret: apiKeySecret,
            redirectURL: redirectURL,
            surveyURL: surveyURL,
            nodeVersion: process.versions.node,
            app_version: packageJson.version,
        });
    }
});

io.on('error', (error) => {
    log.error('Socket.IO error:', error);
});

io.sockets.on('connect', (socket) => {
    log.debug('[' + socket.id + '] connection accepted');
    socket.channels = {};
    sockets[socket.id] = socket;

    socket.on('join', (cfg) => {
        const config = checkXSS(socket.id, cfg);

        log.debug('[' + socket.id + '] join ', config);

        const channel = config.channel;

        if (channel in socket.channels) {
            return log.debug('[' + socket.id + '] [Warning] already joined', channel);
        }
        if (!(channel in channels)) channels[channel] = {};
        if (!(channel in peers)) peers[channel] = {};

        peers[channel][socket.id] = config.peerInfo;

        const activeRooms = getActiveRooms();

        log.info('[Join] - active rooms and peers count', activeRooms);

        log.debug('[Join] - connected peers grp by roomId', peers);

        addPeerTo(channel);

        channels[channel][socket.id] = socket;
        socket.channels[channel] = channel;

        sendToPeer(socket.id, sockets, 'serverInfo', {
            roomPeersCount: Object.keys(peers[channel]).length,
            redirectURL: redirectURL,
            surveyURL: surveyURL,
        });
    });

    socket.on('relaySDP', (config) => {
        const { peerId, sessionDescription } = config;

        sendToPeer(peerId, sockets, 'sessionDescription', {
            peerId: socket.id,
            sessionDescription: sessionDescription,
        });
        log.debug('[' + socket.id + '] relay SessionDescription to [' + peerId + '] ', {
            type: sessionDescription.type,
        });
    });

    socket.on('relayICE', (config) => {
        const { peerId, iceCandidate } = config;

        sendToPeer(peerId, sockets, 'iceCandidate', {
            peerId: socket.id,
            iceCandidate: iceCandidate,
        });
    });

    socket.on('disconnect', (reason) => {
        for (let channel in socket.channels) {
            removePeerFrom(channel);
        }
        log.debug('[' + socket.id + '] disconnected', { reason: reason });
        delete sockets[socket.id];
    });

    socket.on('peerStatus', (cfg) => {
        const config = checkXSS(socket.id, cfg);

        const { roomId, peerName, element, active } = config;

        for (let peerId in peers[roomId]) {
            if (peers[roomId][peerId]['peerName'] == peerName) {
                switch (element) {
                    case 'video':
                        peers[roomId][peerId]['peerVideo'] = active;
                        break;
                    case 'audio':
                        peers[roomId][peerId]['peerAudio'] = active;
                        break;
                    case 'screen':
                        peers[roomId][peerId]['peerScreen'] = active;
                        break;
                }
            }
        }

        const data = {
            peerId: socket.id,
            peerName: peerName,
            element: element,
            active: active,
        };
        sendToRoom(roomId, socket.id, 'peerStatus', data);

        log.debug('[' + socket.id + '] emit peerStatus to [roomId: ' + roomId + ']', data);
    });

    async function addPeerTo(channel) {
        for (let id in channels[channel]) {
            await channels[channel][id].emit('addPeer', {
                peerId: socket.id,
                peers: peers[channel],
                shouldCreateOffer: false,
                iceServers: iceServers,
            });
            socket.emit('addPeer', {
                peerId: id,
                peers: peers[channel],
                shouldCreateOffer: true,
                iceServers: iceServers,
            });
            log.debug('[' + socket.id + '] emit addPeer [' + id + ']');
        }
    }

    async function removePeerFrom(channel) {
        if (!(channel in socket.channels)) {
            log.debug('[' + socket.id + '] [Warning] not in ', channel);
            return;
        }

        delete socket.channels[channel];
        delete channels[channel][socket.id];
        delete peers[channel][socket.id];

        if (Object.keys(peers[channel]).length == 0) {
            delete peers[channel];
        }

        const activeRooms = getActiveRooms();

        log.info('[RemovePeer] - active rooms and peers count', activeRooms);

        log.debug('[RemovePeer] - connected peers grp by roomId', peers);

        for (let id in channels[channel]) {
            await channels[channel][id].emit('removePeer', { peerId: socket.id });
            socket.emit('removePeer', { peerId: id });
            log.debug('[' + socket.id + '] emit removePeer [' + id + ']');
        }
    }

    async function sendToRoom(roomId, socketId, msg, config = {}) {
        for (let peerId in channels[roomId]) {
            if (peerId != socketId) {
                await channels[roomId][peerId].emit(msg, config);
            }
        }
    }

    async function sendToPeer(peerId, sockets, msg, config = {}) {
        if (peerId in sockets) {
            await sockets[peerId].emit(msg, config);
        }
    }

    function getActiveRooms() {
        const roomPeersArray = [];
        for (const roomId in peers) {
            if (peers.hasOwnProperty(roomId)) {
                const peersCount = Object.keys(peers[roomId]).length;
                roomPeersArray.push({
                    roomId: roomId,
                    peersCount: peersCount,
                });
            }
        }
        return roomPeersArray;
    }
});
