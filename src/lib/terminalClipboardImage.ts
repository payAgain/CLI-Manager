// Pure clipboard / image helpers for terminal paste. No xterm runtime
// dependency; these operate on DataTransfer / File / ArrayBuffer only.

export const getClipboardImageFile = (clipboardData: DataTransfer | null) => {
  const items = Array.from(clipboardData?.items ?? []);
  const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
  return imageItem?.getAsFile() ?? null;
};

export const getImageFileExtension = (file: File) => {
  const typeExtension = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (typeExtension) return typeExtension;
  const nameExtension = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return nameExtension || "png";
};

export const createClipboardImageFileName = (file: File) => {
  const trimmedName = file.name.trim();
  if (trimmedName && /\.[a-z0-9]+$/iu.test(trimmedName)) return trimmedName;
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "");
  return `screenshot-${timestamp}.${getImageFileExtension(file)}`;
};

export const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

export const hasDataTransferType = (dataTransfer: DataTransfer | null, type: string): boolean => {
  if (!dataTransfer) return false;
  const types = dataTransfer.types as DataTransfer["types"] & {
    contains?: (value: string) => boolean;
  };
  if (typeof types.contains === "function") return types.contains(type);
  return Array.from(types).includes(type);
};
