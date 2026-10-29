import { createPayloadAdapter } from "@launch/adapter-payload";
import { imagePath } from "@launch/images";

/** Where Payload serves uploads; app/(frontend)/media serves them resized instead. */
const MEDIA_FILES_PATH = "/api/media/file/";

/** A Payload upload URL, pointed at the image route. */
export const mediaUrl = (src: string): string =>
  imagePath(src, MEDIA_FILES_PATH);

/** Maps page documents (read at depth 1) to the shared content model. */
export const payloadAdapter = createPayloadAdapter({
  imageUrl: mediaUrl,
});
