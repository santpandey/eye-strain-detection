import { createVisionEngine, type VisionEngine } from './engine';
import type { WorkerInMessage, WorkerOutMessage } from './types';

// MediaPipe's wasm loader calls importScripts(), which throws a TypeError in
// ES-module workers and then falls back to dynamic import() — that fails under
// Vite and would not define the Module global anyway. Emulate importScripts
// with synchronous XHR (allowed in workers) evaluated in the global scope.
(self as typeof self & { importScripts: unknown }).importScripts = (
  ...urls: (string | URL)[]
) => {
  for (const u of urls) {
    const url = u.toString();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.send();
    if (xhr.status >= 400) throw new Error(`importScripts failed (${xhr.status}): ${url}`);
    (0, eval)(`${xhr.responseText}\n//# sourceURL=${url}`);
  }
};

let engine: VisionEngine | null = null;

function post(msg: WorkerOutMessage) {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = async (ev: MessageEvent<WorkerInMessage>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    try {
      const preferCPU = msg.delegate === undefined ? undefined : msg.delegate === 'CPU';
      engine = await createVisionEngine(msg.wasmBase, msg.modelUrl, {
        preferCPU,
        overrideRenderer: msg.delegateRenderer,
      });
      post({
        type: 'ready',
        delegate: engine.delegate,
        renderer: engine.renderer,
        software: engine.software,
      });
    } catch (e) {
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  } else if (msg.type === 'frame' && engine) {
    try {
      const r = await engine.processFrame(msg.bitmap, msg.t);
      msg.bitmap.close();
      post({ type: 'result', ...r });
    } catch (e) {
      msg.bitmap.close();
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }
};
