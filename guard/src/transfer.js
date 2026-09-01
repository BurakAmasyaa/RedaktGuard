// chrome.runtime mesajlaşması yalnızca JSON taşır; ArrayBuffer doğrudan geçmez.
// Dosya baytları bu yüzden base64 parçalar hâlinde aktarılır.

import { CHUNK_BYTES } from "./protocol.js";

const SLICE = 0x8000;

export function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += SLICE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + SLICE));
  }
  return btoa(binary);
}

export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function* chunkBytes(bytes, size = CHUNK_BYTES) {
  // Boş girdide de tek bir (boş) parça üretilir: chunkCount ile bildirilen
  // sayı, gerçekten gönderilen mesaj sayısına eşit kalmalı.
  if (!bytes.length) {
    yield bytes.subarray(0, 0);
    return;
  }
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
  }
}

export function chunkCount(byteLength, size = CHUNK_BYTES) {
  return Math.max(1, Math.ceil(byteLength / size));
}

// Sıra numarasına göre birleştirir; parçaların sırasız gelmesine karşı dayanıklıdır.
export function joinChunks(parts) {
  const ordered = [...parts].sort((left, right) => left.seq - right.seq);
  const total = ordered.reduce((sum, part) => sum + part.bytes.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of ordered) {
    output.set(part.bytes, offset);
    offset += part.bytes.length;
  }
  return output;
}
