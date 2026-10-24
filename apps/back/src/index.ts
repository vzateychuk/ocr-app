import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
config({ path: path.join(projectRoot, '.envs', 'dev.env') });

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

import { JevService } from './services/jev.service.js';
import { UploadService } from './services/upload.service.js';
import { UploadController } from './controllers/upload.controller.js';
import { uploadMiddleware } from './middlewares/upload.middleware.js';
import { validateFileContent } from './middlewares/validate-file.middleware.js';
import { errorHandler } from './middlewares/error.middleware.js';

const app = express();
const port = process.env.PORT || 3000;

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const KB_BASE_DIR = process.env.KB_BASE_DIR || 'store';

if (!OPENROUTER_API_KEY) {
  console.error('[CRITICAL] Missing OPENROUTER_API_KEY environment variable');
  process.exit(1);
}

const jevService = new JevService(OPENROUTER_API_KEY);
const uploadProcessor = new UploadService(jevService, KB_BASE_DIR);
const uploadController = new UploadController(uploadProcessor);

app.use(helmet());
app.use(cors());
app.use(express.json());

app.post(
  '/api/upload',
  uploadMiddleware.array('images', 10),
  validateFileContent,
  async (req, res, next) => {
    try {
      await uploadController.upload(req, res);
    } catch (error) {
      next(error);
    }
  }
);

app.use(errorHandler);

const server = app.listen(port, () => {
  console.log(`[INFO] Server running at http://localhost:${port}`);
});

process.on('SIGTERM', () => {
  console.log('[INFO] SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('[INFO] HTTP server closed');
    process.exit(0);
  });
});