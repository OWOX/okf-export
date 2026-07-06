import { zipSync, strToU8 } from 'fflate';

/** Zip a { filename: content } map and trigger a browser download. */
export function downloadZip(zipName: string, files: Record<string, string>): void {
  const entries = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)]));
  const bytes = zipSync(entries, { level: 6 });
  const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = zipName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
