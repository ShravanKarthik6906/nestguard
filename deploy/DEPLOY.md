# Deploying KnowFlyZone on Vultr

One small server runs both halves:

```
Browser / phone / device ──https──▶ Caddy (:443) ──┬─▶ /zones /check /device/* /speak /docs ─▶ uvicorn 127.0.0.1:8000
                                                    └─▶ everything else ─▶ app/dist (built frontend)
```

Caddy gets the https certificate by itself. Port 8000 is never opened to the internet.
Until the domain exists, the site runs at `https://<ip-with-dashes>.sslip.io` (also real https).

> The device's demo position lives in the API's memory. **The app and the device must
> use the same API** (both the laptop, or both Vultr). Switch them together.

---

## Udaya: before the deploy (5 min)

1. Merge the app branch into `main` so the server can deploy `main`:
   ```
   git checkout main && git pull && git fetch origin
   git merge origin/claude/cool-einstein-de1aog && git push
   ```
2. Send Shravan the `GEMINI_API_KEY=...` line by DM (his `.env` only has MongoDB and Fish Audio).
3. Be on call for the first start: if the API fails, Shravan sends you the log
   (`journalctl -u nestguard-api -n 50`).

## Shravan: create the server (10 min)

1. Vultr → **Deploy** → **Cloud Compute – Shared CPU**
   - Location: **New York (NJ)**
   - Image: **Ubuntu 24.04 LTS x64**
   - Plan: the smallest one **with IPv4** (about $5-6/month)
   - Turn **off** automatic backups
   - **SSH key**: add your Mac's public key. On the Mac:
     ```
     ls ~/.ssh/id_ed25519.pub || ssh-keygen -t ed25519
     cat ~/.ssh/id_ed25519.pub
     ```
     Paste the whole line into Vultr.
   - Hostname: `nestguard` → **Deploy**
2. Wait for "Running" and copy the **IP address**. Below, `IP` means that address.
3. Add `GEMINI_API_KEY=...` (from Udaya) as a new line in `~/nestguard/backend/.env` on your Mac.

## Shravan: install (10 min)

From your Mac (use the hotspot if the venue Wi-Fi blocks SSH):

```
ssh root@IP
```

On the server:

```
git clone https://github.com/ShravanKarthik6906/nestguard /srv/nestguard
```
If the repo is private, git asks for a username and password: use your GitHub username and a
**fine-grained personal access token** (GitHub → Settings → Developer settings → Fine-grained
tokens → only this repo → Contents: Read-only) as the password.

Back on your **Mac** (new tab), copy the secrets up. They never go through git:

```
scp ~/nestguard/backend/.env root@IP:/srv/nestguard/backend/.env
```

On the **server**:

```
cd /srv/nestguard && bash deploy/setup.sh
```

It installs everything, starts the API and Caddy, and ends with
`API on the server: HTTP 200` and `Done. Open: https://<ip-with-dashes>.sslip.io`.

## Test it

1. Open the printed https URL on your laptop **and** your iPhone.
2. The pill says "· live", the presets work, "Use my location" now asks for permission on the phone.
3. `https://.../docs` shows Udaya's API docs.
4. Tap a preset: you hear the spoken alert (Fish Audio runs on the server now).

Then **tell Ryan**: `NESTGUARD_API=https://<the-url>` (no port, no trailing slash).

## When the domain is ready (GoDaddy)

1. GoDaddy, **My Products**, the domain, **DNS** (Manage DNS):
   - Edit the existing **A** record with name `@` (it points at GoDaddy's "Parked" page) to
     value `IP`, TTL 600 (or the shortest offered). If there is none, add it.
   - Edit or add a **CNAME** record: name `www`, value `@`.
   - Leave the NS and SOA records alone. Domain forwarding must be off.
2. Wait until `dig +short yourdomain.xyz` (or `ping yourdomain.xyz`) on your Mac shows the IP (5-60 min).
3. On the server, once:
   ```
   cd /srv/nestguard && git pull && bash deploy/setup.sh yourdomain.xyz
   ```
   Caddy gets the https certificate by itself. The domain is remembered, so later updates
   don't need it. The sslip.io URL keeps working too. Tell Ryan the domain URL.

## Updating after new commits

```
ssh root@IP
cd /srv/nestguard && git pull && bash deploy/setup.sh
```
(The domain is remembered from the first time it was given.)

## Final voice clips (after feature freeze)

The server is reachable from any network, so on your Mac (with the hotspot for Fish Audio):

```
cd ~/nestguard/backend && source .venv/bin/activate
python make_clips.py --api https://<the-url> --final
```
Commit the MP3s, then run the update above.

## Local dev against the server

```
cd ~/nestguard/app && API_TARGET=https://<the-url> npm run dev
```

## If something breaks

| Problem | Look at |
|---|---|
| API errors / 502 on /check | `journalctl -u nestguard-api -n 50` (send to Udaya) |
| No https / site won't load | `journalctl -u caddy -n 50` (DNS not pointing yet? port 80/443 blocked?) |
| Changed `.env` | `systemctl restart nestguard-api` |
| Spoken alerts silent | Fish Audio balance, then the API log for `Fish Audio failed` |
