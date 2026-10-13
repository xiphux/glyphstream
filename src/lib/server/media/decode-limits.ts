/**
 * Largest image, in pixels (width x height), that sharp will decode.
 *
 * sharp's default ceiling is 268 megapixels, and a PNG of a few hundred KB can
 * declare 16383 x 16383: about 1 GB of RGBA per decode, with thumbnails
 * running three at a time. 100 MP is far above anything a person uploads in
 * normal use (phone panoramas top out around 63 MP, most cameras well under
 * 100) while bounding a decode near 400 MB. An image over it gets no
 * thumbnail and no vision downscale; both paths already fall back for an
 * image they can't decode.
 */
export const MAX_DECODE_PIXELS = 100_000_000;
