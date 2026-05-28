import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = join(rootDir, 'public');
const uploadDir = join(rootDir, 'storage', 'uploads');
const outputDir = join(rootDir, 'storage', 'outputs');

const port = Number(process.env.PORT || 3000);
const defaultMaxUploadMB = 250;
const maxUploadMB = Number(process.env.MAX_UPLOAD_MB || defaultMaxUploadMB);
const maxUploadBytes = maxUploadMB * 1024 * 1024;
const conversionTimeoutMs = Number(process.env.CONVERSION_TIMEOUT_MS || 180000);
const allowedExtensions = new Set(['.pdf', '.epub', '.docx', '.txt', '.html', '.htm', '.rtf', '.azw3']);

await mkdir(uploadDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mobi': 'application/x-mobipocket-ebook',
  '.zip': 'application/zip'
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, converterAvailable: await hasEbookConvert() });
    }

    if (req.method === 'POST' && url.pathname === '/api/convert') {
      return handleConvert(req, res);
    }

    if (req.method === 'GET' && url.pathname.startsWith('/downloads/')) {
      return handleDownload(url, res);
    }

    if (req.method === 'GET') {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || 'Internal server error.' });
  }
});

server.listen(port, () => {
  console.log(`Kindle MOBI Converter available at http://localhost:${port}`);
});

async function handleConvert(req, res) {
  if (!isMultipart(req)) {
    return sendJson(res, 400, { error: 'The request must use multipart/form-data.' });
  }

  if (!await hasEbookConvert()) {
    return sendJson(res, 503, {
      error: 'Calibre is not installed or ebook-convert is not available in PATH.'
    });
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > maxUploadBytes) {
    return sendJson(res, 413, {
      error: `The upload is ${formatBytes(contentLength)}, which exceeds the ${maxUploadMB} MB limit. Select fewer files or increase MAX_UPLOAD_MB.`
    });
  }

  let body;
  try {
    body = await readRequestBody(req, maxUploadBytes, maxUploadMB);
  } catch (error) {
    if (error instanceof UploadLimitError) {
      return sendJson(res, 413, { error: error.message });
    }
    throw error;
  }
  const boundary = getBoundary(req);
  const uploadedFiles = parseFiles(body, boundary);

  if (uploadedFiles.length === 0) {
    return sendJson(res, 400, { error: 'No files were received.' });
  }

  const results = [];
  const failures = [];
  const inputPaths = [];
  const batchId = randomUUID();

  for (const [index, file] of uploadedFiles.entries()) {
    const originalExt = extname(file.filename).toLowerCase();
    if (!allowedExtensions.has(originalExt)) {
      failures.push({ originalName: file.filename, error: `Unsupported format: ${originalExt || 'no extension'}.` });
      continue;
    }

    const itemId = randomUUID();
    const safeBaseName = sanitizeBaseName(file.filename.replace(/\.[^.]+$/, '')) || `document-${index + 1}`;
    const inputPath = join(uploadDir, `${itemId}${originalExt}`);
    const outputFilename = `${safeBaseName}-${itemId.slice(0, 8)}.mobi`;
    const outputPath = join(outputDir, outputFilename);

    inputPaths.push(inputPath);
    await writeFile(inputPath, file.content);

    try {
      const result = await convertToMobi(inputPath, outputPath);
      results.push({
        originalName: file.filename,
        filename: outputFilename,
        suggestedName: `${safeBaseName}.mobi`,
        size: (await stat(outputPath)).size,
        downloadUrl: `/downloads/${encodeURIComponent(outputFilename)}`,
        log: result.stderr.slice(-2000)
      });
    } catch (error) {
      await rm(outputPath, { force: true }).catch(() => {});
      failures.push({ originalName: file.filename, error: error.message });
    }
  }

  await Promise.all(inputPaths.map(path => rm(path, { force: true }).catch(() => {})));

  if (results.length === 0) {
    return sendJson(res, 422, {
      ok: false,
      error: 'No files could be converted.',
      files: [],
      failures
    });
  }

  let zip = null;
  if (results.length > 1) {
    const zipFilename = `mobi-conversions-${batchId.slice(0, 8)}.zip`;
    const zipPath = join(outputDir, zipFilename);
    try {
      await createZip(zipPath, results.map(file => ({ path: join(outputDir, file.filename), name: file.filename })));
      zip = {
        filename: zipFilename,
        downloadUrl: `/downloads/${encodeURIComponent(zipFilename)}`,
        size: (await stat(zipPath)).size
      };
    } catch (error) {
      failures.push({ originalName: 'ZIP archive', error: error.message });
    }
  }

  sendJson(res, 200, {
    ok: true,
    files: results,
    failures,
    zip
  });
}

function convertToMobi(inputPath, outputPath) {
  return new Promise((resolvePromise, reject) => {
    const args = [inputPath, outputPath, '--output-profile', 'kindle', '--mobi-file-type', 'both'];
    const child = spawn('ebook-convert', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('The conversion exceeded the configured time limit.'));
    }, conversionTimeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(new Error(`Could not run ebook-convert: ${error.message}`));
    });
    child.on('close', async code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Conversion failed. ${stderr || stdout || `Code ${code}`}`.trim()));
        return;
      }
      const outputStats = await stat(outputPath).catch(() => null);
      if (!outputStats || outputStats.size === 0) {
        reject(new Error('The conversion finished, but no valid MOBI file was generated.'));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function createZip(zipPath, entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const data = await readFile(entry.path);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);
    const { date, time } = getDosDateTime(new Date());

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endHeader = Buffer.alloc(22);
  endHeader.writeUInt32LE(0x06054b50, 0);
  endHeader.writeUInt16LE(0, 4);
  endHeader.writeUInt16LE(0, 6);
  endHeader.writeUInt16LE(entries.length, 8);
  endHeader.writeUInt16LE(entries.length, 10);
  endHeader.writeUInt32LE(centralSize, 12);
  endHeader.writeUInt32LE(offset, 16);
  endHeader.writeUInt16LE(0, 20);

  await writeFile(zipPath, Buffer.concat([...localParts, ...centralParts, endHeader]));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function getDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
}

function parseFiles(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = splitBuffer(body, delimiter);
  const files = [];

  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) continue;

    const header = part.subarray(0, headerEnd).toString('utf8');
    const nameMatch = header.match(/name="file"/i);
    const filenameMatch = header.match(/filename="([^"]+)"/i);
    if (!nameMatch || !filenameMatch) continue;

    let content = part.subarray(headerEnd + 4);
    if (content.subarray(0, 2).toString() === '\r\n') content = content.subarray(2);
    if (content.subarray(-2).toString() === '\r\n') content = content.subarray(0, -2);
    if (content.length === 0) continue;

    files.push({ filename: filenameMatch[1], content });
  }

  return files;
}

function splitBuffer(buffer, delimiter) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(delimiter);

  while (index !== -1) {
    if (index > start) parts.push(buffer.subarray(start, index));
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }

  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

function readRequestBody(req, maxBytes, maxMB) {
  return new Promise((resolvePromise, reject) => {
    let chunks = [];
    let total = 0;
    let exceeded = false;

    req.on('data', chunk => {
      if (exceeded) return;

      total += chunk.length;
      if (total > maxBytes) {
        exceeded = true;
        chunks = [];
        reject(new UploadLimitError(`The upload exceeds the ${maxMB} MB limit. Select fewer files or increase MAX_UPLOAD_MB.`));
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!exceeded) resolvePromise(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

class UploadLimitError extends Error {}

function isMultipart(req) {
  return String(req.headers['content-type'] || '').includes('multipart/form-data');
}

function getBoundary(req) {
  const match = String(req.headers['content-type'] || '').match(/boundary=([^;]+)/);
  if (!match) throw new Error('Multipart boundary was not found.');
  return match[1];
}

async function serveStatic(pathname, res) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(publicDir, decodeURIComponent(requested)));

  if (!filePath.startsWith(publicDir)) {
    return sendText(res, 403, 'Access denied.');
  }

  const fileStats = await stat(filePath).catch(() => null);
  if (!fileStats || !fileStats.isFile()) {
    return sendText(res, 404, 'Not found.');
  }

  const type = mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  createReadStream(filePath).pipe(res);
}

async function handleDownload(url, res) {
  const filename = decodeURIComponent(url.pathname.replace('/downloads/', ''));
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '');
  const filePath = normalize(join(outputDir, safeFilename));
  const extension = extname(safeFilename).toLowerCase();

  if (!filePath.startsWith(outputDir) || !['.mobi', '.zip'].includes(extension)) {
    return sendText(res, 403, 'Access denied.');
  }

  const fileStats = await stat(filePath).catch(() => null);
  if (!fileStats || !fileStats.isFile()) {
    return sendText(res, 404, 'File not found.');
  }

  const customName = sanitizeDownloadName(url.searchParams.get('name') || safeFilename, extension);

  res.writeHead(200, {
    'Content-Type': mimeTypes[extension] || 'application/octet-stream',
    'Content-Length': fileStats.size,
    'Content-Disposition': `attachment; filename="${customName}"`
  });
  createReadStream(filePath).pipe(res);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
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

function sanitizeBaseName(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function sanitizeDownloadName(value, extension) {
  const base = sanitizeBaseName(value.replace(/\.[^.]+$/, '')) || 'download';
  return `${base}${extension}`;
}

function hasEbookConvert() {
  return new Promise(resolvePromise => {
    const child = spawn('ebook-convert', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolvePromise(false));
    child.on('close', code => resolvePromise(code === 0));
  });
}

async function cleanupOldOutputs() {
  const maxAgeMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const folders = [uploadDir, outputDir];

  for (const folder of folders) {
    const files = await readdir(folder).catch(() => []);
    for (const file of files) {
      if (file === '.gitkeep') continue;
      const filePath = join(folder, file);
      const fileStats = await stat(filePath).catch(() => null);
      if (fileStats && now - fileStats.mtimeMs > maxAgeMs) {
        await rm(filePath, { force: true }).catch(() => {});
      }
    }
  }
}

setInterval(cleanupOldOutputs, 60 * 60 * 1000).unref();
cleanupOldOutputs().catch(() => {});
