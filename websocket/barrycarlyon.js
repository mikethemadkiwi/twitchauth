import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const DEFAULT_URL = 'wss://eventsub.wss.twitch.tv/ws';
const KEEPALIVE_GRACE_MS = 1000;

class EventSubWebSocket extends EventEmitter {
    constructor({
        url = DEFAULT_URL,
        WebSocketImpl = WebSocket,
        reconnectDelay = 1000,
        maxReconnectDelay = 30000
    } = {}) {
        super();

        if (typeof WebSocketImpl !== 'function') {
            throw new Error('A WebSocket implementation is required.');
        }

        this.url = url;
        this.WebSocketImpl = WebSocketImpl;
        this.reconnectDelay = reconnectDelay;
        this.maxReconnectDelay = maxReconnectDelay;
        this.socket = null;
        this.pendingSocket = null;
        this.sessionId = null;
        this.stopped = true;
        this.hasConnected = false;
        this.retryCount = 0;
        this.retryTimer = null;
        this.socketStates = new WeakMap();
    }

    connect(url = this.url) {
        if (!this.stopped || this.socket || this.pendingSocket) {
            return this;
        }

        this.url = url;
        this.stopped = false;
        this.retryCount = 0;

        try {
            this._openSocket(url, false);
        } catch (error) {
            this.stopped = true;
            throw error;
        }

        return this;
    }

    close() {
        this.stopped = true;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.sessionId = null;

        const sockets = new Set([this.socket, this.pendingSocket]);
        this.socket = null;
        this.pendingSocket = null;

        for (const socket of sockets) {
            if (socket && socket.readyState < 2) {
                const state = this.socketStates.get(socket);
                clearTimeout(state?.keepaliveTimer);
                clearTimeout(state?.stabilityTimer);
                this._closeSocket(socket, 1000, 'Client closed');
            }
        }
    }

    _closeSocket(socket, code, reason) {
        if (socket.readyState === 0) {
            socket.addEventListener('open', () => socket.close(code, reason), { once: true });
        } else if (socket.readyState === 1) {
            socket.close(code, reason);
        }
    }

    _openSocket(url, handover, previousSocket = null) {
        let socket;
        try {
            socket = new this.WebSocketImpl(url);
        } catch (error) {
            if (!this.hasConnected && !handover) {
                throw error;
            }
            this._reportError(error);
            this._scheduleReconnect();
            return;
        }

        const state = {
            handover,
            previousSocket,
            welcomed: false,
            keepaliveTimeout: 0,
            keepaliveTimer: null,
            stabilityTimer: null
        };
        this.socketStates.set(socket, state);

        if (handover) {
            this.pendingSocket = socket;
        } else {
            this.socket = socket;
        }

        socket.addEventListener('open', () => {
            this.emit('open', { url, handover });
        });
        socket.addEventListener('message', message => {
            this._handleMessage(socket, message).catch(error => this._reportError(error));
        });
        socket.addEventListener('error', event => {
            this._reportError(event.error || new Error('EventSub WebSocket connection error.'));
        });
        socket.addEventListener('close', event => {
            this._handleClose(socket, event);
        });
    }

    async _handleMessage(socket, message) {
        const rawData = typeof message.data === 'string'
            ? message.data
            : typeof message.data?.text === 'function'
                ? await message.data.text()
                : new TextDecoder().decode(message.data);
        const messageData = JSON.parse(rawData);
        const { metadata, payload } = messageData;

        if (!metadata?.message_type || !payload) {
            throw new Error('Received an invalid EventSub WebSocket message.');
        }

        this.emit('message', messageData);

        switch (metadata.message_type) {
            case 'session_welcome': {
                const session = payload.session;
                if (!session?.id || !Number.isFinite(session.keepalive_timeout_seconds)) {
                    throw new Error('Received an invalid EventSub welcome message.');
                }

                const state = this.socketStates.get(socket);
                state.welcomed = true;
                state.keepaliveTimeout = session.keepalive_timeout_seconds;
                this._resetKeepaliveTimer(socket);

                if (state.handover) {
                    const previousSocket = state.previousSocket;
                    this.socket = socket;
                    this.pendingSocket = null;
                    if (previousSocket && previousSocket.readyState < 2) {
                        this._closeSocket(previousSocket, 1000, 'EventSub session handover complete');
                    }
                }

                const resubscribeRequired = this.hasConnected && !state.handover;
                this.sessionId = session.id;
                this.hasConnected = true;
                clearTimeout(state.stabilityTimer);
                state.stabilityTimer = setTimeout(() => {
                    this.retryCount = 0;
                }, 60000);
                const connection = {
                    session,
                    sessionId: session.id,
                    resubscribeRequired,
                    handover: state.handover
                };
                this.emit('connected', connection);
                if (resubscribeRequired) {
                    this.emit('resubscribe_required', connection);
                }
                break;
            }
            case 'session_keepalive':
                this._resetKeepaliveTimer(socket);
                this.emit('keepalive', metadata);
                break;
            case 'notification': {
                this._resetKeepaliveTimer(socket);
                const notification = { metadata, payload };
                this.emit('notification', notification);
                const type = payload.subscription?.type;
                if (type) {
                    this.emit(type, notification);
                }
                break;
            }
            case 'session_reconnect': {
                const reconnectUrl = payload.session?.reconnect_url;
                if (typeof reconnectUrl !== 'string' || !reconnectUrl) {
                    throw new Error('EventSub requested a reconnect without a valid URL.');
                }
                if (!this.pendingSocket) {
                    this.emit('reconnecting', { reconnectUrl, sessionId: this.sessionId });
                    this._openSocket(reconnectUrl, true, socket);
                }
                break;
            }
            case 'websocket_disconnect':
                this.emit('websocket_disconnect', { metadata, payload });
                break;
            case 'revocation':
                this.emit('revocation', { metadata, payload });
                break;
            default:
                this.emit('unexpected', messageData);
                break;
        }
    }

    _resetKeepaliveTimer(socket) {
        const state = this.socketStates.get(socket);
        if (!state?.welcomed) {
            return;
        }

        clearTimeout(state.keepaliveTimer);
        state.keepaliveTimer = setTimeout(() => {
            this.emit('keepalive_timeout', {
                sessionId: this.sessionId,
                timeoutSeconds: state.keepaliveTimeout
            });
            if (socket.readyState < 2) {
                socket.close(4000, 'EventSub keepalive timeout');
            }
        }, (state.keepaliveTimeout * 1000) + KEEPALIVE_GRACE_MS);
    }

    _handleClose(socket, event) {
        const state = this.socketStates.get(socket);
        const sessionId = state?.welcomed ? this.sessionId : null;
        clearTimeout(state?.keepaliveTimer);
        clearTimeout(state?.stabilityTimer);

        if (this.pendingSocket === socket) {
            this.pendingSocket = null;
        }
        if (this.socket === socket) {
            this.socket = null;
            this.sessionId = null;
        }

        this.emit('disconnected', {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
            sessionId
        });

        if (!this.stopped && !this.socket && !this.pendingSocket) {
            this._scheduleReconnect();
        }
    }

    _scheduleReconnect() {
        if (this.stopped || this.retryTimer || this.socket || this.pendingSocket) {
            return;
        }

        const delay = Math.min(
            this.reconnectDelay * (2 ** this.retryCount),
            this.maxReconnectDelay
        );
        this.retryCount++;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.stopped || this.socket || this.pendingSocket) {
                return;
            }
            this._openSocket(this.url, false);
        }, delay);
    }

    _reportError(error) {
        this.emit('socket_error', error);
    }
}

export default EventSubWebSocket;
