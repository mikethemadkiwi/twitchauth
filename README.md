# twitchauth

Simple Twitch-to-database token refresh system.

## Web dashboard

The Express, Pug & Socket.IO service dashboard listens over HTTPS on port `8081`:

```sh
npm install
npm start
```

Copy `database.json`, `auth_bot.json`, and `scopes.json` from `examples/` into a
`configs/` directory.  
  
Replace the placeholders in `database.json` and
`auth_bot.json` with your MySQL and Twitch application settings, and register
the redirect URI with your Twitch application.  
  
The `scopes.json` file controls the scopes shown by the OAuth generator. The dashboard is available at
<https://localhost:8081>. It displays the MySQL connection and sanity-check status.  
  
Socket.IO remains available to the HTTPS dashboard and overlays on port `8081`.
It is also available over plain HTTP on port `8082` by default for systems that
cannot validate the HTTPS certificate.
  
## EventSub WebSocket client
  
`websocket/barrycarlyon.js` exports an `EventSubWebSocket` class for handling
Twitch EventSub WebSocket messages. It is based on code i once asked Barry for help with. God it's come a long way.

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
warning unless you explicitly trust it.