RE:DOUBT STUDIO — VERSION 7 (SUPABASE CLOUD SYNC)

WHAT'S NEW
- Automatic cloud sync after edits (debounced ~1.4 seconds).
- Supabase password sign-in (plus optional email magic-link sign-in).
- Safe first-login choice when cloud and browser data differ.
- Cloud snapshots: most recent 30 successful saves, with manual restore.
- Browser data remains usable when offline or Supabase is unavailable.
- Existing manual JSON Export/Restore is preserved.

SETUP
1. Before upgrading, open v6 and Export Backup from the Link Library.
2. Create a Supabase project at https://supabase.com/dashboard.
3. In Supabase SQL Editor, paste and RUN the entire supabase_setup.sql file.
4. In Authentication > URL Configuration, set Site URL to your existing
   Netlify URL (https://YOUR-SITE.netlify.app/) and add it to Redirect URLs.
5. In Project Settings / Connect / API Keys (label varies), copy the Project
   URL and the PUBLISHABLE key (sb_publishable_...) or legacy anon key.
   NEVER use a secret key or service_role key in the browser.
6. Deploy the HTML, JS and CSS files to your EXISTING Netlify site.
   (Do not deploy supabase_setup.sql publicly; it is setup-only.)
7. In Control Room click Connect cloud, enter URL, publishable key, and email.
   Open the emailed login link in the SAME Brave browser profile.
8. Check the cloud status and confirm a change syncs; use Restore snapshot
   to review historical versions. Keep periodic manual JSON backups.

IMPORTANT LIMITATIONS
- This is an online sync of the entire studio state, not independent row-level
  collaborative editing. Avoid simultaneous editing in multiple browsers.
- Conflicting versions prompt for a decision instead of silently overwriting.
- Cloud credentials are per-browser; the publishable key is safe to expose ONLY
  because database RLS policies and authenticated RPC enforce per-user access.
- Free Supabase projects can pause when inactive. Local editing still works;
  sync resumes after the project is reactivated and you press Sync now.
- Cloud snapshots are limited to 30 saves, not long-term immutable backups.
- This app stores links and show metadata, not downloaded video files.
- Share the stage tab with tab audio enabled in StreamYard.

VERSION 8 — PASSWORD SIGN-IN
1. In Supabase Dashboard > Authentication > Users, use Add user > Create new user.
2. Enter your email and a strong password, and select Auto Confirm User if offered.
   If the user already exists, use that account instead; do not create duplicates.
3. In the studio, click Connect cloud and enter the project URL and publishable/anon key.
4. Enter the same email and password, then click Sign in with password.
5. Passwords are never saved in localStorage. Supabase manages the login session.
6. The original email sign-in link option remains available.

IMPORTANT: The project must have the SQL setup from v7 applied and Row Level Security enabled.
Before first sync, export a local JSON backup. If a different cloud state exists, review
the conflict prompt carefully. Do not share service_role or secret keys.

VERSION 9 — ARTICLE READER MODE
--------------------------------
Reader Mode is now the default for articles. In the Control Room, cue an article and use the Article presentation dropdown to switch between Reader Mode and Original Website. The Live Stage follows the selected mode. Reader Mode has A+ and A- controls for text sizing; scroll in the stage tab during presentation.

IMPORTANT DEPLOYMENT CHANGE: Reader Mode requires a Netlify Function, so deploy this folder using a Netlify project connected to a Git repository or Netlify CLI (netlify deploy --build --prod). Simple drag-and-drop of the static folder to Netlify Drop does NOT install the function or npm dependencies. Ensure the project base directory contains package.json and netlify.toml. Existing Supabase sync remains unchanged; deploy to the SAME Netlify site/domain to preserve local data.

Article extraction is best effort. Paywalls, blocked scraping, bot challenges, dynamic pages, and copyright restrictions may prevent it. The reader shows a source link rather than attempting to bypass restrictions. Images may be blocked by publishers. This function fetches public pages and should be kept under sensible Netlify usage limits. For reliable protection against DNS rebinding and server-side request forgery, deploy behind a trusted outbound proxy with network egress restrictions before opening the endpoint to untrusted users; hostname DNS validation alone is not sufficient.
