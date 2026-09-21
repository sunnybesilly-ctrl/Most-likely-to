# Most Likely To — real-time party game

Everyone joins from their own phone's browser. No app install, no accounts.
Host sets the dare, the group votes anonymously each round, and whoever
gets the most votes gets the dare.

## How it works
- One person taps **Host a game** → gets a 4-letter room code.
- Everyone else goes to the same URL, enters their name + the code, taps **Join**.
- Host picks (or writes) the dare for the round — say it out loud so
  everyone agrees before it's locked in.
- A random question appears on every phone with a 20-second timer.
  Everyone privately taps who they think it applies to.
- Results reveal together with a live vote bar chart. Whoever's on top
  gets the dare. Host taps **Next round** to keep going.
- Question and dare banks are built in but editable — the host can add
  custom dares from the lobby screen any time.

## Running it locally (to test before your party)
```
npm install
npm start
```
Then open `http://localhost:3000` on your computer, and on your phone
(same wifi) at `http://<your-computer's-local-IP>:3000`.

## Deploying so anyone can join from anywhere
GitHub itself can't run a live server — you need a small always-on host.
**Render's free tier is the easiest** (Railway, Fly.io, or Glitch also work):

1. Push this folder to a new GitHub repo.
2. Go to [render.com](https://render.com) → New → Web Service → connect your repo.
3. Build command: `npm install`  Start command: `npm start`
4. Deploy. Render gives you a URL like `https://your-game.onrender.com` —
   that's the link everyone opens on their phone.

Note: Render's free tier spins down after inactivity, so the first
person to open the link before the party might wait ~30 seconds for it
to wake up. Open it yourself a few minutes early to "warm it up."

## Customizing content
Edit `data.js` — `DEFAULT_QUESTIONS` and `DEFAULT_DARES` are just plain
arrays of strings. Add, remove, or rewrite anything to match your group.
Hosts can also add one-off dares live from the lobby screen without
touching code.

## Notes
- Game state lives in memory on the server — if the server restarts,
  active rooms are lost (fine for a one-night game).
- No data is stored anywhere after the process stops.
