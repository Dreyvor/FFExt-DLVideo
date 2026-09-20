# VideoDL Firefox extension

[![Tests](../../actions/workflows/tests.yml/badge.svg)](../../actions/workflows/tests.yml)

VideoDL discovers video elements, direct video links, WebVTT subtitle tracks, and media network responses on websites. The popup separates videos and `.vtt` files into two tabs so each item can be downloaded independently. Completed downloads remain highlighted in green while the source page stays open.

## Smart download sets

The popup shows available resolution, duration, file size, media type, and subtitle language when a website provides that metadata. Select one video in the **Videos** tab, optionally select one or more caption tracks in the **.vtt files** tab, and choose **Download selected**.

The files are saved without additional prompts under `Downloads/VideoDL/<video name>/`. Captions use the video name plus their language code (or a numeric fallback), and Firefox automatically chooses a unique name if a file already exists. Blue rows are downloading, green rows are complete, and failed files can be retried individually.

## Site access and DRM

VideoDL runs on any normal website that Firefox allows extensions to access. There is no domain allowlist or hostname-hash configuration.

VideoDL does not circumvent digital rights management. If a page attaches encrypted media keys, emits an encrypted-media event, or makes a recognisable DRM licence request, the tab is marked DRM-protected and its download actions are disabled. This includes protected playback used by services such as Netflix and Prime Video.

Some sites expose only short-lived streams or segmented manifests rather than a complete media file. VideoDL can list detected media URLs, but the website's delivery format determines whether Firefox can save a directly playable file.

## Develop and test

```sh
npm install
npm test
npm run lint
npm run build
```

## Install temporarily in Firefox

1. Download or clone this repository.
2. Open Firefox and enter `about:debugging#/runtime/this-firefox` in the address bar.
3. Select **Load Temporary Add-on…**.
4. Open the project directory and select `manifest.json`.
5. Visit a page containing a video and open VideoDL from the Firefox toolbar.

Firefox removes temporary extensions when the browser closes. Repeat these steps after restarting Firefox. During development, select **Reload** beside VideoDL on the `about:debugging` page after changing the source files.

## Automated releases

Pushes and pull requests to `main` run the automated test and Firefox lint workflow. They do not publish releases.

To publish a release manually:

1. Open the repository's **Actions** page on GitHub.
2. Select **Build and release**.
3. Select **Run workflow**, choose the `main` branch, and confirm.

The workflow runs the checks, builds the extension, and creates a UTC-dated GitHub release. Each release contains the extension ZIP, a `.sha256` checksum file, and the checksum in the release notes.

## Privacy and permissions

The extension requests access to all URLs so it can discover media requests. Detected URLs are retained only in memory and are removed when the tab navigates or closes. It does not transmit browsing data. Downloads always use Firefox's save dialog.
