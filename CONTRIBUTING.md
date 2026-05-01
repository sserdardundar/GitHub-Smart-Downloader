# Contributing to GitHub Smart Downloader

Thank you for your interest in making GitHub Smart Downloader even better! 🚀 As a high-performance productivity tool, we prioritize stability, speed, and a premium user experience.

---

## 🛠️ Development Philosophy

- **Zero-Freeze Guarantee**: Heavy processing belongs in the `offscreen.js`. Never block the main thread or the content script.
- **Unified Handshake**: All jobs must use the standardized `jobId` lifecycle to ensure synchronization across the background worker, popup, and toasts.
- **Glassmorphic UI**: Every UI element must match our premium design language. Use `backdrop-filter: blur()`, rounded corners (8px-12px), and HSL-based colors.
- **Cancellable Everything**: Every asynchronous loop must listen for an `AbortSignal`.

---

## 🚦 How to Contribute

### 🐛 Reporting Bugs

- Use the **Bug Report** template.
- Include a link to the specific repository or directory where the issue occurred.
- Check the console logs of both the **Service Worker** and the **Offscreen Document** for error messages.

### ✨ Submitting Code

1.  **Fork & Clone**: Standard GitHub flow.
2.  **Load Unpacked**: Load the extension in Chrome (Developer Mode enabled).
3.  **Implement Changes**: Follow the "Code Style" guidelines below.
4.  **Test Thoroughly**: Run `npm test` to verify logic and perform manual functional testing in the browser.
5.  **Submit PR**: Keep your PRs focused and well-documented.

---

## 💻 Code Style & Standards

- **JavaScript**: Use modern ES6+ features. Prefer `async/await` over promise chaining.
- **Naming**: Use the `gd-` prefix for all custom CSS classes and variables to prevent collision with GitHub's native styles.
- **Messaging**: Always use standard message actions defined in `shared.js` or documented in `background.js`.
- **CSS**: Scoped CSS should be injected via the content script using the `gd-` namespace. Use `--gd-accent` for all themeable colors.

---

## 🧱 Architecture Overview

| Context            | Responsibility                                                                |
| ------------------ | ----------------------------------------------------------------------------- |
| `background.js`    | Job coordination, rate-limit management, and lifecycle monitoring.            |
| `offscreen.js`     | Intensive worker-pool management, parallel file fetching, and ZIP generation. |
| `contentScript.js` | UI injection, high-fidelity toasts, and user event delegation.                |
| `shared.js`        | Core logic, URL parsing, encryption, and shared utilities.                    |

---

## 📄 License

By contributing, you agree that your contributions will be licensed under the **MIT License**.
