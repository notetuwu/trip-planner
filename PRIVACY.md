# Privacy

Trip Planner is an open-source app that runs on your own computer. It has no accounts of its own, no server run by its
developer, no analytics, no ads and no tracking. The developer receives nothing from your use of it.

## What stays on your computer

Your trips, their earlier versions, place lists, settings, API keys and caches are files in the app's data folder.

## Google Drive sync (optional)

Sync is off unless you set it up with your own Google client ID and secret and sign in with Google.

- **Access:** the app asks for Google Drive access, which technically covers your whole Drive, because that is what it
  takes to see files other people put in a folder shared with you. The app only uses the folders you add in Settings →
  Sync: it reads their names and trip files, writes the trips you choose to sync, and can make a new folder when you ask
  it to. Sync never deletes anything in your Drive. In the photo gallery you can delete a photo: after you confirm, your
  own file goes to the Drive trash, and someone else's is only removed from the folder.
- **Your account:** your name and email address are read to show who is signed in and to record who shared a trip.
- **Profile pictures:** the addresses of your picture and of the people on a shared folder or photo folder are kept on
  your computer to show who changed or uploaded what. The pictures load from Google; none are put in a trip file.
- **Shared trips:** a synced trip file holds the trip, its selected place lists, and the name and email address of the
  person who shared it. Everyone who can open that Drive folder can read it. Photo folders on your computer, file paths
  of place lists, and the prompts sent to AI models are left out.
- **Storage:** the sign-in token, client ID and secret stay in the app's data folder on your computer. They are sent
  only to Google.
- **Removing it:** sign out in Settings → Sync to delete the token and revoke the access, or remove the app at
  <https://myaccount.google.com/connections>. Files already in Drive stay there until you delete them.

Data from your Google account is not sold, used for advertising, or sent to the developer.

## Dropbox sync (optional)

Sync with Dropbox is off unless you set it up with your own Dropbox app key and sign in to Dropbox.

- **Access:** the app asks for "Full Dropbox" access, because that is what it takes to see folders other people shared
  with you. It only uses the folders you add in Settings → Sync: it reads their names and trip files, writes the trips
  you choose to sync, makes a new folder when you ask it to, and adds a folder shared with you to your Dropbox when you
  choose it. It never deletes anything in your Dropbox.
- **Your account:** your name and email address are read to show who is signed in and to record who shared a trip.
  Profile pictures of you and a shared folder's members are shown as described for Google Drive above.
- **Shared trips** and **storage** work as for Google Drive above: the token and app key stay in the app's data folder and
  are sent only to Dropbox.
- **Removing it:** sign out in Settings → Sync, or remove the app at <https://www.dropbox.com/account/connected_apps>.

## Folders on your computer (optional)

A sync folder can also be a folder on your computer or a network drive. Trip files are written there and read from there;
whatever carries that folder further (OneDrive, iCloud, a network share) does so under its own terms.

## Other services the app talks to

To do its job the app sends the necessary parts of your requests directly from your computer to other services, each
under its own privacy policy:

- Maps, place search, routes, holidays, weather and similar lookups: the services listed in the
  [README](README.md#services-it-uses). They receive things like place names, coordinates and dates.
- Planning and the trip chat: the AI model you choose. A cloud model's provider receives the trip details needed for the
  answer (including those of a synced trip you're working on). A local model keeps them on your computer. On Google
  Gemini's free tier (a key without billing), Google may use your prompts and the answers to improve its products.
- Web research, if used: the search engine and the websites that are read.
- Optional features you switch on or set up, such as Google Drive photo folders and pictures from Wikimedia.
- Resting the mouse on a photo in the gallery sends where it was taken to OpenStreetMap, to show the place's name.
- Update checks: GitHub (can be switched off in Settings → Updates).

## Questions

Open an issue at <https://github.com/notetuwu/trip-planner/issues>.
