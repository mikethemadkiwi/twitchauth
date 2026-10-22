# twitchauth

Simple Twitch-to-database token refresh system.

## Web dashboard

The Express + Pug service dashboard listens over HTTPS on port `8081`:

```sh
npm install
npm start
```

Copy `database.json`, `auth_bot.json`, and `scopes.json` from `examples/` into a
`configs/` directory. Replace the placeholders in `database.json` and
`auth_bot.json` with your MySQL and Twitch application settings, and register
the redirect URI with your Twitch application. The `scopes.json` file controls
the scopes shown by the OAuth generator. The dashboard is available at
<https://localhost:8081>. It displays
the MySQL connection and sanity-check status; use **Run database check** to
execute a fresh read-only check.

`GET /health` returns JSON health status and responds with HTTP `503` while the
database is disconnected.

Socket.IO remains available to the HTTPS dashboard and overlays on port `8081`.
It is also available over plain HTTP on port `8082` by default for systems that
cannot validate the HTTPS certificate. Connect to
`http://<server-host>:8082` using the `/socket.io/` path. Set `SOCKET_PORT` to
change the HTTP Socket.IO port. The HTTP connection is unencrypted; use it only
on a trusted network because event data can be observed by network intermediaries.
For browser clients hosted on another origin, set `SOCKET_ORIGIN` to a
comma-separated list of their origins (for example,
`https://overlay.example.com`). Non-browser clients do not need this setting.

## EventSub WebSocket client

`websocket/barrycarlyon.js` exports an `EventSubWebSocket` class for handling
Twitch EventSub WebSocket messages. It connects when `connect()` is called,
handles keepalive timeouts and reconnects, and emits `connected` with the
session ID. Subscribe to events on each new session.

### Self-signed certificate

Generate a self-signed localhost certificate from the repository root with
OpenSSL:

```sh
mkdir certs
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -keyout certs/localhost-key.pem -out certs/localhost-cert.pem -days 365 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

Then start the service and open <https://localhost:8081>. Both the certificate
and private key are required; the service exits with an error if either is
missing. Because the certificate is self-signed, browsers will show a trust
warning unless you explicitly trust it. The key and certificate are ignored by
Git. You can set `HTTPS_PORT`, `HTTPS_KEY_PATH`, and `HTTPS_CERT_PATH` to
override the defaults.
