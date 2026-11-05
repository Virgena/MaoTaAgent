/// The only writer on fd 1.
///
/// A `Content-Length` frame cannot be split by another frame, so every byte of
/// one frame is written before the next frame starts. `writeSync` may write
/// fewer bytes than it was given, so the loop is not optional.

import { writeSync } from "node:fs";

export interface Outbound {
  write(frame: unknown): void;
}

export function createOutbound(): Outbound {
  return {
    write(frame) {
      const body = Buffer.from(JSON.stringify(frame), "utf8");
      writeAll(Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"));
      writeAll(body);
    },
  };
}

/// The kernel is the only reader. Once the pipe is broken there is nothing left
/// to serve, so the host leaves instead of spinning on a dead fd.
function writeAll(bytes: Buffer): void {
  try {
    let at = 0;
    while (at < bytes.length) at += writeSync(1, bytes, at);
  } catch {
    process.exit(0);
  }
}
