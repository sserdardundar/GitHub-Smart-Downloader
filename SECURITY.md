# Security Policy

## Supported Versions

We currently support and provide security updates for the following versions of GitHub Smart Downloader:

| Version | Supported          |
| ------- | ------------------ |
| 2.2.x   | :white_check_mark: |
| < 2.0.0 | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability within GitHub Smart Downloader, please do not open a public issue. Instead, please report it via one of the following methods:

1.  **GitHub Security Advisory**: Use the "Report a vulnerability" button in the [Security tab](https://github.com/sserdardundar/GitHub-Smart-Downloader/security/advisories/new) of this repository.
2.  **Email**: Send a detailed report to `serdar@serdardundar.dev`.

We aim to acknowledge all reports within 48 hours and provide a fix or mitigation strategy as soon as possible.

### Privacy & Data Handling

GitHub Smart Downloader is designed with a **privacy-first** approach. All repository processing and data packaging occur exclusively within your browser.

- **Token Security**: GitHub Personal Access Tokens are encrypted before being stored in Chrome extension storage. The extension does not send tokens to any third-party backend.
- **Data Locality**: All file downloads and ZIP generation are performed in an Offscreen Document. No repository data is ever transmitted to external servers other than official GitHub endpoints.
