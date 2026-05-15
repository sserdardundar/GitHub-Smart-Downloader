# Usage Guide

GitHub Smart Downloader is designed to be seamless and integrate directly into your GitHub workflow. This guide covers how to use its various features effectively.

## Installation

### Chrome Web Store

The recommended installation path is the published Chrome Web Store listing:

[Install GitHub Smart Downloader from the Chrome Web Store](https://chromewebstore.google.com/detail/apnjimllodfnaplhmlihkgnanmmcdjfi?utm_source=item-share-cb)

After installation, pin the extension if you want quick access to the popup dashboard and settings.

### Development Mode

If you are contributing to the extension or testing a local build, install it manually:

1. Download or clone this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top right).
4. Click **Load unpacked** and select the root directory of this repository.

## Basic Usage

### Downloading a Full Repository

When you are on the home page of a repository, you will see a **Download Repository** button (customizable in settings) near the "Code" button. Clicking this will fetch the entire branch as a ZIP.

### Downloading a Subdirectory

Navigate into any folder in a repository. The button will automatically update to **Download Directory**. Clicking it will package only that specific folder and its contents into a ZIP.

### Downloading Single Files

Hover over any file in the GitHub file list. A small download icon will appear on the right side of the file row (next to the last commit date). Clicking this downloads just that file.

---

## Advanced Features

### Multi-Select Downloads

You can download specific combinations of files and folders without taking the whole repository:

1. **Enable Selection**: Check the boxes on the left side of any file/folder row.
2. **Action Bar**: A floating bar will appear at the bottom of the screen showing how many items you've selected.
3. **Batch Action**: Click **Download Selected** in the action bar to package all checked items into a single ZIP.

### Keyboard Shortcuts

- **`Esc`**: Clear all current selections and hide the Action Bar.

---

## Configuration & Settings

Access the settings by clicking the extension icon in your browser toolbar and selecting the **gear icon**.

### Personal Access Token (PAT)

GitHub limits unauthenticated API requests to 60 per hour. If you download large directories frequently, you may hit this limit.

1. Create a [Fine-grained PAT](https://github.com/settings/tokens?type=beta) or a Classic Token on GitHub.
2. Grant it **Public Repositories (read-only)** access.
3. Paste it into the GitHub Smart Downloader settings and click **Save Securely**.
4. Your limit will be increased to 5,000 requests per hour.

### UI Customization

- **Theme**: Switch between Light, Dark, or System default.
- **Accent Color**: Change the color of the download buttons and progress bars.
- **Button Style**: Choose between filled, outline, rounded, or pill-shaped buttons to match your preference.

---

## Troubleshooting

### "Rate Limit Reached"

If you see this error, it means you've made too many requests to GitHub. To fix this:

- Wait for the reset period (shown in the extension popup).
- Add a Personal Access Token in the settings to significantly increase your limit.

### Button not appearing

GitHub's UI updates frequently. If the buttons don't appear:

- Refresh the page.
- Ensure you are on a standard repository page (not a Gist or a Wiki).
- Check if another extension is conflicting with the GitHub UI.
