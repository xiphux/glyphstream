import { Buffer } from 'node:buffer';
import { crc32, deflateSync } from 'node:zlib';

/**
 * A valid, all-white 1-bit grayscale PNG of any size. Cheap to build even at
 * 100+ megapixels (one bit per pixel, and blank rows deflate to almost
 * nothing), which makes it the test stand-in for an image whose decode would
 * be expensive: sharp still counts it as width x height pixels.
 */
export function bilevelPng(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(data.length, 0);
		head.write(type, 4, 'ascii');
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
		return Buffer.concat([head, data, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 1; // bit depth
	ihdr[9] = 0; // grayscale
	const rowBytes = 1 + Math.ceil(width / 8); // filter byte + packed pixels
	const raw = Buffer.alloc(rowBytes * height, 0xff);
	for (let y = 0; y < height; y++) raw[y * rowBytes] = 0; // filter: none
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}
