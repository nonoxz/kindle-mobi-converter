const form = document.querySelector('#convertForm');
const fileInput = document.querySelector('#fileInput');
const fileName = document.querySelector('#fileName');
const statusBox = document.querySelector('#status');
const health = document.querySelector('#health');
const button = document.querySelector('#convertButton');
const progressWrap = document.querySelector('#progressWrap');
const progressLabel = document.querySelector('#progressLabel');
const progressPercent = document.querySelector('#progressPercent');
const progressBar = document.querySelector('#progressBar');

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileName.textContent = file ? `${file.name} (${formatBytes(file.size)})` : 'Default maximum size: 80 MB';
  resetProgress();
  setStatus('', '');
});

form.addEventListener('submit', event => {
  event.preventDefault();
  const file = fileInput.files?.[0];

  if (!file) {
    setStatus('Choose a file before converting.', 'error');
    return;
  }

  convertFile(file);
});

function convertFile(file) {
  button.disabled = true;
  progressWrap.hidden = false;
  setProgress(0, 'Preparing file...');
  setStatus('Keep this window open while the conversion finishes.', '');

  const data = new FormData();
  data.append('file', file);

  const request = new XMLHttpRequest();
  request.open('POST', '/api/convert');
  request.responseType = 'json';
  request.timeout = 240000;

  request.upload.addEventListener('progress', event => {
    if (!event.lengthComputable) {
      setProgress(12, 'Uploading file...');
      return;
    }

    const uploadPercent = Math.round((event.loaded / event.total) * 70);
    setProgress(Math.max(4, uploadPercent), 'Uploading file...');
  });

  request.addEventListener('loadstart', () => {
    setProgress(3, 'Starting conversion...');
  });

  request.addEventListener('load', () => {
    const payload = request.response;

    if (request.status < 200 || request.status >= 300) {
      const message = payload?.error || `Conversion failed with HTTP status ${request.status}.`;
      finishWithError(message);
      return;
    }

    if (!payload?.downloadUrl || !payload?.filename) {
      finishWithError('The server finished the conversion but did not return a valid download link.');
      return;
    }

    setProgress(100, 'Conversion finished. Downloading MOBI...');
    statusBox.className = 'status success';
    statusBox.innerHTML = `Conversion ready. If the download does not start, use this link: <a href="${payload.downloadUrl}" download="${payload.filename}">${payload.filename}</a>`;
    startDownload(payload.downloadUrl, payload.filename);
    button.disabled = false;
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
    finishWithError('The conversion took too long and was cancelled by the browser.');
  });

  request.upload.addEventListener('load', () => {
    setProgress(75, 'File received. Calibre is converting it to MOBI...');
    progressBar.classList.add('is-working');
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

function startDownload(downloadUrl, filename) {
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

function finishWithError(message) {
  progressBar.classList.remove('is-working');
  setProgress(100, 'Conversion stopped.');
  setStatus(message, 'error');
  button.disabled = false;
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
  setProgress(0, 'Preparing file...');
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
