/** Browser directory entries are read repeatedly because Chromium returns them in batches. */
export async function droppedUploadFiles(transfer: DataTransfer): Promise<File[]> {
  const items = Array.from(transfer.items).filter(item => item.kind === 'file');
  if (!items.length) return Array.from(transfer.files);
  const entries = items.map(item => ({entry: item.webkitGetAsEntry?.(), file: item.getAsFile()}));
  async function read(entry: FileSystemEntry, prefix: string): Promise<File[]> {
    const relativePath = prefix + entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      Object.defineProperty(file, 'webkitRelativePath', {value:relativePath, configurable:true});
      return [file];
    }
    if (!entry.isDirectory) return [];
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const result: File[] = [];
    while (true) {
      const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!children.length) break;
      for (const child of children) result.push(...await read(child, relativePath + '/'));
    }
    return result;
  }
  const files: File[] = [];
  for (const {entry, file} of entries) {
    if (entry) files.push(...await read(entry, ''));
    else if (file) files.push(file);
  }
  return files;
}
