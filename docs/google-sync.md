# Syncing trips through Google Drive: setting up your Google client

Settings → Sync keeps trips in step between your computers and with other people, through Google Drive folders. To sign
in, the app needs a Google "OAuth client": an ID and a secret that tell Google which app is asking. The app ships
without one. You make your own, free, once, in about 5–10 minutes. The same steps are in the app (Settings → Sync).

This is **not** the same thing as a Google API key, but it comes from the same place, and can be in the same project.

## Steps

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and pick a project at the top. The one with your
   Google API key is fine; otherwise make one (**New project**, any name). No payment details are needed.
2. Open [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) and press **Enable**.
   (If it says **Manage**, it's already on.)
3. [Google Auth Platform → Branding](https://console.cloud.google.com/auth/branding): **Get started** (not shown if the
   project already has a sign-in screen). App name "Trip Planner", your email as support email, audience **External**,
   your contact email, agree, **Create**.

   Then on **Branding**, under **App domain**, fill in these and press **Save** (without them **Publish app** sends you
   back to this page; the terms of service link can stay empty):

   | Field | Value |
   | --- | --- |
   | Application home page | `https://github.com/notetuwu/trip-planner` |
   | Privacy policy link | `https://github.com/notetuwu/trip-planner/blob/main/PRIVACY.md` |
   | Authorized domains | `github.com` |

4. [Audience](https://console.cloud.google.com/auth/audience): **Publish app** and confirm, so the status is **In
   production**. In "Testing", Google signs you out every 7 days. Don't submit it for verification.
   Then [Data access](https://console.cloud.google.com/auth/scopes) → **Add or remove scopes** → paste
   `https://www.googleapis.com/auth/drive` under **Manually add scopes** → **Add to table** → **Update** → **Save**.
5. [Clients](https://console.cloud.google.com/auth/clients) → **Create client** → application type **Desktop app** →
   **Create**. Copy the **Client ID** and **Client secret** now, or download the JSON: Google shows the secret only
   once. (Lost it? Create another client.)
6. In the app, Settings → Sync: paste both (or the downloaded JSON), **Save**, then **Sign in with Google**.
7. Google says **"Google hasn't verified this app"**, because it's your own private app: **Advanced → Go to Trip Planner
   (unsafe)**, tick the Drive box, continue.
   If it says **"Access blocked: … has not completed the Google verification process"** instead, the app is still in
   Testing: do step 4 (**Publish app**) and sign in again.

Menu names in Google's console change now and then; the links should still lead to the right pages.

## Sharing with other computers and people

- **Your other computers:** paste the same ID and secret there. Nothing else to set up.
- **Friends:** each makes their own the same way. Or you give them yours: then they count towards your project's limit
  of 100 users (unverified apps; the count can't be reset), and see your support email when they sign in. Only give it to
  people you trust.
- Different clients can sync through the same folder: access depends on each Google account and on how the folder is
  shared in Drive.

## Why the whole of Drive?

The narrower permission (`drive.file`) only covers files an app created with the same account, so you couldn't see trips
a friend put in a shared folder. The app only opens the folders added in Settings → Sync and never deletes anything.

## What's kept where

- Your client ID and secret are in the data folder (`sync/google-client.json`), the Google sign-in token in
  `sync/google-auth.json`; both readable only by your user where the system allows, and gitignored when running from
  source. The secret and token are never sent to the page, to a phone, into a trip or into Drive. Instead of entering
  them in the app you can set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (environment or a `.env` file in the data
  folder).
- **Sign out** (Settings → Sync) deletes the token and tells Google to revoke it. You can also remove the app's access
  at <https://myaccount.google.com/connections>.
- Trip files in Drive are like exports: the trip and its ticked place lists. Left out: photo folders on your computer,
  place lists' file paths, the prompt sent to the AI and the model's thinking.
- Before sync replaces a trip with a newer version from Drive, the old one is kept in the trip's versions (Your trips →
  Recover…). Drive keeps earlier versions of its files too (a file's ⋮ → File information → Manage versions).
