const form = document.querySelector('#convertForm');
const fileInput = document.querySelector('#fileInput');
const fileName = document.querySelector('#fileName');
const statusBox = document.querySelector('#status');
const health = document.querySelector('#health');
const button = document.querySelector('#convertButton');
const clearButton = document.querySelector('#clearButton');
const progressWrap = document.querySelector('#progressWrap');
const progressLabel = document.querySelector('#progressLabel');
const progressPercent = document.querySelector('#progressPercent');
const progressBar = document.querySelector('#progressBar');
const resultsPanel = document.querySelector('#resultsPanel');
const resultsSummary = document.querySelector('#resultsSummary');
const resultsList = document.querySelector('#resultsList');
const failuresList = document.querySelector('#failuresList');
const zipDownload = document.querySelector('#zipDownload');

fileInput.addEventListener('change', () => {
  const files = getSelectedFiles();
  fileName.textContent = formatSelection(files);
  resetProgress();
  setStatus('', '');
  clearResults();
});

clearButton.addEventListener('click', () => {
  fileInput.value = '';
  fileName.textContent = 'Default maximum upload size: 80 MB total';
  resetProgress();
  setStatus('', '');
  clearResults();
});

form.addEventListener('submit', event => {
  event.preventDefault();
  const files = getSelectedFiles();

  if (files.length === 0) {
    setStatus('Choose at least one file before converting.', 'error');
    return;
  }

  convertFiles(files);
});

function convertFiles(files) {
  button.disabled = true;
  clearButton.disabled = true;
  progressWrap.hidden = false;
  setProgress(0, 'Preparing files...');
  setStatus(`Converting ${files.length} file${files.length === 1 ? '' : 's'}. Keep this window open.`, '');
  clearResults();

  const data = new FormData();
  for (const file of files) {
    data.append('file', file);
  }

  const request = new XMLHttpRequest();
  request.open('POST', '/api/convert');
  request.responseType = 'json';
  request.timeout = Math.max(240000, files.length * 180000 + 60000);

  request.upload.addEventListener('progress', event => {
    if (!event.lengthComputable) {
      setProgress(12, 'Uploading files...');
      return;
    }

    const uploadPercent = Math.round((event.loaded / event.total) * 55);
    setProgress(Math.max(4, uploadPercent), 'Uploading files...');
  });

  request.addEventListener('loadstart', () => {
    setProgress(3, 'Starting batch conversion...');
  });

  request.upload.addEventListener('load', () => {
    setProgress(65, 'Files received. Calibre is converting them one by one...');
    progressBar.classList.add('is-working');
  });

  request.addEventListener('load', () => {
    const payload = request.response;

    if (request.status < 200 || request.status >= 300) {
      const message = payload?.error || `Conversion failed with HTTP status ${request.status}.`;
      finishWithError(message, payload);
      return;
    }

    if (!Array.isArray(payload?.files) || payload.files.length === 0) {
      finishWithError('The server finished, but no converted files were returned.', payload);
      return;
    }

    setProgress(100, 'Batch conversion finished.');
    renderResults(payload);
    setStatus(`Converted ${payload.files.length} of ${files.length} file${files.length === 1 ? '' : 's'}.`, payload.failures?.length ? 'warning' : 'success');
    button.disabled = false;
    clearButton.disabled = false;
  });

  request.addEventListener('loadend', () => {
    if (button.disabled && request.status === 0) {
      finishWithError('The server did not respond. Check that the app is still running.');
    }
  });

  request.addEventListener('error', () => {
    finishWithError('Could not connect to the conversion server.');
  });

  request.addEventListener('timeout', () => {
    finishWithError('The conversion took too long and was cancelled by the browser. Try fewer files or increase server timeout settings.');
  });

  request.send(data);
}

async function loadHealth() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const payload = await response.json();
    health.textContent = payload.converterAvailable
      ? 'Calibre is available. The server can convert files.'
      : 'Calibre is not available. Install Calibre to enable real conversions.';
  } catch {
    health.textContent = 'Could not check converter status.';
  }
}

function renderResults(payload) {
  resultsPanel.hidden = false;
  resultsSummary.textContent = `${payload.files.length} file${payload.files.length === 1 ? '' : 's'} ready for download.`;
  resultsList.innerHTML = '';
  failuresList.innerHTML = '';

  if (payload.zip?.downloadUrl) {
    zipDownload.hidden = false;
    zipDownload.href = payload.zip.downloadUrl;
    zipDownload.download = payload.zip.filename;
    zipDownload.textContent = `Download ZIP (${formatBytes(payload.zip.size)})`;
  } else {
    zipDownload.hidden = true;
  }

  for (const file of payload.files) {
    resultsList.append(createResultItem(file));
  }

  if (Array.isArray(payload.failures) && payload.failures.length > 0) {
    const title = document.createElement('h3');
    title.textContent = 'Files not converted';
    failuresList.append(title);

    for (const failure of payload.failures) {
      const item = document.createElement('p');
      item.textContent = `${failure.originalName}: ${failure.error}`;
      failuresList.append(item);
    }
  }
}

function createResultItem(file) {
  const item = document.createElement('article');
  item.className = 'result-item';

  const info = document.createElement('div');
  info.className = 'result-info';

  const title = document.createElement('h3');
  title.textContent = file.originalName;

  const meta = document.createElement('p');
  meta.textContent = `${file.filename} · ${formatBytes(file.size)}`;

  info.append(title, meta);

  const controls = document.createElement('div');
  controls.className = 'result-controls';

  const rename = document.createElement('input');
  rename.type = 'text';
  rename.value = file.suggestedName || file.filename;
  rename.ariaLabel = `Download name for ${file.originalName}`;

  const download = document.createElement('a');
  download.className = 'download-button';
  download.textContent = 'Download';
  download.href = buildDownloadUrl(file.downloadUrl, rename.value);
  download.download = normalizeMobiName(rename.value);

  rename.addEventListener('input', () => {
    download.href = buildDownloadUrl(file.downloadUrl, rename.value);
    download.download = normalizeMobiName(rename.value);
  });

  controls.append(rename, download);
  item.append(info, controls);
  return item;
}

function buildDownloadUrl(downloadUrl, name) {
  const safeName = normalizeMobiName(name);
  return `${downloadUrl}?name=${encodeURIComponent(safeName)}`;
}

function normalizeMobiName(value) {
  const fallback = 'converted-book.mobi';
  const cleaned = String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ');

  if (!cleaned) return fallback;
  return cleaned.toLowerCase().endsWith('.mobi') ? cleaned : `${cleaned}.mobi`;
}

function finishWithError(message, payload = null) {
  progressBar.classList.remove('is-working');
  setProgress(100, 'Conversion stopped.');
  setStatus(message, 'error');
  if (payload?.failures?.length) {
    renderResults({ files: payload.files || [], failures: payload.failures, zip: null });
  }
  button.disabled = false;
  clearButton.disabled = false;
}

function setStatus(message, type) {
  statusBox.className = `status ${type}`.trim();
  statusBox.textContent = message;
}

function setProgress(percent, label) {
  const normalized = Math.max(0, Math.min(100, Math.round(percent)));
  progressLabel.textContent = label;
  progressPercent.textContent = `${normalized}%`;
  progressBar.style.width = `${normalized}%`;

  if (normalized >= 100) {
    progressBar.classList.remove('is-working');
  }
}

function resetProgress() {
  progressWrap.hidden = true;
  progressBar.classList.remove('is-working');
  setProgress(0, 'Preparing files...');
}

function clearResults() {
  resultsPanel.hidden = true;
  resultsList.innerHTML = '';
  failuresList.innerHTML = '';
  zipDownload.hidden = true;
}

function getSelectedFiles() {
  return Array.from(fileInput.files || []);
}

function formatSelection(files) {
  if (files.length === 0) return 'Default maximum upload size: 80 MB total';
  if (files.length === 1) return `${files[0].name} (${formatBytes(files[0].size)})`;

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  return `${files.length} files selected (${formatBytes(totalSize)} total)`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units.shift();

  while (value >= 1024 && units.length) {
    value /= 1024;
    unit = units.shift();
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

loadHealth();
