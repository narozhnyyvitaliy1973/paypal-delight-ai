import sharp, { type OutputInfo } from 'sharp';
import { AppError } from '../errors.js';

export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_MAX_PIXELS = 16_000_000;
export interface PhotoUpload { bytes: Buffer; contentType: string; consent: boolean }
export interface PreparedPhoto { bytes: Buffer; contentType: 'image/png'; width: number; height: number }
const invalid = () => new AppError(400, 'PHOTO_INVALID', 'Use a valid, single-frame JPEG, PNG or WebP image.');

function signature(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return undefined;
}

// Originals and cleaned photos stay in memory; a process crash leaves no photo files.
export async function withPreparedPhoto<T>(upload: PhotoUpload | undefined, process: (photo?: PreparedPhoto) => Promise<T>): Promise<T> {
  if (!upload) return process();
  let cleaned: { data: Buffer; info: OutputInfo } | undefined;
  try {
    if (upload.consent !== true) throw new AppError(400, 'PHOTO_CONSENT_REQUIRED', 'Separate photo consent is required.');
    if (!Buffer.isBuffer(upload.bytes) || upload.bytes.length === 0) throw invalid();
    if (upload.bytes.length > PHOTO_MAX_BYTES) throw new AppError(413, 'PHOTO_TOO_LARGE', 'Photo exceeds the size limit.');
    const format = signature(upload.bytes);
    if (!format || upload.contentType !== `image/${format}`) throw invalid();

    try {
      const image = sharp(upload.bytes, { limitInputPixels: PHOTO_MAX_PIXELS, failOn: 'warning' });
      const metadata = await image.metadata();
      if (metadata.format !== format || (metadata.pages ?? 1) !== 1 ||
          !metadata.width || !metadata.height || metadata.width * metadata.height > PHOTO_MAX_PIXELS) throw invalid();
      // rotate() applies orientation before EXIF is dropped. No keepMetadata/withMetadata.
      cleaned = await image.rotate().resize({ width: 511, height: 511, fit: 'inside', withoutEnlargement: true })
        .png().toBuffer({ resolveWithObject: true });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw invalid();
    }

    return await process({ bytes: cleaned.data, contentType: 'image/png', width: cleaned.info.width, height: cleaned.info.height });
  } finally {
    cleaned?.data.fill(0);
    if (Buffer.isBuffer(upload.bytes)) upload.bytes.fill(0);
  }
}
