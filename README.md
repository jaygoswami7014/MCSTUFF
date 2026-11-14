# MCSTUFF

Minecraft files hub. Node + Express + SQLite.

## Railway
1. Push this folder to GitHub, create a Railway project from the repo.
2. Add one Volume mounted at `/app/data`.
3. Variables: `DB_PATH=/app/data/mcstuff.db`, `UPLOAD_DIR=/app/data/uploads`, `SESSION_SECRET=<long random text>`, `NODE_ENV=production`.
4. Open the site, go to `/login`. The first account that registers is the admin automatically.

## ZIP Update
Admin panel > ZIP Update. Check ZIP, Apply. A backup is made, the server restarts by itself and the page reloads.
Protected (never overwritten): `data/`, `public/uploads/`, `node_modules/`, `package-lock.json`.
