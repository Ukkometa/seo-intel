/**
 * Minimal ZIP archive builder — zero dependencies.
 * Creates valid ZIP files (uncompressed / STORE method) from an array of entries.
 * Sufficient for text-based exports (MD, JSON, CSV) where deflate adds little value.
 *
 * Usage:
 *   import { createZip } from './lib/export-zip.js';
 *   const buf = createZip([{ name: 'report.md', content: '# Hello' }]);
 *   res.end(buf);
 */

/**
 * @param {{ name: string, content: string | Buffer }[]} entries
 * @returns {Buffer} Valid ZIP archive
 */
export function createZip(entries) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    const crc = crc32(data);

    // Local file header (30 + nameLen + dataLen)
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);   // signature
    local.writeUInt16LE(20, 4);            // version needed (2.0)
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(0, 8);             // compression: STORE
    local.writeUInt16LE(0, 10);            // mod time
    local.writeUInt16LE(0, 12);            // mod date
    local.writeUInt32LE(crc, 14);          // crc-32
    local.writeUInt32LE(data.length, 18);  // compressed size
    local.writeUInt32LE(data.length, 22);  // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26); // filename length
    local.writeUInt16LE(0, 28);            // extra field length
    nameBytes.copy(local, 30);

    localHeaders.push(Buffer.concat([local, data]));

    // Central directory header (46 + nameLen)
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);  // signature
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0, 8);           // flags
    central.writeUInt16LE(0, 10);          // compression: STORE
    central.writeUInt16LE(0, 12);          // mod time
    central.writeUInt16LE(0, 14);          // mod date
    central.writeUInt32LE(crc, 16);        // crc-32
    central.writeUInt32LE(data.length, 20); // compressed size
    central.writeUInt32LE(data.length, 24); // uncompressed size
    central.writeUInt16LE(nameBytes.length, 28); // filename length
    central.writeUInt16LE(0, 30);          // extra field length
    central.writeUInt16LE(0, 32);          // comment length
    central.writeUInt16LE(0, 34);          // disk number start
    central.writeUInt16LE(0, 36);          // internal attrs
    central.writeUInt32LE(0, 38);          // external attrs
    central.writeUInt32LE(offset, 42);     // local header offset
    nameBytes.copy(central, 46);

    centralHeaders.push(central);
    offset += local.length + data.length;
  }

  const centralDir = Buffer.concat(centralHeaders);
  const centralDirOffset = offset;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);                // signature
  eocd.writeUInt16LE(0, 4);                          // disk number
  eocd.writeUInt16LE(0, 6);                          // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);              // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);             // total entries
  eocd.writeUInt32LE(centralDir.length, 12);          // central dir size
  eocd.writeUInt32LE(centralDirOffset, 16);           // central dir offset
  eocd.writeUInt16LE(0, 20);                          // comment length

  return Buffer.concat([...localHeaders, centralDir, eocd]);
}

// ─── CRC-32 (IEEE 802.3) ────────────────────────────────────────────────────

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c;
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
