# Backend Version Control

The backend is the source of truth for Android release metadata. An admin
updates the record through the Admin App's **Versions** tab, which calls:

```text
PUT /api/admin/versions/android
```

The request supports:

```json
{
  "latestVersion": "1.2.0",
  "latestVersionCode": 3,
  "minimumSupportedVersion": "1.1.0",
  "updateRequired": false,
  "updateUrl": "https://github.com/example/release.apk",
  "message": "A new version is available."
}
```

`latestVersion` and `minimumSupportedVersion` must use `x.y.z` format.
`latestVersionCode` must be a positive integer and must match the Android
`versionCode` in the APK. `updateUrl` must be HTTPS. The APK itself should be
hosted by GitHub Releases, a private release server, or another trusted HTTPS
host; the backend stores and distributes the release URL but does not accept
arbitrary APK uploads.

Customer apps check:

```text
GET /api/versions/check?platform=android&version=1.1.0&versionCode=2
```

The response includes `updateAvailable`, `forceUpdate`, `latestVersion`,
`latestVersionCode`, `updateRequired`, `updateUrl`, and `message`. The app
opens the trusted release URL through Android's system installer/browser.

For a real release:

1. Build the APK with the same release keystore and a higher `versionCode`.
2. Upload the APK to a trusted HTTPS release URL.
3. Open Admin App -> Versions.
4. Set the latest version name, version code, minimum supported version,
   release URL, message, and whether the update is required.
5. Save and test the customer app's manual update check.

The admin route remains protected by the admin JWT. The public check endpoint
returns release metadata only and never exposes database credentials or APK
signing secrets.