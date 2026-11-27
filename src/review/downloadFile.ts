export function downloadFile(file: Blob, filename: string) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Give the browser time to take ownership of the download.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
