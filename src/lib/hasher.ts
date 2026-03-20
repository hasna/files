import { blake3 } from "@noble/hashes/blake3";
import { readFileSync } from "fs";

export function hashFile(filePath: string): string {
  const data = readFileSync(filePath);
  const hash = blake3(data);
  return Buffer.from(hash).toString("hex");
}

export function hashBuffer(data: Uint8Array): string {
  return Buffer.from(blake3(data)).toString("hex");
}
