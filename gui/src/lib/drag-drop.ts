/**
 * Browser drag-and-drop handler for the HTTP (web) build.
 *
 * The Tauri shell emits `files://dropped` with filesystem paths — that
 * IPC does not exist in a browser. We listen to the standard HTML5
 * dragover/drop events on `window`, collect the File objects, and POST
 * them as multipart form-data to /api/inbox/upload. The server pipes
 * each to the same `<root>/inbox/<ISO>-<basename>` layout the existing
 * chokidar watcher monitors — the rest of the flow keeps working.
 *
 * No-op in Tauri runtime (Tauri's own drag-drop handler stays
 * authoritative).
 *
 * @module @lib/drag-drop
 */
import { isTauriRuntime } from './rpc-transport';

export interface BrowserUploadResult {
  count: number;
}

export function setupBrowserDragDrop(
  getToken: () => string | null,
  onUploaded: (result: BrowserUploadResult) => void,
  onError?: (err: Error) => void,
): () => void {
  if (isTauriRuntime())
    return () => {
      /* Tauri build owns the drag-drop pipeline natively */
    };

  let dragDepth = 0;

  const onDragEnter = (e: DragEvent): void => {
    if (e.dataTransfer === null) return;
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    dragDepth += 1;
    document.body.classList.add('dnd-hover');
  };

  const onDragOver = (e: DragEvent): void => {
    if (e.dataTransfer === null) return;
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (e: DragEvent): void => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      document.body.classList.remove('dnd-hover');
    }
  };

  const onDrop = async (e: DragEvent): Promise<void> => {
    if (e.dataTransfer === null) return;
    if (e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dnd-hover');

    const token = getToken();
    if (token === null) {
      onError?.(new Error('drag-drop: no auth token available'));
      return;
    }

    const fd = new FormData();
    for (const file of Array.from(e.dataTransfer.files)) {
      fd.append('files', file, file.name);
    }

    try {
      const res = await fetch('/api/inbox/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) {
        onError?.(new Error(`drag-drop: upload returned HTTP ${res.status}`));
        return;
      }
      const body = (await res.json()) as
        | { ok: true; result: { count: number; paths: string[] } }
        | { ok: false; error: { code: string; message: string } };
      if (body.ok) {
        onUploaded({ count: body.result.count });
      } else {
        onError?.(new Error(`drag-drop: ${body.error.code}: ${body.error.message}`));
      }
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  // Wrap async onDrop into a sync listener so removeEventListener can
  // reference the SAME function instance later (closures with `void
  // onDrop(e)` produced a new function each render, leaking listeners).
  const onDropSync = (e: DragEvent): void => {
    void onDrop(e);
  };

  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDropSync);

  return (): void => {
    window.removeEventListener('dragenter', onDragEnter);
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('dragleave', onDragLeave);
    window.removeEventListener('drop', onDropSync);
  };
}
