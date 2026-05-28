import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
const maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 80) * 1024 * 1024;
const conversionTimeoutMs = Number(process.env.CONVERSION_TIMEOUT_MS || 180000);
const allowedExtensions = new Set(['.pdf', '.epub', '.docx', '.txt', '.html', '.htm', '.rtf', '.azw3']);

await mkdir(uploadDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mobi': 'application/x-mobipocket-ebook'
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
      return handleDownload(url.pathname, res);
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

  const body = await readRequestBody(req, maxUploadBytes);
  const boundary = getBoundary(req);
  const file = parseSingleFile(body, boundary);

  if (!file) {
    return sendJson(res, 400, { error: 'No file was received.' });
  }

  const originalExt = extname(file.filename).toLowerCase();
  if (!allowedExtensions.has(originalExt)) {
    return sendJson(res, 400, { error: `Unsupported format: ${originalExt || 'no extension'}.` });
  }

  const jobId = randomUUID();
  const safeBaseName = sanitizeBaseName(file.filename.replace(/\.[^.]+$/, '')) || 'documento';
  const inputPath = join(uploadDir, `${jobId}${originalExt}`);
  const outputFilename = `${safeBaseName}-${jobId.slice(0, 8)}.mobi`;
  const outputPath = join(outputDir, outputFilename);

  await writeFile(inputPath, file.content);

  try {
    const result = await convertToMobi(inputPath, outputPath);
    sendJson(res, 200, {
      ok: true,
      filename: outputFilename,
      downloadUrl: `/downloads/${encodeURIComponent(outputFilename)}`,
      log: result.stderr.slice(-4000)
    });
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => {});
    sendJson(res, 422, { error: error.message });
  } finally {
    await rm(inputPath, { force: true }).catch(() => {});
  }
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

function parseSingleFile(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = splitBuffer(body, delimiter);

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

    return { filename: filenameMatch[1], content };
  }

  return null;
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

function readRequestBody(req, maxBytes) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error(`El archivo supera el limite de ${Math.round(maxBytes / 1024 / 1024)} MB.`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

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

async function handleDownload(pathname, res) {
  const filename = decodeURIComponent(pathname.replace('/downloads/', ''));
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '');
  const filePath = normalize(join(outputDir, safeFilename));

  if (!filePath.startsWith(outputDir) || !safeFilename.endsWith('.mobi')) {
    return sendText(res, 403, 'Access denied.');
  }

  const fileStats = await stat(filePath).catch(() => null);
  if (!fileStats || !fileStats.isFile()) {
    return sendText(res, 404, 'File not found.');
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-mobipocket-ebook',
    'Content-Length': fileStats.size,
    'Content-Disposition': `attachment; filename="${safeFilename}"`
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

function sanitizeBaseName(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
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
