# Scorekeeper

A simple, dark, phone-first (landscape) scorekeeper. Plain HTML/CSS/JS, no build step.
Games are shared between devices with a 5-digit code, using Supabase.

## Setup

1. **Supabase:** open the SQL Editor, paste `supabase/schema.sql`, and run it.
2. **Connect the app:** put your Project URL and **anon public** key in `js/config.js`
   (Project Settings -> API). Both are safe to be public.
   **Never** commit the `service_role` key or your database password.
3. **Deploy:** merge to `main`. The workflow in `.github/workflows/pages.yml` publishes to GitHub Pages.
4. **First time in the editor** you will be asked to create a PIN (entered twice).
   Forgot it? Run `delete from sk_settings;` in the Supabase SQL Editor and set a new one.

## Phone tips

- **iPhone:** Safari can't go full screen by itself. Share -> *Add to Home Screen*, then open it from the home screen.
- **Android/desktop:** the corner button toggles full screen.

## Tests

```bash
node --test tests/logic.test.js
```

## How it works

- Every tap is stored as one row (`sk_events`), and scores are totalled from those rows, so
  simultaneous taps from different devices never overwrite each other. Undo flips a flag on the row.
- Stats are written only when a game is finished, and never in Practice Mode.
- Live games that are untouched for 3 days are deleted automatically. Player profiles and saved results are kept.
