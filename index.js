// Json Configs {NOT IN GIT FOLDER. SEE README FOR SKELETONS OF FILES}
import dbDeets from './configs/database.json' with {type: 'json'};
import authBot from './configs/auth_bot.json' with {type: 'json'};
import scopes from './configs/scopes.json' with {type: 'json'};
// nodejs imports
import express from 'express';
import esess from 'express-session';
import mysql from 'mysql';
import got from 'got';
import { Server as SocketIOServer } from 'socket.io';
import fs from 'fs';
import http from 'node:http';
import https from 'node:https';
import EventSubWebSocket from './websocket/barrycarlyon.js';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Global variables
let BotAuth = null;
let logged_in_users = [];
let logged_in_sockets = [];
// Database connection and status tracking
let db_connection = mysql.createConnection(dbDeets);
const dbStatus = {
    connection: 'connecting',
    sanityCheck: 'not run',
    lastChecked: null
};
let reconnectTimer;
// Function to run a sanity check on the database connection
function runSanityCheck() {
    return new Promise((resolve, reject) => {
        let rand1 = Math.floor(Math.random() * 2600);
        let rand2 = Math.floor(Math.random() * 1337);
        let qStr = `SELECT ${rand1} + ${rand2} AS solution`;
        db_connection.query(qStr, function (error, results) {
            dbStatus.lastChecked = new Date().toISOString();
            if (error) {
                dbStatus.sanityCheck = 'failed';
                reject(error);
                return;
            }
            console.log(`[Database] Sanity Check: ${rand1} + ${rand2} Result:`, results[0].solution);
            dbStatus.sanityCheck = 'passed';
            resolve(true);
        });
    });
}
// Check the database connection and run a sanity check
function checkDatabase() {
    runSanityCheck().catch((error) => {
        console.error('[Database] Sanity check failed:', error.code || error.message);
    });
}
// Schedule a reconnect attempt if the database connection is lost
function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        dbStatus.connection = 'connecting';
        db_connection.connect(function(err) {
            if (err) {
                dbStatus.connection = 'disconnected';
                console.error('[Database] Reconnection failed:', err.code || err.message);
                scheduleReconnect();
                return;
            }
            dbStatus.connection = 'connected';
            checkDatabase();
        });
    }, 1000);
}

function GetAuth(twitchid){
    return new Promise((resolve, reject)=>{
        const selectQuery = `SELECT * FROM twitch WHERE twitchid = '${twitchid}' LIMIT 1`;
        db_connection.query(selectQuery, function (error, results) {
            if (error) {
                reject(error);
                return;
            }
            const exists = results.length > 0;
            if (exists) {
                resolve(JSON.parse(results[0].Auth));
            } else {
                resolve(null);
            }
        });
    });
}

// Function to store authentication data in the database
function StoreAuth(twitchid, auth){
    return new Promise((resolve, reject)=>{
        const prepData = JSON.stringify(auth);
        if (!twitchid || !prepData) {
            resolve(true);
            return;
        }
        const selectQuery = `SELECT * FROM twitch WHERE twitchid = '${twitchid}' LIMIT 1`;
        db_connection.query(selectQuery, function (error, results) {
            if (error) {
                reject(error);
                return;
            }
            const exists = results.length > 0;
            if (exists) {
                const updateQuery = `UPDATE twitch SET Auth = ? WHERE twitchid = ?`;
                db_connection.query(updateQuery, [prepData, twitchid], function (saveError) {
                    if (saveError) {
                        reject(saveError);
                        return;
                    }
                    resolve(true);
                });
            } else {
                const insertQuery = `INSERT INTO twitch (twitchid, Auth) VALUES ('${twitchid}', '${prepData}')`;
                db_connection.query(insertQuery, function (saveError) {
                    if (saveError) {
                        reject(saveError);
                        return;
                    }
                    resolve(true);
                });
            }
        });
    });
}

// Retrieve the state for an existing Twitch account
function GetAccountState(twitchid){
    return new Promise((resolve, reject)=>{
        const selectQuery = 'SELECT twitchid, State FROM twitch WHERE twitchid = ? LIMIT 1';
        db_connection.query(selectQuery, [twitchid], function (error, results) {
            if (error) {
                reject(error);
                return;
            }
            if (results.length > 0) {
                // console.log(results[0])
                resolve(results[0]);
            } else {
                reject(new Error(`No Twitch account found for ID ${twitchid}.`));
            }
        });
    });
}

// Update the state for a Twitch account
function UpdateAccountState(twitchid, state){
    return new Promise((resolve, reject)=>{
        const updateQuery = 'UPDATE twitch SET State = ? WHERE twitchid = ?';
        db_connection.query(updateQuery, [state, twitchid], function (saveError) {
            if (saveError) {
                reject(saveError);
                return;
            }
            resolve(true);
        });
    });
}

function ResetAccountStates(state){
    return new Promise((resolve, reject)=>{
        const updateQuery = 'UPDATE twitch SET State = ?';
        db_connection.query(updateQuery, [state], function (saveError) {
            if (saveError) {
                reject(saveError);
                return;
            }
            resolve(true);
        });
    });
}

// Function to retrieve the list of authenticated Twitch accounts from the database
function authlist(){
    return new Promise((resolve, reject)=>{
        const selectQuery = `SELECT * FROM twitch`;
        db_connection.query(selectQuery, function (error, results) {
            if (error) {
                reject(error);
                return;
            }
            const exists = results.length > 0;
            if (exists) {
                resolve(results);
            } else {
                resolve(null);
            }
        });
    });
}

// Validate and refresh token if needed
async function ValidateToken(account) {    
    let auth = JSON.parse(account.Auth);
    if (!logged_in_users[account.twitchid]) {
        return false;
    }
    try {
        const tokenStatus = await got.get('https://id.twitch.tv/oauth2/validate', {
            headers: {
                Authorization: 'OAuth ' + auth.access_token
            }
        }).json();

        if (tokenStatus.expires_in <= 3600) {
            const refreshedToken = await got.post('https://id.twitch.tv/oauth2/token', {
                headers: {
                    Accept: 'application/json'
                },
                form: {
                    client_id: authBot.client_id,
                    client_secret: authBot.client_secret,
                    grant_type: 'refresh_token',
                    refresh_token: auth.refresh_token
                }
            }).json();
            await StoreAuth(account.twitchid, refreshedToken);
            await SayInChat(account.twitchid, `Auth Refreshed! New Expiration: ${refreshedToken.expires_in} seconds`);
        }
        else{
            console.log(`[AuthToken] Auth Valid for ${account.twitchid}! Expiration: ${tokenStatus.expires_in} seconds`);
        }
        return true;
    } catch (error) {
        console.log('[AuthToken] Validation or refresh failed:', error.response?.body || error.message);
        return false;
    }
}

async function SayInChat(ownerTwitchId, chatMessage) {
    try {
        if (!authBot.twitchid) {
            throw new Error('auth_bot.json must include the bot Twitch user ID.');
        }

        const botUserAuth = await GetAuth(authBot.twitchid);
        if (!botUserAuth?.access_token) {
            throw new Error(`No user access token is stored for bot Twitch ID ${authBot.twitchid}.`);
        }

        const tokenValidation = await got.get('https://id.twitch.tv/oauth2/validate', {
            headers: {
                Authorization: `OAuth ${botUserAuth.access_token}`
            }
        }).json();

        if (tokenValidation.client_id !== authBot.client_id) {
            throw new Error('The stored bot token was authorized for a different Twitch application.');
        }
        if (String(tokenValidation.user_id) !== String(authBot.twitchid)) {
            throw new Error('The stored bot token belongs to a different Twitch user.');
        }

        const requiredScopes = ['user:write:chat', 'user:bot'];
        const grantedScopes = new Set(tokenValidation.scopes || []);
        const missingScopes = requiredScopes.filter(scope => !grantedScopes.has(scope));
        if (missingScopes.length > 0) {
            throw new Error(`The bot user must authorize these scopes: ${missingScopes.join(', ')}.`);
        }

        const response = await got.post('https://api.twitch.tv/helix/chat/messages', {
            headers: {
                'Client-ID': authBot.client_id,
                Authorization: `Bearer ${botUserAuth.access_token}`
            },
            json: {
                broadcaster_id: ownerTwitchId,
                sender_id: tokenValidation.user_id,
                message: chatMessage
            }
        }).json();
        return response.data;
    } catch (error) {
        console.error('Error body:', error.response?.body || error.message);
        throw error;
    }
}

async function fetchStreamById(ownerId, ownerToken, uId) {
    const response = await got.get('https://api.twitch.tv/helix/channels', {
        headers: {
            'Client-ID': ownerId,
            Authorization: 'Bearer ' + ownerToken
        },
        searchParams: {
            broadcaster_id: uId
        }
    }).json();
    return response.data[0];
}

async function SubscribeToTopic(session_id, type, version, condition, ownerId, ownerToken) {
    try {
        const response = await got.post('https://api.twitch.tv/helix/eventsub/subscriptions', {
            headers: {
                'Client-ID': ownerId,
                Authorization: 'Bearer ' + ownerToken
            },
            json: {
                type,
                version,
                condition,
                transport: {
                    method: 'websocket',
                    session_id
                }
            }
        }).json();
        const subscriptions = response.data;
        // console.log(subscriptions[0].type, subscriptions[0].status);
        return subscriptions;
    } catch (error) {
        console.error('Error body:', error.response?.body || error.message);
        throw error;
    }
}
// DATABASE CONNECTION
db_connection.connect(function(err) {
    if (err) {
        dbStatus.connection = 'disconnected';
        console.error('[Database] Connection failed:', err.code || err.message);
        scheduleReconnect();
        return;
    }
    dbStatus.connection = 'connected';
    checkDatabase();
});

db_connection.on('error', function(err) {
    dbStatus.connection = 'disconnected';
    console.error('[Database] Connection error:', err.code || err.message);
    db_connection.end();
    scheduleReconnect();
});

// EXPRESS SERVER SETUP

const app = express();
const asession = esess({
    secret: randomBytes(4).toString('base64'),
    resave: true,
    saveUninitialized: false,
    cookie: {
        secure: 'auto',
        maxAge: (30 * 60 * 1000)
    },
    rolling: true
});
const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const excuses = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'public', 'excuses.json'), 'utf8'));
if (!Array.isArray(excuses) || excuses.length === 0 || excuses.some(excuse => typeof excuse !== 'string')) {
    throw new Error('public/excuses.json must contain a non-empty array of strings.');
}

app.set('view engine', 'pug');
app.set('views', path.join(projectDirectory, 'views'));
app.use(express.static(path.join(projectDirectory, 'public')));
app.use(express.urlencoded({ extended: false }));   
app.use(asession);
app.use(function(req,res,next) {
    var flash = {
        error:      (req.session.error ? req.session.error : false),
        warning:    (req.session.warning ? req.session.warning : false),
        success:    (req.session.success ? req.session.success : false)
    }
    res.locals.flash = flash;

    if (req.session.error) { req.session.error = ''; }
    if (req.session.warning) { req.session.warning = ''; }
    if (req.session.success) { req.session.success = ''; }

    next();
});

// APP ROUTES

app.get('/', (req, res) => {
    res.render('index', {
        dbStatus,
        masterAuthIsNull: BotAuth === null
    });
});

// BOFH stuff
app.get('/bofh', (req, res) => {
    const excuse = excuses[Math.floor(Math.random() * excuses.length)];
    res.render('bofh', { excuse });
});

app.get('/bofhinchat', (req, res) => {
    if (req.session.token) {
        got.get('https://id.twitch.tv/oauth2/validate', {
            headers: {
                Authorization: 'OAuth ' + req.session.token.access_token
            }
        }).json()
        .then(async token => {
            //
            const excuse = excuses[Math.floor(Math.random() * excuses.length)];
            await SayInChat(token.user_id, `The reason for the downtime is: [ ${excuse} ]`);
            //
            res.redirect('/kiwisbot/');
        })
        .catch(err => {
            console.error('Error body:', err.response?.body || err.message);
            req.session.error = 'An Error occured: ' + (err.response?.body?.message || 'Unknown');
            res.redirect('/kiwisbot/');
        });

        return
    }
});

// token generator
app.get('/generator', (req, res) => {
    res.render('generator', {
        flash: {},
        scopes,
        client_id: authBot.client_id,
        redirect_uri: authBot.redirect_uri,
        state: randomBytes(16).toString('hex')
    });
});

app.get('/startbot', (req, res) => {   
    if (req.session.token) {
        got.get('https://id.twitch.tv/oauth2/validate', {
            headers: {
                Authorization: 'OAuth ' + req.session.token.access_token
            }
        }).json()
        .then(async token => {
            //
            req.session.config.state = 0;
            await UpdateAccountState(token.user_id, req.session.config.state);            
            await SayInChat(token.user_id, `Bot Started! Thanks for using Kiwisbot!`);
          
            if (!logged_in_sockets[token.user_id]) {
                logged_in_sockets[token.user_id] = {};
                logged_in_sockets[token.user_id].socket = new EventSubWebSocket();
                logged_in_sockets[token.user_id].socket.on('connected', async ({ sessionId, handover }) => {
                    if (!handover) {
                        console.log(`[EventSub] Connected to Twitch for ID ${token.user_id} with session ${sessionId}`);
                        const broadcasterId = token.user_id;
                        const availableScopes = new Set(req.session.token.scope || []);
                        const requiredSubscriptions = [
                            { type: 'user.update', version: '1', condition: { user_id: broadcasterId }, requiredScopes: ['user:read:email'] },
                            { type: 'stream.online', version: '1', condition: { broadcaster_user_id: broadcasterId }, requiredScopes: [] },
                            { type: 'stream.offline', version: '1', condition: { broadcaster_user_id: broadcasterId }, requiredScopes: [] },
                            { type: 'channel.update', version: '2', condition: { broadcaster_user_id: broadcasterId }, requiredScopes: ['user:read:broadcast'] },
                            { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId }, requiredScopes: ['moderator:read:followers'] },
                            { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: broadcasterId }, requiredScopes: [] },
                            { type: 'channel.bits.use', version: '1', condition: { broadcaster_user_id: broadcasterId }, requiredScopes: ['bits:read'] },
                            { type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: broadcasterId, user_id: broadcasterId }, requiredScopes: ['user:read:chat'] },
                            { type: 'channel.chat.notification', version: '1', condition: { broadcaster_user_id: broadcasterId, user_id: broadcasterId }, requiredScopes: ['user:read:chat'] },
                            { type: 'channel.channel_points_automatic_reward_redemption.add', version: '2', condition: { broadcaster_user_id: broadcasterId }, requiredScopes: ['channel:read:redemptions', 'channel:manage:redemptions'], requireAnyScope: true },
                            { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: { broadcaster_user_id: broadcasterId }, requiredScopes: ['channel:read:redemptions', 'channel:manage:redemptions'], requireAnyScope: true },
                            { type: 'channel.subscribe', version: '1', condition: { broadcaster_user_id: broadcasterId }, requiredScopes: ['channel:read:subscriptions'] },
                            { type: 'channel.subscription.gift', version: '1', condition: { broadcaster_user_id: broadcasterId }, requiredScopes: ['channel:read:subscriptions'] },
                            { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: broadcasterId }, requiredScopes: ['channel:read:subscriptions'] }
                        ];

                        const subscriptionResults = await Promise.allSettled(requiredSubscriptions.map(async subscription => {
                            const hasRequiredScope = subscription.requireAnyScope
                                ? subscription.requiredScopes.some(scope => availableScopes.has(scope))
                                : subscription.requiredScopes.every(scope => availableScopes.has(scope));
                            if (!hasRequiredScope) {
                                const requirement = subscription.requireAnyScope
                                    ? `one of: ${subscription.requiredScopes.join(', ')}`
                                    : subscription.requiredScopes.join(', ');
                                console.warn(`[EventSub] Skipping ${subscription.type} for Twitch ID ${broadcasterId}: token is missing ${requirement}.`);
                                return;
                            }
                            await SubscribeToTopic(
                                sessionId,
                                subscription.type,
                                subscription.version,
                                subscription.condition,
                                authBot.client_id,
                                req.session.token.access_token
                            );
                        }));

                        for (const result of subscriptionResults) {
                            if (result.status === 'rejected') {
                                console.error(`[EventSub] Subscription request failed for Twitch ID ${broadcasterId}:`, result.reason.response?.body || result.reason.message);
                            }
                        }
                    }
                });
                logged_in_sockets[token.user_id].socket.on('disconnected', ({ code, reason, sessionId }) => {
                    console.error(`[EventSub] Twitch ID ${token.user_id} disconnected (code ${code}, session ${sessionId || 'not established'}): ${reason || 'no reason provided'}`);
                });
                logged_in_sockets[token.user_id].socket.on('socket_error', error => {
                    console.error(`[EventSub] WebSocket error for Twitch ID ${token.user_id}:`, error.message);
                });
                logged_in_sockets[token.user_id].socket.on('websocket_disconnect', ({ payload }) => {
                    console.error(`[EventSub] Twitch requested disconnect for ID ${token.user_id}:`, payload);
                });
                logged_in_sockets[token.user_id].socket.on('keepalive_timeout', ({ sessionId, timeoutSeconds }) => {
                    console.error(`[EventSub] No notification or keepalive received for ${timeoutSeconds} seconds for Twitch ID ${token.user_id}, session ${sessionId || 'unknown'}; reconnecting.`);
                });
                logged_in_sockets[token.user_id].socket.on('revocation', ({ payload }) => {
                    console.error('EventSub subscription revoked:', payload.subscription);
                });
                
                // MAIN LISTENED EVENTS
                logged_in_sockets[token.user_id].socket.on('channel.update', async function({ payload }){
                    await SayInChat(payload.event.broadcaster_user_id, `Updated: Category[ ${payload.event.category_name} ] Title[ ${payload.event.title} ]`)
                    await SayInChat(authBot.twitchid, `Updated: Category[ ${payload.event.category_name} ] Title[ ${payload.event.title} ]`)

                });
                logged_in_sockets[token.user_id].socket.on('stream.online', async function({ payload }){
                    await SayInChat(payload.event.broadcaster_user_id, `Stream is Online ]`)
                    await SayInChat(authBot.twitchid, `${broadcaster.user_name}'s Stream is Online ]`)
                    // socket.emit('Twitch', ['stream.online', payload])
                });
                logged_in_sockets[token.user_id].socket.on('stream.offline', async function({ payload }){
                    await SayInChat(payload.event.broadcaster_user_id, `Stream is Offline ]`)
                    await SayInChat(authBot.twitchid, `${broadcaster.user_name}'s Stream is Offline ]`)
                });
                logged_in_sockets[token.user_id].socket.on('user.update', function({ payload }){
                    console.log('user.update', payload)
                    // socket.emit('Twitch', ['user.update', payload])
                });
                logged_in_sockets[token.user_id].socket.on('channel.follow', function({ payload }){
                    console.log('channel.follow', payload.event.user_name)
                    // socket.emit('Twitch', ['channel.follow', payload])
                    // Kiwisbot.SayInChat(cess_token, Oner.id, OwnerBot.bot.id, `Thanks for the Follow: ${payload.event.user_name}! miketh101Heart Please do not chew on the furniture.  miketh101Heart`)
                });
                logged_in_sockets[token.user_id].socket.on('channel.raid', async function({ payload }){
                    console.log('channel.raid',payload.event.from_broadcaster_user_name, payload.event.viewers)
                    // socket.emit('Twitch', ['channel.raid', payload])
                    // let shoutthresh = Number(payload.event.viewers)
                    // if (shoutthresh>5) {
                    //     Kiwisbot.ShoutoutUser(Creds.auth.client_id, Creds.tokens.access_token, OwnerBot.owner.id, payload.event.from_broadcaster_user_id)
                    //     Kiwisbot.SayInChat(cess_token, Oner.id, OwnerBot.bot.id, `Thanks for the Raid: ${payload.event.from_broadcaster_user_name}! miketh101Heart What did your <${payload.event.viewers}> Viewers do to deserve this?!`)
                    // }
                    // else {
                    //     Kiwisbot.SayInChat(cess_token, Oner.id, OwnerBot.bot.id, `Thanks for the Raid: ${payload.event.from_broadcaster_user_name}! miketh101Heart What did your <${payload.event.viewers}> Viewers do to deserve this?!`)
                    // }        
                });
                logged_in_sockets[token.user_id].socket.on('channel.chat.notification', function({ payload }){
                    console.log('channel.chat.notification',payload)
                    // socket.emit('Twitch', ['channel.chat.notification', payload])
                    console.log(`${payload.event.notice_type} || ${payload.event.system_message} ||`)
                });
                logged_in_sockets[token.user_id].socket.on('channel.bits.use', function({ payload }){
                    console.log('channel.bits.use',payload)
                    // socket.emit('Twitch', ['channel.bits.use', payload])
                });
                logged_in_sockets[token.user_id].socket.on('channel.chat.message', function({ payload }){
                    // socket.emit('Twitch', ['channel.chat.message', payload])
                    let currentDT = new Date();
                    if (payload.event.reply != null){
                        console.log(currentDT, `reply to <${payload.event.reply.parent_user_name}>`)
                    }                    
                    emitSocketEvent('Twitch', ['channel.chat.message', payload])
                    console.log(currentDT, `<${payload.event.chatter_user_name}>`, payload.event.message.text)
                });    
                logged_in_sockets[token.user_id].socket.on('channel.channel_points_custom_reward_redemption.add', async function({ payload }){
                       let reward = payload.event.reward
                        let redeemer = {
                            display_name: payload.event.user_name,
                            login: payload.event.user_login,
                            id: payload.event.user_id,
                            user_input: payload.event.user_input
                        }
                        // let tUser = await Kiwisbot.fetchUserByName(Creds.auth.client_id, Creds.tokens.access_token, redeemer.login)
                        let rewardData = {redeemer: redeemer, reward: reward}
                        switch(rewardData.reward.title){ // this handles random file calls for overlay media.
                            case 'LookMa':
                                if (reward.cost === 1) {
                                    emitSocketEvent('Twitch', ['channel.channel_points_custom_reward_redemption.add', payload])
                                    // iterate thru logged_in_users and say this in chat for each user that has the bot running
                                    for (let userId in logged_in_users) {
                                        if (userId === payload.event.broadcaster_user_id){
                                            await SayInChat(userId, `Look Ma! ${redeemer.display_name} is going to be a Dragon!`);
                                        } else {
                                            await SayInChat(userId, `Look Ma! ${redeemer.display_name} is going to be a Dragon in ${payload.event.broadcaster_user_name}'s chat!`);
                                        }
                                    }
                                    break;
                                }
                            case 'bofh':
                                const excuse = excuses[Math.floor(Math.random() * excuses.length)];
                                // console.log(payload.event.broadcaster_user_id)
                                emitSocketEvent('Twitch', ['channel.channel_points_custom_reward_redemption.add', payload, excuse])
                                await SayInChat(payload.event.broadcaster_user_id, `Ok Look, ${redeemer.display_name}, the reason is ${excuse}. Don't blame me! I'm just a bot.`);
                                break;
                            case 'BunnySays':
                                let files = fs.readdirSync('public/sounds/bunny/');
                                let rFile = Math.floor(Math.random() * files.length);
                                let fileSTR = `${files[rFile]}`;    
                                console.log('BunnySays', fileSTR)                       
                                emitSocketEvent('Twitch', ['channel.channel_points_custom_reward_redemption.add', payload, fileSTR])
                            break;
                            case 'Loud':
                                let filesh = fs.readdirSync('public/sounds/honk/');
                                let rFileh = Math.floor(Math.random() * filesh.length);
                                let fileSTRh = `${filesh[rFileh]}`;
                                console.log('Loud', fileSTRh)
                                emitSocketEvent('Twitch', ['channel.channel_points_custom_reward_redemption.add', payload, fileSTRh])
                            break;
                            case 'Honk':
                                console.log('Honk', 'honk.mp3')
                                emitSocketEvent('Twitch', ['channel.channel_points_custom_reward_redemption.add', payload, 'honk.mp3'])
                            break;
                            case 'YouWereKicked':
                                console.log('TSKicked', 'YouWhereKickedFromTheServer.mp3')
                                emitSocketEvent('Twitch', ['channel.channel_points_custom_reward_redemption.add', payload, 'YouWhereKickedFromTheServer.mp3'])
                            break;
                            case 'Gong':
                                console.log('Gong', 'gong.mp3')
                                emitSocketEvent('Twitch', ['channel.channel_points_custom_reward_redemption.add', payload, 'gong.mp3'])
                            break;
                            default:
                                emitSocketEvent('Twitch', ['channel.channel_points_custom_reward_redemption.add', payload])
                    }
                    console.log('channel.channel_points_custom_reward_redemption.add', payload)
                });
                logged_in_sockets[token.user_id].socket.on('channel.channel_points_automatic_reward_redemption.add', function({ payload }){
                    console.log(`<${payload.event.reward.type}> Cost:(${payload.event.reward.channel_points})`, payload.event.user_name)
                });

                //
                logged_in_sockets[token.user_id].socket.connect();
            }
            //
            res.redirect('/kiwisbot/');
        })
        .catch(err => {
            console.error('Error body:', err.response?.body || err.message);
            req.session.error = 'An Error occured: ' + (err.response?.body?.message || 'Unknown');
            res.redirect('/kiwisbot/');
        });

        return
    }
});

app.get('/stopbot', (req, res) => {   
    if (req.session.token) {
        got.get('https://id.twitch.tv/oauth2/validate', {
            headers: {
                Authorization: 'OAuth ' + req.session.token.access_token
            }
        }).json()
        .then(async token => {
            //
            console.log(`[Bot] Stopping bot for Twitch ID ${token.user_id}`);
                            req.session.config.state = -1;
                            await UpdateAccountState(token.user_id, req.session.config.state);
                            // // clean up the socket for this user if it exists
                            const socket = logged_in_sockets[token.user_id]?.socket;
                            if (socket) {
                                socket.close();
                                delete logged_in_sockets[token.user_id];
                            }
                            await SayInChat(token.user_id, `Bot Stopped. Thanks for using Kiwisbot!`);
                            // //
                            res.redirect('/kiwisbot/');
        })
        .catch(err => {
            console.error('Error body:', err.response?.body || err.message);
            req.session.error = 'An Error occured: ' + (err.response?.body?.message || 'Unknown');
            res.redirect('/kiwisbot/');
        });

        return
    }
});

app.route('/kiwisbot/').get((req, res) => {
    if (req.session.token) {
        got.get('https://id.twitch.tv/oauth2/validate', {
            headers: {
                Authorization: 'OAuth ' + req.session.token.access_token
            }
        }).json()
        .then(async token => {

            req.session.config = await GetAccountState(token.user_id);
            // console.log(req.session.config.State)
            req.session.channel = await fetchStreamById(authBot.client_id, req.session.token.access_token, token.user_id);

            if (BotAuth!=null){
                res.render(
                    'loggedin',
                    {
                        user: req.session.user,
                        token: req.session.token,
                        config: req.session.config.State,
                        channel: req.session.channel
                    }
                );
            }
            else{
                res.render(
                    'redirect',
                    {
                        user: req.session.user,
                        excuse: excuses[Math.floor(Math.random() * excuses.length)]
                    }
                );
            }
            await StoreAuth(token.user_id, req.session.token);
            logged_in_users[token.user_id] = token;
            if (String(token.user_id) === String(authBot.twitchid)) {
                BotAuth = token;
            }
        })
        .catch(err => {
            console.error('Error body:', err.response?.body || err.message);
            req.session.error = 'An Error occured: ' + (err.response?.body?.message || 'Unknown');
            res.redirect('/kiwisbot/');
        });

        return
    }
    let { code, error, error_description, scope, state } = req.query;
    if (code) {
        state = decodeURIComponent(state);
        if (req.session.state != state) {
            req.session.error = 'State does not match. Please try again!';
            res.redirect('/kiwisbot/');
            return;
        }
        delete req.session.state;
        got.post('https://id.twitch.tv/oauth2/token', {
            headers: {
                Accept: 'application/json'
            },
            form: {
                client_id: authBot.client_id,
                client_secret: authBot.client_secret,
                code,
                grant_type: 'authorization_code',
                redirect_uri: authBot.redirect_uri
            }
        }).json()
        .then(async token => {
            req.session.token = token;
            await StoreAuth(token.user_id, req.session.token);
            return got.get('https://api.twitch.tv/helix/users', {
                headers: {
                    Accept: 'application/json',
                    'Client-ID': authBot.client_id,
                    Authorization: 'Bearer ' + req.session.token.access_token
                }
            }).json()
        })
        .then(profile => {
            if (profile && profile.data && profile.data[0]) {
                req.session.user = profile.data[0];
            } else {
                req.session.warning = 'We got a Token but failed to get your Twitch profile from Helix';
            }
            res.redirect('/kiwisbot/');
        })
        .catch(err => {
            console.error('Error body:', err.response?.body || err.message);
            req.session.error = 'An Error occured: ' + (err.response?.body?.message || 'Unknown');
            res.redirect('/kiwisbot/');
        });

        return;
    }
    var auth_error = '';
    if ( error ) {
        auth_error = 'oAuth Error ' + error_description;
    }
    req.session.state = randomBytes(16).toString('base64');
    res.render('generator', {
        client_id: authBot.client_id,
        redirect_uri: authBot.redirect_uri,
        auth_error,
        scopes: JSON.parse(fs.readFileSync(path.join(projectDirectory, '.', 'configs/scopes.json'))),
        state: req.session.state
    });
})
.post((req, res) => {
    res.redirect('/kiwisbot/');
});

app.post('/check', (req, res) => {
    if (dbStatus.connection !== 'connected') {
        return res.redirect(303, '/');
    }

    dbStatus.sanityCheck = 'checking';
    runSanityCheck()
        .catch((error) => {
            console.error('[Database] Sanity check failed:', error.code || error.message);
        })
        .finally(() => res.redirect(303, '/'));
});

app.get('/health', (req, res) => {
    const healthy = dbStatus.connection === 'connected';
    res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' : 'unavailable',
        database: dbStatus.connection,
        sanityCheck: dbStatus.sanityCheck,
        masterAuth: true,
        lastChecked: dbStatus.lastChecked
    });
});



// Start the server
const httpsKeyPath = process.env.HTTPS_KEY_PATH || path.join(projectDirectory, 'certs', 'localhost-key.pem');
const httpsCertPath = process.env.HTTPS_CERT_PATH || path.join(projectDirectory, 'certs', 'localhost-cert.pem');
const httpsPort = Number(process.env.HTTPS_PORT || 8081);
const socketPort = Number(process.env.SOCKET_PORT || 8082);

if (!fs.existsSync(httpsKeyPath) || !fs.existsSync(httpsCertPath)) {
    throw new Error(`HTTPS requires both a certificate and private key. Checked "${httpsKeyPath}" and "${httpsCertPath}".`);
}
// Reset bot state for all users on server start 
await ResetAccountStates(-1);
const server = https.createServer({
    key: fs.readFileSync(httpsKeyPath),
    cert: fs.readFileSync(httpsCertPath)
}, app);
const secureIo = new SocketIOServer(server);
const socketHttpServer = http.createServer();
const socketIoOptions = {};
if (process.env.SOCKET_ORIGIN) {
    socketIoOptions.cors = {
        origin: process.env.SOCKET_ORIGIN.split(',').map(origin => origin.trim())
    };
}
const io = new SocketIOServer(socketHttpServer, socketIoOptions);
const socketServers = [secureIo, io];
function emitSocketEvent(event, data) {
    for (const socketServer of socketServers) {
        socketServer.emit(event, data);
    }
}
for (const socketServer of socketServers) {
    socketServer.on('connection', socket => {
        socket.name = socket.id;
        console.log(`[Socket.IO] Client connected: ${socket.id}`);
        socket.on('disconnect', () => {
            console.log('AUTHSOCKET', `${socket.name} disconnected`);
        });
    });
}

socketHttpServer.listen(socketPort, () => {
    console.log(`[Socket.IO] HTTP server listening on port ${socketPort}`);
});
server.listen(httpsPort, async () => {
    console.log(`[Web] TwitchAuth dashboard listening on https://localhost:${httpsPort}`);
    setInterval(async () => {
        let accounts = await authlist();
        if (!accounts) {
            console.log('[AuthToken] No accounts found in database to validate.');
            return;
        }
        for (let account of accounts) {
            try {
                await ValidateToken(account);
            } catch (error) {
                console.error('[AuthToken] Error validating token for Twitch ID:', account.twitchid, error.message);
            }
        }
    }, 1000 * 60); // Update every 10 seconds
});