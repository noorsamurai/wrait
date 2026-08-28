/**
 * Just enough EXIF to answer one question: when was this taken.
 *
 * A phone photo carries far more than that - GPS coordinates, the exact
 * device, sometimes a street address. In a clinic that is the last thing that
 * should travel with a picture of a patient, so nothing here can put those
 * back: re-encoding drops every tag, and the only one that can be restored is
 * the timestamp, and only when someone asks for it.
 */

const ASCII = 2;
const LONG = 4;

const TAG_DATE_TIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;

/** "YYYY:MM:DD HH:MM:SS", the format EXIF stores and expects. */
export function toExifDate(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${when.getFullYear()}:${pad(when.getMonth() + 1)}:${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
  );
}

/** Walks the JPEG's segments looking for the APP1 that holds EXIF. */
function findExif(view: DataView): number | null {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null;
    const marker = view.getUint8(offset + 1);
    // Start of scan: image data begins, no more metadata segments.
    if (marker === 0xda) return null;
    const length = view.getUint16(offset + 2);
    if (marker === 0xe1 && offset + 4 + 6 <= view.byteLength) {
      let header = "";
      for (let i = 0; i < 4; i++) header += String.fromCharCode(view.getUint8(offset + 4 + i));
      if (header === "Exif") return offset + 10;
    }
    offset += 2 + length;
  }
  return null;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const code = view.getUint8(offset + i);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/**
 * The date the photo was taken, if the file says so.
 *
 * Returns the raw EXIF string, which is what gets written back - no timezone
 * guessing in either direction.
 */
export async function readDateTaken(file: Blob): Promise<string | null> {
  // The metadata lives at the front; reading the whole photo to find it would
  // pull megabytes into memory for twenty bytes.
  const head = await file.slice(0, 128 * 1024).arrayBuffer();
  const view = new DataView(head);

  const found = findExif(view);
  if (found === null) return null;
  const tiff: number = found;

  const little = view.getUint16(tiff) === 0x4949;
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);

  if (u16(tiff + 2) !== 0x2a) return null;

  function scan(ifd: number, wanted: number): { value: string | null; exifIfd: number | null } {
    if (ifd + 2 > view.byteLength) return { value: null, exifIfd: null };
    const count = u16(ifd);
    let value: string | null = null;
    let exifIfd: number | null = null;

    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (entry + 12 > view.byteLength) break;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const length = u32(entry + 4);

      if (tag === TAG_EXIF_IFD && type === LONG) {
        exifIfd = tiff + u32(entry + 8);
      } else if (tag === wanted && type === ASCII) {
        // Anything over four bytes is stored elsewhere and referenced.
        const at = length > 4 ? tiff + u32(entry + 8) : entry + 8;
        if (at + length <= view.byteLength) value = readAscii(view, at, length);
      }
    }
    return { value, exifIfd };
  }

  const ifd0 = scan(tiff + u32(tiff + 4), TAG_DATE_TIME);
  // DateTimeOriginal is when the shutter fired; DateTime can be a later edit.
  if (ifd0.exifIfd !== null) {
    const original = scan(ifd0.exifIfd, TAG_DATE_TIME_ORIGINAL).value;
    if (original) return original;
  }
  return ifd0.value;
}

/**
 * Rebuilds a JPEG with an EXIF block carrying only the date.
 *
 * Written by hand rather than copied from the original, so there is no way
 * for a tag nobody asked for to survive: whatever is not constructed here
 * does not exist in the output.
 */
export async function withDateTaken(jpeg: Blob, exifDate: string): Promise<Blob> {
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return jpeg;

  // 20 bytes: nineteen characters and the terminator EXIF requires.
  const date = new Uint8Array(20);
  for (let i = 0; i < 19; i++) date[i] = exifDate.charCodeAt(i) || 0x20;

  const IFD0 = 8;
  const IFD0_SIZE = 2 + 2 * 12 + 4;
  const EXIF_IFD = IFD0 + IFD0_SIZE;
  const EXIF_IFD_SIZE = 2 + 1 * 12 + 4;
  const DATA = EXIF_IFD + EXIF_IFD_SIZE;
  const TIFF_SIZE = DATA + date.length;

  const tiff = new DataView(new ArrayBuffer(TIFF_SIZE));
  const bytesOf = new Uint8Array(tiff.buffer);

  // Little-endian TIFF header pointing at IFD0.
  tiff.setUint16(0, 0x4949, true);
  tiff.setUint16(2, 0x2a, true);
  tiff.setUint32(4, IFD0, true);

  tiff.setUint16(IFD0, 2, true);
  tiff.setUint16(IFD0 + 2, TAG_DATE_TIME, true);
  tiff.setUint16(IFD0 + 4, ASCII, true);
  tiff.setUint32(IFD0 + 6, date.length, true);
  tiff.setUint32(IFD0 + 10, DATA, true);

  tiff.setUint16(IFD0 + 14, TAG_EXIF_IFD, true);
  tiff.setUint16(IFD0 + 16, LONG, true);
  tiff.setUint32(IFD0 + 18, 1, true);
  tiff.setUint32(IFD0 + 22, EXIF_IFD, true);
  tiff.setUint32(IFD0 + 26, 0, true);

  tiff.setUint16(EXIF_IFD, 1, true);
  tiff.setUint16(EXIF_IFD + 2, TAG_DATE_TIME_ORIGINAL, true);
  tiff.setUint16(EXIF_IFD + 4, ASCII, true);
  tiff.setUint32(EXIF_IFD + 6, date.length, true);
  tiff.setUint32(EXIF_IFD + 10, DATA, true);
  tiff.setUint32(EXIF_IFD + 14, 0, true);

  bytesOf.set(date, DATA);

  const header = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
  const segmentLength = 2 + header.length + TIFF_SIZE;
  const app1 = new Uint8Array(2 + segmentLength);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = (segmentLength >> 8) & 0xff;
  app1[3] = segmentLength & 0xff;
  app1.set(header, 4);
  app1.set(bytesOf, 4 + header.length);

  // Straight after the start-of-image marker, before everything else.
  return new Blob([bytes.slice(0, 2), app1, bytes.slice(2)], { type: "image/jpeg" });
}
