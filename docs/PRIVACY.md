# Privacy Policy for GitHub Smart Downloader

**Last Updated: May 1, 2026**

GitHub Smart Downloader is committed to protecting your privacy. This Privacy Policy explains how we handle your data when you use our Chrome Extension.

## 1. Data Collection and Usage

GitHub Smart Downloader is designed with a **Privacy-First** architecture. 

*   **Personal Data**: We do not collect, store, or transmit any personal data to external servers. All extension operations are performed locally in your browser.
*   **GitHub Tokens**: If you provide a GitHub Personal Access Token, it is encrypted using AES-GCM and stored exclusively within your browser's internal extension storage (`chrome.storage.local`). The extension never transmits your token to any third-party backend; it is sent only to official GitHub APIs (`api.github.com`) via secure HTTPS connections.
*   **Repository Data**: Any files or repositories you download are processed in your browser's memory and saved directly to your local file system via the browser's download manager. No repository content is ever uploaded to or stored on our servers.

## 2. Third-Party Services

GitHub Smart Downloader interacts exclusively with official GitHub endpoints:
*   `github.com`
*   `api.github.com`
*   `raw.githubusercontent.com`
*   `codeload.github.com`

All communications with these services are encrypted via HTTPS.

## 3. Data Security

We implement industry-standard security measures to protect your local data:
*   **Encryption**: Sensitive information (GitHub Tokens) is encrypted before storage.
*   **Permissions**: We follow the principle of least privilege, requesting only the permissions strictly necessary for the extension's functionality.

## 4. Changes to This Policy

We may update our Privacy Policy from time to time. We will notify you of any changes by updating the "Last Updated" date at the top of this document.

## 5. Contact Us

If you have any questions about this Privacy Policy, please contact us at `serdar@serdardundar.dev`.
