# Your own Google project and client (Settings → Accounts)

One Google project and sign-in of your own serves everything Google can add to the planner:

- **Sync trips through Google Drive** folders, between your computers and with other people (Settings → Sync).
- **Photos from Drive folders** on the map and in the gallery, also ones that aren't shared publicly.
- **Gemini's exact limits:** the planner reads your Gemini key's limits from its Google Cloud project (the Service
  Usage API), the same numbers AI Studio shows, so it knows which models the key can run without spending test requests.

- **Booking emails from Gmail** in the trip chat: browse or search your mail, pick a confirmation, and the chat reads
  it. Read-only. Each Gmail account is connected on its own (Settings → Accounts → Gmail → Add account), and can be a
  different one from Drive's; with the app **In production** any of your accounts can sign in to it.

To sign in, the app needs a Google "OAuth client": an ID and a secret that tell Google which app is asking. The app ships
without one. You make your own, free, once, in about 5–10 minutes. The app takes you through the same steps (Settings →
Accounts → Connect, or the Connect button of the feature), showing only the ones that feature needs. It first asks how:
**I'm new to this** explains each page and why it's needed, one step at a time; **I know the Google Cloud Console** puts
every link and value on one checklist.

This is **not** the same thing as a Google API key (or a Gemini key), but it comes from the same place, and should be in
the same project as your Gemini key.

## Steps

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and pick, at the top, the project your Gemini key
   belongs to: AI Studio made one with your first key, called "Default Gemini Project", whose ID starts with
   `gen-lang-client-` ([AI Studio → API keys](https://aistudio.google.com/apikey) shows each key's project). Gemini's
   limits are read from the project the client is made in. No Gemini key? Any project will do, or make one (**New
   project**, any name; it isn't selected by itself, so once the notification at the top right says it's made, press
   **Select project** there). No payment details are needed.
2. Switch on the APIs for what you want, by opening each and pressing **Enable** (if it says **Manage**, it's on already):

   | API | For |
   | --- | --- |
   | [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) | Sync, photos from Drive |
   | [Service Usage API](https://console.cloud.google.com/apis/library/serviceusage.googleapis.com) | Gemini's exact limits |
   | [Cloud Billing API](https://console.cloud.google.com/apis/library/cloudbilling.googleapis.com) | Whether billing is on (which limits apply) |
   | [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) | Booking emails from Gmail |

3. [Google Auth Platform → Branding](https://console.cloud.google.com/auth/branding): **Get started** (not shown if the
   project already has a sign-in screen). App name "Trip Planner", your email as support email, audience **External**,
   your contact email, agree, **Create**.

   Then scroll down the same **Branding** page, fill in these boxes (**Authorized domains** has a **+ Add domain**
   button; only `github.com` goes in it, without `https://`) and press **Save** at the bottom. Without them **Publish
   app** sends you back to this page; the terms of service link stays empty.

   | Field | Value |
   | --- | --- |
   | Application home page | `https://github.com/notetuwu/trip-planner` |
   | Privacy policy link | `https://github.com/notetuwu/trip-planner/blob/main/PRIVACY.md` |
   | Authorized domains | `github.com` |

4. [Audience](https://console.cloud.google.com/auth/audience): **Publish app** and confirm, so the status is **In
   production**. In "Testing", Google signs you out every 7 days. Don't submit it for verification.
5. [Clients](https://console.cloud.google.com/auth/clients) → **Create client** → application type **Desktop app** →
   **Create**. Copy the **Client ID** and **Client secret** now, or download the JSON: Google shows the secret only
   once. (Lost it? Create another client.)
6. In the app's steps, paste both (or the downloaded JSON) and press **Next**, then **Sign in with Google** (for
   Gemini's limits, with the account that owns the project).
7. Google says **"Google hasn't verified this app"**, because it's your own private app: **Advanced → Go to Trip Planner
   (unsafe)**, tick every box, continue.
   If it says **"Access blocked: … has not completed the Google verification process"** instead, the app is still in
   Testing: do step 4 (**Publish app**) and sign in again.

Adding a feature later? Switch on its API (step 2), then sign in again: the app's steps show just that. Read-only
Cloud access is asked for only when Gemini's exact limits are on, and Gmail only when it's connected. Google treats
reading mail as sensitive, so it needs the app **In production** (step 4) and shows the "unverified app" warning; a work
or school account's administrator may block it.

Menu names in Google's console change now and then; the links should still lead to the right pages.

## Gemini's exact limits

The project is the client's own: a Google client ID starts with its project's number
(`123456789012-….apps.googleusercontent.com`). If your Gemini key is in another project, enter that project's ID or
number under Settings → AI models → Google Gemini → Exact limits. They're read again every 10 minutes at most, and
when you press **Check again**.

What's read: the project's Gemini API quotas (requests a day and a minute, per model, for the free tier or, with billing
on, the paid one) and whether billing is on. Nothing is changed in the project. Models retired for new users are spotted
with Google's token counter (`countTokens`), which spends none of the key's requests.

## Sharing with other computers and people

- **Your other computers:** paste the same ID and secret there. Nothing else to set up.
- **Friends:** each makes their own the same way. Or you give them yours: then they count towards your project's limit
  of 100 users (unverified apps; the count can't be reset), and see your support email when they sign in. Only give it to
  people you trust.
- Different clients can sync through the same folder: access depends on each Google account and on how the folder is
  shared in Drive.

## Who has access to a folder

In the folder browser, select a Drive folder (or open one) and click **Access**. It lists who the folder is shared with.
If your account may share it, you can add people or Google groups by email address, change what they may do, remove
them, and turn "anyone with the link" on or off. Otherwise the list is only shown, or, where Google doesn't tell you who
else is on it, nothing but that. Access that comes from a folder further up is changed on that folder. Ownership can't
be handed over here.

To share a folder but not one inside it, select the inner folder, click **Access**, then **Limit access** (Google's
"limited access"). After that only the owner (in a shared drive, its managers) and people added to that folder itself can
open it. Others with access above still see its name, and are listed under "Can't open this folder"; **Let in** adds one
of them back. The button shows only when Google says your account may change it. Single files can't be limited.

## One folder per trip

In Settings → Sync, tick **Also find trips in the folders inside it** on the folder that holds your trips' folders. Only
the folders directly inside it are looked through. A file named `trip.json` goes by its folder's name.

To let people see just the trips they're on:

1. Share the top folder with them as **Viewer**.
2. Limit access on **every** trip's folder, and add that trip's people to it as editors.
3. They add the top folder as their sync folder and tick the same box.

They see the names of all the folders inside, but only open the ones they're added to. A folder that isn't limited, and
any file directly in the top folder, is open to everyone on the top folder.

Adding a trip (Your trips → the cloud on it) asks where it goes and shows who can open that place; nothing goes to the
top unless you choose it. A new folder can be made there, limited from the start. If a trip's file is later moved to a
folder where someone new could open it (or Google can't tell), syncing pauses until you confirm.

## Why the whole of Drive?

The narrower permission (`drive.file`) only covers files an app created with the same account, so you couldn't see trips
a friend put in a shared folder. The app only opens the folders added in Settings → Sync and never deletes anything.

## What's kept where

- Your client ID and secret are in the data folder (`sync/google-client.json`), the Google sign-in token in
  `sync/google-auth.json`; both readable only by your user where the system allows, and gitignored when running from
  source. The secret and token are never sent to the page, to a phone, into a trip or into Drive. Instead of entering
  them in the app you can set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (environment or a `.env` file in the data
  folder).
- **Sign out** (Settings → Accounts) deletes the token and tells Google to revoke it. You can also remove the app's
  access at <https://myaccount.google.com/connections>.
- Trip files in Drive are like exports: the trip and its ticked place lists. Left out: photo folders on your computer,
  place lists' file paths, the prompt sent to the AI and the model's thinking.
- Before sync replaces a trip with a newer version from Drive, the old one is kept in the trip's versions (Your trips →
  Recover…). Drive keeps earlier versions of its files too (a file's ⋮ → File information → Manage versions).
