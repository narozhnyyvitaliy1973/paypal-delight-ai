import { mkdir, copyFile } from 'node:fs/promises';
await mkdir(new URL('../dist/assets/', import.meta.url), { recursive: true });
for (const mode of ['caricature', 'greeting-card', 'mini-comic']) {
  await copyFile(new URL(`../src/assets/mock-${mode}.png`, import.meta.url), new URL(`../dist/assets/mock-${mode}.png`, import.meta.url));
}
