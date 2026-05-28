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
const processDetails = document.querySelector('#processDetails');
const processLog = document.querySelector('#processLog');
const clearLogButton = document.querySelector('#clearLogButton');
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
  resetLog();
  if (files.length > 0) {
    appendLog(`Selected ${files.length} file${files.length === 1 ? '' : 's'} (${formatBytes(totalSize(files))} total).`);
    for (const file of files) {
      appendLog(`- ${file.name} (${formatBytes(file.size)})`);
    }
  }
});

clearButton.addEventListener('click', () => {
  fileInput.value = '';
  fileName.textContent = 'Default maximum upload size: 80 MB total';
  resetProgress();
  setStatus('', '');
  clearResults();
  resetLog();
});

clearLogButton.addEventListener('click', () => {
  resetLog();
});

form.addEventListener('submit', event => {
  event.preventDefault();
  const files = getSelectedFiles();

  if (files.length === 0) {
    setStatus('Choose at least one file before converting.', 'error');
    appendLog('Conversion blocked: no files selected.', 'error');
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
  resetLog();
  appendLog(`Starting batch conversion for ${files.length} file${files.length === 1 ? '' : 's'}.`);
  appendLog(`Total upload size: ${formatBytes(totalSize(files))}.`);

  const data = new FormData();
  for (const file of files) {
    data.append('file', file);
    appendLog(`Queued: ${file.name} (${formatBytes(file.size)}).`);
  }

  const request = new XMLHttpRequest();
  request.open('POST', '/api/convert');
  request.responseType = 'json';
  request.timeout = Math.max(240000, files.length * 180000 + 60000);
  appendLog(`Request timeout set to ${Math.round(request.timeout / 1000)} seconds.`);

  request.upload.addEventListener('progress', event => {
    if (!event.lengthComputable) {
      setProgress(12, 'Uploading files...');
      appendLog('Uploading files. Total upload size is not available from the browser.');
      return;
    }

    const uploadPercent = Math.round((event.loaded / event.total) * 55);
    setProgress(Math.max(4, uploadPercent), 'Uploading files...');
    appendLogOnce('upload-started', 'Upload started.');
    updateLastUploadLog(event.loaded, event.total);
  });

  request.addEventListener('loadstart', () => {
    setProgress(3, 'Starting batch conversion...');
    appendLog('HTTP request opened. Sending files to the server.');
  });

  request.upload.addEventListener('load', () => {
    setProgress(65, 'Files received. Calibre is converting them one by one...');
    progressBar.classList.add('is-working');
    appendLog('Upload completed. Server is running Calibre conversions sequentially.');
  });

  request.addEventListener('load', () => {
    const payload = request.response;
    appendLog(`Server responded with HTTP ${request.status}.`);

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
    appendServerDetails(payload);
    setStatus(`Converted ${payload.files.length} of ${files.length} file${files.length === 1 ? '' : 's'}.`, payload.failures?.length ? 'warning' : 'success');
    appendLog('Batch conversion finished.');
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
    appendLog(`Health check: converterAvailable=${payload.converterAvailable}.`);
  } catch {
    health.textContent = 'Could not check converter status.';
    appendLog('Health check failed. The server may be offline.', 'error');
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

function appendServerDetails(payload) {
  for (const file of payload.files || []) {
    appendLog(`Converted: ${file.originalName} -> ${file.filename} (${formatBytes(file.size)}).`, 'success');
    if (file.log) {
      appendLog(`Calibre log for ${file.originalName}:\n${file.log}`);
    }
  }

  if (payload.zip) {
    appendLog(`ZIP ready: ${payload.zip.filename} (${formatBytes(payload.zip.size)}).`, 'success');
  }

  for (const failure of payload.failures || []) {
    appendLog(`Failed: ${failure.originalName}: ${failure.error}`, 'error');
  }
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
  appendLog(message, 'error');
  if (payload?.failures?.length) {
    renderResults({ files: payload.files || [], failures: payload.failures, zip: null });
    appendServerDetails(payload);
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

function resetLog() {
  processLog.textContent = '';
  loggedOnce.clear();
  lastUploadLog = '';
}

function appendLog(message, type = 'info') {
  const now = new Date().toLocaleTimeString();
  const prefix = type === 'error' ? 'ERROR' : type === 'success' ? 'OK' : 'INFO';
  processLog.textContent += `[${now}] [${prefix}] ${message}\n`;
  processLog.scrollTop = processLog.scrollHeight;
}

const loggedOnce = new Set();
let lastUploadLog = '';

function appendLogOnce(key, message) {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  appendLog(message);
}

function updateLastUploadLog(loaded, total) {
  const percent = Math.round((loaded / total) * 100);
  const next = `Upload progress: ${percent}% (${formatBytes(loaded)} of ${formatBytes(total)}).`;
  if (next === lastUploadLog) return;
  lastUploadLog = next;
  appendLog(next);
}

function getSelectedFiles() {
  return Array.from(fileInput.files || []);
}

function totalSize(files) {
  return files.reduce((sum, file) => sum + file.size, 0);
}

function formatSelection(files) {
  if (files.length === 0) return 'Default maximum upload size: 80 MB total';
  if (files.length === 1) return `${files[0].name} (${formatBytes(files[0].size)})`;

  return `${files.length} files selected (${formatBytes(totalSize(files))} total)`;
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

appendLog('Interface loaded. Waiting for files.');
loadHealth();
