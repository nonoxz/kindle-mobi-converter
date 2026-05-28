# Kindle MOBI Converter

A lightweight web application for converting ebooks and documents to MOBI, designed for Kindle users.

Built by [nonoxz](https://github.com/nonoxz).

![Kindle MOBI Converter screenshot](assets/screenshot.png)

## Features

- Convert `EPUB`, `PDF`, `DOCX`, `TXT`, `HTML`, `RTF` and `AZW3` files to `MOBI`.
- Convert one file or many files in the same batch.
- Download all converted files as a ZIP archive.
- Review converted files in a results list.
- Rename each MOBI file before downloading it.
- Browser-based upload flow with progress feedback.
- Manual download links for each converted file.
- Backend powered by Node.js and Calibre's `ebook-convert`.
- No npm runtime dependencies.
- Dockerfile included for Linux deployments.

## Requirements

- Node.js 20 or newer
- Calibre installed on the machine running the server
- `ebook-convert` available in `PATH`

## Install Requirements by Operating System

### Linux Ubuntu/Debian

Install Node.js from your distribution packages, NodeSource, `nvm`, or another trusted source. Then install Calibre:

```bash
sudo apt update
sudo apt install calibre
```

Check the converter:

```bash
ebook-convert --version
```

### macOS

Install Node.js from <https://nodejs.org/> or with Homebrew:

```bash
brew install node
```

Install Calibre from <https://calibre-ebook.com/download_osx> or with Homebrew Cask:

```bash
brew install --cask calibre
```

If `ebook-convert` is not found after installing Calibre, add Calibre's command-line tools to your shell path:

```bash
export PATH="/Applications/calibre.app/Contents/MacOS:$PATH"
```

To make that permanent for Zsh:

```bash
echo 'export PATH="/Applications/calibre.app/Contents/MacOS:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Check the converter:

```bash
ebook-convert --version
```

### Windows

Install Node.js from <https://nodejs.org/>. During installation, keep the option that adds Node.js to `PATH` enabled.

Install Calibre from <https://calibre-ebook.com/download_windows>. After installation, `ebook-convert.exe` is usually located at:

```text
C:\Program Files\Calibre2\ebook-convert.exe
```

Add Calibre to your Windows `Path` environment variable:

```text
C:\Program Files\Calibre2
```

Then open a new PowerShell window and verify:

```powershell
ebook-convert --version
```

If PowerShell still does not find it, run the app from a terminal where Calibre is available or restart Windows after updating `Path`.

## Local Usage

Clone the repository and start the server:

```bash
git clone https://github.com/nonoxz/kindle-mobi-converter.git
cd kindle-mobi-converter
npm start
```

Open the app:

```text
http://localhost:3000
```

Then:

1. Choose one or more ebook/document files.
2. Click **Convert to MOBI**.
3. Wait for the upload and batch conversion progress to finish.
4. Review the converted files list.
5. Optionally edit the download name for each MOBI file.
6. Download files one by one, or use **Download ZIP** when multiple files were converted.

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | ---: | --- |
| `PORT` | `3000` | HTTP server port. |
| `MAX_UPLOAD_MB` | `80` | Maximum upload size in megabytes. |
| `CONVERSION_TIMEOUT_MS` | `180000` | Maximum conversion time per file. |

Example:

```bash
PORT=8080 MAX_UPLOAD_MB=120 npm start
```

## Docker

Build and run:

```bash
docker build -t kindle-mobi-converter .
docker run --rm -p 3000:3000 kindle-mobi-converter
```

The Docker image installs Calibre inside the container.

## Deployment Notes

GitHub Pages is not enough for this project because ebook conversion requires a backend process that can run `ebook-convert`.

Recommended deployment targets:

- A Linux VPS with Node.js and Calibre installed.
- Docker on a server.
- A platform that supports custom Docker images.

## Security Notes

This first version is suitable for personal or internal use. Before exposing it publicly, consider adding:

- authentication
- rate limiting
- background job queue
- antivirus scanning or file sandboxing
- scheduled cleanup policies
- external object storage for generated files

## Changelog

Release notes are tracked in [CHANGELOG.md](CHANGELOG.md).

## License

MIT License. See [LICENSE](LICENSE).
