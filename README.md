<div align="center">
  <img src="assests/icon/icon.png" alt="Kivo Logo" width="128" height="128">

  # Kivo

  **A minimal, fast, and modern desktop HTTP client built with Rust and Tauri**
  
  **Author**: TrisH0x2A

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
  [![Rust](https://img.shields.io/badge/Rust-1.77+-orange.svg)](https://www.rust-lang.org/)
  [![Tauri](https://img.shields.io/badge/Tauri-2.0-blue.svg)](https://tauri.app/)
  [![React](https://img.shields.io/badge/React-19-lightblue.svg)](https://react.dev/)
  [![Vite](https://img.shields.io/badge/Vite-7-purple.svg)](https://vitejs.dev/)

  ![Kivo Banner](/assests/banner/banner-dark.jpg)
</div>

## Overview

Kivo is a fast, local-first API client for developers who want a capable desktop workflow without losing control of their data. It supports everyday HTTP work as well as GraphQL, gRPC, realtime streams, scripting, load testing, collection runs, and rich import/export flows.

## Features

- **Cross-Platform Support**: Native builds for Windows (MSI/NSIS), macOS (Silicon/Intel DMG), and Linux (DEB/RPM).
- **Protocol Coverage**: HTTP, GraphQL, gRPC with proto files or server reflection, WebSocket, SSE, and Socket.IO.
- **Multipart & Binary Workflows**: Multipart file fields, raw file uploads, binary response preservation, and response export.
- **Collection Runner**: Run HTTP/GraphQL requests in order with folder scoping, retries, script assertions, and result summaries.
- **Multi-Scope Environments**: Manage workspace variables, collection overrides, and active workspace environments.
- **Hierarchical Collections**: Organize requests into workspaces, collections, folders, and pinned request tabs.
- **Request History**: Persist recent request runs with sensitive query values redacted.
- **Advanced Network Controls**: Redirect settings, timeouts, cookie jar, proxy overrides, proxy auth, custom CA, and mTLS client certificate paths.
- **Security**: Local-first data storage, encrypted sensitive auth/app-settings fields, and hardened request script execution.
- **Import / Export**: Kivo full-fidelity exports plus Postman, OpenAPI 3, Swagger 2, and Bruno-compatible flows for supported request types.
- **JSON Response Query Engine**: Filter and search JSON response bodies using text search, conditional expressions (`userid > 3`), compound queries (`age > 20 && status == active`), and logical operators. See the [engine documentation](docs/json-query-engine.md) for details.
- **Expanded Auth Support**: Basic Auth, Bearer, API Key, OAuth 2.0 flows, token refresh, and environment-aware inheritance.
- **Request Scripts Panel**: Pre-request and after-response JavaScript editors with snippets, logs, tests, and script vars.
- **Load Testing**: Run local load tests with latency, throughput, and status summaries.
- **Modern Desktop UI**: Keyboard shortcuts, theme packs, square-edged panels, settings management, and a built-in updater.

## Download Kivo (v0.4.1)

Get the latest stable version for your operating system:

| Platform | Installer | Architecture |
| :--- | :--- | :--- |
| **Windows** | [Download .exe](https://github.com/TrisH0x2A/Kivo/releases/download/v0.4.1/Kivo_0.4.1_x64-setup.exe) / [.msi](https://github.com/TrisH0x2A/Kivo/releases/download/v0.4.1/Kivo_0.4.1_x64_en-US.msi) | `x64` |
| **macOS** | [Apple Silicon .dmg](https://github.com/TrisH0x2A/Kivo/releases/download/v0.4.1/Kivo_0.4.1_aarch64.dmg) | `arm64` |
| **macOS** | [Intel .dmg](https://github.com/TrisH0x2A/Kivo/releases/download/v0.4.1/Kivo_0.4.1_x64.dmg) | `x64` |
| **Linux** | [Download .deb](https://github.com/TrisH0x2A/Kivo/releases/download/v0.4.1/Kivo_0.4.1_amd64.deb) | `x64` |
| **Linux** | [Download .rpm](https://github.com/TrisH0x2A/Kivo/releases/download/v0.4.1/Kivo-0.4.1-1.x86_64.rpm) | `x64` |

*For other formats and old releases, visit the [Releases page](https://github.com/TrisH0x2A/Kivo/releases).*

### Linux Installation Guide

- **Debian / Ubuntu**:
  ```bash
  sudo apt install ./Kivo_0.4.1_amd64.deb
  ```
- **Fedora / RHEL**:
  ```bash
  sudo dnf install ./Kivo-0.4.1-1.x86_64.rpm
  ```
- **Arch / Other (RPM via rpm tool)**:
  ```bash
  sudo rpm -i --nodeps --nosignature ./Kivo-0.4.1-1.x86_64.rpm
  ```

---

## Build from Source

### Prerequisites

- Node.js (v18 or later)
- pnpm (Recommended)
- Rust toolchain (v1.77 or later)

### Installation

1. Clone the repository
   ```bash
   git clone https://github.com/TrisH0x2A/Kivo.git
   cd Kivo
   ```

2. Install frontend dependencies
   ```bash
   pnpm install
   ```

3. Run in development mode
   ```bash
   pnpm dev
   ```

### Building for Production

To create a production-ready bundle for your current platform:

```bash
pnpm build
```

The installer will be generated in the `desktop/target/release/bundle` directory.

## Contributing

Contributions are welcome! If you have suggestions for improvements or encounter any bugs, please feel free to open an issue or submit a pull request.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Changelog

### v0.4.1 (2026-04-23)

- **feat**: add collection folders with nested structure support
- **feat**: add request settings improvements and folder-level controls
- **feat**: add folder menu parity with copy/paste and show-in-files actions
- **feat**: add collection-level folder paste support for cross-collection workflows
- **fix**: preserve scope body state and stabilize JSON persistence
- **fix**: persist and normalize GraphQL body/variables more reliably
- **fix**: trim auth payload values before save/send
- **chore**: restore newline storage handling

### v0.4.0 (2026-04-22)

- **feat**: add oauth2 auth flow with native exchange
- **feat**: add app settings page with storage management
- **feat**: modernize app settings UI & navigation
- **feat**: add dot-path and prefix queries for JSON filtering
- **feat**: add cancellable loading state for responses
- **feat**: add report issue link & support resources
- **feat**: add sonner toasts for improved notifications
- **feat**: add exchange cancel support for OAuth flow
- **fix**: major refactor to stabilize auth panel inputs
- **fix**: align settings pane width and responsiveness
- **fix**: stack app settings sections for better layout
- **fix**: normalize storage path logic to Kivo root
- **fix**: preserve settings sidebar tab state
- **fix**: decouple sidebar select toggle logic
- **fix**: resolve auth environment variable exporting
- **fix**: update auth test fixtures and validation
- **fix**: trim refresh inputs and handle cursor drift
- **Note**: This project has officially migrated from `dexter-xD/Kivo` to `TrisH0x2A/Kivo`.

### v0.3.6 (2026-04-19)

- **Expanded Auth Support**. Added Basic Auth and API Key (Header/Query) with collection-level inheritance.
- **JSON Query Engine v1**. Integrated a high-performance, index-backed engine for real-time response filtering.
- **Smart Env Autocomplete**. Added `{{` triggered suggestions with arrow-key navigation and Tab selection.
- **UI & Performance**. Refined JSON tree visualization, added bulk-edit mode, and fixed state normalization bugs.

See the full [CHANGELOG.md](CHANGELOG.md) for more details.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Tauri](https://tauri.app/) for the excellent desktop application framework
- [Rust](https://www.rust-lang.org/) for providing the performance and safety
- [React](https://react.dev/) and [Tailwind CSS](https://tailwindcss.com/) for the modern frontend stack
- [Lucide](https://lucide.dev/) for the beautiful icon set
