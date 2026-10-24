import { mkdir, copyFile } from 'node:fs/promises';
await mkdir(new URL('../dist/assets/', import.meta.url), { recursive: true });
await copyFile(new URL('../src/assets/mock-caricature.png', import.meta.url), new URL('../dist/assets/mock-caricature.png', import.meta.url));
