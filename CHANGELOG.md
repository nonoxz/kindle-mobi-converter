# Changelog

All notable changes to this project will be documented in this file.

## [0.3.1] - 2026-05-28

### Fixed

- Increased the default batch upload limit from 80 MB to 250 MB.
- Added explicit HTTP 413 JSON responses when uploads exceed `MAX_UPLOAD_MB`, avoiding a misleading browser connection error.

## [0.3.0] - 2026-05-28

### Added

- Collapsible process details panel below the progress bar.
- Browser-side conversion log with upload progress, server response, converted files, failures and Calibre logs.
- Clear log control for the process details panel.

## [0.2.0] - 2026-05-28

### Added

- Batch conversion support for multiple selected files.
- ZIP download for multi-file conversion results.
- Converted files list with individual download links.
- Per-file download name editing before downloading a MOBI file.
- Clear button to reset selected files, progress and results.

### Changed

- Upload copy now explains that the default upload limit applies to the total request size.
- Conversion progress text now reflects batch processing.

## [0.1.0] - 2026-05-28

### Added

- Initial web app for converting ebooks and documents to MOBI using Calibre.
- Single-file upload and conversion flow.
- Progress feedback during upload and conversion.
- Automatic download and manual download fallback.
- English UI, MIT license, screenshot, Dockerfile and setup instructions for Linux, macOS and Windows.
