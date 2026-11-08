# HashHouse

My team and I built HashHouse at a hackathon in July 2026. It's a vault for AI models that tells you if a model has been changed when it shouldn't have been.

![HashHouse dashboard](docs/screenshot.png)

## The idea

AI models get passed around a lot between training, testing, and deployment. If someone swaps or edits a model file along the way, it's really hard to notice. We wanted a simple way to catch that.

## What it does

When you upload a model, HashHouse takes a SHA-256 fingerprint of it. Change even one byte and the fingerprint changes, so any edit shows up.

Every upload is saved as a new version. Old versions can't be edited or deleted, so you always have the full history.

You need a password and a one-time code from an authenticator app to get in.

There's also a dashboard that checks every model against its saved fingerprint and flags anything that doesn't match.

## How we built it

- Frontend: React
- Backend: FastAPI (Python)
- Database: SQLite
- Login: JSON Web Tokens and time-based one-time codes

## Team

<!-- add names and GitHub links -->
- Udaya Raja ([@U-daya](https://github.com/U-daya)): what you worked on
- Teammate ([@handle](https://github.com/handle)): what they worked on

## Running it yourself

<!-- check these against the repo -->

Backend:
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

Frontend:
```bash
cd frontend
npm install
npm run dev
```

## What we want to add next

- Signatures so you can see who uploaded each version
- Email or Slack alerts when a model fails a check
- Cloud storage support
