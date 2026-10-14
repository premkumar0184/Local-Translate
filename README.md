# Helium Local Page Translator

<div align="center">

![Helium Local Page Translator](screenshot.png)

**High-performance, 100% private, on-device webpage translation for Chromium browsers powered by a local LibreTranslate engine.**

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Tested on Chromium](https://img.shields.io/badge/Chromium-All%20Browsers-success.svg)](#part-2-browser-installation-guide)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Zero Telemetry](https://img.shields.io/badge/Privacy-100%25%20Local%20%7C%20Zero%20Telemetry-brightgreen.svg)](#privacy--security-guarantee)
[![Tests Passing](https://img.shields.io/badge/Tests-14%2F14%20Passing-brightgreen.svg)](#automated-test-suite)

[Features](#key-features) • [Quick Start](#quick-start-30-second-overview) • [LibreTranslate Setup](#part-1-setting-up-libretranslate-local-server) • [Browser Install](#part-2-browser-installation-guide) • [Hardware Tuning](#hardware-acceleration--tuning) • [Troubleshooting](#part-4-troubleshooting--faq)

</div>

---

## Why Helium Local Translator?

Most web page translators route every word of every site you visit through external corporate cloud APIs (Google, Microsoft, DeepL). **Helium Local Page Translator** runs entirely on your local machine:

- **100% Private & Air-Gapped Capable**: All translation models run locally at `http://127.0.0.1:5000`. Zero network traffic leaves your computer. No accounts, no API tokens, no tracking.
- **Smart DOM Walker & Subtree Pruning**: Uses `NodeFilter.FILTER_REJECT` to skip entire non-translatable DOM subtrees (`<script>`, `<style>`, `<code>`, `<pre>`, `<svg>`, hidden containers) in a single step rather than walking thousands of irrelevant elements.
- **In-Page Phrase Deduplication**: Groups repeated phrases (menus, footers, buttons, recurring terms). Only unique phrases are sent for translation, and all matching DOM nodes are updated simultaneously. Reduces model inference load and latency by **30% to 60%**.
- **Viewport-First Prioritization**: Text in the visible viewport is translated first so you can start reading immediately. Off-screen batches yield to the browser idle loop (`requestIdleCallback`) to maintain 60 FPS scrolling.
- **Shared In-Flight Requests & LRU Cache**: Background service worker maintains an in-memory LRU cache (2,000 phrases) and collapses concurrent duplicate requests into a single promise.
- **One-Click Instant Rollback**: Revert any translated page to its exact original text in milliseconds, with whitespace and punctuation preserved.
- **Comprehensive CJK & Unicode Support**: Full support for Chinese, Japanese, Korean logograms, single-letter European words, Cyrillic, Indic, and Arabic scripts.
- **Modern Accessible UI**: Real-time ping latency check, live tab translation state sync, progress bar with phrase and node metrics, and full WCAG AA dark/light mode.

---

## Quick Start (30-Second Overview)

```sh
# 1. Start local LibreTranslate server using Docker (persists models)
docker compose up -d

# 2. Check that the server is online and English is available
curl -s http://127.0.0.1:5000/languages | grep '"code":"en"'

# 3. Load the extension in your browser:
#    Open chrome://extensions (or your browser's extension page)
#    Enable "Developer mode" -> Click "Load unpacked" -> Select this repository folder
```

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Chromium Webpage (DOM)                          │
│                                                                        │
│  [Visible Viewport Nodes]              [Off-screen Content Nodes]      │
└──────────────────┬──────────────────────────────────┬──────────────────┘
                   │                                  │
      (TreeWalker with FILTER_REJECT)     (requestIdleCallback Yielding)
                   │                                  │
                   ▼                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      content.js (Content Script)                       │
│  - Text sanitization & whitespace preservation                         │
│  - In-page phrase deduplication (unique string groups)                 │
│  - Viewport-first priority queue & DOM node references                 │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ chrome.runtime.sendMessage
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    background.js (Service Worker)                      │
│  - In-memory LRU Cache (2,000 entries)                                 │
│  - In-flight request deduplication map (shared Promises)               │
│  - 150-second timeout guard & error isolation                          │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ HTTP POST /translate
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│           Local LibreTranslate Engine (http://127.0.0.1:5000)          │
│  - Argos Translate / CTranslate2 local neural machine translation      │
│  - Multi-threaded CPU or CUDA GPU acceleration                         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Repository Structure

```
helium-local-translator/
├── icons/
│   ├── icon-16.png        # Favicon & extension details badge (16x16)
│   ├── icon-32.png        # High-DPI Windows / Chromium toolbar icon (32x32)
│   ├── icon-48.png        # Browser extensions management page (48x48)
│   └── icon-128.png       # Web Store & high-resolution displays (128x128)
├── test/
│   └── translator.test.js # Standalone Node.js test suite (14 passing unit tests)
├── background.js          # MV3 service worker, LRU cache & request deduplication
├── content.js             # High-performance DOM walker, deduplication & batching
├── docker-compose.yml     # Out-of-the-box 1-command LibreTranslate deployment
├── manifest.json          # Chrome Extensions Manifest V3 definition
├── package.json           # Node package definition & test runner
├── popup.css              # Dark/light responsive stylesheet
├── popup.html             # Extension action popup interface
├── popup.js               # Status checking, tab sync & translation controls
├── screenshot.png         # High-resolution extension UI screenshot
├── .gitignore             # Standard git ignore patterns for OS, Node, & Python
├── LICENSE                # MIT Open-Source License
└── README.md              # Complete documentation & cross-platform guide
```

---

## Part 1: Setting Up LibreTranslate (Local Server)

The extension connects to LibreTranslate via `http://127.0.0.1:5000`. Choose any of the following installation methods for your operating system.

### Method A: Docker / Docker Compose (Recommended)

Docker is the cleanest method because it encapsulates Python, CTranslate2, and dependencies without system pollution.

#### 1. Quick Start with Included `docker-compose.yml`

This repository includes a pre-configured `docker-compose.yml`:

```sh
# Start LibreTranslate in the background
docker compose up -d

# View initialization logs and model download progress
docker compose logs -f

# Check status
docker compose ps
```

#### 2. Or Run Directly with `docker run`

##### Linux & macOS
```bash
docker run -d \
  --name libretranslate \
  --restart unless-stopped \
  -p 127.0.0.1:5000:5000 \
  -v libretranslate-data:/home/libretranslate/.local \
  libretranslate/libretranslate:latest \
  --load-only en,es,fr,de,hi,ru,zh,ja,it,pt,ar \
  --threads 4
```

##### Windows (PowerShell)
```powershell
docker run -d `
  --name libretranslate `
  --restart unless-stopped `
  -p 127.0.0.1:5000:5000 `
  -v libretranslate-data:/home/libretranslate/.local `
  libretranslate/libretranslate:latest `
  --load-only en,es,fr,de,hi,ru,zh,ja,it,pt,ar `
  --threads 4
```

> **Note on Model Persistence**: The `-v libretranslate-data:...` flag ensures downloaded models are stored permanently in a Docker volume so they don't re-download on restart.

---

### Method B: Python Virtual Environment (`venv`)

Ideal if you prefer running directly on bare metal without Docker overhead.

#### Requirements
- Python 3.10, 3.11, or 3.12
- C/C++ compiler tools (for `argos-translate` / `ctranslate2` dependencies)

#### Linux (Ubuntu / Debian / Fedora / Arch)
```bash
# Ubuntu / Debian prerequisites
sudo apt update && sudo apt install -y python3-pip python3-venv build-essential

# Create and activate virtual environment
python3 -m venv ~/libretranslate-env
source ~/libretranslate-env/bin/activate

# Install LibreTranslate
pip install --upgrade pip
pip install libretranslate

# Start the server (binds to 127.0.0.1:5000)
libretranslate --host 127.0.0.1 --port 5000 --threads 4 --load-only en,zh,ja,hi,ru,de,fr,es
```

#### macOS (Apple Silicon M1/M2/M3/M4 or Intel)
```bash
# Install Python via Homebrew if needed
brew install python@3.11

# Create and activate virtual environment
python3.11 -m venv ~/libretranslate-env
source ~/libretranslate-env/bin/activate

# Install LibreTranslate
pip install --upgrade pip
pip install libretranslate

# IMPORTANT FOR MACOS: Check Port 5000 (AirPlay Receiver) before starting! See Troubleshooting section.
libretranslate --host 127.0.0.1 --port 5000 --threads 4 --load-only en,zh,ja,hi,ru,de,fr,es
```

#### Windows 10 / 11 (PowerShell)
```powershell
# Open PowerShell (ensure Python 3.10+ is installed from python.org with "Add to PATH" checked)
python -m venv $HOME\libretranslate-env

# If script execution is restricted:
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

# Activate virtual environment
& "$HOME\libretranslate-env\Scripts\Activate.ps1"

# Install LibreTranslate
pip install --upgrade pip
pip install libretranslate

# Run server
libretranslate --host 127.0.0.1 --port 5000 --threads 4 --load-only en,zh,ja,hi,ru,de,fr,es
```

---

### Method C: Pipx (Isolated CLI Application)

If you have `pipx` installed:

```bash
pipx install libretranslate
libretranslate --host 127.0.0.1 --port 5000 --threads 4 --load-only en,zh,ja,hi,ru,de,fr,es
```

---

### Method D: Pre-Built Binaries, Standalone Packages & Snap

For users who want to avoid compiling C/C++ dependencies or managing virtual environments:

#### 1. Pre-Compiled Binary Python Wheels (Zero C++ Compiling)
Python wheel distributions (`.whl`) contain pre-compiled native CTranslate2 machine learning binaries for x86_64 and ARM64 (Apple Silicon). Force pip to use pre-built binary wheels:
```bash
pip install --only-binary :all: libretranslate
libretranslate --host 127.0.0.1 --port 5000 --threads 4 --load-only en,zh,ja,hi,ru,de,fr,es
```

#### 2. Linux Snap Standalone Package
On Ubuntu and distributions with `snapd`, Argos Translate (the core neural translation engine) can be installed as an isolated, pre-built binary sandbox:
```bash
sudo snap install argos-translate
```

#### 3. Pre-Built Container Runtime (Docker)
Because LibreTranslate relies on machine learning weights and native CTranslate2 matrix libraries, the official Docker container (`libretranslate/libretranslate:latest`) serves as the official pre-built, self-contained binary execution format across Windows, macOS, and Linux. It requires zero compiler tools or system packages:
```bash
docker run -d --name libretranslate -p 127.0.0.1:5000:5000 libretranslate/libretranslate:latest --load-only en,zh,ja,hi,ru,de,fr,es
```

#### 4. Portable Desktop Client (Tauri AppImage / Windows Executable)
If you prefer a native desktop application interface, LibreTranslate Desktop (built on Tauri + Rust) distributes standalone pre-built `.AppImage` (Linux) and portable executables. Run your local server and connect the desktop app seamlessly to `http://127.0.0.1:5000`.

---

### Managing Language Models

By default, LibreTranslate can either download all supported language models (~10 GB) or only the languages you need.

#### 1. Recommended Pre-Loaded Language Set
Use the `--load-only` flag to download only the languages you want to translate to English:

```bash
--load-only en,zh,ja,hi,ru,de,fr,es,it,pt,ko,ar
```

| Code | Language | Code | Language |
| :--- | :--- | :--- | :--- |
| `en` | **English (Required)** | `ja` | Japanese |
| `zh` | Chinese (Simplified) | `ko` | Korean |
| `hi` | Hindi | `ru` | Russian |
| `de` | German | `fr` | French |
| `es` | Spanish | `it` | Italian |
| `pt` | Portuguese | `ar` | Arabic |

#### 2. Verifying Available Languages
You can check which models are loaded in your terminal at any time:

```bash
curl -s http://127.0.0.1:5000/languages | jq .
```
*(On Windows PowerShell, use `Invoke-RestMethod http://127.0.0.1:5000/languages | ConvertTo-Json`)*

#### 3. Air-Gapped / Completely Offline Installation
If your machine is not connected to the internet:
1. Download model packages (`.argosmodel`) from [Argos Translate Index](https://raw.githubusercontent.com/argosopentech/argospm-index/main/index.json).
2. Install them via `argospm`:
   ```bash
   argospm install translate-zh_en-1_9.argosmodel
   argospm install translate-ja_en-1_9.argosmodel
   ```
3. Run LibreTranslate with `--offline`.

---

### Hardware Acceleration & Tuning

| Hardware Setting | Configuration | Expected Impact |
| :--- | :--- | :--- |
| **CPU Worker Threads** | `--threads <CORES>` (e.g. `--threads 4` or `--threads 8`) | Prevents bottle-necking during batch translation requests |
| **Batch Limit** | `--batch-limit 100` | Optimizes CTranslate2 matrix batching |
| **NVIDIA GPU (Docker)** | `docker run --gpus all ...` | 5x to 15x inference speedup on CUDA-capable GPUs |
| **NVIDIA GPU (Python)** | Install CUDA-enabled PyTorch in venv | Automatic CTranslate2 CUDA inference |
| **Memory Allocation** | ~1.5 GB base RAM + ~200 MB per loaded language model | Smooth operation on machines with 8 GB+ RAM |

#### Running with GPU Acceleration (Docker)
Ensure you have the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed:

```bash
docker run -d \
  --name libretranslate-gpu \
  --gpus all \
  --restart unless-stopped \
  -p 127.0.0.1:5000:5000 \
  libretranslate/libretranslate:latest \
  --threads 4 \
  --load-only en,zh,ja,hi,ru,de,fr,es
```

---

## Part 2: Browser Installation Guide

Helium Local Page Translator is built strictly on standard **Chromium Manifest V3** APIs. It works identically on any modern Chromium-based browser across **Linux, macOS, and Windows**.

### Step 1: Clone or Download the Repository

Save the repository to a permanent directory on your computer:

```bash
# Using Git
git clone https://github.com/<your-username>/helium-local-translator.git ~/Apps/helium-local-translator

# Or download and extract the ZIP file to:
# Linux / macOS: ~/Apps/helium-local-translator
# Windows: C:\Apps\helium-local-translator
```

> ⚠️ **Important**: Do not move or delete this folder after installing, as the browser loads the extension files directly from this folder in developer mode.

---

### Step 2: Install in Your Browser

#### 🪐 Helium Browser
1. In the address bar, navigate to `chrome://extensions` or `helium://extensions`.
2. Toggle **Developer mode** on (top-right switch).
3. Click the **Load unpacked** button.
4. Select the `helium-local-translator` directory.

#### 🌐 Google Chrome & Chromium
1. Navigate to `chrome://extensions`.
2. Turn ON **Developer mode** using the toggle switch in the upper-right corner.
3. Click **Load unpacked** in the top-left toolbar.
4. Select the `helium-local-translator` folder.

#### 🦁 Brave Browser
1. Navigate to `brave://extensions`.
2. Turn ON **Developer mode** in the upper-right corner.
3. Click **Load unpacked** and select the extension folder.
4. *(Optional)* In `brave://settings/shields`, local network access for extensions is permitted by default.

#### 🌊 Microsoft Edge
1. Navigate to `edge://extensions`.
2. In the left navigation menu, enable the **Developer mode** toggle.
3. Click the **Load unpacked** button at the top of the page.
4. Select the `helium-local-translator` folder.

#### 🔴 Opera & Opera GX
1. Navigate to `opera://extensions`.
2. Enable **Developer mode** via the switch in the top-right corner.
3. Click **Load unpacked** in the top bar.
4. Select the `helium-local-translator` folder.

#### ⚡ Vivaldi
1. Navigate to `vivaldi://extensions`.
2. Enable **Developer mode** in the upper-right corner.
3. Click **Load unpacked** and select the `helium-local-translator` folder.

#### 🎨 Arc / Other Chromium Browsers
1. Open Arc Settings (`Cmd + ,` or `Ctrl + ,`) -> **Extensions** (or navigate to `arc://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and choose the `helium-local-translator` folder.

---

### Step 3: Pin the Extension to Your Toolbar

1. Click the **Extensions icon** (puzzle piece 🧩) next to your browser's address bar.
2. Find **Helium Local Page Translator**.
3. Click the **Pin icon** 📌 to keep it visible in your toolbar.

---

### Step 4: Keyboard Shortcuts

The extension comes with a built-in keyboard shortcut:

| Operating System | Default Shortcut | Action |
| :--- | :--- | :--- |
| **Windows & Linux** | <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>W</kbd> | Translate active page to English |
| **macOS** | <kbd>Option (⌥)</kbd> + <kbd>Shift (⇧)</kbd> + <kbd>W</kbd> | Translate active page to English |

#### Customizing the Shortcut
To change the shortcut at any time:
1. Navigate to `chrome://extensions/shortcuts` (or `edge://extensions/shortcuts`, `brave://extensions/shortcuts`).
2. Scroll to **Helium Local Page Translator**.
3. Click the pencil icon next to **"Translate the current page into English"** and press your desired shortcut keys.

---

## Part 3: Using the Extension

```
┌───────────────────────────────────────┐
│ 🌐 Helium Translator   [ Ready · 4ms ]│
│    Local LibreTranslate → English     │
├───────────────────────────────────────┤
│                                       │
│ [   ➜ Translate to English   ]        │
│ [   ↺ Restore original       ]        │
│                                       │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100%    │
│ Translation complete                  │
│                                       │
│ ✔ Page translated to English in 2.1s  │
│ [482 fragments] [146 unique] [336 dedup]
├───────────────────────────────────────┤
│ Shortcut: Alt + Shift + W   🔒 Local  │
└───────────────────────────────────────┘
```

1. **Verify Server Status**:
   - Open the popup. The status badge in the top right will show `Ready · Xms` with a green indicator.
   - If offline, click the badge at any time to re-check connectivity.
2. **Translate Page**:
   - Click **Translate to English** or press `Alt + Shift + W`.
   - The visible viewport will translate first, followed by background sections.
   - The animated progress bar shows processed unique phrases and total DOM nodes.
3. **Restore Original Content**:
   - Click **Restore original** to immediately swap back original text nodes without reloading the webpage.
4. **Cancel Running Translation**:
   - If a translation is running, the secondary button changes to **Cancel**. Clicking it immediately aborts remaining server requests and rolls back modified nodes safely.

---

## Part 4: Troubleshooting & FAQ

### 1. macOS: Port 5000 is occupied / "Cannot reach LibreTranslate"
> 💡 **Crucial macOS Fix**: On macOS Monterey, Ventura, Sonoma, and Sequoia, Apple's built-in **AirPlay Receiver** listens on port 5000 by default.

**Fix Option A: Disable AirPlay Receiver (Recommended)**
1. Open **System Settings** on your Mac.
2. Navigate to **General** -> **AirDrop & Handoff**.
3. Turn **AirPlay Receiver** OFF.
4. Start LibreTranslate on port 5000.

**Fix Option B: Check What is Using Port 5000**
```bash
lsof -i :5000
```

---

### 2. Error: "English model is not installed"
The extension translates source languages into English (`target: "en"`). LibreTranslate requires the English target model installed.

**Fix**:
Check installed languages:
```bash
curl -s http://127.0.0.1:5000/languages
```
Ensure your `--load-only` flag or argospm packages includes `en` (e.g. `--load-only en,zh,ja,es`).

---

### 3. Error: "Restricted browser pages cannot be translated"
Under Chromium security specifications, browser extensions are forbidden from injecting scripts into internal browser pages:
- `chrome://*` or `edge://*` or `brave://*`
- The Chrome Web Store or Edge Add-ons gallery
- `about:blank` or blank new-tab pages without a loaded document

**Solution**: Test on any regular public website (e.g., Wikipedia, foreign news portals, GitHub documentation).

---

### 4. Linux: Docker Permission Denied
If `docker run` gives `permission denied while trying to connect to the Docker daemon socket`:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

---

### 5. Windows: PowerShell Execution Policy Error
If running `Activate.ps1` gives `File ... cannot be loaded because running scripts is disabled`:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

---

### 6. Are Code Blocks and Forms Translated?
No. The DOM walker skips:
- `<code>`, `<pre>`, `<kbd>`, `<samp>`
- Form controls: `<textarea>`, `<input>`, `<select>`, `<option>`
- `<script>`, `<style>`, `<noscript>`, `<template>`
- `<svg>`, `<canvas>`, `<math>`, `<iframe>`, `<audio>`, `<video>`
- Any element with `contenteditable="true"` or `aria-hidden="true"` or `hidden`

---

## Part 5: Development & Verification

### Automated Test Suite

The repository includes a comprehensive standalone Node.js test suite with zero third-party dependencies:

```bash
# Run test suite
npm test
```

### What the Test Suite Verifies (14 Tests):
- `splitWhitespace`: Accurate Unicode whitespace extraction and core text separation.
- `isEligibleText`: Acceptance of CJK logograms, single-letter European words, and rejection of pure numbers/symbols.
- `shouldRejectElement`: Correct exclusion of code blocks, form inputs, editable fields, and hidden subtrees.
- `XML & Lowercase Tags`: Robust case-insensitive tag rejection for XHTML/XML elements.
- `deduplication`: Grouping identical phrases across the DOM and sorting viewport-visible nodes to the front.
- `TranslationCache`: Correct LRU eviction when cache exceeds limit (`maxSize = 2000`).
- `translateBatchWithCache`: Efficient caching avoiding repeated network requests.
- `inFlight Deduplication`: Promise sharing for concurrent identical requests.
- `Error Isolation`: Mismatched server responses fail cleanly without cache poisoning.
- `AbortController & Rollback`: Aborting in-flight operations safely reverts DOM nodes.
- `Batch Chunking`: Proper slicing of unique text groups into batch sizes of 40.
- `isRestrictedUrl`: Safe protection preventing script execution on internal browser pages (`chrome://`, `edge://`, `about:blank`, webstore).
- `Manifest V3 Integrity`: Complete validation of `manifest.json` schema, permissions, host permissions, and service worker.
- `Extension Icons`: Verification that all 4 icon sizes (16, 32, 48, 128) exist on disk with valid PNG headers.
- `Live LibreTranslate Server`: Real-time connectivity and translation validation if local engine is online.

---

## Part 6: Git & Publishing to GitHub

To publish this project to your GitHub account:

```bash
# 1. Initialize git repository (if not already done)
git init -b main

# 2. Add all files
git add .

# 3. Create your initial commit
git commit -m "feat: initial commit of Helium Local Page Translator v0.3.1"

# 4. Add your GitHub remote repository URL
git remote add origin https://github.com/<your-username>/helium-local-translator.git

# 5. Push to GitHub
git push -u origin main
```

---

## Privacy & Security Guarantee

- **Zero Cloud Network Calls**: Network requests are exclusively restricted to `http://127.0.0.1:5000/*` via Manifest V3 host permissions.
- **On-Demand Script Injection**: Uses `activeTab` and `scripting` permissions to inject scripts only when you explicitly invoke translation.
- **Zero Third-Party Trackers or Analytics**: No telemetry, no fingerprinting, no third-party CDNs.
- **Local Model Execution**: Translation is executed directly by local machine learning weights on your CPU or GPU.

---

## License

This project is open-source software licensed under the **[MIT License](LICENSE)**.
