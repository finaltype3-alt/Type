# Institution Typing Examination — Version 3

This is a real server-backed institutional prototype.

## What it does
- Admin authentication.
- Admin creates private exams.
- Admin sets candidate, language, duration, WPM, full marks and violation limit.
- Admin enters the exact reference passage privately.
- Candidate receives an exam code.
- Candidate sees ONLY the physical source (book/exam paper), not the website reference text.
- Server starts and stores the official start/expiry timestamps.
- Server calculates total words, mistakes, correct words, accuracy and marks.
- Results are stored in SQLite.
- Admin can see exam status and results.
- Browser-level copy/paste, drag/drop, shortcuts, tab/window and fullscreen violations are monitored.

## Important security deployment instructions
Set these environment variables in production:
ADMIN_USER
ADMIN_PASSWORD
SESSION_SECRET
DB_PATH (optional)

Do not leave the default ADMIN_PASSWORD.

For a truly institution-only deployment, put the site behind your institution's identity provider/VPN/SSO or an additional access gateway. An exam code alone is not an identity system.

## Run locally
1. Install Node.js 20+.
2. In this folder run:
   npm install
   npm start
3. Open http://localhost:3000
4. Login with the ADMIN_USER and ADMIN_PASSWORD environment values.

Example:
ADMIN_USER=youradmin ADMIN_PASSWORD=strong-password SESSION_SECRET=a-long-random-secret npm start

## Scoring
Required words = duration in minutes × required WPM.
Mistake words are excluded from correct words.
Final marks = min(full marks, correct words / required words × full marks).

## Browser limitation
No ordinary browser application can guarantee that a person will not use another device, OCR, another computer or physical assistance. This system hardens the web session and logs browser-level violations. For high-stakes exams, use managed devices, proctoring, institutional network controls or a dedicated kiosk environment.

## Storage (Firebase removed)
All exam data (exams, roll-number locks, results) is now saved on your own domain through `/api/store`.
No Firebase and no outside database is used.

**On Netlify** (uses Netlify Blobs automatically, nothing to set up):
1. Put this folder in a Git repository and connect it to Netlify (or run `netlify deploy --build --prod` with the Netlify CLI).
   Plain drag-and-drop does not build the function.
2. Optional but recommended, in Site settings → Environment variables: `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`.
   If you do not set them, the admin name and password in `server.js` are used (same as before).

**On any Node host** (VPS, Render, Railway, cPanel Node, etc.): run `npm install` and `npm start`.
Data is kept in SQLite (`exam.db`). Use a host with a persistent disk.

Files: `lib/store-core.js` (access rules), `netlify/functions/store.mjs` (Netlify storage), `server.js` (Node storage), `netlify.toml`.
