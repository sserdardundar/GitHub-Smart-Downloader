# Technical Architecture Deep Dive

## 1. Introduction

GitHub Smart Downloader is a high-performance browser extension designed to provide granular and mass download capabilities for GitHub repositories. Unlike standard "Download ZIP" buttons provided by GitHub, GitHub Smart Downloader allows for specific subdirectory selection, multi-item batching, and single-file downloads, all while maintaining a lag-free user experience.

This document provides an exhaustive look at the internal mechanics, design patterns, and performance optimizations that make GitHub Smart Downloader the most reliable repository downloader in the Manifest V3 ecosystem.

---

## 2. The Manifest V3 Paradigm Shift

The transition from Manifest V2 to V3 introduced several critical constraints that directly impacted the design of GitHub Smart Downloader:

### 2.1 The Ephemeral Service Worker

In Manifest V3, the persistent "Background Page" is replaced by a Service Worker. Service Workers are designed to be short-lived; they wake up to handle an event and go back to sleep.

- **The Problem**: Generating a 500MB ZIP file can take several minutes. If the Service Worker is terminated during this process, the download fails.
- **The Solution**: GitHub Smart Downloader uses the **Offscreen Document API**. By moving the heavy binary processing to a hidden DOM context, we ensure that the process can complete regardless of the Service Worker's state.

### 2.2 Memory Constraints

Service Workers have strict memory limits. Handling large Blobs (binary large objects) in the Service Worker context often leads to out-of-memory crashes.

- **Strategy**: We keep the Service Worker as a lightweight "Coordinator" and offload all high-memory operations (like `JSZip` generation) to the Offscreen Document, which has a higher memory ceiling and a standard DOM environment.

---

## 3. Core Contexts & Modules

### 3.1 Background Coordinator (`js/background.js`)

The Background Service Worker acts as the nervous system of the extension. It manages the state and communication between all other parts.

#### 3.1.1 Collaborative Engine Management

The background maintains a global registry of active archives (`hotArchives`) and pending downloads (`pendingArchives`). This allows multiple tabs or separate download jobs targeting the same repository to share a single source archive, dramatically reducing network bandwidth and API consumption.

#### 3.1.2 Job Lifecycle Management

Every download request is assigned a unique `jobId`. The background maintains a `downloadJobs` Map that tracks the state of every active operation:

- `starting`: Initializing metadata.
- `enumerating`: Scanning the repository structure.
- `downloading`: Fetching file contents from GitHub CDN.
- `zipping`: Packaging files into an archive.
- `complete`: Ready for user retrieval.

### 3.2 Content Integration Engine (`js/contentScript.js`)

The Content Script handles DOM injection, selection logic, and event delegation. It uses a custom throttling mechanism and a `MutationObserver` to maintain a native feel on GitHub's SPA architecture.

### 3.3 Offscreen Processing Engine (`js/offscreen.js`)

This is the heavy-lifting context, responsible for binary processing and high-concurrency downloads.

#### 3.3.1 Tiered Memory Pooling

To ensure performance and persistence, the engine implements a tiered caching system:

1.  **RAM Cache**: Immediate access for active and recently used archives.
2.  **IndexedDB (Persistent Disk)**: Stores repository archives across browser sessions and background suspension cycles.
3.  **Sliding TTL**: Archives are automatically evicted after 10 minutes of inactivity to keep memory and disk usage optimal.

#### 3.3.2 Global File Orchestrator

A singleton orchestrator deduplicates individual file fetches across all active jobs. If two different jobs require the same file, the orchestrator joins the existing download instead of initiating a new network request.

---

## 4. Intelligence & Strategy Selection

The `planDownloadStrategy` function evaluates the most efficient approach for every task:

### 4.1 Full Archive Strategy

- **Trigger**: User requests the root of a branch/repo.
- **Benefit**: Zero API cost; direct redirection to GitHub's native ZIP generator.

### 4.2 Surgical Extraction (Filtered Archive)

- **Trigger**: High selection density (90%+) or cache-hit on a shared archive.
- **Benefit**: Opens a full archive in `JSZip` and removes excluded folders. This is the fastest method for large repositories as it avoids recursive API scanning.

### 4.3 Recursive Scan Strategy

- **Trigger**: Sparse or fragmented selections.
- **Benefit**: Extreme precision; only fetches specifically requested files.

---

## 5. Security & Encryption Model

PATs are treated as highly sensitive. Decryption only happens in the Background Service Worker's memory space.

### 5.1 AES-GCM Implementation

1. **Key Generation**: Unique device UUID + high-entropy salt.
2. **Derivation**: **PBKDF2** (100,000 iterations).
3. **Encryption**: **AES-GCM (256-bit)** provides both confidentiality and tamper-resistance.

---

## 6. Performance Optimizations

### 6.1 Shared Resource Handshake

The background and offscreen contexts use a robust ping-loop handshake during initialization to prevent race conditions where tasks are dispatched before the binary engine is ready.

### 6.2 O(1) ZIP Packaging

Uses the `STORE` method by default to eliminate CPU bottlenecks, shifting the focus to network speed.

### 6.3 Memory Watchdog

Monitors metadata overhead (approx 1.5KB per file). If a job exceeds the user-defined memory limit or hits a 50,000-file threshold, the system triggers a safety abort to prevent browser-level process kills.

---

## 7. Error Handling & Resilience

### 7.1 Exponential Backoff

Every fetch operation (individual files or archives) implements 3 retries with exponential backoff to handle transient network flakiness.

### 7.2 Rate Limit Intelligence

Actively tracks `X-RateLimit-*` headers to provide human-readable countdowns and automatic job suspension during peak API usage.

---

## 8. Appendix: Architecture Schema

| Context            | Role          | Primary Tooling                         |
| :----------------- | :------------ | :-------------------------------------- |
| **Service Worker** | Coordinator   | `chrome.storage`, `chrome.runtime`      |
| **Offscreen**      | Binary Engine | `JSZip`, `IndexedDB`, `AbortController` |
| **Content Script** | UI Bridge     | `MutationObserver`, Custom CSS          |
| **Popup**          | Control Panel | Vanilla JS, CSS Variables               |

---

_(End of Technical Architecture Deep Dive)_
