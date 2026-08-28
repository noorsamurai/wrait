import { readDateTaken, withDateTaken } from "./exif";

/** Where the output can go. WebP is smallest, JPEG the most universally read. */
export type PhotoFormat = "image/jpeg" | "image/png" | "image/webp";

export const FORMAT_LABELS: Record<PhotoFormat, string> = {
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/webp": "WebP",
};

const EXTENSIONS: Record<PhotoFormat, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Fractions of the image, so a crop survives rotation and resizing. */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FULL_CROP: Crop = { x: 0, y: 0, width: 1, height: 1 };

export interface PhotoEdit {
  /** Clockwise, in quarter turns. */
  rotation: 0 | 90 | 180 | 270;
  crop: Crop;
}

export interface PhotoOutput {
  format: PhotoFormat;
  /** Longest edge in pixels, or null to keep the original size. */
  maxEdge: number | null;
  /** 0..1, ignored by PNG. */
  quality: number;
  /**
   * Everything is dropped when a photo is re-encoded. This puts back the one
   * tag worth keeping - never location, never device.
   */
  keepDateTaken: boolean;
}

export const DEFAULT_OUTPUT: PhotoOutput = {
  format: "image/jpeg",
  maxEdge: 2048,
  quality: 0.85,
  keepDateTaken: false,
};

export const SIZE_OPTIONS: { label: string; maxEdge: number | null }[] = [
  { label: "Full storlek", maxEdge: null },
  { label: "2048 px", maxEdge: 2048 },
  { label: "1024 px", maxEdge: 1024 },
];

/**
 * Decodes with the camera's orientation already applied.
 *
 * An iPhone photo is usually stored landscape with a tag saying "actually
 * rotate this"; without honouring that here, every portrait photo would
 * arrive on its side.
 */
export async function loadBitmap(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file, { imageOrientation: "from-image" });
}

/** Size after rotation, before cropping. */
function orientedSize(bitmap: ImageBitmap, rotation: number) {
  const swapped = rotation === 90 || rotation === 270;
  return {
    width: swapped ? bitmap.height : bitmap.width,
    height: swapped ? bitmap.width : bitmap.height,
  };
}

/** Pixel dimensions the edit will produce, for showing a size estimate. */
export function outputSize(bitmap: ImageBitmap, edit: PhotoEdit, output: PhotoOutput) {
  const oriented = orientedSize(bitmap, edit.rotation);
  let width = Math.max(1, Math.round(oriented.width * edit.crop.width));
  let height = Math.max(1, Math.round(oriented.height * edit.crop.height));

  if (output.maxEdge && Math.max(width, height) > output.maxEdge) {
    const scale = output.maxEdge / Math.max(width, height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  return { width, height };
}

/**
 * Applies the edit and encodes.
 *
 * Rotation, crop and resize all happen in one draw: going through a canvas
 * per step would compound the resampling and soften the picture.
 */
export async function renderPhoto(
  original: Blob,
  bitmap: ImageBitmap,
  edit: PhotoEdit,
  output: PhotoOutput,
): Promise<Blob> {
  const target = outputSize(bitmap, edit, output);

  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Kunde inte behandla bilden.");

  // JPEG has no transparency; without this a PNG's transparent corners come
  // out black rather than white.
  if (output.format === "image/jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, target.width, target.height);
  }

  context.imageSmoothingQuality = "high";
  context.save();
  // Work in the rotated frame, then draw the source into it.
  context.translate(target.width / 2, target.height / 2);
  context.rotate((edit.rotation * Math.PI) / 180);

  const drawWidth = (edit.rotation === 90 || edit.rotation === 270 ? target.height : target.width);
  const drawHeight = (edit.rotation === 90 || edit.rotation === 270 ? target.width : target.height);

  context.drawImage(
    bitmap,
    edit.crop.x * bitmap.width,
    edit.crop.y * bitmap.height,
    edit.crop.width * bitmap.width,
    edit.crop.height * bitmap.height,
    -drawWidth / 2,
    -drawHeight / 2,
    drawWidth,
    drawHeight,
  );
  context.restore();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, output.format, output.format === "image/png" ? undefined : output.quality),
  );
  if (!blob) throw new Error("Kunde inte spara bilden.");

  if (output.keepDateTaken && output.format === "image/jpeg") {
    const taken = await readDateTaken(original);
    if (taken) return withDateTaken(blob, taken);
  }
  return blob;
}

/** Keeps the original stem, swaps the extension for what was produced. */
export function outputName(name: string, format: PhotoFormat): string {
  const stem = name.replace(/\.[^./\\]+$/, "") || "bild";
  return `${stem}.${EXTENSIONS[format]}`;
}
