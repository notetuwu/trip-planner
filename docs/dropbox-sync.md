# Syncing trips through Dropbox: setting up your Dropbox app

Settings → Sync can keep trips in step through Dropbox folders, yours or ones others shared with you. To sign in, the
app needs a Dropbox "app key": you register your own free Dropbox app once, in about 5 minutes. The same steps are in the
app (Settings → Accounts → Your Dropbox app).

If the Dropbox app is installed on your computer, you don't need any of this: add a folder from your Dropbox folder
under **This computer** instead (Settings → Sync → Add a folder), and Dropbox's own app carries it.

## Steps

1. Open the [Dropbox App Console](https://www.dropbox.com/developers/apps) and sign in.
2. **Create app**: choose **Scoped access**, then **Full Dropbox**. (Full Dropbox is needed to see folders others
   shared with you; the app only opens your sync folders.) Name it anything that isn't taken, like "Trip Planner" and
   your name. Press **Create app**.
3. **Permissions** tab: tick `files.metadata.read`, `files.content.read`, `files.content.write`, `sharing.read` and
   `sharing.write`, then press **Submit** at the bottom.
4. **Settings** tab, under **OAuth 2** → **Redirect URIs**: add `http://localhost:47618/`. Leave **Allow public clients
   (Implicit Grant & PKCE)** on **Allow**.
5. Copy the **App key** from the top of the Settings tab and paste it in Settings → Accounts → Your Dropbox app → **Save**.
   The app secret isn't needed (the app signs in with PKCE).
6. **Sign in to Dropbox** and allow the app.

## Other computers and other people

- **Your other computers:** paste the same app key there and sign in.
- **Friends:** each makes their own app the same way. Or, on your app's Settings tab, press **Enable additional users**
  to let them use your key: a new Dropbox app is in "development" and can link up to 500 accounts (after 50, Dropbox asks
  for a review within two weeks).
- **A folder someone shared with you** shows under Dropbox → Shared with me in the folder browser. One that isn't in
  your Dropbox yet is added to it when you choose it (like "Add to Dropbox" on the website). A pasted shared link works
  once the folder is in your Dropbox.

## What's kept where

- The app key and the sign-in token are in the data folder (`sync/dropbox-client.json`, `sync/dropbox-auth.json`),
  readable only by your user where the system allows. The token is never sent to the page, a phone, a trip or a folder.
  Instead of entering the key you can set `DROPBOX_APP_KEY`.
- **Sign out** (Settings → Accounts) deletes the token and tells Dropbox to end the access. You can also remove the app at
  <https://www.dropbox.com/account/connected_apps>.
- Nothing is ever deleted in Dropbox. A trip is written as a new version only over the version the app last read; if
  someone saved it meanwhile, the next sync joins the two (see Settings → Sync → Good to know).
- Photo folders in Dropbox aren't read yet: use the Dropbox app's folder under This computer for those.
