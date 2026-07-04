# SprintRay Desktop Scanner Integration — Simulator

English | [中文](./README.zh-CN.md)

A reference implementation and command-line **simulator of the desktop-app side** of SprintRay's
device-login + scan-upload integration. Use it to understand the flow and to test your integration
end to end before building it into your real desktop scanner app.

Zero dependencies — Node.js ≥ 18 built-ins only.

## How the integration works

From your desktop app's point of view, there are four steps — **no browser, no re-login, and no
token ever travels in the launch URL**:

1. **Launch.** From a treatment page, the SprintRay web app opens your app through its custom URL
   scheme with a base64-encoded JSON payload — `yourscheme://<base64_json>` — carrying a **one-time,
   short-lived `code`**.
2. **Decode.** Base64-decode the payload and read the `code`, the token-endpoint path, and the
   treatment/case identifiers (see [Launch payload](#launch-payload)).
3. **Exchange.** POST the `code` + your client credentials over HTTPS to obtain the signed-in
   doctor's `access_token`.
4. **Upload.** For each scan file, request a presigned upload URL, then PUT the file bytes to it.
   The scans attach to the treatment automatically.

### Launch payload

```json
{
  "caller": { "name": "SprintRay", "version": "1.0.0" },
  "case": { "ID": "<external-case-id>" },
  "auth": {
    "code": "<one-time-code>",
    "tokenEndpoint": "/api/integration/device-login-token",
    "expiresIn": 600
  },
  "treatmentId": "<treatment-id>",
  "supportedFileTypes": [1, 2]
}
```

| Field | Use |
|---|---|
| `auth.code` | one-time device-login code to exchange |
| `auth.tokenEndpoint` | token endpoint **path** — join onto the backend origin |
| `auth.expiresIn` | code lifetime, seconds |
| `treatmentId` | treatment the scans attach to |
| `case.ID` | external case id (send as `externalCaseId` on upload) |
| `supportedFileTypes` | jaws to upload — `1` = upper, `2` = lower |

## API contract

Two calls. `{ORIGIN}` is the SprintRay backend origin (e.g. `https://dashboard.sprintray.com`)
— no `/api` suffix; the paths already include it.

### 1. Exchange the code for a token

```http
POST {ORIGIN}{auth.tokenEndpoint}
Content-Type: application/json

{ "code": "<code>", "clientId": "<your-client-id>", "clientSecret": "<your-client-secret>" }
```

`200 → { "access_token": "…", "token_type": "Bearer", "expires_in": 86400 }`

Errors: `400` code missing/expired/already used · `401` bad client credentials.
When the token expires, re-launch to obtain a new one.

### 2. Get a presigned upload URL, then PUT the file

```http
POST {ORIGIN}/api/file/upload
Authorization: Bearer <access_token>
Content-Type: application/json

{ "fileName": "upper.stl", "fileSize": 3083734, "treatmentId": "<treatment-id>",
  "treatmentFileType": 1, "externalCaseId": "<external-case-id>" }
```

`200 →` a presigned upload URL (a JSON string, or `{ "url": "…" }`)

```http
PUT <presignedUrl>
Content-Type: application/octet-stream
Content-Length: <fileSize>

<raw file bytes>
```

`200`/`204` on success. **No** auth header on the PUT — the presigned URL is self-authorizing.

- `treatmentFileType`: **`1` = upper jaw, `2` = lower jaw**
- Scan files are **STL**.

## What you need from SprintRay

| Value | Env var | Notes |
|---|---|---|
| Backend origin | `SCANPRO_BASE_URL` | no `/api` suffix |
| Client id | `SCANPRO_CLIENT_ID` | your integration's public id |
| Client secret | `SCANPRO_CLIENT_SECRET` | keep server-side / in your app only |
| URL scheme | `SCANPRO_URL_SCHEME` | the scheme your app registers, e.g. `openScanPro` |

## Running the simulator

Prerequisites: Node.js ≥ 18 (`--env-file` needs ≥ 20.6). macOS / Windows / Linux (macOS is the
tested path for scheme registration).

```sh
cp .env.example .env      # fill in origin, client id/secret, scheme
```

### Register the URL scheme (real OS launch)

Make the OS route `yourscheme://…` to this simulator, so clicking the launch entry in the browser
starts it for real:

```sh
npm run register      # register the scheme with the OS
npm run status        # show what the scheme currently resolves to
npm run unregister    # remove it
```

- **macOS**: an app is created under `~/Applications`; the first launch asks to control Terminal
  (to show the run) — click **OK**, or `npm run register -- --headless` to log to a file instead.
  Re-run `register` after changing code or `.env`.
- **Windows / Linux**: registers a per-user handler (registry / `.desktop`).

### Run against a launch URL directly

```sh
# Form A — the deep link handed over by the browser
node --env-file=.env src/index.js "yourscheme://<base64_json>"

# Form B — an explicit code (no launch URL)
node --env-file=.env src/index.js --code <code> --base-url <origin> --treatment-id <guid>
```

Add `--demo-refresh` to also exercise the token-refresh endpoint.

### What it does

Each run exchanges the code, then uploads `fixtures/upper.stl` and `fixtures/lower.stl` with a live
progress bar. **Every backend request and response is logged in full** (method, URL, headers, body /
status, headers, body) so you can see exactly what to send and what to expect. Swap the two files in
`fixtures/` to upload your own scans.

## Exit codes

- `0` — token exchange + all uploads succeeded (or a register/status/unregister command completed)
- `1` — bad arguments, missing env, or a failed exchange/upload
