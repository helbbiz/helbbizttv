# helbbizTTV Twitch site

This repository contains the static helbbizTTV website and a small Node.js API used for Twitch data. There are no third-party npm dependencies.

## Static website on Render

Keep the existing Static Site connected to this repository's `main` branch, with the Root Directory set to the repository root, build command `npm ci && npm run build`, and publish directory `dist/`. The build script copies the HTML, CSS, and browser JavaScript into `dist/`.

## Twitch API service on Render

Create a separate **Web Service** from this same repository:

- Root Directory: repository root
- Runtime: Node
- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Service name: `helbizttv-api` (the site calls `https://helbizttv-api.onrender.com/api`)

Set these environment variables in the API service's Render dashboard; never commit their values:

- `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`: create an application in the Twitch Developer Console and use its app credentials. The API uses the client-credentials flow and keeps secrets on the server.
- `FRONTEND_ORIGINS`: `https://helbizttv.onrender.com` (add any custom site domains as comma-separated origins).
- Optional `NEXT_STREAM_AT`: the next confirmed stream time as an ISO timestamp including timezone, for example `2027-08-20T19:00:00-04:00`. Leave unset when the time is not confirmed.
- Optional `NEXT_STREAM_TIMEZONE`: IANA timezone name for the schedule display, such as `America/New_York`.
- Optional `NEXT_STREAM_DURATION_MINUTES`: calendar event length from 15 to 720 minutes (defaults to 180).

The public website displays a neutral unavailable state until the API service and credentials are configured. It never substitutes invented live status, viewer counts, clips, or schedule data. Featured clips remain visible if the API is unavailable. Twitch chat is loaded only after the visitor opens it, and its embed uses the active site hostname as the required `parent`.

The API health endpoint reports whether both Twitch credential variables are configured (never their values). The clip endpoint accepts a page size from 1 to 100 and an opaque Twitch pagination cursor; the website lets visitors filter clips by game, sort by date or views, and load additional pages.

If Render reports that it cannot find `package.json` under `/opt/render/project/src`, confirm the service Root Directory is blank or `.` and that it is connected to the repository root, not a nested folder.
