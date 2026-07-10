# Change Log

All notable changes to this project will be documented in this file.

## [0.4.1]. 2026-04-23

### v0.4.1: Folder Hierarchy, Settings, and Workflow Refinements
- **feat**: add collection folders with nested structure support
- **feat**: add request settings improvements and folder-level controls
- **feat**: add folder menu parity with copy/paste and show-in-files actions
- **feat**: add collection-level folder paste support for cross-collection workflows
- **fix**: preserve scope body state and stabilize JSON persistence
- **fix**: persist and normalize GraphQL body/variables more reliably
- **fix**: trim auth payload values before save/send
- **chore**: restore newline storage handling

**Author**: TrisH0x2A.

## [0.4.0]. 2026-04-22

### v0.4.0: OAuth 2.0 Integration & Modernized Workspace
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

**Note**: This project has officially migrated from `dexter-xD/Kivo` to `TrisH0x2A/Kivo`.
**Author**: TrisH0x2A.

## [0.3.6]. 2026-04-18

### v0.3.6: Expanded Auth Support & JSON Query Engine

- **feat**: Expanded Auth Support. New support for Basic Auth and API Key (Header/Query) with inheritance.
- **feat**: Environment Autocomplete. Triggered by `{{`, supports arrow-key navigation and Tab selection.
- **feat**: Kivo JSON Query Engine v1. High-performance, index-backed engine for real-time response filtering.
- **feat**: Enhanced Variable Highlighting. Robust syntax highlighting in URL and Auth fields.
- **feat**: JSON Tree Filtering. Expression-based search with dynamic node highlighting.
- **feat**: UI Polish. Bulk edit mode for headers, quick-copy for JSON nodes, and rich response visualization.
- **fix**: Resolved state normalization bugs that stripped auth fields during rapid typing.
- **fix**: Fixed header deletion and response persistence issues.

## [0.3.5]. 2026-04-12

### v0.3.5: Cross-Platform Storage & Smart Setup

- **feat**: Improved default storage paths for macOS and Linux (Documents → Home → AppData).
- **feat**: New "Create Kivo Subfolder" toggle with auto-detection to prevent nested data.
- **feat**: Smarter path separator handling and dynamic placeholders based on detected OS.
- **fix**: Absolute path detection now uses `Path::is_absolute()` for better reliability.

## [0.3.4]. 2026-04-11

### v0.3.4: macOS & Linux RPM Support

- **macOS Support**: Native DMG and App bundles for both Apple Silicon and Intel Macs.
- **Native UX**: Transparent titlebar with overlay traffic lights and drag-region support for a better macOS experience.
- **Linux Expansion**: Added `.rpm` package support alongside `.deb` for broader Linux compatibility.
- **CI/CD**: Fully automated release pipeline for Windows, Linux (DEB/RPM), and macOS (DMG).

## What's Changed
* feat: add macOS build support (Intel + Apple Silicon DMGs) by @sriannamalai in https://github.com/TrisH0x2A/Kivo/pull/4

## New Contributors
* @sriannamalai made their first contribution in https://github.com/TrisH0x2A/Kivo/pull/4

## [0.3.3]. 2026-04-08

### Hotfix: Native Auto-Updater

- **Fixed**: Corrected a CI publishing issue where `latest.json` was missing from release artifacts.
- **New**: Backports the Auto-Updater. Kivo now automatically checks for, silently downloads, and prepares updates under the hood.
- **New**: Seamless Upgrades UI. Apply downloaded updates instantly via a Toast notification or manually check inside Collection Settings.
- **Security**: Signed Binaries. Cryptographically secure Tauri signatures are exclusively utilized.

## [0.3.2]. 2026-04-08

### This release introduces Native Auto-Updates.

- **New**: Auto Updater. Kivo now automatically checks for, silently downloads, and prepares updates in the background, minimizing disruptions.
- **New**: Seamless Upgrades. You can now restart and apply updates whenever you are ready via a clean Toast notification or directly from the Collection Settings panel.
- **Security**: Signed Binaries. All updates are now distributed and verified utilizing Tauri's cryptographically secure signatures.

## [0.3.1]. 2026-04-06

### Fixed

- **Collection Data Loss**. When you edit environment variables it no longer removes requests and subfolders from the collection directory.

- **Requests Not Persisted**. New requests are now correctly saved to disk. Stay there even after you restart the app.

- **Request Not Working**. Deleting a request now properly removes its file from disk.

- **Slash Names Breaking Storage**. Collection and request names with `/` or characters are now safely changed for the filesystem while keeping the original display name.

### Changed

- **Storage Robustness**. All serde structs now use defaults stopping silent deserialization failures from corrupting state.

- **Testability**. Core storage logic is now extracted into functions and covered by 59 unit tests across normal, complex and stress scenarios.

## [0.3.0]. 2026-04-05

### Added

- **Multi-Scope Environments**. You can now manage global workspace variables and collection-specific overrides.

- **Modernized Collection Settings**. We completely redesigned the Overview, Headers and Auth pages.

- **Auth Token Visibility**. You can toggle visibility for authentication tokens.

- **Storage Folder Access**. You can now open the data directory directly from the UI.

### Changed

- **Zero-Friction Workflow**. We improved the autosave for deletions and navigation.

- **Navbar Analytics**. We refined environment chips and tooltip summaries.

### Fixed

- **Documents Storage Fallback**. We corrected the path resolution to default to your Documents folder.

- **Auth Save TypeError**. We resolved UI state-to-backend communication bugs.

## [0.2.0]. 2026-04-03

### Added

- **Hierarchical Collection Structure**. You can organize requests into collections within workspaces.

- **Setup Wizard**. We created an onboarding experience to bootstrap application configuration.

- **Sidebar Search**. You can now filter collections and requests in time.

- **Enhanced Context Menus**. We added high-performance logic for cloning, renaming and copy-pasting.

- **Native System Dialogs**. We integrated directory selection for storage paths.

### Changed

- **Name-Based Identifiers**. We created a tracking system for workspaces and collections.

### Fixed

- **"Show in Files" Integration**. We fixed the native folder reveal functionality.

- **Empty State Logic**. We improved UI prompts for workspaces and collections.

## [0.1.1]. 2026-04-02

### Added

- **Open Config Directory**. We added a button to workspaces for access to local data files.

- **Tauri Opener Plugin**. We migrated to Tauris opener plugin for better security and performance.

### Fixed

- **Query Parameter/Header Deletion**. We resolved an issue where query parameters and headers could not be fully deleted.

- **Request Initialization**. We initialized requests with empty parameter and header lists for a cleaner start.

- **GraphQL Variables Editor**. We restored the GraphQL variables editor in the request panel.

## [0.1.0]. 2026-03-31

### Added

- **Initial Release**. Kivo. An fast desktop HTTP client built with Rust and Tauri.

- **Core Features**. It includes request handling, collections, tabbed interface and built-in GraphQL support.

- **Platform Support**. It is available, for Windows and Linux (Debian).
