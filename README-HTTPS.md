# HTTPS-first setup for Microsoft authentication and Graph

This version starts HTTPS locally by default because Microsoft Entra ID authentication and Graph callback flows should use an HTTPS redirect URL.

## Local run

1. Copy `.env.example` to `.env`.
2. Keep:

```env
BASE_URL=https://localhost:3000
LOCAL_HTTPS=true
SSL_KEY_PATH=./certs/test.key
SSL_CERT_PATH=./certs/test.crt
```

3. In Azure / Microsoft Entra app registration, add this redirect URI:

```text
https://localhost:3000/auth/office365/callback
```

4. Run:

```bash
npm install
npm start
```

5. Open:

```text
https://localhost:3000
```

Your browser may warn because the bundled local certificate is self-signed. Continue only for local development.

## Railway / production

Do not make Node create its own HTTPS server in Railway. Railway terminates HTTPS and forwards traffic to Node over HTTP.

Use:

```env
NODE_ENV=production
PRODUCTION=true
BASE_URL=https://your-production-domain
LOCAL_HTTPS=false
```

In Microsoft Entra app registration, add:

```text
https://your-production-domain/auth/office365/callback
```

The app redirects non-HTTPS forwarded production requests back to HTTPS and marks session cookies as secure.
